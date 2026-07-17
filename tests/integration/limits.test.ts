// Baseline web hardening on the routes (US-018): write rate limits, the body
// size cap, cursor pagination, and the bounded reconciliation export. Handlers
// invoked directly, no HTTP server.
//
// Payments created here are never deleted: their creation is audited, and
// deleting an audited payment NULLs the event's paymentId and breaks the hash
// chain (AGENTS.md gotcha).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as auditGET } from "@/app/api/audit/route";
import { GET as entitiesGET } from "@/app/api/entities/route";
import { GET as paymentsGET, POST as paymentsPOST } from "@/app/api/payments/route";
import { GET as reconciliationGET } from "@/app/api/reconciliation/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { API_KEY_HEADER } from "@/lib/auth";
import { MAX_BODY_BYTES } from "@/app/api/limits";
import { resetRateLimits } from "@/lib/rate-limit";
import { MAX_PAGE_LIMIT } from "@/lib/pagination";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";
import { createDraftPayment } from "../helpers/payments";

function post(path: string, body: unknown, key?: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://test.local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { [API_KEY_HEADER]: key } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...({ duplex: "half" } as object),
  });
}

const get = (path: string, key: string) =>
  new NextRequest(`http://test.local${path}`, { headers: { [API_KEY_HEADER]: key } });

const createBody = (reference: string) => ({
  sender_id: "ent_acme_us",
  recipient_id: "ent_tokyo_supplier",
  amount: "1000.00",
  source_currency: "USD",
  destination_currency: "JPY",
  reference_id: reference,
});

/**
 * The suite pins the limit effectively off (see FIXTURE_ENV) so one busy file
 * cannot 429 the next. These tests lower it for themselves and put it back.
 */
function withWriteLimit(limit: number) {
  const previous = process.env.RATE_LIMIT_WRITES_PER_MINUTE;
  process.env.RATE_LIMIT_WRITES_PER_MINUTE = String(limit);
  resetRateLimits();
  return () => {
    process.env.RATE_LIMIT_WRITES_PER_MINUTE = previous;
    resetRateLimits();
  };
}

describe("write rate limits", () => {
  let restore = () => {};
  beforeEach(() => {
    restore = withWriteLimit(3);
  });
  afterEach(() => restore());

  it("429s a burst past the limit, with a Retry-After the caller can use", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await paymentsPOST(post("/api/payments", createBody(`RL-${i}`), API_KEYS.operator));
      expect(res.status).toBe(201);
    }

    const refused = await paymentsPOST(post("/api/payments", createBody("RL-over"), API_KEYS.operator));
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({ error_code: "rate_limited" });

    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("the refused write never happened", async () => {
    for (let i = 0; i < 3; i++) {
      await paymentsPOST(post("/api/payments", createBody(`RL-B-${i}`), API_KEYS.operator));
    }
    const refused = await paymentsPOST(post("/api/payments", createBody("RL-B-ghost"), API_KEYS.operator));
    expect(refused.status).toBe(429);

    // The whole point of refusing early: no row, and no audit event either.
    await expect(prisma.payment.count({ where: { referenceId: "RL-B-ghost" } })).resolves.toBe(0);
  });

  it("budgets are per principal, not global", async () => {
    for (let i = 0; i < 3; i++) {
      await paymentsPOST(post("/api/payments", createBody(`RL-C-${i}`), API_KEYS.operator));
    }
    expect((await paymentsPOST(post("/api/payments", createBody("RL-C-x"), API_KEYS.operator))).status).toBe(429);

    // A different key still has its own budget — one noisy tenant must not be
    // able to lock every other tenant out.
    const acme = await paymentsPOST(post("/api/payments", createBody("RL-C-acme"), API_KEYS.entities.ent_acme_us));
    expect(acme.status).toBe(201);
  });

  it("reads are not rate-limited", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await paymentsGET(get("/api/payments?limit=1", API_KEYS.operator))).status).toBe(200);
    }
  });

  it("the unauthenticated login endpoint falls back to the caller's address", async () => {
    const from = (ip: string) =>
      loginPOST(post("/api/auth/login", { api_key: "sos_wrong" }, undefined, { "x-forwarded-for": ip }));

    // Three wrong guesses are 401s; the fourth from the same address is refused
    // outright — this is the endpoint key-guessing would target.
    for (let i = 0; i < 3; i++) expect((await from("203.0.113.7")).status).toBe(401);
    expect((await from("203.0.113.7")).status).toBe(429);

    // ...and another address is unaffected.
    expect((await from("203.0.113.8")).status).toBe(401);
  });
});

