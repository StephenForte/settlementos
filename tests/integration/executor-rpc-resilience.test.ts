// ForteL2 RPC resilience: destination payout receipt loss (T1-1) and
// network-aware replica-lag retries (T1-2). Hermetic on the fixture chains —
// CI never depends on a live ForteL2 stack.

import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import {
  executePayment,
  executorTestHooks,
  repairCompensation,
  stuckPayments,
} from "@/lib/executor";
import {
  accountsFor,
  networkContracts,
  replicaLagRetries,
  tokenBalance,
  transactionOutcome,
} from "@/lib/chain";
import { verifyAuditChain } from "@/lib/audit";
import { createApprovedPayment } from "../helpers/payments";
import type { Address } from "viem";

const senderWallet = (networkId: string) =>
  accountsFor(networkId).entityWallets.ent_acme_us.address as Address;

function walletBalance(networkId: string, symbol: string, owner: Address): Promise<bigint> {
  return tokenBalance(networkId, networkContracts(networkId).tokens[symbol].address, owner);
}

async function auditActions(paymentId: string): Promise<string[]> {
  const events = await prisma.auditEvent.findMany({ where: { paymentId }, orderBy: { id: "asc" } });
  return events.map((e) => e.action);
}

async function assertAuditIntact(): Promise<void> {
  const result = await verifyAuditChain();
  expect(result.valid).toBe(true);
}

afterEach(() => {
  delete executorTestHooks.beforeDestinationPayout;
  delete executorTestHooks.beforeDestinationTxHashPersist;
  delete executorTestHooks.afterDestinationPayoutSubmitted;
  delete executorTestHooks.afterDestinationPayout;
  delete executorTestHooks.afterLedgerCredit;
  delete executorTestHooks.beforeCompensationTransfer;
  delete executorTestHooks.escrowReadFails;
  delete executorTestHooks.destinationPayoutOutcome;
});

