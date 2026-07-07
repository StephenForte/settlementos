// Payment execution orchestrator. Drives an APPROVED payment through:
// liquidity reservation → on-chain escrow → confirmation → FX/settlement →
// payout (ledger credit) → SETTLED, with audit events at every step and
// refund-on-failure semantics.

import type { Payment } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { assertTransition, type PaymentStatus } from "./state";
import { assetForCurrency, toBaseUnits } from "./assets";
import { loadDeployments, onchainPaymentId, operatorWrite } from "./chain";
import { availableLiquidity, type RouteOption } from "./routing";
import { keccak256, toHex } from "viem";

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
 * Execute an APPROVED payment end-to-end. Runs synchronously — the local chain
 * confirms in milliseconds. On on-chain failure after escrow, funds are refunded.
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
  const dep = loadDeployments();
  const sourceAsset = assetForCurrency(payment.sourceCurrency);
  const destAsset = assetForCurrency(payment.destinationCurrency);
  const sourceToken = dep.contracts.tokens[sourceAsset.symbol];
  const destAmount = route.estimated_destination_amount;

  const senderWallet = payment.sender.wallets[0];
  const recipientWallet = payment.recipient.wallets[0];
  if (!senderWallet || !recipientWallet) throw new Error("Sender and recipient must have registered wallets");

  // 1. Reserve destination-side liquidity.
  const liq = await availableLiquidity(destAsset.symbol);
  if (Number(liq.available) < Number(destAmount)) {
    const failureReason = `Insufficient ${destAsset.symbol} liquidity: need ${destAmount}, available ${liq.available}`;
    await setStatus(payment, "FAILED", { failureReason });
    throw new Error(`Insufficient liquidity for ${destAsset.symbol}`);
  }
  await prisma.liquidityReservation.upsert({
    where: { paymentId: payment.id },
    create: {
      paymentId: payment.id,
      asset: destAsset.symbol,
      network: route.destination_network,
      amount: destAmount,
    },
    update: { asset: destAsset.symbol, amount: destAmount, status: "RESERVED" },
  });
  payment = {
    ...payment,
    ...(await setStatus(payment, "LIQUIDITY_RESERVED", {}, { reservedAmount: destAmount, asset: destAsset.symbol })),
  };

  const pid = onchainPaymentId(payment.id);
  const routeIdHash = keccak256(toHex(route.route_id));

  try {
    // 2. Escrow source funds on-chain.
    const amountUnits = toBaseUnits(payment.amount, sourceToken.decimals);
    const initTx = await operatorWrite("initiatePayment", [
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
      })),
    };

    // 3. Confirmation (receipt already awaited by operatorWrite).
    payment = {
      ...payment,
      ...(await setStatus(payment, "CONFIRMED_ONCHAIN", {}, {
        blockNumber: initTx.blockNumber.toString(),
        gasUsed: initTx.gasUsed.toString(),
      })),
    };

    // 4. FX conversion + on-chain settlement: release escrow to the treasury,
    //    recording the destination leg on the settlement contract.
    const destToken = dep.contracts.tokens[destAsset.symbol];
    const settledUnits = toBaseUnits(destAmount, destToken.decimals);
    const settleTx = await operatorWrite("settlePayment", [
      pid,
      routeIdHash,
      dep.accounts.treasury.address,
      settledUnits,
      destAsset.symbol,
    ]);
    payment = {
      ...payment,
      ...(await setStatus(payment, "FX_OR_SWAP_COMPLETED", {
        settleTxHash: settleTx.hash,
        fxRate: route.estimated_fx_rate,
        destinationAmount: destAmount,
      })),
    };

    // 5. Payout leg (simulated fiat rail): credit the recipient's local-currency ledger.
    payment = { ...payment, ...(await setStatus(payment, "PAYOUT_PENDING")) };
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

    // If funds were escrowed, refund on-chain.
    if (["SUBMITTED_ONCHAIN", "CONFIRMED_ONCHAIN"].includes(payment.status)) {
      try {
        await operatorWrite("failAndRefund", [pid, reason.slice(0, 200)]);
        await audit("payment.onchain_refund", { reason }, payment.id);
        const failed = await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED", failureReason: reason },
        });
        await audit("payment.status.failed", { reason }, payment.id);
        const refunded = await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "REFUNDED" },
        });
        await audit("payment.status.refunded", {}, payment.id);
        return refunded ?? failed;
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