/**
 * `x-forwarded-for` is client-settable — Next only fills it from the socket when
 * it is absent (`??=`), so a client that sends its own wins. Behind a known number
 * of our own proxies we can read past the forged part of the list.
 */
describe("login rate limit behind a trusted proxy", () => {
  let restore = () => {};
  let restoreHops = () => {};

  beforeEach(() => {
    restore = withWriteLimit(3);
  });
  afterEach(() => {
    restore();
    restoreHops();
  });

  function withHops(hops: string | undefined) {
    const previous = process.env.TRUSTED_PROXY_HOPS;
    if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = hops;
    restoreHops = () => {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = previous;
    };
  }

  const guess = (xff: string) =>
    loginPOST(post("/api/auth/login", { api_key: "sos_wrong" }, undefined, { "x-forwarded-for": xff }));

  it("counts the address the trusted proxy observed, not the client's claim", async () => {
    withHops("1");

    // One proxy of ours, which appends what it saw: 198.51.100.5. The attacker
    // forges the left of the list, rotating a fresh value every attempt to look
    // like a new caller each time.
    for (let i = 0; i < 3; i++) {
      expect((await guess(`10.0.0.${i}, 198.51.100.5`)).status).toBe(401);
    }

    // Rotation buys nothing: the rightmost hop is the one we count, and it is the
    // one entry the attacker cannot write.
    expect((await guess("10.0.0.99, 198.51.100.5")).status).toBe(429);
  });

  it("a genuinely different caller behind the same proxy keeps its own budget", async () => {
    withHops("1");

    for (let i = 0; i < 3; i++) expect((await guess(`10.0.0.1, 198.51.100.20`)).status).toBe(401);
    expect((await guess("10.0.0.1, 198.51.100.20")).status).toBe(429);

    // Blocking the proxy itself would lock out every user behind it.
    expect((await guess("10.0.0.1, 198.51.100.21")).status).toBe(401);
  });

  it("an attacker cannot escape by lengthening the list", async () => {
    withHops("1");

    // Padding the left just pushes the forgeries further from where we read.
    for (let i = 0; i < 3; i++) {
      expect((await guess(`10.0.0.${i}, 172.16.0.${i}, 192.0.2.${i}, 198.51.100.30`)).status).toBe(401);
    }
    expect((await guess("10.0.0.9, 172.16.0.9, 192.0.2.9, 198.51.100.30")).status).toBe(429);
  });

  it("two trusted hops read one further left", async () => {
    withHops("2");

    // client, edge-observed, inner-proxy-observed: with two hops of ours the
    // second from the right is the outermost address we can vouch for.
    for (let i = 0; i < 3; i++) {
      expect((await guess(`10.0.0.${i}, 198.51.100.40, 172.16.9.9`)).status).toBe(401);
    }
    expect((await guess("10.0.0.9, 198.51.100.40, 172.16.9.9")).status).toBe(429);
  });

  it("unset keeps the documented best-effort behavior", async () => {
    withHops(undefined);

    // No claim about the topology, so no pretending: the leftmost entry is used,
    // exactly as before. This is the case the env var exists to fix.
    for (let i = 0; i < 3; i++) expect((await guess("203.0.113.50, 198.51.100.60")).status).toBe(401);
    expect((await guess("203.0.113.50, 198.51.100.60")).status).toBe(429);
  });

  it("falls back rather than misreading a list shorter than the configured hops", async () => {
    // A misconfiguration (or a request that skipped the proxy) must not index off
    // the end of the list and key everything on "undefined".
    withHops("3");
    expect((await guess("203.0.113.70")).status).toBe(401);
    expect((await guess("203.0.113.70")).status).toBe(401);
  });
});

