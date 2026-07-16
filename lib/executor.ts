// Payment execution orchestrator. Drives an APPROVED payment through:
// liquidity reservation → on-chain escrow (source network) → confirmation →
// FX/settlement → payout → SETTLED, with audit events at every step and
// refund-on-failure semantics.
//
// Cross-network routes add a simulated bridge leg: after source-chain
// settlement, the treasury pays out destination-asset tokens to the
// recipient's wallet ON the destination network (a real ERC-20 transfer on
// chain 2), giving the payment transaction hashes on both networks.

import { randomUUID } from "node:crypto";
import type { Payment, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { ApiError } from "./api-errors";
import { type PaymentStatus } from "./state";
import { transitionStatus } from "./transitions";
import { assetForCurrency, toBaseUnits } from "./assets";
import {
  accountsFor,
  loadDeployments,
  onchainPaymentId,
  operatorWrite,
  treasuryTokenTransfer,
} from "./chain";
import { availableLiquidity, type RouteOption } from "./routing";
import { recallForPayment } from "./treasury";
import { keccak256, toHex, type Address } from "viem";

/**
 * Someone else is already executing this payment (or it left APPROVED before we
 * claimed it). A 409 via `caughtErrorResponse`, same as StaleTransitionError:
 * expected under concurrency, not a bug. The message names no internals and does
 * not distinguish the two causes.
 */
export class ExecutionLeaseError extends ApiError {
  constructor(readonly paymentId: string) {
    super("conflict", "payment is already being executed");
    this.name = "ExecutionLeaseError";
  }
}

type PaymentWithParties = Prisma.PaymentGetPayload<{
  include: { sender: { include: { wallets: true } }; recipient: { include: { wallets: true } } };
}>;

// Every status change the executor makes is a compare-and-swap against the
// status it last observed, so a concurrent writer can never be overwritten:
// a lost race throws StaleTransitionError out of executePayment rather than
// corrupting the lifecycle. Keep the `payment = { ...payment, ...(await
// setStatus(...)) }` assignments — the local row *is* the CAS's expected value.
async function setStatus(
  payment: Payment,
  to: PaymentStatus,
  dbData: Partial<Payment> = {},
  auditDetail: Record<string, unknown> = {}
) {
  return transitionStatus(payment, to, { data: dbData, detail: auditDetail });
}

function selectedRoute(payment: Payment): RouteOption {
  if (!payment.quoteJson) throw new Error("Payment has no quote");
  const routes = JSON.parse(payment.quoteJson) as RouteOption[];
  const route = routes.find((r) => r.route_id === payment.selectedRouteId) ?? routes[0];
  if (!route) throw new Error("No route available on quote");
  return route;
}

/**
 * Execute an APPROVED payment end-to-end. Runs synchronously — the local
 * chains confirm in milliseconds. On on-chain failure after escrow, funds are
 * refunded on the source network.
 *
 * At most one attempt runs per payment: the execution lease is claimed here,
 * before anything reads a chain or moves a token, so a second concurrent execute
 * throws ExecutionLeaseError (→ 409) having touched no chain state at all.
 */
export async function executePayment(paymentId: string): Promise<Payment> {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
  });

  if (payment.status !== "APPROVED") {
    throw new Error(`Payment must be APPROVED to execute (current: ${payment.status})`);
  }

  // The claim, not the check above, is what decides the race: the status read a
  // moment ago is already stale. `executionLeaseId: null` admits exactly one
  // winner; everyone else matches zero rows.
  const leaseId = randomUUID();
  const { count } = await prisma.payment.updateMany({
    where: { id: paymentId, status: "APPROVED", executionLeaseId: null },
    data: { executionLeaseId: leaseId, leasedAt: new Date() },
  });
  if (count === 0) throw new ExecutionLeaseError(paymentId);

  try {
    return await runExecution({ ...payment, executionLeaseId: leaseId }, leaseId);
  } finally {
    // transitionStatus releases the lease at SETTLED/FAILED/REFUNDED, so this
    // normally matches zero rows. It exists for the throws that never reach a
    // transition at all — an unquoted payment, a wallet lookup that fails, an
    // RPC down during setup — which would otherwise strand the lease and lock
    // the payment out of every retry. Scoped to our own leaseId so it can never
    // free a later attempt's.
    await prisma.payment
      .updateMany({
        where: { id: paymentId, executionLeaseId: leaseId },
        data: { executionLeaseId: null, leasedAt: null },
      })
      .catch(() => {});
  }
}

