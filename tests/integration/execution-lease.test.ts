// The per-payment execution lease (US-007): one attempt per payment, claimed
// before anything touches a chain. Two concurrent executes must not both escrow
// — the money leg is the one place a lost race cannot be undone by a DB rollback.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as executePOST } from "@/app/api/payments/[id]/execute/route";
import { prisma } from "@/lib/db";
import { executePayment } from "@/lib/executor";
import { accountsFor, tokenBalance, networkContracts } from "@/lib/chain";
import { toBaseUnits } from "@/lib/assets";
import { API_KEY_HEADER } from "@/lib/auth";
import { API_KEYS } from "../fixture";
import { createApprovedPayment } from "../helpers/payments";
import type { Address } from "viem";

async function treasuryUsdc(networkId: string): Promise<bigint> {
  const contracts = networkContracts(networkId);
  return tokenBalance(
    networkId,
    contracts.tokens.mockUSDC.address,
    accountsFor(networkId).treasury.address as Address
  );
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

function executeRequest(id: string, key: string) {
  return new NextRequest(`http://test.local/api/payments/${id}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", [API_KEY_HEADER]: key },
    body: "{}",
    ...({ duplex: "half" } as object),
  });
}

describe("execution lease", () => {
  it("lets exactly one of two concurrent executes escrow, and only once on-chain", async () => {
    const amount = "100000.00";
    const treasuryBefore = await treasuryUsdc("base-local");
    const payment = await createApprovedPayment({ amount });

    const results = await Promise.allSettled([executePayment(payment.id), executePayment(payment.id)]);

    const settled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(settled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      name: "ExecutionLeaseError",
      code: "conflict",
    });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("SETTLED");

    // The on-chain proof: escrow released exactly one payment's USDC to the
    // treasury. A second escrow would have moved it twice.
    const treasuryAfter = await treasuryUsdc("base-local");
    expect(treasuryAfter - treasuryBefore).toBe(toBaseUnits(amount, 6));

    // One escrow tx, one reservation, one ledger credit — the loser left nothing.
    const escrowEvents = await prisma.auditEvent.findMany({
      where: { paymentId: payment.id, action: "payment.status.submitted_onchain" },
    });
    expect(escrowEvents).toHaveLength(1);
    expect(await prisma.ledgerCredit.count({ where: { paymentId: payment.id } })).toBe(1);
    const reservation = await prisma.liquidityReservation.findUnique({
      where: { paymentId: payment.id },
    });
    expect(reservation?.status).toBe("CONSUMED");
  });

  it("answers the losing concurrent execute request with 409 conflict", async () => {
    const payment = await createApprovedPayment({ amount: "10000.00" });

    const [a, b] = await Promise.all([
      executePOST(executeRequest(payment.id, API_KEYS.operator), routeParams(payment.id)),
      executePOST(executeRequest(payment.id, API_KEYS.operator), routeParams(payment.id)),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    // A conflict, not an execution_failed: nothing was attempted, let alone failed.
    expect(await loser.json()).toMatchObject({ error_code: "conflict" });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      status: "SETTLED",
    });
  });

  it("releases the lease at SETTLED so the row is not left locked", async () => {
    const payment = await createApprovedPayment({ amount: "10000.00" });
    await executePayment(payment.id);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("SETTLED");
    expect(after.executionLeaseId).toBeNull();
    expect(after.leasedAt).toBeNull();
  });

  it("releases the lease at FAILED so an operator retry stays possible", async () => {
    // $800k → ~125M JPY, past the treasury's 100M mockJPY: fails before escrow.
    const payment = await createApprovedPayment({ amount: "800000.00" });
    await expect(executePayment(payment.id)).rejects.toThrow(/Insufficient mockJPY liquidity/);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("FAILED");
    expect(after.executionLeaseId).toBeNull();
    expect(after.leasedAt).toBeNull();
  });

  it("releases the lease when execution throws before reaching any transition", async () => {
    // No quote → selectedRoute throws during setup, long before a status moves.
    const payment = await createApprovedPayment({ amount: "10000.00" });
    await prisma.payment.update({ where: { id: payment.id }, data: { quoteJson: null } });

    await expect(executePayment(payment.id)).rejects.toThrow(/no quote/);

    // Still APPROVED, so nothing cleared the lease on its behalf — the executor's
    // own backstop has to, or the payment is locked out of execution forever.
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("APPROVED");
    expect(after.executionLeaseId).toBeNull();
  });

  it("refuses to execute a payment whose lease is already held", async () => {
    const payment = await createApprovedPayment({ amount: "10000.00" });
    await prisma.payment.update({
      where: { id: payment.id },
      data: { executionLeaseId: "lease_held_by_someone_else", leasedAt: new Date() },
    });

    await expect(executePayment(payment.id)).rejects.toMatchObject({ name: "ExecutionLeaseError" });

    // The intruder's lease survives: a losing attempt must not free a lease it
    // does not own.
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.executionLeaseId).toBe("lease_held_by_someone_else");
    expect(after.status).toBe("APPROVED");
  });
});
