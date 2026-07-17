// The compensation saga: what happens when the destination leg fails *after* the
// source escrow has already been released to the treasury. There is nothing left
// to refund at that point, so the sender must be made whole out of treasury.
//
// Both failure points are provoked with the executor's test hooks — no real input
// can make a healthy fixture chain fail mid-saga.

import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { executePayment, executorTestHooks } from "@/lib/executor";
import {
  accountsFor,
  networkContracts,
  onchainPaymentId,
  onchainPaymentState,
  tokenBalance,
} from "@/lib/chain";
import { toBaseUnits } from "@/lib/assets";
import { createApprovedPayment } from "../helpers/payments";
import type { Address } from "viem";

function walletBalance(networkId: string, symbol: string, owner: Address): Promise<bigint> {
  return tokenBalance(networkId, networkContracts(networkId).tokens[symbol].address, owner);
}

const senderWallet = (networkId: string) =>
  accountsFor(networkId).entityWallets.ent_acme_us.address as Address;

async function auditActions(paymentId: string): Promise<string[]> {
  const events = await prisma.auditEvent.findMany({ where: { paymentId }, orderBy: { id: "asc" } });
  return events.map((e) => e.action);
}

afterEach(() => {
  delete executorTestHooks.beforeSettlement;
  delete executorTestHooks.beforeDestinationPayout;
  delete executorTestHooks.afterDestinationPayout;
  delete executorTestHooks.escrowReadFails;
});

