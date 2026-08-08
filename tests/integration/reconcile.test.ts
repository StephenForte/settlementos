// R1 — operator re-reconcile: re-read chain evidence, advance only on conclusive
// outcomes, never broadcast. Hermetic on the fixture chains.

import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  executePayment,
  executorTestHooks,
  reconcileUnresolvedPayment,
  stuckPayments,
} from "@/lib/executor";
import { POST as reconcilePOST } from "@/app/api/payments/[id]/reconcile/route";
import { API_KEY_HEADER } from "@/lib/auth";
import {
  accountsFor,
  networkContracts,
  tokenBalance,
} from "@/lib/chain";
import { verifyAuditChain } from "@/lib/audit";
import { API_KEYS } from "../fixture";
import { createApprovedPayment } from "../helpers/payments";
import type { Address } from "viem";

const senderWallet = () => accountsFor("base-local").entityWallets.ent_acme_us.address as Address;

function walletBalance(symbol: string, owner: Address): Promise<bigint> {
  return tokenBalance("base-local", networkContracts("base-local").tokens[symbol].address, owner);
}

function reconcileRequest(id: string, key: string) {
  return new NextRequest(`http://test.local/api/payments/${id}/reconcile`, {
    method: "POST",
    headers: { [API_KEY_HEADER]: key },
  });
}

const reconcile = (id: string, key: string = API_KEYS.operator) =>
  reconcilePOST(reconcileRequest(id, key), { params: Promise.resolve({ id }) });

async function assertAuditIntact(): Promise<void> {
  const result = await verifyAuditChain();
  expect(result.valid).toBe(true);
}

/** PAYOUT_PENDING with a mined destination attempt, catch forced to unknown. */
async function createUnresolvedPayout(amount = "2200.00") {
  const payment = await createApprovedPayment({
    amount,
    sourceNetwork: "base-local",
    destinationNetwork: "polygon-local",
  });
  executorTestHooks.afterDestinationPayoutSubmitted = () => {
    throw new Error("destination RPC dropped after submit");
  };
  executorTestHooks.destinationPayoutOutcome = "unknown";
  const stuck = await executePayment(payment.id);
  delete executorTestHooks.afterDestinationPayoutSubmitted;
  delete executorTestHooks.destinationPayoutOutcome;
  expect(stuck.status).toBe("PAYOUT_PENDING");
  expect(stuck.destinationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  return stuck;
}

/** COMPENSATION_PENDING with a mined compensation attempt, catch forced unknown. */
async function createUnresolvedCompensation(amount = "1400.00") {
  const payment = await createApprovedPayment({ amount });
  executorTestHooks.beforeDestinationPayout = () => {
    throw new Error("destination rail unavailable");
  };
  executorTestHooks.afterCompensationSubmitted = () => {
    throw new Error("source RPC dropped after compensation submit");
  };
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
  delete executorTestHooks.afterDestinationPayoutSubmitted;
  delete executorTestHooks.beforeDestinationPayout;
  delete executorTestHooks.afterCompensationSubmitted;
  delete executorTestHooks.beforeCompensationTransfer;
  delete executorTestHooks.destinationPayoutOutcome;
  delete executorTestHooks.compensationPayoutOutcome;
  delete executorTestHooks.escrowReadFails;
});