describe("request body cap", () => {
  it("413s a body past the cap", async () => {
    const huge = JSON.stringify({ ...createBody("TOO-BIG"), memo: "x".repeat(MAX_BODY_BYTES) });
    const res = await paymentsPOST(post("/api/payments", huge, API_KEYS.operator));
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error_code: "payload_too_large" });
    await expect(prisma.payment.count({ where: { referenceId: "TOO-BIG" } })).resolves.toBe(0);
  });

  it("413s even when Content-Length lies about the size", async () => {
    // The declared length is a hint, not the enforcement: if the header were
    // trusted, the cap would be decorative.
    const huge = JSON.stringify({ ...createBody("LIAR"), memo: "x".repeat(MAX_BODY_BYTES) });
    const res = await paymentsPOST(post("/api/payments", huge, API_KEYS.operator, { "content-length": "42" }));
    expect(res.status).toBe(413);
  });

  it("an ordinary body is unaffected", async () => {
    const res = await paymentsPOST(post("/api/payments", createBody("NORMAL-SIZE"), API_KEYS.operator));
    expect(res.status).toBe(201);
  });
});

describe("GET /api/payments pagination", () => {
  it("defaults are bounded and the response says whether more remain", async () => {
    const res = await paymentsGET(get("/api/payments?limit=1", API_KEYS.operator));
    const body = await res.json();
    expect(body.payments).toHaveLength(1);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBe(body.payments[0].id);
  });

  it("rejects a limit past the cap", async () => {
    const res = await paymentsGET(get(`/api/payments?limit=${MAX_PAGE_LIMIT + 1}`, API_KEYS.operator));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error_code: "invalid_request" });
  });

  it("a cursor walk visits every payment exactly once", async () => {
    // Created in one go, so several will share a createdAt millisecond — which
    // is exactly the case an untiebroken sort gets wrong.
    for (let i = 0; i < 5; i++) await createDraftPayment({ amount: "1.00" });

    const expected = await prisma.payment.findMany({ select: { id: true } });
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 200; page++) {
      const url: string = `/api/payments?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const body = await (await paymentsGET(get(url, API_KEYS.operator))).json();
      seen.push(...body.payments.map((p: { id: string }) => p.id));
      if (!body.has_more) break;
      cursor = body.next_cursor;
      expect(cursor).not.toBeNull();
    }

    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect(seen.sort()).toEqual(expected.map((p) => p.id).sort()); // nothing skipped
  });

  it("a tenant's walk covers only its own payments", async () => {
    const body = await (await paymentsGET(get("/api/payments?limit=200", API_KEYS.entities.ent_sg_supplier))).json();
    const sg = await prisma.entity.findUniqueOrThrow({ where: { externalId: "ent_sg_supplier" } });
    for (const p of body.payments) {
      expect([p.senderId, p.recipientId]).toContain(sg.id);
    }
  });
});

describe("GET /api/audit pagination", () => {
  it("bounds the page and still verifies the whole chain", async () => {
    const res = await auditGET(get("/api/audit?limit=3", API_KEYS.operator));
    const body = await res.json();
    expect(body.events).toHaveLength(3);
    expect(body.has_more).toBe(true);
    // Integrity is a property of the log, not of the page asked for.
    expect(body.integrity.valid).toBe(true);
    expect(body.integrity.events_verified).toBeGreaterThan(3);
  });

  it("a cursor walk visits every event exactly once", async () => {
    const total = await prisma.auditEvent.count();
    const seen: number[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 500; page++) {
      const url: string = `/api/audit?limit=25${cursor ? `&cursor=${cursor}` : ""}`;
      const body = await (await auditGET(get(url, API_KEYS.operator))).json();
      seen.push(...body.events.map((e: { id: number }) => e.id));
      if (!body.has_more) break;
      cursor = body.next_cursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    // The log only grows (it is append-only), so anything beyond the count read
    // at the top is an event this walk raced, not a duplicate.
    expect(seen.length).toBeGreaterThanOrEqual(total);
  });

  it("rejects a cursor that is not an event id", async () => {
    const res = await auditGET(get("/api/audit?cursor=pay_abc", API_KEYS.operator));
    expect(res.status).toBe(400);
  });

  it("rejects a cursor past the 32-bit id range with a 400, not an uncaught 500", async () => {
    // Digits-only but larger than a Postgres/SQLite Int — Number() then Prisma
    // would throw and surface as a 500 without the bounds check.
    const res = await auditGET(get("/api/audit?cursor=99999999999999999999", API_KEYS.operator));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/entities pagination", () => {
  it("bounds the list and pages with a cursor", async () => {
    const first = await (await entitiesGET(get("/api/entities?limit=1", API_KEYS.operator))).json();
    expect(first.entities).toHaveLength(1);
    // Four demo entities are seeded, so a limit of 1 has more to come.
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBe(first.entities[0].id);

    const second = await (
      await entitiesGET(get(`/api/entities?limit=1&cursor=${first.next_cursor}`, API_KEYS.operator))
    ).json();
    expect(second.entities[0].id).not.toBe(first.entities[0].id);
  });

  it("rejects a limit over the cap", async () => {
    const res = await entitiesGET(get(`/api/entities?limit=${MAX_PAGE_LIMIT + 1}`, API_KEYS.operator));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/reconciliation date range", () => {
  const csvIds = (text: string) =>
    text
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(",")[0]);

  it("defaults to the last 30 days", async () => {
    const fresh = await createDraftPayment({ amount: "2.00" });
    const text = await (await reconciliationGET(get("/api/reconciliation", API_KEYS.operator))).text();
    expect(csvIds(text)).toContain(fresh.id);
  });

  it("includes a payment 29.5 days old — the default window is a full 30 days", async () => {
    const p = await createDraftPayment({ amount: "4.00" });
    // Inside 30 days but outside the buggy 29-day window (the default `to` used to
    // be padded a day forward, so `from` only reached now−29d).
    await prisma.payment.update({
      where: { id: p.id },
      data: { createdAt: new Date(Date.now() - 29.5 * 24 * 60 * 60 * 1000) },
    });
    const text = await (await reconciliationGET(get("/api/reconciliation", API_KEYS.operator))).text();
    expect(csvIds(text)).toContain(p.id);
  });

  it("excludes payments outside the range", async () => {
    const old = await createDraftPayment({ amount: "3.00" });
    // Backdate it past the default window. Safe to update: createdAt is not part
    // of the audit hash, and this row's own event records its creation, not its
    // timestamp.
    await prisma.payment.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    });

    const defaulted = await (await reconciliationGET(get("/api/reconciliation", API_KEYS.operator))).text();
    expect(csvIds(defaulted)).not.toContain(old.id);

    // ...and an explicit range that covers it brings it back.
    const widened = await (
      await reconciliationGET(get("/api/reconciliation?from=2000-01-01", API_KEYS.operator))
    ).text();
    expect(csvIds(widened)).toContain(old.id);
  });

  it("a date-only `to` includes the whole of that day", async () => {
    const today = await createDraftPayment({ amount: "4.00" });
    const day = new Date().toISOString().slice(0, 10);
    // Read as a bare instant, `to=<today>` would mean midnight and drop
    // everything made since.
    const text = await (
      await reconciliationGET(get(`/api/reconciliation?from=2000-01-01&to=${day}`, API_KEYS.operator))
    ).text();
    expect(csvIds(text)).toContain(today.id);
  });

  it("rejects an unparseable or inverted range", async () => {
    for (const qs of ["from=nonsense", "from=2026-13-45", "from=2026-02-01&to=2026-01-01"]) {
      const res = await reconciliationGET(get(`/api/reconciliation?${qs}`, API_KEYS.operator));
      expect(res.status, qs).toBe(400);
    }
  });

  it("audits one summary event per export, naming the range — not one per row", async () => {
    const before = await prisma.auditEvent.count({ where: { action: "reconciliation.exported" } });
    const text = await (await reconciliationGET(get("/api/reconciliation", API_KEYS.operator))).text();
    const rowCount = csvIds(text).length;
    expect(rowCount).toBeGreaterThan(1);

    const events = await prisma.auditEvent.findMany({
      where: { action: "reconciliation.exported" },
      orderBy: { id: "desc" },
    });
    expect(events.length).toBe(before + 1);

    const detail = JSON.parse(events[0].detail);
    expect(detail.paymentCount).toBe(rowCount);
    expect(Date.parse(detail.from)).not.toBeNaN();
    expect(Date.parse(detail.to)).not.toBeNaN();
  });
});
