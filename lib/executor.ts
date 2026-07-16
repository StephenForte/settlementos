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
  onchainPaymentState,
  operatorWrite,
  treasuryTokenTransfer,
  type OnchainPaymentState,
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

/**
 * Test-only injection points. The compensation saga only runs when the
 * destination leg fails *after* the source escrow was already released, which no
 * real input can provoke on a healthy fixture chain — so tests reach in here.
 * Nothing in the app assigns these; leave them undefined in every other context.
 */
export const executorTestHooks: {
  /** Throws with the escrow held but not yet released — the refund path. */
  beforeSettlement?: () => void | Promise<void>;
  /** Throws in the payout leg, with the source chain already settled — the compensation path. */
  beforeDestinationPayout?: () => void | Promise<void>;
  /** Throws in the on-chain refund, stranding a held escrow at FAILED. */
  beforeRefund?: () => void | Promise<void>;
  /**
   * Throws inside the compensation transfer itself, stranding the payment in
   * COMPENSATION_PENDING — the state an operator repair exists to fix. Runs on the
   * repair's transfer too, so a test must clear it before repairing.
   */
  beforeCompensationTransfer?: () => void | Promise<void>;
} = {};

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

/** An entity's wallet on `networkId` — addresses differ per network. */
function walletOn(wallets: { network: string; address: string }[], networkId: string) {
  return wallets.find((w) => w.network === networkId) ?? wallets[0];
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
  // Hoisted out of the try: the compensation path pays this exact amount back.
  const amountUnits = toBaseUnits(payment.amount, sourceToken.decimals);

  try {
    // 2. Escrow source funds on the source network.
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
    await executorTestHooks.beforeSettlement?.();
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

    // 5. Payout leg. Everything past this point runs with the source escrow
    //    already released, so a failure here compensates rather than refunds.
    payment = { ...payment, ...(await setStatus(payment, "PAYOUT_PENDING")) };
    await executorTestHooks.beforeDestinationPayout?.();

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

    // Reconcile before deciding what to undo: the DB records what this attempt
    // *tried*, the escrow records what actually landed, and they disagree exactly
    // when a step threw mid-flight. Refunding an already-released escrow reverts
    // ("not initiated"); marking a released one FAILED strands the sender's money.
    // A read that itself fails (RPC down) falls back to the DB's view.
    const escrow = await onchainPaymentState(sourceNet, pid).catch(() => null);

    // Escrow already released to the treasury: nothing to refund, so make the
    // sender whole out of treasury instead.
    if (escrow === "SETTLED") {
      return await compensateSender(payment, { ...compensationContextFor(payment), reason });
    }

    // Funds still escrowed on the source network: refund on-chain.
    const escrowHeld =
      escrow === "INITIATED" ||
      (escrow === null && ["SUBMITTED_ONCHAIN", "CONFIRMED_ONCHAIN"].includes(payment.status));
    if (escrowHeld) {
      try {
        await executorTestHooks.beforeRefund?.();
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

interface CompensationContext {
  /** Why the destination leg failed — operator detail, scrubbed for tenants on read. */
  reason: string;
  network: string;
  tokenSymbol: string;
  /** Display amount (decimal string) for the audit trail. */
  amount: string;
  /** The same base units that were escrowed — the sender is made exactly whole. */
  amountUnits: bigint;
  sender: Address;
}

/**
 * What compensating this payment would cost and where it would go, derived from
 * the row alone — so the executor's own catch and a later operator repair can
 * never disagree about the amount. The network is the payment's source network,
 * which is also what every quoted route carries as `source_network` (lib/routing
 * reads it off this same column).
 */
function compensationContextFor(payment: PaymentWithParties): CompensationContext {
  const network = payment.sourceNetwork;
  const asset = assetForCurrency(payment.sourceCurrency);
  const token = loadDeployments().networks[network].contracts.tokens[asset.symbol];
  const senderWallet = walletOn(payment.sender.wallets, network);
  if (!senderWallet) throw new Error("Sender has no registered wallet");
  return {
    reason: payment.failureReason ?? "destination leg failed after settlement",
    network,
    tokenSymbol: asset.symbol,
    amount: payment.amount,
    amountUnits: toBaseUnits(payment.amount, token.decimals),
    sender: senderWallet.address as Address,
  };
}

/**
 * Compensating action for a destination leg that failed *after* the source escrow
 * was released. `failAndRefund` is not available here — the escrow row is SETTLED
 * and its balance has already moved to the treasury — so the treasury sends the
 * source amount straight back to the sender's wallet on the source network.
 */
async function compensateSender(payment: Payment, ctx: CompensationContext): Promise<Payment> {
  const compensating = await transitionStatus(payment, "COMPENSATION_PENDING", {
    data: { failureReason: ctx.reason },
    detail: {
      network: ctx.network,
      asset: ctx.tokenSymbol,
      amount: ctx.amount,
      escrowState: "SETTLED",
    },
  });
  return runCompensationTransfer(compensating, ctx);
}

/**
 * The transfer half of the saga, entered with the payment already in
 * COMPENSATION_PENDING — by the executor's catch, or by an operator repair of an
 * attempt whose transfer failed.
 *
 * A failed transfer leaves the payment in COMPENSATION_PENDING rather than FAILED:
 * the sender's funds are genuinely still missing, and that is the state a repair
 * re-enters. Nothing retries automatically — compensation moves real money, so the
 * decision to send it again is an operator's.
 */
async function runCompensationTransfer(compensating: Payment, ctx: CompensationContext): Promise<Payment> {
  try {
    await executorTestHooks.beforeCompensationTransfer?.();
    const tx = await treasuryTokenTransfer(ctx.network, ctx.tokenSymbol, ctx.sender, ctx.amountUnits);
    await audit(
      "payment.compensation_transfer",
      {
        network: ctx.network,
        asset: ctx.tokenSymbol,
        amount: ctx.amount,
        amountUnits: ctx.amountUnits.toString(), // never a bigint — audit() JSON-stringifies
        to: ctx.sender,
        txHash: tx.hash,
      },
      compensating.id
    );
    return await transitionStatus(compensating, "COMPENSATED", {
      data: { compensationTxHash: tx.hash },
      detail: { network: ctx.network, txHash: tx.hash },
    });
  } catch (err) {
    await audit(
      "payment.compensation_failed",
      {
        network: ctx.network,
        asset: ctx.tokenSymbol,
        amount: ctx.amount,
        reason: err instanceof Error ? err.message : String(err),
      },
      compensating.id
    );
    return compensating;
  }
}

// ---------------------------------------------------------------------------
// Operator repair. Both entry points below exist because an execution attempt can
// end with the sender's money neither delivered nor returned — a compensation
// transfer that itself failed, or a refund leg that never landed. Nothing polls
// for these, so an operator has to be able to see and finish them by hand.
// ---------------------------------------------------------------------------

export interface StuckPayment {
  payment: PaymentWithParties;
  /** Live escrow state on the source network. Null when the RPC read failed. */
  escrowState: OnchainPaymentState | null;
}

/**
 * Payments an operator may still owe an action: the compensation transfers that
 * failed, plus the FAILED attempts whose escrow was never resolved on-chain.
 *
 * The DB cannot answer this alone — a FAILED payment is only really finished if
 * its escrow came back — so each candidate is checked against its source chain.
 * A read that fails degrades to `escrowState: null` and the payment is *kept* in
 * the list: unknown is not the same as fine, and a flaky RPC must not make a
 * stranded payment disappear from the one view that would surface it.
 */
export async function stuckPayments(): Promise<StuckPayment[]> {
  const candidates = await prisma.payment.findMany({
    where: {
      OR: [
        { status: "COMPENSATION_PENDING" },
        // Nothing was escrowed without an onchainPaymentId, so those FAILED
        // payments (rejected quote, insufficient liquidity) hold no funds.
        { status: "FAILED", onchainPaymentId: { not: null } },
      ],
    },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
    orderBy: { createdAt: "desc" },
  });

  const rows = await Promise.all(
    candidates.map(async (payment) => ({
      payment,
      escrowState: await onchainPaymentState(payment.sourceNetwork, onchainPaymentId(payment.id)).catch(
        () => null
      ),
    }))
  );

  // A FAILED payment whose escrow really did refund is done: the sender has their
  // funds back and only the REFUNDED transition is missing. Everything else here
  // has money sitting somewhere it does not belong.
  return rows.filter((r) => r.payment.status === "COMPENSATION_PENDING" || r.escrowState !== "REFUNDED");
}

/**
 * Re-run the compensation transfer for a payment stuck in COMPENSATION_PENDING.
 *
 * Idempotent in the sense that matters for something that moves money: a payment
 * already COMPENSATED is returned untouched rather than paid twice, and the lease
 * makes two concurrent repairs impossible. The escrow is re-read first for the
 * same reason the executor reads it — only a *released* escrow may be repaid from
 * treasury, and the DB status alone is not evidence of that.
 */
export async function repairCompensation(paymentId: string): Promise<Payment> {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
  });

  if (payment.status === "COMPENSATED") return payment;
  if (payment.status !== "COMPENSATION_PENDING") {
    throw new ApiError("conflict", `payment cannot be repaired from status ${payment.status}`);
  }

  // Same shape as the executor's claim: the CAS, not the check above, is what
  // decides the race between two operators clicking Repair at once.
  const leaseId = randomUUID();
  const { count } = await prisma.payment.updateMany({
    where: { id: paymentId, status: "COMPENSATION_PENDING", executionLeaseId: null },
    data: { executionLeaseId: leaseId, leasedAt: new Date() },
  });
  if (count === 0) throw new ExecutionLeaseError(paymentId);

  try {
    const ctx = compensationContextFor(payment);
    const escrow = await onchainPaymentState(ctx.network, onchainPaymentId(payment.id)).catch(() => null);
    // Stopping on an unreadable escrow costs nothing: the transfer would run on
    // that same unreachable network anyway.
    if (escrow === null) {
      throw new ApiError("conflict", "source network unreachable — escrow state could not be confirmed");
    }
    if (escrow !== "SETTLED") {
      throw new ApiError("conflict", "source escrow was not released — this payment is not owed compensation");
    }
    return await runCompensationTransfer({ ...payment, executionLeaseId: leaseId }, ctx);
  } finally {
    // transitionStatus frees the lease at COMPENSATED; this catches the exits that
    // never reach a transition (an unreadable escrow, a transfer that threw).
    await prisma.payment
      .updateMany({
        where: { id: paymentId, executionLeaseId: leaseId },
        data: { executionLeaseId: null, leasedAt: null },
      })
      .catch(() => {});
  }
}
