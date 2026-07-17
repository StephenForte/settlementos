// Operator repair of partial settlements (US-010): the stuck list and the
// endpoint that finishes a compensation whose transfer failed.
//
// A payment reaches COMPENSATION_PENDING here the only way it can — the executor's
// test hooks fail the payout leg after the escrow is released, then fail the
// compensation transfer itself, leaving the sender genuinely short with the escrow
// really SETTLED on-chain. Payments are never deleted: their events are audited,
// and deleting an audited payment breaks the hash chain (AGENTS.md gotcha).

import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { executePayment, executorTestHooks, stuckPayments } from "@/lib/executor";
import { GET as paymentsGET } from "@/app/api/payments/route";
import { POST as repairPOST } from "@/app/api/payments/[id]/repair/route";
import { API_KEY_HEADER } from "@/lib/auth";
import {
  accountsFor,
  networkContracts,
  onchainPaymentId,
  onchainPaymentState,
  operatorWrite,
  tokenBalance,
} from "@/lib/chain";
import { API_KEYS } from "../fixture";
import { createApprovedPayment } from "../helpers/payments";
import type { Address } from "viem";

const senderWallet = () => accountsFor("base-local").entityWallets.ent_acme_us.address as Address;

function walletBalance(symbol: string, owner: Address): Promise<bigint> {
  return tokenBalance("base-local", networkContracts("base-local").tokens[symbol].address, owner);
}

function repairRequest(id: string, key: string) {
  return new NextRequest(`http://test.local/api/payments/${id}/repair`, {
    method: "POST",
    headers: { [API_KEY_HEADER]: key },
  });
}

const repair = (id: string, key: string = API_KEYS.operator) =>
  repairPOST(repairRequest(id, key), { params: Promise.resolve({ id }) });

function stuckRequest(key: string) {
  return new NextRequest("http://test.local/api/payments?stuck=true", {
    headers: { [API_KEY_HEADER]: key },
  });
}

/**
 * Run a payment into COMPENSATION_PENDING: settled on-chain, payout failed,
 * compensation transfer failed. The hooks are cleared before returning so the
 * repair under test runs for real.
 */
async function createStuckPayment(amount = "1200.00") {
  const payment = await createApprovedPayment({ amount });
  executorTestHooks.beforeDestinationPayout = () => {
    throw new Error("destination rail unavailable");
  };
  executorTestHooks.beforeCompensationTransfer = () => {
    throw new Error("treasury signer unavailable");
  };
  const result = await executePayment(payment.id);
  delete executorTestHooks.beforeDestinationPayout;
  delete executorTestHooks.beforeCompensationTransfer;

  // Precondition of every test below — assert it rather than assume it.
  expect(result.status).toBe("COMPENSATION_PENDING");
  return result;
}

afterEach(() => {
  delete executorTestHooks.beforeSettlement;
  delete executorTestHooks.beforeDestinationPayout;
  delete executorTestHooks.beforeCompensationTransfer;
  delete executorTestHooks.beforeRefund;
  delete executorTestHooks.escrowReadFails;
});