async function runExecution(claimed: PaymentWithParties, leaseId: string): Promise<Payment> {
  let payment = claimed;
  const route = selectedRoute(payment);
  const sourceNet = route.source_network;
  const destNet = route.destination_network;
  const isCrossChain = sourceNet !== destNet;

  const dep = loadDeployments();
  const sourceAsset = assetForCurrency(payment.sourceCurrency);
  const destAsset = assetForCurrency(payment.destinationCurrency);
  const sourceToken = dep.networks[sourceNet].contracts.tokens[sourceAsset.symbol];
  const destAmount = route.estimated_destination_amount;

  const walletOn = (wallets: { network: string; address: string }[], networkId: string) =>
    wallets.find((w) => w.network === networkId) ?? wallets[0];
  const senderWallet = walletOn(payment.sender.wallets, sourceNet);
  const recipientWallet = walletOn(payment.recipient.wallets, destNet);
  if (!senderWallet || !recipientWallet) throw new Error("Sender and recipient must have registered wallets");

  // The route decides the actual destination network (fallback routes settle on source).
  if (payment.destinationNetwork !== destNet) {
    payment = {
      ...payment,
      ...(await prisma.payment.update({
        where: { id: payment.id },
        data: { destinationNetwork: destNet },
      })),
    };
  }

  // 0. Auto-recall: the route only cleared because liquidity is parked in the
  //    MMF, so redeem it T+0 before reserving anything against it.
  if (route.recall_required) {
    try {
      // Emits a TREASURY_RECALLED per position plus one payment-linked
      // TREASURY_AUTO_RECALLED summarizing the redemption.
      await recallForPayment({
        networkId: destNet,
        asset: destAsset.symbol,
        amount: destAmount,
        paymentId: payment.id,
      });
    } catch (err) {
      const failureReason = `Auto-recall of parked ${destAsset.symbol} on ${destNet} failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      // Nothing is reserved or escrowed yet, but a stale reservation from an
      // earlier attempt must not survive a failed payment.
      await prisma.liquidityReservation
        .update({ where: { paymentId: payment.id }, data: { status: "RELEASED" } })
        .catch(() => {});
      await setStatus(payment, "FAILED", { failureReason });
      throw new Error(failureReason);
    }
  }

  // 1. Reserve destination-side liquidity on the destination network.
  const liq = await availableLiquidity(destAsset.symbol, destNet);
  if (Number(liq.available) < Number(destAmount)) {
    const failureReason = `Insufficient ${destAsset.symbol} liquidity on ${destNet}: need ${destAmount}, available ${liq.available}`;
    await setStatus(payment, "FAILED", { failureReason });
    throw new Error(failureReason);
  }
  // Lease and reservation are written together: re-asserting the lease inside the
  // same transaction is what makes a reservation impossible without it. The claim
  // is re-checked rather than assumed — between the claim and here the payment ran
  // an auto-recall and a chain read, and a reservation held by an attempt that no
  // longer owns the payment would silently withhold liquidity from everyone else.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: "APPROVED", executionLeaseId: leaseId },
      data: { leasedAt: new Date() },
    });
    if (count === 0) throw new ExecutionLeaseError(payment.id);
    await tx.liquidityReservation.upsert({
      where: { paymentId: payment.id },
      create: {
        paymentId: payment.id,
        asset: destAsset.symbol,
        network: destNet,
        amount: destAmount,
      },
      update: { asset: destAsset.symbol, network: destNet, amount: destAmount, status: "RESERVED" },
    });
  });
  payment = {
    ...payment,
    ...(await setStatus(payment, "LIQUIDITY_RESERVED", {}, {
      reservedAmount: destAmount,
      asset: destAsset.symbol,
      network: destNet,
    })),
  };

  const pid = onchainPaymentId(payment.id);
  const routeIdHash = keccak256(toHex(route.route_id));

  try {
    // 2. Escrow source funds on the source network.
    const amountUnits = toBaseUnits(payment.amount, sourceToken.decimals);
    const initTx = await operatorWrite(sourceNet, "initiatePayment", [
      pid,
      senderWallet.address,
      recipientWallet.address,
      sourceToken.address,
      amountUnits,
      payment.sourceCurrency,
      payment.destinationCurrency,
    ]);
    payment = {
      ...payment,
      ...(await setStatus(payment, "SUBMITTED_ONCHAIN", {
        txHash: initTx.hash,
        onchainPaymentId: pid,
      }, { network: sourceNet })),
    };

    // 3. Confirmation (receipt already awaited by operatorWrite).
    payment = {
      ...payment,
      ...(await setStatus(payment, "CONFIRMED_ONCHAIN", {}, {
        network: sourceNet,
        blockNumber: initTx.blockNumber.toString(),
        gasUsed: initTx.gasUsed.toString(),
      })),
    };

    // 4. FX conversion + source-chain settlement: release escrow to the treasury,
    //    recording the destination leg on the settlement contract.
    const destTokenOnDest = dep.networks[destNet].contracts.tokens[destAsset.symbol];
    const settledUnits = toBaseUnits(destAmount, destTokenOnDest.decimals);
    const settleTx = await operatorWrite(sourceNet, "settlePayment", [
      pid,
      routeIdHash,
      accountsFor(sourceNet).treasury.address,
      settledUnits,
      destAsset.symbol,
    ]);
    payment = {
      ...payment,
      ...(await setStatus(payment, "FX_OR_SWAP_COMPLETED", {
        settleTxHash: settleTx.hash,
        fxRate: route.estimated_fx_rate,
        destinationAmount: destAmount,
      }, { network: sourceNet })),
    };

    // 5. Payout leg.
    payment = { ...payment, ...(await setStatus(payment, "PAYOUT_PENDING")) };

    if (isCrossChain) {
      // Simulated bridge: treasury releases destination-asset tokens to the
      // recipient's wallet on the destination network.
      const bridgeTx = await treasuryTokenTransfer(
        destNet,
        destAsset.symbol,
        recipientWallet.address as Address,
        settledUnits
      );
      payment = {
        ...payment,
        ...(await prisma.payment.update({
          where: { id: payment.id },
          data: { destinationTxHash: bridgeTx.hash },
        })),
      };
      await audit(
        "bridge.destination_payout",
        {
          network: destNet,
          asset: destAsset.symbol,
          amount: destAmount,
          to: recipientWallet.address,
          txHash: bridgeTx.hash,
        },
        payment.id
      );
    }

    // Simulated fiat rail: credit the recipient's local-currency ledger.
    await prisma.ledgerCredit.create({
      data: {
        paymentId: payment.id,
        entityId: payment.recipientId,
        currency: payment.destinationCurrency,
        amount: destAmount,
      },
    });
    await audit(
      "payout.ledger_credit",
      { entityId: payment.recipientId, currency: payment.destinationCurrency, amount: destAmount },
      payment.id
    );

    // 6. Consume the reservation and settle.
    await prisma.liquidityReservation.update({
      where: { paymentId: payment.id },
      data: { status: "CONSUMED" },
    });
    payment = { ...payment, ...(await setStatus(payment, "SETTLED")) };
    return payment;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await prisma.liquidityReservation
      .update({ where: { paymentId: payment.id }, data: { status: "RELEASED" } })
      .catch(() => {});

    // If funds were escrowed on the source network, refund on-chain.
    if (["SUBMITTED_ONCHAIN", "CONFIRMED_ONCHAIN"].includes(payment.status)) {
      try {
        await operatorWrite(sourceNet, "failAndRefund", [pid, reason.slice(0, 200)]);
        await audit("payment.onchain_refund", { network: sourceNet, reason }, payment.id);
        payment = { ...payment, ...(await setStatus(payment, "FAILED", { failureReason: reason })) };
        return await setStatus(payment, "REFUNDED");
      } catch (refundErr) {
        await audit(
          "payment.refund_failed",
          { reason: refundErr instanceof Error ? refundErr.message : String(refundErr) },
          payment.id
        );
      }
    }
    // The refund leg may have landed FAILED before it threw; FAILED → FAILED is
    // not a legal move, and the payment is already where this path wants it.
    if (payment.status === "FAILED") return payment;
    return await setStatus(payment, "FAILED", { failureReason: reason });
  }
}
