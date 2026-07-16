import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { StaleTransitionError, transitionStatus } from "@/lib/transitions";
import { createDraftPayment } from "../helpers/payments";

// Payments here get audited, so they are never deleted — an AuditEvent's
// paymentId is inside its hash and Prisma would NULL it on delete, breaking the
// chain for every later event (AGENTS.md gotcha).

describe("compare-and-swap status transitions", () => {
  it("applies a legal transition and audits it once", async () => {
    const payment = await createDraftPayment();
    const updated = await transitionStatus(payment, "QUOTED", { actor: "tester" });

    expect(updated.status).toBe("QUOTED");
    const events = await prisma.auditEvent.findMany({
      where: { paymentId: payment.id, action: "payment.status.quoted" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("tester");
    expect(JSON.parse(events[0].detail)).toMatchObject({ from: "DRAFT", to: "QUOTED" });
  });

  it("writes the extra columns in the same statement as the status", async () => {
    const payment = await createDraftPayment();
    const updated = await transitionStatus(payment, "QUOTED", {
      data: { selectedRouteId: "route_cas" },
    });
    expect(updated.status).toBe("QUOTED");
    expect(updated.selectedRouteId).toBe("route_cas");
  });

  it("refuses an illegal transition before touching the row", async () => {
    const payment = await createDraftPayment();
    await expect(transitionStatus(payment, "SETTLED")).rejects.toThrow(/Invalid payment state transition/);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("DRAFT");
  });

  it("lets exactly one of two concurrent transitions win", async () => {
    const payment = await createDraftPayment();

    // Both writers hold the same stale-able view of the row (status DRAFT) and
    // race. Legal moves both — only the CAS separates them.
    const results = await Promise.allSettled([
      transitionStatus(payment, "QUOTED", { actor: "writer-a" }),
      transitionStatus(payment, "CANCELLED", { actor: "writer-b" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const loss = (rejected[0] as PromiseRejectedResult).reason;
    expect(loss).toBeInstanceOf(StaleTransitionError);
    expect(loss.expectedFrom).toBe("DRAFT");
    expect(loss.code).toBe("conflict");

    // The row landed in the winner's status, whole — not a mix of the two.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value;
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe(winner.status);
    expect(["QUOTED", "CANCELLED"]).toContain(after.status);
  });

  it("audits only the transition that actually happened", async () => {
    const payment = await createDraftPayment();

    await Promise.allSettled([
      transitionStatus(payment, "QUOTED", { actor: "writer-a" }),
      transitionStatus(payment, "CANCELLED", { actor: "writer-b" }),
    ]);

    // The loser must leave no trace: an audit event for a change it never made
    // would be a lie in an append-only log.
    const events = await prisma.auditEvent.findMany({ where: { paymentId: payment.id } });
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe(`payment.status.${after.status.toLowerCase()}`);
  });
});
