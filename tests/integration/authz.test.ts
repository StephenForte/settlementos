// Authorization + tenant scoping on the read routes (US-003), handlers invoked
// directly (no HTTP server). The rules under test:
//   - anonymous / invalid key  -> generic 401 everywhere but /api/networks
//   - OPERATOR, REVIEWER       -> read everything
//   - ENTITY                   -> only rows it is party to; other tenants' ids
//                                 404 rather than 403 (no existence oracle)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET as auditGET } from "@/app/api/audit/route";
import { GET as balancesGET } from "@/app/api/balances/route";
import { GET as entitiesGET } from "@/app/api/entities/route";
import { GET as networksGET } from "@/app/api/networks/route";
import { GET as paymentGET } from "@/app/api/payments/[id]/route";
import { GET as paymentsGET } from "@/app/api/payments/route";
import { GET as reconciliationGET } from "@/app/api/reconciliation/route";
import { API_KEY_COOKIE, API_KEY_HEADER } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";

/** A GET carrying an api key in the header (undefined = anonymous). */
function get(path: string, key?: string) {
  return new NextRequest(`http://test.local${path}`, {
    headers: key ? { [API_KEY_HEADER]: key } : {},
  });
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** Payments created here so the tenant filter has something to exclude. */
const CREATED: string[] = [];
let acmePayment = "";
let othersPayment = "";

async function seedPayment(senderExternalId: string, recipientExternalId: string) {
  const [sender, recipient] = await Promise.all([
    prisma.entity.findUniqueOrThrow({ where: { externalId: senderExternalId } }),
    prisma.entity.findUniqueOrThrow({ where: { externalId: recipientExternalId } }),
  ]);
  const payment = await prisma.payment.create({
    data: {
      id: `pay_authz_${senderExternalId.slice(4, 12)}_${recipient.id.slice(-4)}`,
      senderId: sender.id,
      recipientId: recipient.id,
      amount: "1000.00",
      sourceCurrency: "USD",
      destinationCurrency: "USD",
      sourceAsset: "mockUSDC",
      destinationAsset: "mockUSDC",
      sourceNetwork: "base-local",
      destinationNetwork: "base-local",
      referenceId: "INV-AUTHZ",
    },
  });
  CREATED.push(payment.id);
  return payment.id;
}

beforeAll(async () => {
  acmePayment = await seedPayment("ent_acme_us", "ent_tokyo_supplier");
  othersPayment = await seedPayment("ent_sg_supplier", "ent_osaka_parts");
});

// The DB is shared across files; leave it as we found it.
afterAll(async () => {
  await prisma.payment.deleteMany({ where: { id: { in: CREATED } } });
});

describe("authentication", () => {
  it("gives a generic 401 to anonymous callers on every non-public read route", async () => {
    const responses = await Promise.all([
      paymentsGET(get("/api/payments")),
      paymentGET(get(`/api/payments/${acmePayment}`), routeParams(acmePayment)),
      entitiesGET(get("/api/entities")),
      balancesGET(get("/api/balances")),
      reconciliationGET(get("/api/reconciliation")),
      auditGET(get("/api/audit")),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("treats an invalid key exactly like anonymous — no oracle for which keys exist", async () => {
    const res = await paymentsGET(get("/api/payments", "sos_not_a_real_key"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts the session cookie as well as the header (the browser demo's path)", async () => {
    const req = new NextRequest("http://test.local/api/payments", {
      headers: { cookie: `${API_KEY_COOKIE}=${API_KEYS.operator}` },
    });
    expect((await paymentsGET(req)).status).toBe(200);
  });

  it("leaves /api/networks public — static registry data, no tenant rows", async () => {
    const res = await networksGET();
    expect(res.status).toBe(200);
    expect((await res.json()).networks.length).toBeGreaterThan(0);
  });
});

describe("GET /api/payments tenant scoping", () => {
  it("shows OPERATOR and REVIEWER every payment", async () => {
    for (const key of [API_KEYS.operator, API_KEYS.reviewer]) {
      const res = await paymentsGET(get("/api/payments", key));
      expect(res.status).toBe(200);
      const ids = (await res.json()).payments.map((p: { id: string }) => p.id);
      expect(ids).toEqual(expect.arrayContaining([acmePayment, othersPayment]));
    }
  });

  it("shows an ENTITY only the payments it is party to", async () => {
    const res = await paymentsGET(get("/api/payments", API_KEYS.entities.ent_acme_us));
    expect(res.status).toBe(200);
    const ids = (await res.json()).payments.map((p: { id: string }) => p.id);
    expect(ids).toContain(acmePayment);
    expect(ids).not.toContain(othersPayment);
  });

  it("counts the recipient as a party, not just the sender", async () => {
    const res = await paymentsGET(get("/api/payments", API_KEYS.entities.ent_tokyo_supplier));
    const ids = (await res.json()).payments.map((p: { id: string }) => p.id);
    expect(ids).toContain(acmePayment);
    expect(ids).not.toContain(othersPayment);
  });
});

describe("GET /api/payments/[id] tenant scoping", () => {
  it("lets an ENTITY read its own payment", async () => {
    const res = await paymentGET(
      get(`/api/payments/${acmePayment}`, API_KEYS.entities.ent_acme_us),
      routeParams(acmePayment)
    );
    expect(res.status).toBe(200);
    expect((await res.json()).payment.id).toBe(acmePayment);
  });

  it("404s another tenant's payment — identical to a nonexistent id", async () => {
    const foreign = await paymentGET(
      get(`/api/payments/${othersPayment}`, API_KEYS.entities.ent_acme_us),
      routeParams(othersPayment)
    );
    const ghost = await paymentGET(
      get("/api/payments/pay_does_not_exist", API_KEYS.entities.ent_acme_us),
      routeParams("pay_does_not_exist")
    );
    expect(foreign.status).toBe(404);
    expect(ghost.status).toBe(404);
    // Byte-identical bodies: the response must not confirm that the id exists.
    expect(await foreign.json()).toEqual(await ghost.json());
  });

  it("lets a REVIEWER read any payment", async () => {
    const res = await paymentGET(
      get(`/api/payments/${othersPayment}`, API_KEYS.reviewer),
      routeParams(othersPayment)
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/entities tenant scoping", () => {
  it("shows OPERATOR every entity", async () => {
    const res = await entitiesGET(get("/api/entities", API_KEYS.operator));
    expect(res.status).toBe(200);
    expect((await res.json()).entities.length).toBeGreaterThan(1);
  });

  it("shows an ENTITY only itself", async () => {
    const res = await entitiesGET(get("/api/entities", API_KEYS.entities.ent_acme_us));
    expect(res.status).toBe(200);
    const { entities } = await res.json();
    expect(entities.map((e: { externalId: string }) => e.externalId)).toEqual(["ent_acme_us"]);
  });
});

describe("platform-only read routes", () => {
  it("403s an ENTITY on balances, reconciliation, and audit", async () => {
    const key = API_KEYS.entities.ent_acme_us;
    const responses = await Promise.all([
      balancesGET(get("/api/balances", key)),
      reconciliationGET(get("/api/reconciliation", key)),
      auditGET(get("/api/audit", key)),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });

  it("serves a REVIEWER the audit log and the reconciliation export", async () => {
    const auditRes = await auditGET(get("/api/audit", API_KEYS.reviewer));
    expect(auditRes.status).toBe(200);
    expect((await auditRes.json()).integrity).toMatchObject({ valid: true });

    const csv = await reconciliationGET(get("/api/reconciliation", API_KEYS.reviewer));
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain("payment_id");
  });
});