describe("T1-1 — destination payout receipt loss after mine", () => {
  it("completes forward when the receipt is lost after the payout mined", async () => {
    const recipient = accountsFor("polygon-local").entityWallets.ent_tokyo_supplier.address as Address;
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const recipientJpyBefore = await walletBalance("polygon-local", "mockJPY", recipient);

    const payment = await createApprovedPayment({
      amount: "5000.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    // Simulate RPC drop after writeContract returns but before confirm() — the
    // tx still mines on the local destination chain.
    executorTestHooks.afterDestinationPayoutSubmitted = () => {
      throw new Error("destination RPC dropped after submit");
    };

    const result = await executePayment(payment.id);

    expect(result.status).toBe("SETTLED");
    expect(result.destinationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.compensationTxHash).toBeNull();

    // Recipient keeps the payout; sender is not compensated.
    expect(await walletBalance("polygon-local", "mockJPY", recipient)).toBeGreaterThan(recipientJpyBefore);
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBeLessThan(senderBefore);

    const actions = await auditActions(payment.id);
    expect(actions).toContain("bridge.destination_payout_submitted");
    expect(actions).toContain("payment.settlement_recovered");
    expect(actions).not.toContain("bridge.destination_payout");
    expect(actions).not.toContain("payment.compensation_transfer");

    const reservation = await prisma.liquidityReservation.findUnique({ where: { paymentId: payment.id } });
    expect(reservation?.status).toBe("CONSUMED");
    await assertAuditIntact();
  });

  it("compensates exactly once when the payout leg never runs", async () => {
    const recipient = accountsFor("polygon-local").entityWallets.ent_tokyo_supplier.address as Address;
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const recipientJpyBefore = await walletBalance("polygon-local", "mockJPY", recipient);

    const payment = await createApprovedPayment({
      amount: "3000.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("destination rail unavailable before submit");
    };

    const result = await executePayment(payment.id);

    expect(result.status).toBe("COMPENSATED");
    expect(result.destinationTxHash).toBeNull();
    expect(result.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(senderBefore);
    expect(await walletBalance("polygon-local", "mockJPY", recipient)).toBe(recipientJpyBefore);

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.compensation_transfer");
    expect(actions.filter((a) => a === "payment.compensation_transfer")).toHaveLength(1);
    expect(await prisma.ledgerCredit.count({ where: { paymentId: payment.id } })).toBe(0);
    await assertAuditIntact();
  });

  it("compensates when a submitted payout reverted on the destination chain", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));

    const payment = await createApprovedPayment({
      amount: "3000.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    executorTestHooks.afterDestinationPayoutSubmitted = () => {
      throw new Error("destination RPC dropped after submit");
    };
    executorTestHooks.destinationPayoutOutcome = "reverted";

    const result = await executePayment(payment.id);

    expect(result.status).toBe("COMPENSATED");
    expect(result.destinationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(senderBefore);

    const actions = await auditActions(payment.id);
    expect(actions).toContain("bridge.destination_payout_submitted");
    expect(actions.filter((a) => a === "payment.compensation_transfer")).toHaveLength(1);
    await assertAuditIntact();
  });

  it("leaves the payment non-terminal when the destination chain is unreadable", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));

    const payment = await createApprovedPayment({
      amount: "4000.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    executorTestHooks.afterDestinationPayoutSubmitted = () => {
      throw new Error("destination RPC dropped after submit");
    };
    executorTestHooks.destinationPayoutOutcome = "unknown";

    const result = await executePayment(payment.id);

    expect(result.status).toBe("PAYOUT_PENDING");
    expect(result.destinationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.compensationTxHash).toBeNull();

    // No compensation — sender stays short of a refund, recipient may or may not
    // have tokens depending on whether the attempt actually mined (unknown here).
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBeLessThan(senderBefore);

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.destination_payout_unresolved");
    expect(actions).not.toContain("payment.compensation_transfer");

    const reservation = await prisma.liquidityReservation.findUnique({ where: { paymentId: payment.id } });
    expect(reservation?.status).toBe("RESERVED");

    const listed = await stuckPayments();
    expect(listed.some((s) => s.payment.id === payment.id)).toBe(true);
    await assertAuditIntact();
  });

  it("repairCompensation refuses to double-pay when the destination receipt is confirmed", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));

    const payment = await createApprovedPayment({
      amount: "4500.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    executorTestHooks.afterDestinationPayoutSubmitted = () => {
      throw new Error("destination RPC dropped after submit");
    };

    const settled = await executePayment(payment.id);
    expect(settled.status).toBe("SETTLED");

    // Case (a) already settled forward — repair must not move money again.
    await expect(repairCompensation(payment.id)).rejects.toThrow(/cannot be repaired from status SETTLED/);
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBeLessThan(senderBefore);

    const actions = await auditActions(payment.id);
    expect(actions.filter((a) => a === "payment.compensation_transfer")).toHaveLength(0);
    await assertAuditIntact();
  });

  it("repairCompensation refuses compensation when destination payout is confirmed on a misclassified row", async () => {
    const payment = await createApprovedPayment({
      amount: "3500.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("payout failed");
    };
    executorTestHooks.beforeCompensationTransfer = () => {
      throw new Error("treasury signer unavailable");
    };
    const stuck = await executePayment(payment.id);
    delete executorTestHooks.beforeDestinationPayout;
    delete executorTestHooks.beforeCompensationTransfer;
    expect(stuck.status).toBe("COMPENSATION_PENDING");

    // Simulate a row that reached COMPENSATION_PENDING while the destination
    // payout actually landed — repair must refuse, not pay the sender again.
    await prisma.payment.update({
      where: { id: payment.id },
      data: { destinationTxHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    });
    executorTestHooks.destinationPayoutOutcome = "confirmed";

    await expect(repairCompensation(payment.id)).rejects.toThrow(/destination payout already confirmed/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "COMPENSATION_PENDING"
    );
    await assertAuditIntact();
  });

  it("repairCompensation refuses when destination payout outcome is unknown", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));

    const payment = await createApprovedPayment({
      amount: "3200.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("payout failed");
    };
    executorTestHooks.beforeCompensationTransfer = () => {
      throw new Error("treasury signer unavailable");
    };
    const stuck = await executePayment(payment.id);
    delete executorTestHooks.beforeDestinationPayout;
    delete executorTestHooks.beforeCompensationTransfer;
    expect(stuck.status).toBe("COMPENSATION_PENDING");
    const short = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    expect(short).toBeLessThan(senderBefore);

    await prisma.payment.update({
      where: { id: payment.id },
      data: { destinationTxHash: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef" },
    });
    executorTestHooks.destinationPayoutOutcome = "unknown";

    // Unknown must move no money — repairing would risk paying the sender while
    // a still-unreadable destination attempt might yet confirm.
    await expect(repairCompensation(payment.id)).rejects.toThrow(/outcome unresolved/);
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(short);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "COMPENSATION_PENDING"
    );
    await assertAuditIntact();
  });

  it("completes forward when destinationTxHash persist fails after broadcast (T5-3)", async () => {
    const recipient = accountsFor("polygon-local").entityWallets.ent_tokyo_supplier.address as Address;
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const recipientJpyBefore = await walletBalance("polygon-local", "mockJPY", recipient);

    const payment = await createApprovedPayment({
      amount: "2800.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    // Hash is known in memory; DB write never lands. Catch must still reconcile
    // the mined destination payout instead of compensating the sender.
    executorTestHooks.beforeDestinationTxHashPersist = () => {
      throw new Error("db unavailable writing destinationTxHash");
    };

    const result = await executePayment(payment.id);

    expect(result.status).toBe("SETTLED");
    expect(result.compensationTxHash).toBeNull();
    expect(await walletBalance("polygon-local", "mockJPY", recipient)).toBeGreaterThan(recipientJpyBefore);
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBeLessThan(
      senderBefore
    );

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.settlement_recovered");
    expect(actions).not.toContain("payment.compensation_transfer");
    await assertAuditIntact();
  });

  it("lists hash-less PAYOUT_PENDING in stuckPayments (T5-4)", async () => {
    const payment = await createApprovedPayment({
      amount: "2100.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });

    // Process death between PAYOUT_PENDING and hash persist: escrow released,
    // no destinationTxHash. Must stay visible — T4's hash-gated candidacy hid it.
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "PAYOUT_PENDING", destinationTxHash: null },
    });
    await prisma.liquidityReservation.create({
      data: {
        paymentId: payment.id,
        network: "polygon-local",
        asset: "mockJPY",
        amount: "1000",
        status: "RESERVED",
      },
    });

    const listed = await stuckPayments();
    expect(listed.some((s) => s.payment.id === payment.id)).toBe(true);
  });
});

describe("R4 — transactionOutcome missing-receipt mapping", () => {
  it("maps a missing receipt (viem throw) to unknown, not absent", async () => {
    // viem throws TransactionReceiptNotFoundError rather than returning null.
    // Mapping that throw to "absent" would reintroduce the T1-1 double-pay:
    // catch compensates on absent while a mempool tx may still mine.
    const outcome = await transactionOutcome(
      "base-local",
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    );
    expect(outcome).toBe("unknown");
    expect(outcome).not.toBe("absent");
  });
});

describe("T1-2 — network-aware replica-lag retries", () => {
  it("skips replica-lag retries on ForteL2 and local chains", () => {
    expect(replicaLagRetries("fortel2-sepolia")).toBe(0);
    expect(replicaLagRetries("fortel2-local")).toBe(0);
    expect(replicaLagRetries("base-local")).toBe(0);
    expect(replicaLagRetries("polygon-local")).toBe(0);
  });

  it("retains replica-lag retries on live public testnets", () => {
    expect(replicaLagRetries("base-sepolia")).toBe(4);
    expect(replicaLagRetries("polygon-amoy")).toBe(4);
  });
});
