// Legacy, non-canonical Payment.amount rows. Payments written before the money
// gate (lib/money) passed only a `Number(amount) > 0` check, so a database that
// predates it can hold "1e5" or an over-precise "100.001" — strings every parse
// downstream now rejects. Creation is gated now, but the rows already written
// are the problem, and only history can produce one: these tests forge them with
// a raw update because every path into the row refuses them.
//
// The rule: such a payment must fail *where the caller can still act on it*, not
// strand halfway through the gate.
//
// Payments created here are never deleted: their creation is audited, and
// deleting an audited payment NULLs the event's paymentId and breaks the hash
// chain (AGENTS.md gotcha).

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as executePOST } from "@/app/api/payments/[id]/execute/route";
import { POST as cancelPOST } from "@/app/api/payments/[id]/cancel/route";
import { API_KEY_HEADER } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { quoteRoutes } from "@/lib/routing";
import { API_KEYS } from "../fixture";
import { createDraftPayment } from "../helpers/payments";

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

const post = (path: string, key: string) =>
  new NextRequest(`http://test.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [API_KEY_HEADER]: key },
    body: JSON.stringify({}),
    ...({ duplex: "half" } as object),
  });

/** A row as a pre-gate database holds it: quoted while the amount was still accepted. */
async function legacyQuotedPayment(amount: string) {
  const payment = await createDraftPayment({ amount: "100000.00" });
  const routes = await quoteRoutes(payment.id);
  return prisma.payment.update({
    where: { id: payment.id },
    data: { amount, quoteJson: JSON.stringify(routes), status: "QUOTED" },
  });
}

describe("execute on a legacy non-canonical amount", () => {
  // An exponent Number() reads happily, a third yen decimal on a 2-dp currency,
  // and a negative — the three shapes `Number(amount) > 0` let through.
  for (const amount of ["1e5", "100.001", "-5.00"]) {
    it(`refuses ${amount} with a 409 and leaves the payment untouched`, async () => {
      const payment = await legacyQuotedPayment(amount);

      const res = await executePOST(
        post(`/api/payments/${payment.id}/execute`, API_KEYS.operator),
        routeParams(payment.id)
      );

      // A 409, not the 500 an uncaught MoneyError produced: the request is
      // well-formed, the stored payment is what cannot be executed.
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error_code: "conflict" });

      // Still QUOTED — the gate is checked before the status moves, so the
      // payment never enters COMPLIANCE_PENDING, which execute cannot resume from.
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe("QUOTED");
    });
  }

  it("never bills the compliance gate for a payment it cannot read", async () => {
    const payment = await legacyQuotedPayment("1e5");
    await executePOST(post(`/api/payments/${payment.id}/execute`, API_KEYS.operator), routeParams(payment.id));

    // The parse that throws sits *inside* the gate, past the provider calls, so a
    // check row here would mean we screened (and on a real provider, paid for) a
    // payment that was never executable.
    await expect(prisma.complianceCheck.count({ where: { paymentId: payment.id } })).resolves.toBe(0);
  });

  it("leaves the caller a way out: the payment is still cancellable", async () => {
    const payment = await legacyQuotedPayment("100.001");
    await executePOST(post(`/api/payments/${payment.id}/execute`, API_KEYS.operator), routeParams(payment.id));

    // The whole point of failing at QUOTED. Stranded in COMPLIANCE_PENDING the row
    // could only ever be cancelled; here the normal lifecycle still applies.
    const res = await cancelPOST(post(`/api/payments/${payment.id}/cancel`, API_KEYS.operator), routeParams(payment.id));
    expect(res.status).toBe(200);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("CANCELLED");
  });

  it("a canonical amount is unaffected", async () => {
    // The guard rejects malformed money, not payments — a well-formed row must
    // still go through the gate exactly as before.
    const payment = await legacyQuotedPayment("1000.00");
    const res = await executePOST(
      post(`/api/payments/${payment.id}/execute`, API_KEYS.operator),
      routeParams(payment.id)
    );

    expect(res.status).toBe(200);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).not.toBe("QUOTED");
  });
});
