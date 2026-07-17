// The CAS reaching the client (US-006): the review and cancel routes decide a
// race with the compare-and-swap, not with the status check they read first, and
// the loser sees a 409 conflict rather than silently clobbering the winner.
// Handlers invoked directly, no HTTP server.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as cancelPOST } from "@/app/api/payments/[id]/cancel/route";
import { POST as reviewPOST } from "@/app/api/payments/[id]/review/route";
import { POST as quotePOST } from "@/app/api/payments/[id]/quote/route";
import { API_KEY_HEADER } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";
import { createDraftPayment } from "../helpers/payments";

function post(path: string, body: Record<string, unknown>, key: string) {
  return new NextRequest(`http://test.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [API_KEY_HEADER]: key },
    body: JSON.stringify(body),
    ...({ duplex: "half" } as object),
  });
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** Statuses of a set of responses, sorted so order of resolution doesn't matter. */
const statuses = (rs: Response[]) => rs.map((r) => r.status).sort();

describe("concurrent writes on the same payment", () => {
  it("settles two racing reviewers: one 200, one 409", async () => {
    const payment = await createDraftPayment();
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "MANUAL_REVIEW" } });

    const [a, b] = await Promise.all([
      reviewPOST(
        post(`/api/payments/${payment.id}/review`, { decision: "approve" }, API_KEYS.reviewer),
        routeParams(payment.id)
      ),
      reviewPOST(
        post(`/api/payments/${payment.id}/review`, { decision: "reject" }, API_KEYS.operator),
        routeParams(payment.id)
      ),
    ]);

    expect(statuses([a, b])).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await loser.json()).toMatchObject({ error_code: "conflict" });

    // One decision, one audit event — the payment is approved or rejected, never both.
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(["APPROVED", "REJECTED"]).toContain(after.status);
    const events = await prisma.auditEvent.findMany({
      where: { paymentId: payment.id, action: { startsWith: "payment.review." } },
    });
    expect(events).toHaveLength(1);
  });

  it("settles two racing cancels: one 200, one 409", async () => {
    const payment = await createDraftPayment();

    const [a, b] = await Promise.all([
      cancelPOST(post(`/api/payments/${payment.id}/cancel`, {}, API_KEYS.operator), routeParams(payment.id)),
      cancelPOST(
        post(`/api/payments/${payment.id}/cancel`, {}, API_KEYS.entities.ent_acme_us),
        routeParams(payment.id)
      ),
    ]);

    expect(statuses([a, b])).toEqual([200, 409]);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      status: "CANCELLED",
    });
    const events = await prisma.auditEvent.findMany({
      where: { paymentId: payment.id, action: "payment.status.cancelled" },
    });
    expect(events).toHaveLength(1);
  });

  it("a quote racing a cancel can never resurrect the cancelled payment", async () => {
    const payment = await createDraftPayment();
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "QUOTED" } });

    // The quote route once wrote QUOTED via a raw update with no status guard, so a
    // cancel landing mid-quote could be clobbered back to QUOTED — an illegal
    // CANCELLED→QUOTED resurrection. Through transitionStatus the quote's write is a
    // CAS on QUOTED: once the cancel lands CANCELLED, the quote matches zero rows and
    // 409s. The cancel therefore always wins the final state.
    const [q, c] = await Promise.all([
      quotePOST(post(`/api/payments/${payment.id}/quote`, {}, API_KEYS.operator), routeParams(payment.id)),
      cancelPOST(post(`/api/payments/${payment.id}/cancel`, {}, API_KEYS.operator), routeParams(payment.id)),
    ]);

    expect(c.status).toBe(200);
    expect([200, 409]).toContain(q.status);
    // The invariant that matters: never QUOTED after a successful cancel.
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      status: "CANCELLED",
    });
  });
});