describe("POST /api/payments/[id]/repair", () => {
  it("finishes the compensation and makes the sender whole", async () => {
    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const stuck = await createStuckPayment("1200.00");

    // The sender really is short at this point: escrow released, nothing returned.
    const escrowed = await walletBalance("mockUSDC", senderWallet());
    expect(escrowed).toBeLessThan(senderBefore);
    expect(await onchainPaymentState("base-local", onchainPaymentId(stuck.id))).toBe("SETTLED");

    const res = await repair(stuck.id);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("COMPENSATED");
    expect(body.compensation_transaction_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(senderBefore);

    const repaired = await prisma.payment.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(repaired.status).toBe("COMPENSATED");
    // The repair must not hold the payment hostage if it is ever needed again.
    expect(repaired.executionLeaseId).toBeNull();
  });

  it("is idempotent: repairing a COMPENSATED payment pays nothing a second time", async () => {
    const stuck = await createStuckPayment("800.00");
    await repair(stuck.id);
    const afterFirst = await walletBalance("mockUSDC", senderWallet());

    const res = await repair(stuck.id);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("COMPENSATED");
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(afterFirst);
    // One transfer, one COMPENSATED transition — the replay wrote no new history.
    const actions = await prisma.auditEvent.count({
      where: { paymentId: stuck.id, action: "payment.compensation_transfer" },
    });
    expect(actions).toBe(1);
  });

  it("refuses a payment that is not awaiting compensation", async () => {
    const settled = await createApprovedPayment({ amount: "300.00" });
    await executePayment(settled.id);

    const res = await repair(settled.id);

    expect(res.status).toBe(409);
    expect((await res.json()).error_code).toBe("conflict");
  });

  it("refuses to pay when the escrow read fails — unknown is not SETTLED", async () => {
    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const stuck = await createStuckPayment("500.00");
    const short = await walletBalance("mockUSDC", senderWallet());
    expect(short).toBeLessThan(senderBefore);

    executorTestHooks.escrowReadFails = true;
    const res = await repair(stuck.id);
    delete executorTestHooks.escrowReadFails;

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error_code: "conflict",
      message: expect.stringMatching(/unreachable/i),
    });
    // No second transfer on a failed read — the sender stays short until a
    // real repair confirms the escrow is SETTLED.
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(short);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe(
      "COMPENSATION_PENDING"
    );

    await repair(stuck.id); // leave the fixture treasury whole
  });

  it("refuses to pay when the escrow was never released", async () => {
    // COMPENSATION_PENDING without a settled escrow — the DB status alone must
    // not authorize a treasury-funded transfer.
    const payment = await createApprovedPayment({ amount: "275.00" });
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "COMPENSATION_PENDING", failureReason: "synthetic — escrow never released" },
    });
    expect(await onchainPaymentState("base-local", onchainPaymentId(payment.id))).toBe("NONE");

    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const res = await repair(payment.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error_code: "conflict",
      message: expect.stringMatching(/not owed compensation/i),
    });
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(senderBefore);

    // Drop out of COMPENSATION_PENDING so stuckPayments does not keep listing it.
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
  });

  it("is OPERATOR-only, and hides unknown ids the same way the read routes do", async () => {
    const stuck = await createStuckPayment("400.00");

    const asEntity = await repair(stuck.id, API_KEYS.entities.ent_acme_us);
    expect(asEntity.status).toBe(403);

    const anonymous = await repairPOST(
      new NextRequest(`http://test.local/api/payments/${stuck.id}/repair`, { method: "POST" }),
      { params: Promise.resolve({ id: stuck.id }) }
    );
    expect(anonymous.status).toBe(401);

    const missing = await repair("pay_does_not_exist");
    expect(missing.status).toBe(404);

    // Still stuck: neither rejected caller moved a token.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe(
      "COMPENSATION_PENDING"
    );
    await repair(stuck.id); // leave the fixture treasury whole
  });
});

describe("GET /api/payments?stuck=true", () => {
  it("lists a stranded payment with its live escrow state, and drops it once repaired", async () => {
    const stuck = await createStuckPayment("900.00");

    const listed = await stuckPayments();
    const mine = listed.find((s) => s.payment.id === stuck.id);
    expect(mine).toBeDefined();
    expect(mine!.escrowState).toBe("SETTLED");

    const res = await paymentsGET(stuckRequest(API_KEYS.operator));
    const body = await res.json();
    expect(res.status).toBe(200);
    const row = body.payments.find((p: { id: string }) => p.id === stuck.id);
    expect(row).toMatchObject({ status: "COMPENSATION_PENDING", escrow_state: "SETTLED" });
    // OPERATOR detail is not scrubbed on this view — it is why the row is here.
    expect(row.failureReason).toContain("destination rail unavailable");

    await repair(stuck.id);

    const after = await stuckPayments();
    expect(after.find((s) => s.payment.id === stuck.id)).toBeUndefined();
  });

  it("excludes payments that settled or refunded cleanly", async () => {
    const settled = await createApprovedPayment({ amount: "250.00" });
    await executePayment(settled.id);

    const refunded = await createApprovedPayment({ amount: "350.00" });
    executorTestHooks.beforeSettlement = () => {
      throw new Error("fx feed unavailable");
    };
    const refundResult = await executePayment(refunded.id);
    delete executorTestHooks.beforeSettlement;
    expect(refundResult.status).toBe("REFUNDED");

    const listed = (await stuckPayments()).map((s) => s.payment.id);
    expect(listed).not.toContain(settled.id);
    expect(listed).not.toContain(refunded.id);
  });

  it("is OPERATOR-only — a reviewer that may read every payment may not read this view", async () => {
    expect((await paymentsGET(stuckRequest(API_KEYS.reviewer))).status).toBe(403);
    expect((await paymentsGET(stuckRequest(API_KEYS.entities.ent_acme_us))).status).toBe(403);
    expect(
      (await paymentsGET(new NextRequest("http://test.local/api/payments?stuck=true"))).status
    ).toBe(401);
  });
});

