// Idempotent writes (US-008): the same Idempotency-Key replays the first
// response instead of creating or executing twice. Handlers invoked directly,
// no HTTP server.
//
// Payments created here are never deleted: their creation is audited, and
// deleting an audited payment NULLs the event's paymentId and breaks the hash
// chain (AGENTS.md gotcha).

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as executePOST } from "@/app/api/payments/[id]/execute/route";
import { API_KEY_HEADER } from "@/lib/auth";
import { IDEMPOTENCY_HEADER, IDEMPOTENCY_TTL_MS, hashRequest } from "@/lib/idempotency";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";
import { createDraftPayment } from "../helpers/payments";

/** A fresh key per test, so tests never collide through the shared fixture DB. */
const freshKey = () => `idem_${randomBytes(8).toString("hex")}`;

function post(path: string, body: Record<string, unknown>, key: string, idempotencyKey?: string) {
  return new NextRequest(`http://test.local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [API_KEY_HEADER]: key,
      ...(idempotencyKey ? { [IDEMPOTENCY_HEADER]: idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    ...({ duplex: "half" } as object),
  });
}

const createBody = (reference: string) => ({
  sender_id: "ent_acme_us",
  recipient_id: "ent_tokyo_supplier",
  amount: "1000.00",
  source_currency: "USD",
  destination_currency: "JPY",
  reference_id: reference,
});

const createPayment = (body: Record<string, unknown>, idempotencyKey?: string, key: string = API_KEYS.operator) =>
  paymentsPOST(post("/api/payments", body, key, idempotencyKey));

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/payments idempotency", () => {
  it("replays the first response and creates exactly one payment", async () => {
    const idKey = freshKey();
    const body = createBody(`REPLAY-${idKey}`);

    const first = await createPayment(body, idKey);
    const second = await createPayment(body, idKey);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json();
    expect(await second.json()).toEqual(firstBody);
    expect(second.headers.get("idempotent-replay")).toBe("true");

    // The replay never reached the handler: one row, one audit event.
    const payments = await prisma.payment.findMany({ where: { referenceId: `REPLAY-${idKey}` } });
    expect(payments).toHaveLength(1);
    expect(payments[0].id).toBe(firstBody.payment_id);
    const events = await prisma.auditEvent.findMany({
      where: { paymentId: firstBody.payment_id, action: "payment.created" },
    });
    expect(events).toHaveLength(1);
  });

  it("replays regardless of key order in the body", async () => {
    const idKey = freshKey();
    const body = createBody(`ORDER-${idKey}`);
    const reordered = Object.fromEntries(Object.entries(body).reverse());

    const first = await createPayment(body, idKey);
    const second = await createPayment(reordered, idKey);

    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });

  it("422s the same key with a different body", async () => {
    const idKey = freshKey();
    await createPayment(createBody(`CONFLICT-${idKey}`), idKey);

    const conflicting = await createPayment({ ...createBody(`CONFLICT-${idKey}`), amount: "2000.00" }, idKey);

    expect(conflicting.status).toBe(422);
    expect(await conflicting.json()).toMatchObject({ error_code: "idempotency_conflict" });
    // The conflicting request did not run.
    const payments = await prisma.payment.findMany({ where: { referenceId: `CONFLICT-${idKey}` } });
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe("1000.00");
  });

  it("treats different keys, and no key at all, as different requests", async () => {
    const reference = `DISTINCT-${randomBytes(4).toString("hex")}`;
    const responses = await Promise.all([
      createPayment(createBody(reference), freshKey()),
      createPayment(createBody(reference), freshKey()),
      createPayment(createBody(reference)),
    ]);

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json()).payment_id)));
    expect(ids.size).toBe(3);
  });

  it("scopes keys per principal: the same key from another caller is unrelated", async () => {
    const idKey = freshKey();
    const body = createBody(`TENANT-${idKey}`);

    const asOperator = await createPayment(body, idKey);
    const asAcme = await createPayment(body, idKey, API_KEYS.entities.ent_acme_us);

    expect(asAcme.status).toBe(201);
    expect(asAcme.headers.get("idempotent-replay")).toBeNull();
    expect((await asAcme.json()).payment_id).not.toBe((await asOperator.json()).payment_id);
  });

  it("409s while the original request is still in flight", async () => {
    const idKey = freshKey();
    const body = createBody(`INFLIGHT-${idKey}`);
    const operatorKey = await prisma.apiKey.findFirstOrThrow({ where: { role: "OPERATOR" } });

    // A reservation with no stamped response is exactly what an unfinished
    // request leaves behind.
    await prisma.idempotencyRecord.create({
      data: {
        principalId: operatorKey.id,
        key: idKey,
        route: "POST /api/payments",
        requestHash: hashRequest(body),
      },
    });

    const duplicate = await createPayment(body, idKey);

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error_code: "conflict" });
    expect(await prisma.payment.findMany({ where: { referenceId: `INFLIGHT-${idKey}` } })).toHaveLength(0);
  });

  it("expires a record after 24h and lets the key be reused", async () => {
    const idKey = freshKey();
    const body = createBody(`EXPIRY-${idKey}`);
    const first = await createPayment(body, idKey);

    // Backdate past the TTL — expiry is evaluated when the key is next presented.
    await prisma.idempotencyRecord.updateMany({
      where: { key: idKey },
      data: { createdAt: new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000) },
    });

    const reused = await createPayment(body, idKey);

    expect(reused.status).toBe(201);
    expect(reused.headers.get("idempotent-replay")).toBeNull();
    expect((await reused.json()).payment_id).not.toBe((await first.json()).payment_id);
    expect(await prisma.payment.findMany({ where: { referenceId: `EXPIRY-${idKey}` } })).toHaveLength(2);
  });

  it("rejects an oversized key", async () => {
    const res = await createPayment(createBody("OVERSIZE"), "k".repeat(256));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "invalid_request" });
  });

  it.each([
    { label: "unparseable", body: "{not json" },
    { label: "missing", body: undefined },
  ])("does not lock the key to {} when the first body is $label", async ({ body: badBody }) => {
    const idKey = freshKey();
    const body = createBody(`RECOVER-${idKey}`);

    const malformed = await paymentsPOST(
      new NextRequest("http://test.local/api/payments", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: API_KEYS.operator,
          [IDEMPOTENCY_HEADER]: idKey,
        },
        ...(badBody !== undefined ? { body: badBody } : {}),
        ...({ duplex: "half" } as object),
      })
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error_code: "invalid_request",
      message: "body must be a JSON object",
    });

    // A valid retry with the same key must create — not 422 because the bad
    // attempt was fingerprinted as {}.
    const retry = await createPayment(body, idKey);
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replay")).toBeNull();
    expect(await prisma.payment.findMany({ where: { referenceId: `RECOVER-${idKey}` } })).toHaveLength(1);
  });
});

/** Execute with no body at all — the route accepts missing via `(raw ?? {})`. */
function executeEmpty(paymentId: string, key: string, idempotencyKey: string) {
  return executePOST(
    new NextRequest(`http://test.local/api/payments/${paymentId}/execute`, {
      method: "POST",
      headers: {
        [API_KEY_HEADER]: key,
        [IDEMPOTENCY_HEADER]: idempotencyKey,
      },
      ...({ duplex: "half" } as object),
    }),
    routeParams(paymentId)
  );
}