describe("reconcileUnresolvedPayment — conclusive evidence advances", () => {
  it("completes forward on confirmed destination evidence", async () => {
    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const stuck = await createUnresolvedPayout("2200.00");
    const short = await walletBalance("mockUSDC", senderWallet());
    expect(short).toBeLessThan(senderBefore);

    // Real chain receipt is confirmed — clear any override and re-read.
    const result = await reconcileUnresolvedPayment(stuck.id);

    expect(result.action).toBe("completed_forward");
    expect(result.outcome).toBe("confirmed");
    expect(result.payment.status).toBe("SETTLED");
    // No compensation — sender stays short (payment genuinely settled).
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(short);
    expect((await stuckPayments()).some((s) => s.payment.id === stuck.id)).toBe(false);
    await assertAuditIntact();
  });

  it("opens COMPENSATION_PENDING on reverted destination without transferring", async () => {
    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const stuck = await createUnresolvedPayout("1800.00");
    const short = await walletBalance("mockUSDC", senderWallet());
    expect(short).toBeLessThan(senderBefore);

    executorTestHooks.destinationPayoutOutcome = "reverted";
    const result = await reconcileUnresolvedPayment(stuck.id);
    delete executorTestHooks.destinationPayoutOutcome;

    expect(result.action).toBe("awaiting_compensation");
    expect(result.outcome).toBe("reverted");
    expect(result.payment.status).toBe("COMPENSATION_PENDING");
    // Re-read must not broadcast — sender still short until /repair.
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(short);
    expect(result.payment.compensationTxHash).toBeNull();
    expect((await stuckPayments()).some((s) => s.payment.id === stuck.id)).toBe(true);
    await assertAuditIntact();
  });

  it("marks COMPENSATED on confirmed compensation evidence without re-transfer", async () => {
    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const stuck = await createUnresolvedCompensation("1400.00");
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(senderBefore);

    const result = await reconcileUnresolvedPayment(stuck.id);

    expect(result.action).toBe("marked_compensated");
    expect(result.outcome).toBe("confirmed");
    expect(result.payment.status).toBe("COMPENSATED");
    expect(result.payment.compensationTxHash).toBe(stuck.compensationTxHash);
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(senderBefore);
    await assertAuditIntact();
  });
});

describe("reconcileUnresolvedPayment — unknown evidence changes nothing", () => {
  it("leaves PAYOUT_PENDING untouched and broadcasts nothing", async () => {
    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const stuck = await createUnresolvedPayout("2100.00");
    const short = await walletBalance("mockUSDC", senderWallet());

    executorTestHooks.destinationPayoutOutcome = "unknown";
    const result = await reconcileUnresolvedPayment(stuck.id);
    delete executorTestHooks.destinationPayoutOutcome;

    expect(result.action).toBe("unchanged");
    expect(result.outcome).toBe("unknown");
    expect(result.payment.status).toBe("PAYOUT_PENDING");
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(short);
    expect(short).toBeLessThan(senderBefore);
    expect((await stuckPayments()).some((s) => s.payment.id === stuck.id)).toBe(true);
    await assertAuditIntact();
  });

  it("leaves COMPENSATION_PENDING untouched and broadcasts nothing", async () => {
    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const stuck = await createUnresolvedCompensation("1250.00");
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(senderBefore);

    executorTestHooks.compensationPayoutOutcome = "unknown";
    const result = await reconcileUnresolvedPayment(stuck.id);
    delete executorTestHooks.compensationPayoutOutcome;

    expect(result.action).toBe("unchanged");
    expect(result.outcome).toBe("unknown");
    expect(result.payment.status).toBe("COMPENSATION_PENDING");
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(senderBefore);
    expect((await stuckPayments()).some((s) => s.payment.id === stuck.id)).toBe(true);
    await assertAuditIntact();
  });
});

describe("POST /api/payments/[id]/reconcile", () => {
  it("is OPERATOR-only and hides unknown ids", async () => {
    const stuck = await createUnresolvedPayout("1600.00");

    expect((await reconcile(stuck.id, API_KEYS.entities.ent_acme_us)).status).toBe(403);
    expect(
      (
        await reconcilePOST(
          new NextRequest(`http://test.local/api/payments/${stuck.id}/reconcile`, {
            method: "POST",
          }),
          { params: Promise.resolve({ id: stuck.id }) }
        )
      ).status
    ).toBe(401);
    expect((await reconcile("pay_does_not_exist")).status).toBe(404);

    // Rejected callers moved nothing.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe(
      "PAYOUT_PENDING"
    );
  });

  it("returns outcome and action on conclusive evidence", async () => {
    const stuck = await createUnresolvedCompensation("1150.00");
    const res = await reconcile(stuck.id);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      payment_id: stuck.id,
      status: "COMPENSATED",
      outcome: "confirmed",
      action: "marked_compensated",
    });
    expect(body.compensation_transaction_hash).toBe(stuck.compensationTxHash);
  });

  it("admits exactly one concurrent reconcile when two fire at once", async () => {
    const stuck = await createUnresolvedCompensation("1050.00");
    const senderBefore = await walletBalance("mockUSDC", senderWallet());

    const [a, b] = await Promise.all([reconcile(stuck.id), reconcile(stuck.id)]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([200, 409]);
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(senderBefore);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe(
      "COMPENSATED"
    );

    const winner = a.status === 200 ? await a.json() : await b.json();
    expect(winner.action).toBe("marked_compensated");
    await assertAuditIntact();
  });
});