describe("repair concurrency", () => {
  it("admits exactly one repair when two fire at once", async () => {
    const senderBefore = await walletBalance("mockUSDC", senderWallet());
    const stuck = await createStuckPayment("700.00");

    const [a, b] = await Promise.all([repair(stuck.id), repair(stuck.id)]);
    const statuses = [a.status, b.status].sort();

    // The loser 409s on the lease rather than sending a second transfer.
    expect(statuses).toEqual([200, 409]);
    // Exactly one compensation: the sender is whole, not paid twice.
    expect(await walletBalance("mockUSDC", senderWallet())).toBe(senderBefore);
    expect(
      await prisma.auditEvent.count({
        where: { paymentId: stuck.id, action: "payment.compensation_transfer" },
      })
    ).toBe(1);
  });
});

describe("stuck detection reads the chain, not just the DB", () => {
  it("lists a FAILED payment whose escrow is still held, and drops it once refunded", async () => {
    // The state the DB alone cannot describe: the refund leg threw, so the row
    // says FAILED while the sender's funds are still locked in escrow.
    const payment = await createApprovedPayment({ amount: "600.00" });
    executorTestHooks.beforeSettlement = () => {
      throw new Error("fx feed unavailable");
    };
    executorTestHooks.beforeRefund = () => {
      throw new Error("operator signer unavailable");
    };
    const result = await executePayment(payment.id);
    delete executorTestHooks.beforeSettlement;
    delete executorTestHooks.beforeRefund;

    expect(result.status).toBe("FAILED");
    const pid = onchainPaymentId(payment.id);
    expect(await onchainPaymentState("base-local", pid)).toBe("INITIATED");

    const listed = await stuckPayments();
    expect(listed.find((s) => s.payment.id === payment.id)?.escrowState).toBe("INITIATED");

    // Release the escrow the way an operator would, and the payment stops being
    // stuck — same row, same status, different chain facts.
    await operatorWrite("base-local", "failAndRefund", [pid, "operator repair"]);
    const after = await stuckPayments();
    expect(after.find((s) => s.payment.id === payment.id)).toBeUndefined();
  });

  it("keeps a FAILED held-escrow payment when the escrow RPC read fails", async () => {
    // Unknown ≠ fine: a flaky read must not drop the payment from the one view
    // that surfaces stranded funds. Force the read null while the escrow is
    // really INITIATED — without the null keep, the row would vanish.
    const payment = await createApprovedPayment({ amount: "625.00" });
    executorTestHooks.beforeSettlement = () => {
      throw new Error("fx feed unavailable");
    };
    executorTestHooks.beforeRefund = () => {
      throw new Error("operator signer unavailable");
    };
    await executePayment(payment.id);
    delete executorTestHooks.beforeSettlement;
    delete executorTestHooks.beforeRefund;

    const pid = onchainPaymentId(payment.id);
    expect(await onchainPaymentState("base-local", pid)).toBe("INITIATED");

    executorTestHooks.escrowReadFails = true;
    try {
      const listed = await stuckPayments();
      const mine = listed.find((s) => s.payment.id === payment.id);
      expect(mine).toBeDefined();
      expect(mine!.escrowState).toBeNull();

      const res = await paymentsGET(stuckRequest(API_KEYS.operator));
      const row = (await res.json()).payments.find((p: { id: string }) => p.id === payment.id);
      expect(row).toMatchObject({ status: "FAILED", escrow_state: null });
    } finally {
      delete executorTestHooks.escrowReadFails;
    }

    await operatorWrite("base-local", "failAndRefund", [pid, "operator repair"]);
  });

  it("lists a held-escrow FAILED payment even when onchainPaymentId was never recorded", async () => {
    // The receipt-timeout strand: the escrow tx mined but confirmation threw, so
    // the payment FAILED with onchainPaymentId still null while the funds are held.
    // The escrow id is deterministic from payment.id, so the DB column is not the
    // signal — keying the stuck query off it (the old filter) hid exactly this.
    const payment = await createApprovedPayment({ amount: "650.00" });
    executorTestHooks.beforeSettlement = () => {
      throw new Error("fx feed unavailable");
    };
    executorTestHooks.beforeRefund = () => {
      throw new Error("operator signer unavailable");
    };
    await executePayment(payment.id);
    delete executorTestHooks.beforeSettlement;
    delete executorTestHooks.beforeRefund;

    const pid = onchainPaymentId(payment.id);
    expect(await onchainPaymentState("base-local", pid)).toBe("INITIATED");

    // Model the strand: null the column the old query keyed on. The payment has a
    // reservation (created just before escrow), which is the real "attempted
    // escrow" signal, so it must stay visible.
    await prisma.payment.update({ where: { id: payment.id }, data: { onchainPaymentId: null } });

    const listed = await stuckPayments();
    expect(listed.find((s) => s.payment.id === payment.id)?.escrowState).toBe("INITIATED");

    await operatorWrite("base-local", "failAndRefund", [pid, "operator repair"]); // leave the escrow clean
  });
});
