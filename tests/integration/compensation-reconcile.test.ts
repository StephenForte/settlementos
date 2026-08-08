// T5-2 / T6 — compensation transfer receipt-loss double-pay window.
// Mirrors T4's destination-leg submit/confirm seam on the treasury→sender
// make-good. Hermetic on the fixture chains.

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
  tokenBalance,
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

/**
 * Drive a payment into COMPENSATION_PENDING with a mined compensation attempt
 * whose receipt was "lost" (forced unknown on the same-process catch reconcile).
 * Clears hooks before returning so the caller controls the next move.
 */
async function createCompensationAttemptPending(amount = "1500.00") {
  const payment = await createApprovedPayment({ amount });
  executorTestHooks.beforeDestinationPayout = () => {
    throw new Error("destination rail unavailable");
  };
  executorTestHooks.afterCompensationSubmitted = () => {
    throw new Error("source RPC dropped after compensation submit");
  };
  // Force the same-process catch reconcile to leave the attempt unresolved so
  // we can exercise repair / operator re-reconcile — without this the local
  // chain's readable receipt would complete forward in the same call.
  executorTestHooks.compensationPayoutOutcome = "unknown";

  const stuck = await executePayment(payment.id);
  delete executorTestHooks.beforeDestinationPayout;
  delete executorTestHooks.afterCompensationSubmitted;
  delete executorTestHooks.compensationPayoutOutcome;

  expect(stuck.status).toBe("COMPENSATION_PENDING");
  expect(stuck.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  return stuck;
}

afterEach(() => {
  delete executorTestHooks.beforeDestinationPayout;
  delete executorTestHooks.beforeCompensationTransfer;
  delete executorTestHooks.afterCompensationSubmitted;
  delete executorTestHooks.beforeCompensationTxHashPersist;
  delete executorTestHooks.compensationPayoutOutcome;
  delete executorTestHooks.destinationPayoutOutcome;
  delete executorTestHooks.escrowReadFails;
});

describe("T5-2 — compensation receipt loss after mine", () => {
  it("pays the sender exactly once when the compensation receipt is lost and repair runs", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const stuck = await createCompensationAttemptPending("1500.00");

    // First transfer mined — sender is already whole even though status is pending.
    const afterFirst = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    expect(afterFirst).toBe(senderBefore);

    // Repair must reconcile the attempt hash, not broadcast a second transfer.
    const repaired = await repairCompensation(stuck.id);
    expect(repaired.status).toBe("COMPENSATED");
    expect(repaired.compensationTxHash).toBe(stuck.compensationTxHash);

    const afterRepair = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    // Property: sender paid exactly ONCE. Double-pay would leave them above
    // senderBefore by the escrowed amount.
    expect(afterRepair).toBe(senderBefore);

    const actions = await auditActions(stuck.id);
    expect(actions).toContain("payment.compensation_submitted");
    expect(actions).toContain("payment.compensation_recovered");
    // No second broadcast — confirmation audit only lands on the happy confirm() path.
    expect(actions.filter((a) => a === "payment.compensation_transfer")).toHaveLength(0);
    expect(actions.filter((a) => a === "payment.compensation_submitted")).toHaveLength(1);

    const listed = await stuckPayments();
    expect(listed.some((s) => s.payment.id === stuck.id)).toBe(false);
    await assertAuditIntact();
  });

  it("completes forward in-process when the receipt is readable after submit throws", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const payment = await createApprovedPayment({ amount: "1100.00" });

    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("destination rail unavailable");
    };
    executorTestHooks.afterCompensationSubmitted = () => {
      throw new Error("source RPC dropped after compensation submit");
    };
    // No outcome override — local chain receipt is readable; catch must complete.

    const result = await executePayment(payment.id);

    expect(result.status).toBe("COMPENSATED");
    expect(result.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(
      senderBefore
    );

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.compensation_submitted");
    expect(actions).toContain("payment.compensation_recovered");
    expect(actions.filter((a) => a === "payment.compensation_transfer")).toHaveLength(0);
    await assertAuditIntact();
  });

  it("retries a reverted compensation attempt and succeeds exactly once", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const payment = await createApprovedPayment({ amount: "900.00" });

    // Never submit on the first compensation attempt — strand with a synthetic
    // reverted hash so repair sees reverted → fresh transfer is correct.
    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("destination rail unavailable");
    };
    executorTestHooks.beforeCompensationTransfer = () => {
      throw new Error("treasury signer unavailable");
    };
    const stuck = await executePayment(payment.id);
    delete executorTestHooks.beforeDestinationPayout;
    delete executorTestHooks.beforeCompensationTransfer;
    expect(stuck.status).toBe("COMPENSATION_PENDING");
    expect(stuck.compensationTxHash).toBeNull();

    const short = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    expect(short).toBeLessThan(senderBefore);

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        compensationTxHash:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
    });
    executorTestHooks.compensationPayoutOutcome = "reverted";

    // First repair call: outcome is reverted, so a fresh transfer should run.
    // Clear the override inside beforeCompensationTransfer so the new attempt's
    // confirm path is not forced-reverted.
    executorTestHooks.beforeCompensationTransfer = () => {
      delete executorTestHooks.compensationPayoutOutcome;
    };

    const repaired = await repairCompensation(payment.id);
    expect(repaired.status).toBe("COMPENSATED");
    expect(repaired.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(repaired.compensationTxHash).not.toBe(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    );
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(
      senderBefore
    );

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.compensation_submitted");
    expect(actions).toContain("payment.compensation_transfer");
    expect(actions.filter((a) => a === "payment.compensation_transfer")).toHaveLength(1);
    await assertAuditIntact();
  });

  it("moves no money on unknown compensation outcome and stays visible in stuckPayments", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const stuck = await createCompensationAttemptPending("1300.00");
    const afterAttempt = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    expect(afterAttempt).toBe(senderBefore);

    executorTestHooks.compensationPayoutOutcome = "unknown";
    await expect(repairCompensation(stuck.id)).rejects.toThrow(/outcome unresolved/);

    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(
      afterAttempt
    );
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.status).toBe("COMPENSATION_PENDING");
    expect(row.compensationTxHash).toBe(stuck.compensationTxHash);

    const listed = await stuckPayments();
    expect(listed.some((s) => s.payment.id === stuck.id)).toBe(true);

    const actions = await auditActions(stuck.id);
    expect(actions).toContain("payment.compensation_unresolved");
    expect(actions.filter((a) => a === "payment.compensation_transfer")).toHaveLength(0);
    await assertAuditIntact();
  });

  it("completes when compensationTxHash persist fails after broadcast (T5-3 mirror)", async () => {
    const senderBefore = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    const payment = await createApprovedPayment({ amount: "1000.00" });

    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("destination rail unavailable");
    };
    executorTestHooks.beforeCompensationTxHashPersist = () => {
      throw new Error("db unavailable writing compensationTxHash");
    };

    const result = await executePayment(payment.id);

    expect(result.status).toBe("COMPENSATED");
    expect(result.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await walletBalance("base-local", "mockUSDC", senderWallet("base-local"))).toBe(
      senderBefore
    );

    const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(persisted.compensationTxHash).toBe(result.compensationTxHash);

    const actions = await auditActions(payment.id);
    expect(actions).toContain("payment.compensation_recovered");
    expect(actions).not.toContain("payment.compensation_submitted");
    await assertAuditIntact();
  });
});
