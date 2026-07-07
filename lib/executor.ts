// Payment execution orchestrator. Drives an APPROVED payment through:
// liquidity reservation → on-chain escrow (source network) → confirmation →
// FX/settlement → payout → SETTLED, with audit events at every step and
// refund-on-failure semantics.
//
// Cross-network routes add a simulated bridge leg: after source-chain
// settlement, the treasury pays out destination-asset tokens to the
// recipient's wallet ON the destination network (a real ERC-20 transfer on
// chain 2), giving the payment transaction hashes on both networks.

import type { Payment } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { assertTransition, type PaymentStatus } from "./state";
import { assetForCurrency, toBaseUnits } from "./assets";
import {
  accountsFor,
  loadDeployments,
  onchainPaymentId,
  operatorWrite,
  treasuryTokenTransfer,
} from "./chain";
import { availableLiquidity, type RouteOption } from "./routing";
import { keccak256, toHex, type Address } from "viem";

async function setStatus(
  payment: Payment,
  to: PaymentStatus,
  dbData: Partial<Payment> = {},
  auditDetail: Record<string, unknown> = {}
) {
  assertTransition(payment.status, to);
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: to, ...dbData },
  });
  await audit(
    `payment.status.${to.toLowerCase()}`,
    { from: payment.status, to, ...dbData, ...auditDetail },
    payment.id
  );
  return updated;
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
 */
export async function executePayment(paymentId: string): Promise<Payment> {
  let payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { sender: { include: { wallets: true } }, recipient: { include: { wallets: true } } },
  });

  if (payment.status !== "APPROVED") {
    throw new Error(`Payment must be APPROVED to execute (current: ${payment.status})`);
  }

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

  // 1. Reserve destination-side liquidity on the destination network.
  const liq = await availableLiquidity(destAsset.symbol, destNet);
  if (Number(liq.available) < Number(destAmount)) {
    const failureReason = `Insufficient ${destAsset.symbol} liquidity on ${destNet}: need ${destAmount}, available ${liq.available}`;
    await setStatus(payment, "FAILED", { failureReason });
    throw new Error(failureReason);
  }
  await prisma.liquidityReservation.upsert({
    where: { paymentId: payment.id },
    create: {
      paymentId: payment.id,
      asset: destAsset.symbol,
      network: destNet,
      amount: destAmount,
    },
    update: { asset: destAsset.symbol, network: destNet, amount: destAmount, status: "RESERVED" },
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
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED", failureReason: reason },
        });
        await audit("payment.status.failed", { reason }, payment.id);
        const refunded = await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "REFUNDED" },
        });
        await audit("payment.status.refunded", {}, payment.id);
        return refunded;
      } catch (refundErr) {
        await audit(
          "payment.refund_failed",
          { reason: refundErr instanceof Error ? refundErr.message : String(refundErr) },
          payment.id
        );
      }
    }
    const failed = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "FAILED", failureReason: reason },
    });
    await audit("payment.status.failed", { reason }, payment.id);
    return failed;
  }
}