describe("POST /api/payments/[id]/execute idempotency", () => {
  it("replays the first attempt's response without re-running the handler", async () => {
    // DRAFT is not executable, so the handler answers 409 without touching a
    // chain — the point here is that the *stored* response comes back verbatim.
    const payment = await createDraftPayment();
    const idKey = freshKey();

    const first = await executePOST(
      post(`/api/payments/${payment.id}/execute`, {}, API_KEYS.operator, idKey),
      routeParams(payment.id)
    );
    const second = await executePOST(
      post(`/api/payments/${payment.id}/execute`, {}, API_KEYS.operator, idKey),
      routeParams(payment.id)
    );

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get("idempotent-replay")).toBe("true");
  });

  it("stamps a 409 from a missing body so a retry replays", async () => {
    // execute accepts `(raw ?? {})`; a missing body that answers 409 must still
    // lock the key — abandoning it would re-run the handler on retry.
    const payment = await createDraftPayment();
    const idKey = freshKey();

    const first = await executeEmpty(payment.id, API_KEYS.operator, idKey);
    const second = await executeEmpty(payment.id, API_KEYS.operator, idKey);

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get("idempotent-replay")).toBe("true");
  });

  it("422s one key aimed at a second payment", async () => {
    const [a, b] = await Promise.all([createDraftPayment(), createDraftPayment()]);
    const idKey = freshKey();

    await executePOST(post(`/api/payments/${a.id}/execute`, {}, API_KEYS.operator, idKey), routeParams(a.id));
    const crossed = await executePOST(
      post(`/api/payments/${b.id}/execute`, {}, API_KEYS.operator, idKey),
      routeParams(b.id)
    );

    expect(crossed.status).toBe(422);
    expect(await crossed.json()).toMatchObject({ error_code: "idempotency_conflict" });
  });
});