describe("compensation saga — destination leg fails after settlement", () => {
  it("returns the source amount to the sender and lands COMPENSATED", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const payment = await createApprovedPayment({ amount: "1000.00" });
    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("destination rail unavailable at 10.0.0.5:8545");
    };

    const result = await executePayment(payment.id);

    expect(result.status).toBe("COMPENSATED");
    expect(result.settleTxHash).toMatch(/^0x[0-9a-f]{64}$/); // settlement really happened
    expect(result.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The sender is exactly whole: escrowed → released to treasury → sent back.
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(senderBefore);

    // This is a compensation, not a refund wearing its clothes: the escrow row on
    // the contract is SETTLED, and failAndRefund was never called.
    expect(await onchainPaymentState("base-local", onchainPaymentId(payment.id))).toBe("SETTLED");

    const actions = await auditActions(payment.id);
    expect(actions).toEqual(
      expect.arrayContaining([
        "payment.status.compensation_pending",
        "payment.compensation_transfer",
        "payment.status.compensated",
      ])
    );
    expect(actions).not.toContain("payment.onchain_refund");
    expect(actions).not.toContain("payment.status.refunded");

    // The failed leg must not leave liquidity reserved or the payment leased.
    const reservation = await prisma.liquidityReservation.findUnique({ where: { paymentId: payment.id } });
    expect(reservation?.status).toBe("RELEASED");
    expect(result.executionLeaseId).toBeNull();

    // No payout landed, so no ledger credit may exist for it.
    expect(await prisma.ledgerCredit.count({ where: { paymentId: payment.id } })).toBe(0);
  });

  it("compensates on the SOURCE network when a cross-chain bridge payout fails", async () => {
    const recipient = accountsFor("polygon-local").entityWallets.ent_tokyo_supplier.address as Address;
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const recipientJpyBefore = await walletBalance("polygon-local", "mockJPY", recipient);

    const payment = await createApprovedPayment({
      amount: "5000.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });
    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("bridge relayer timed out");
    };

    const result = await executePayment(payment.id);

    expect(result.status).toBe("COMPENSATED");
    // Compensation is denominated in the SOURCE asset on the SOURCE network —
    // paying the sender back in destination asset would be a different bug.
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(senderBefore);
    // The recipient never got the bridge payout, so nothing moved on destination.
    expect(await walletBalance("polygon-local", "mockJPY", recipient)).toBe(recipientJpyBefore);
    expect(result.destinationTxHash).toBeNull();
  });

  it("audits the compensation transfer with the escrowed amount, not a bigint", async () => {
    const payment = await createApprovedPayment({ amount: "2500.00" });
    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("payout leg down");
    };

    await executePayment(payment.id);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { paymentId: payment.id, action: "payment.compensation_transfer" },
    });
    const detail = JSON.parse(event.detail);
    expect(detail).toMatchObject({
      network: "base-local",
      asset: "mockUSDC",
      amount: "2500.00",
      amountUnits: toBaseUnits("2500.00", 6).toString(),
      to: senderWallet("base-local"),
    });
    expect(detail.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("no double payout — a failure AFTER the recipient is paid completes forward", () => {
  it("keeps the recipient's payout and settles, never compensating the sender", async () => {
    const recipient = accountsFor("polygon-local").entityWallets.ent_tokyo_supplier.address as Address;
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const recipientJpyBefore = await walletBalance("polygon-local", "mockJPY", recipient);

    const payment = await createApprovedPayment({
      amount: "5000.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });
    // Throw AFTER the bridge payout has landed (destinationTxHash written) but
    // before the ledger credit — the window where compensating would refund the
    // sender while the recipient keeps the payout, paying twice out of treasury.
    executorTestHooks.afterDestinationPayout = () => {
      throw new Error("ledger write failed after payout");
    };

    const result = await executePayment(payment.id);

    // Completed forward, not compensated.
    expect(result.status).toBe("SETTLED");
    expect(result.destinationTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The recipient keeps the bridge payout...
    expect(await walletBalance("polygon-local", "mockJPY", recipient)).toBeGreaterThan(recipientJpyBefore);
    // ...and the sender is NOT paid back: the payment genuinely settled, so the
    // escrowed source amount stays with the treasury. A compensation here would
    // have restored senderBefore — the double-pay bug.
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBeLessThan(senderBefore);

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.settlement_recovered");
    expect(actions).toContain("payout.ledger_credit");
    expect(actions).not.toContain("payment.status.compensation_pending");
    expect(actions).not.toContain("payment.compensation_transfer");

    // The recovered payment is a normal settlement: reservation consumed, one
    // ledger credit, lease released.
    const reservation = await prisma.liquidityReservation.findUnique({ where: { paymentId: payment.id } });
    expect(reservation?.status).toBe("CONSUMED");
    expect(await prisma.ledgerCredit.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(result.executionLeaseId).toBeNull();
  });
});

describe("compensation reconciliation — an unreadable escrow at a settled status still compensates", () => {
  it("compensates (not FAILs) when the payout throws and the escrow read fails", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const payment = await createApprovedPayment({ amount: "3000.00" });

    // The payout leg throws (status is PAYOUT_PENDING, escrow already SETTLED
    // on-chain), and the reconciling escrow read also fails — an RPC flap hitting
    // both. The DB status alone proves settlement happened, so the sender must be
    // compensated; before the fix this fell through to FAILED and stranded them.
    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("payout rail down");
    };
    executorTestHooks.escrowReadFails = true;

    const result = await executePayment(payment.id);

    expect(result.status).toBe("COMPENSATED");
    expect(result.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(senderBefore);

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.status.compensation_pending");
    expect(actions).toContain("payment.compensation_transfer");
    expect(actions).not.toContain("payment.status.failed");
  });
});

describe("compensation saga — the refund path is unchanged before settlement", () => {
  it("refunds on-chain (not compensates) when the escrow is still held", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const payment = await createApprovedPayment({ amount: "1500.00" });
    executorTestHooks.beforeSettlement = () => {
      throw new Error("fx feed unavailable");
    };

    const result = await executePayment(payment.id);

    // Escrow was never released, so the contract refunds it — the compensation
    // path must not fire here or the sender would be paid twice.
    expect(result.status).toBe("REFUNDED");
    expect(await onchainPaymentState("base-local", onchainPaymentId(payment.id))).toBe("REFUNDED");
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(senderBefore);

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.onchain_refund");
    expect(actions).not.toContain("payment.status.compensation_pending");
    expect(result.compensationTxHash).toBeNull();
  });
});
