// List UX hides ForteL2 payments from before the 2026-08-22 re-genesis.
// Detail-by-id keeps them — the rows are history, not deleted.

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as paymentGET } from "@/app/api/payments/[id]/route";
import { GET as paymentsGET } from "@/app/api/payments/route";
import { API_KEY_HEADER } from "@/lib/auth";
import { FORTEL2_SEPOLIA_REGENESIS_AT } from "@/lib/networks";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";
import { createDraftPayment } from "../helpers/payments";

const BEFORE = new Date(FORTEL2_SEPOLIA_REGENESIS_AT.getTime() - 1000);
const AFTER = new Date(FORTEL2_SEPOLIA_REGENESIS_AT.getTime() + 1000);

function get(path: string, key: string = API_KEYS.operator) {
  return new NextRequest(`http://test.local${path}`, {
    headers: { [API_KEY_HEADER]: key },
  });
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

const created: string[] = [];

afterEach(async () => {
  // These drafts are never audited, so delete is safe (AGENTS.md gotcha).
  if (created.length === 0) return;
  await prisma.payment.deleteMany({ where: { id: { in: [...created] } } });
  created.length = 0;
});

async function seed(opts: Parameters<typeof createDraftPayment>[0]) {
  const payment = await createDraftPayment(opts);
  created.push(payment.id);
  return payment;
}

describe("GET /api/payments hides pre-re-genesis ForteL2 rows", () => {
  it("drops wiped-chain legs and keeps post-wipe plus other networks", async () => {
    const hiddenSource = await seed({
      sourceNetwork: "fortel2-sepolia",
      destinationNetwork: "base-sepolia",
      createdAt: BEFORE,
    });
    const hiddenDest = await seed({
      sourceNetwork: "base-sepolia",
      destinationNetwork: "fortel2-sepolia",
      createdAt: BEFORE,
    });
    const visibleAfter = await seed({
      sourceNetwork: "fortel2-sepolia",
      destinationNetwork: "fortel2-sepolia",
      createdAt: AFTER,
    });
    const visibleOther = await seed({
      sourceNetwork: "base-sepolia",
      destinationNetwork: "base-sepolia",
      createdAt: BEFORE,
    });

    const res = await paymentsGET(get("/api/payments?limit=200"));
    expect(res.status).toBe(200);
    const ids = ((await res.json()).payments as { id: string }[]).map((p) => p.id);

    expect(ids).not.toContain(hiddenSource.id);
    expect(ids).not.toContain(hiddenDest.id);
    expect(ids).toContain(visibleAfter.id);
    expect(ids).toContain(visibleOther.id);
  });

  it("still returns a hidden payment by id", async () => {
    const hidden = await seed({
      sourceNetwork: "fortel2-sepolia",
      destinationNetwork: "fortel2-sepolia",
      createdAt: BEFORE,
    });

    const res = await paymentGET(get(`/api/payments/${hidden.id}`), routeParams(hidden.id));
    expect(res.status).toBe(200);
    expect((await res.json()).payment.id).toBe(hidden.id);
  });

  it("rejects a tenant cursor that points at a hidden in-scope row", async () => {
    const hidden = await seed({
      sourceNetwork: "fortel2-sepolia",
      destinationNetwork: "fortel2-sepolia",
      createdAt: BEFORE,
    });

    const res = await paymentsGET(
      get(`/api/payments?cursor=${hidden.id}`, API_KEYS.entities.ent_acme_us),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error_code: "invalid_request" });
  });
});
