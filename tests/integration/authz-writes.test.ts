// Authorization on the write routes (US-004), handlers invoked directly (no HTTP
// server). The rules under test:
//   - anonymous            -> generic 401 on every write route
//   - POST /api/payments   -> OPERATOR, or the ENTITY named as sender_id
//   - quote/execute/cancel -> OPERATOR or the payment's sender; a non-party
//                             tenant 404s exactly like a nonexistent id
//   - review               -> REVIEWER/OPERATOR only, reviewer taken from the key
//   - treasury writes      -> OPERATOR only
// Plus: the audit actor is the authenticated principal, never a body field.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST as entitiesPOST } from "@/app/api/entities/route";
import { POST as cancelPOST } from "@/app/api/payments/[id]/cancel/route";
import { POST as executePOST } from "@/app/api/payments/[id]/execute/route";
import { POST as quotePOST } from "@/app/api/payments/[id]/quote/route";
import { POST as reviewPOST } from "@/app/api/payments/[id]/review/route";
import { POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as accruePOST } from "@/app/api/treasury/accrue/route";
import { POST as parkPOST } from "@/app/api/treasury/park/route";
import { POST as recallPOST } from "@/app/api/treasury/recall/route";
import { API_KEY_HEADER } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";

/** A POST carrying an api key in the header (undefined = anonymous). */
function post(path: string, body: Record<string, unknown> = {}, key?: string) {
  return new NextRequest(`http://test.local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { [API_KEY_HEADER]: key } : {}),
    },
    body: JSON.stringify(body),
    // undici requires duplex when a body is present on a constructed Request
    ...({ duplex: "half" } as object),
  });
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

const CREATED: string[] = [];
let acmePayment = ""; // acme -> tokyo, DRAFT
let othersPayment = ""; // sgp -> osaka, DRAFT: acme is not a party
let reviewPayment = ""; // acme -> tokyo, MANUAL_REVIEW

async function seedPayment(sender: string, recipient: string, status = "DRAFT") {
  const [s, r] = await Promise.all([
    prisma.entity.findUniqueOrThrow({ where: { externalId: sender } }),
    prisma.entity.findUniqueOrThrow({ where: { externalId: recipient } }),
  ]);
  const payment = await prisma.payment.create({
    data: {
      id: `pay_authzw_${sender.slice(4, 10)}_${status.slice(0, 4).toLowerCase()}_${r.id.slice(-4)}`,
      senderId: s.id,
      recipientId: r.id,
      amount: "1000.00",
      sourceCurrency: "USD",
      destinationCurrency: "USD",
      sourceAsset: "mockUSDC",
      destinationAsset: "mockUSDC",
      sourceNetwork: "base-local",
      destinationNetwork: "base-local",
      referenceId: "INV-AUTHZW",
      status,
    },
  });
  CREATED.push(payment.id);
  return payment.id;
}

beforeAll(async () => {
  acmePayment = await seedPayment("ent_acme_us", "ent_tokyo_supplier");
  othersPayment = await seedPayment("ent_sg_supplier", "ent_osaka_parts");
  reviewPayment = await seedPayment("ent_acme_us", "ent_tokyo_supplier", "MANUAL_REVIEW");
});

// The DB is shared across files, so clean up — but deleting a payment NULLs the
// paymentId of its audit rows (Prisma's SetNull default), and paymentId is
// inside the event hash. Deleting an *audited* payment would therefore break the
// chain for every other test file. Audit-free rows only.
afterAll(async () => {
  const audited = new Set(
    (
      await prisma.auditEvent.findMany({
        where: { paymentId: { in: CREATED } },
        select: { paymentId: true },
      })
    ).map((e) => e.paymentId)
  );
  await prisma.payment.deleteMany({ where: { id: { in: CREATED.filter((id) => !audited.has(id)) } } });
});

describe("write routes reject anonymous callers", () => {
  it("gives a generic 401, identical to the read routes'", async () => {
    const responses = await Promise.all([
      paymentsPOST(post("/api/payments", {})),
      quotePOST(post(`/api/payments/${acmePayment}/quote`), routeParams(acmePayment)),
      executePOST(post(`/api/payments/${acmePayment}/execute`), routeParams(acmePayment)),
      cancelPOST(post(`/api/payments/${acmePayment}/cancel`), routeParams(acmePayment)),
      reviewPOST(post(`/api/payments/${reviewPayment}/review`, { decision: "approve" }), routeParams(reviewPayment)),
      entitiesPOST(post("/api/entities", { name: "Nope", country: "US" })),
      parkPOST(post("/api/treasury/park", {})),
      recallPOST(post("/api/treasury/recall", {})),
      accruePOST(post("/api/treasury/accrue", {})),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });
});

describe("POST /api/payments sender authorization", () => {
  const draft = (senderId: string) => ({
    sender_id: senderId,
    recipient_id: "ent_tokyo_supplier",
    amount: "1000.00",
    source_currency: "USD",
    destination_currency: "JPY",
    source_network: "base-local",
    destination_network: "base-local",
    reference_id: "INV-AUTHZW-CREATE",
  });

  it("403s an ENTITY naming another tenant as sender", async () => {
    const res = await paymentsPOST(
      post("/api/payments", draft("ent_sg_supplier"), API_KEYS.entities.ent_acme_us)
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("403s an ENTITY naming a sender that does not exist at all — same answer, no oracle", async () => {
    const res = await paymentsPOST(
      post("/api/payments", draft("ent_no_such_entity"), API_KEYS.entities.ent_acme_us)
    );
    expect(res.status).toBe(403);
  });

  it("403s a REVIEWER: reviewers decide on payments, they do not originate them", async () => {
    const res = await paymentsPOST(post("/api/payments", draft("ent_acme_us"), API_KEYS.reviewer));
    expect(res.status).toBe(403);
  });

  it("lets an ENTITY create its own payment and audits the entity as actor", async () => {
    const res = await paymentsPOST(
      post("/api/payments", draft("ent_acme_us"), API_KEYS.entities.ent_acme_us)
    );
    expect(res.status).toBe(201);
    const { payment_id } = await res.json();
    CREATED.push(payment_id);

    const event = await prisma.auditEvent.findFirst({
      where: { paymentId: payment_id, action: "payment.created" },
    });
    expect(event?.actor).toBe("ACME US Inc API key (ENTITY)");
  });
});

describe("payment write routes: sender or operator only", () => {
  it("404s a non-party tenant, byte-identically to a nonexistent id", async () => {
    const key = API_KEYS.entities.ent_acme_us;
    const foreign = await quotePOST(
      post(`/api/payments/${othersPayment}/quote`, {}, key),
      routeParams(othersPayment)
    );
    const ghost = await quotePOST(
      post("/api/payments/pay_does_not_exist/quote", {}, key),
      routeParams("pay_does_not_exist")
    );
    expect(foreign.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(await foreign.json()).toEqual(await ghost.json());
  });

  it("403s the recipient — a party may watch a payment but not drive it", async () => {
    const res = await cancelPOST(
      post(`/api/payments/${acmePayment}/cancel`, {}, API_KEYS.entities.ent_tokyo_supplier),
      routeParams(acmePayment)
    );
    expect(res.status).toBe(403);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: acmePayment } })).toMatchObject({
      status: "DRAFT",
    });
  });

  it("403s a REVIEWER on execute — the compliance gate is not an execution key", async () => {
    const res = await executePOST(
      post(`/api/payments/${acmePayment}/execute`, {}, API_KEYS.reviewer),
      routeParams(acmePayment)
    );
    expect(res.status).toBe(403);
  });

  it("lets the sender cancel its own payment and audits the sender as actor", async () => {
    const res = await cancelPOST(
      post(`/api/payments/${acmePayment}/cancel`, {}, API_KEYS.entities.ent_acme_us),
      routeParams(acmePayment)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "CANCELLED" });

    const event = await prisma.auditEvent.findFirst({
      where: { paymentId: acmePayment, action: "payment.status.cancelled" },
    });
    expect(event?.actor).toBe("ACME US Inc API key (ENTITY)");
  });
});

describe("POST /api/payments/[id]/review", () => {
  it("403s an ENTITY, even the payment's own sender", async () => {
    const res = await reviewPOST(
      post(`/api/payments/${reviewPayment}/review`, { decision: "approve" }, API_KEYS.entities.ent_acme_us),
      routeParams(reviewPayment)
    );
    expect(res.status).toBe(403);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: reviewPayment } })).toMatchObject({
      status: "MANUAL_REVIEW",
    });
  });

  it("records the REVIEWER principal as actor and ignores a forged body reviewer", async () => {
    const res = await reviewPOST(
      post(
        `/api/payments/${reviewPayment}/review`,
        { decision: "approve", note: "cleared", reviewer: "someone_else" },
        API_KEYS.reviewer
      ),
      routeParams(reviewPayment)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "APPROVED" });

    const event = await prisma.auditEvent.findFirst({
      where: { paymentId: reviewPayment, action: "payment.review.approved" },
    });
    expect(event?.actor).toBe("Compliance reviewer (REVIEWER)");
    expect(event?.actor).not.toContain("someone_else");
  });
});

describe("treasury write routes are OPERATOR only", () => {
  it("403s an ENTITY and a REVIEWER before any chain call", async () => {
    const responses = await Promise.all([
      parkPOST(post("/api/treasury/park", {}, API_KEYS.entities.ent_acme_us)),
      recallPOST(post("/api/treasury/recall", {}, API_KEYS.entities.ent_acme_us)),
      accruePOST(post("/api/treasury/accrue", {}, API_KEYS.entities.ent_acme_us)),
      parkPOST(post("/api/treasury/park", {}, API_KEYS.reviewer)),
      recallPOST(post("/api/treasury/recall", {}, API_KEYS.reviewer)),
      accruePOST(post("/api/treasury/accrue", {}, API_KEYS.reviewer)),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });
});

describe("POST /api/entities is OPERATOR only", () => {
  it("403s an ENTITY onboarding a counterparty", async () => {
    const res = await entitiesPOST(
      post("/api/entities", { name: "Rogue Co", country: "US" }, API_KEYS.entities.ent_acme_us)
    );
    expect(res.status).toBe(403);
    expect(await prisma.entity.findFirst({ where: { name: "Rogue Co" } })).toBeNull();
  });
});
