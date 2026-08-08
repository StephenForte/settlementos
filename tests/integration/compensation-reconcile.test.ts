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
import { createApprovedPayment } from "../helpers/payments";
import type { Address } from "viem";

const senderWallet = (networkId: string) =>
  accountsFor(networkId).entityWallets.ent_acme_us.address as Address;

function walletBalance(networkId: string, symbol: string, owner: Address): Promise<bigint> {
  return tokenBalance(networkId, networkContracts(networkId).tokens[symbol].address, owner);
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
    const payment = await createApprovedPayment({ amount: "1500.00" });

    // Destination fails after escrow release → compensation path. Then drop the
    // RPC after writeContract returns but before confirm() — the transfer still
    // mines on the local source chain.
    executorTestHooks.beforeDestinationPayout = () => {
      throw new Error("destination rail unavailable");
    };
    executorTestHooks.afterCompensationSubmitted = () => {
      throw new Error("source RPC dropped after compensation submit");
    };

    const stuck = await executePayment(payment.id);
    delete executorTestHooks.beforeDestinationPayout;
    delete executorTestHooks.afterCompensationSubmitted;

    expect(stuck.status).toBe("COMPENSATION_PENDING");
    // Pre-fix: hash was never persisted (only written on COMPENSATED). With the
    // bug, repair has no attempt to reconcile and pays again.
    const afterFirst = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    // First transfer mined — sender is already whole even though status is pending.
    expect(afterFirst).toBe(senderBefore);

    await repairCompensation(payment.id);

    const afterRepair = await walletBalance("base-local", "mockUSDC", senderWallet("base-local"));
    // Property: sender paid exactly ONCE. Double-pay would leave them above
    // senderBefore by the escrowed amount.
    expect(afterRepair).toBe(senderBefore);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe("COMPENSATED");
    expect(row.compensationTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    const listed = await stuckPayments();
    expect(listed.some((s) => s.payment.id === payment.id)).toBe(false);
  });
});
