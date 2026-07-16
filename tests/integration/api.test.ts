// API route handlers invoked directly (no HTTP server) — validation contracts
// and the network-availability endpoint.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET as networksGET } from "@/app/api/networks/route";
import { POST as paymentsPOST } from "@/app/api/payments/route";
import { prisma } from "@/lib/db";
import { API_KEY_HEADER } from "@/lib/auth";
import { API_KEYS } from "../fixture";

function postJson(body: Record<string, unknown>, key: string = API_KEYS.operator) {
  return new NextRequest("http://test.local/api/payments", {
    method: "POST",
    headers: { "content-type": "application/json", [API_KEY_HEADER]: key },
    body: JSON.stringify(body),
    // undici requires duplex when a body is present on a constructed Request
    ...({ duplex: "half" } as object),
  });
}

const VALID = {
  sender_id: "ent_acme_us",
  recipient_id: "ent_tokyo_supplier",
  amount: "100000.00",
  source_currency: "USD",
  destination_currency: "JPY",
  source_network: "base-local",
  destination_network: "base-local",
  purpose: "supplier_payment",
  reference_id: "INV-API-TEST",
};

describe("GET /api/networks", () => {
  it("reports local networks as available and the real testnets as not deployed in tests", async () => {
    const res = await networksGET();
    const { networks } = await res.json();

    const byId = Object.fromEntries(networks.map((n: { id: string }) => [n.id, n]));
    expect(byId["base-local"]).toMatchObject({ available: true, live: false });
    expect(byId["polygon-local"]).toMatchObject({ available: true });
    expect(byId["base-sepolia"]).toMatchObject({
      available: false,
      live: true,
      explorer_url: "https://sepolia.basescan.org",
    });
    expect(byId["polygon-amoy"]).toMatchObject({
      available: false,
      live: true,
      explorer_url: "https://amoy.polygonscan.com",
    });
  });
});

describe("POST /api/payments", () => {
  it("creates a DRAFT payment and audits it", async () => {
    const res = await paymentsPOST(postJson(VALID));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.status).toBe("DRAFT");

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: data.payment_id } });
    expect(payment.sourceAsset).toBe("mockUSDC");
    expect(payment.destinationAsset).toBe("mockJPY");

    const audits = await prisma.auditEvent.findMany({ where: { paymentId: data.payment_id } });
    expect(audits.map((a) => a.action)).toContain("payment.created");
  });

  it("rejects unknown networks", async () => {
    const res = await paymentsPOST(postJson({ ...VALID, source_network: "arbitrum-one" }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/unknown network/);
  });

  it("rejects registered-but-undeployed networks with a actionable hint", async () => {
    // The real testnets are in the registry but not in the test fixture's deployments.
    const res = await paymentsPOST(postJson({ ...VALID, destination_network: "base-sepolia" }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/no deployed contracts.*deploy:base-sepolia/);

    const amoy = await paymentsPOST(postJson({ ...VALID, destination_network: "polygon-amoy" }));
    expect(amoy.status).toBe(400);
    expect((await amoy.json()).message).toMatch(/no deployed contracts.*deploy:polygon-amoy/);
  });

  it("rejects missing required fields", async () => {
    const res = await paymentsPOST(postJson({ sender_id: "ent_acme_us" }));
    expect(res.status).toBe(400);
  });

  it("rejects non-positive and non-numeric amounts", async () => {
    for (const amount of ["-5", "0", "abc"]) {
      const res = await paymentsPOST(postJson({ ...VALID, amount }));
      expect(res.status, `amount=${amount}`).toBe(400);
    }
  });

  it("rejects amounts the API boundary must not coerce", async () => {
    // Number() would take all of these; the canonical grammar does not.
    for (const amount of ["1e6", "Infinity", "NaN", "+100.00", " 100.00", 100000, "1000000000000000.00"]) {
      const res = await paymentsPOST(postJson({ ...VALID, amount }));
      expect(res.status, `amount=${JSON.stringify(amount)}`).toBe(400);
      expect((await res.json()).error_code).toBe("invalid_request");
    }
  });

  it("rejects precision the destination currency cannot hold", async () => {
    const res = await paymentsPOST(
      postJson({ ...VALID, source_currency: "JPY", destination_currency: "JPY", amount: "25000.001" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/whole numbers/);
  });

  it("stores the canonical string form of an accepted amount", async () => {
    const res = await paymentsPOST(postJson({ ...VALID, amount: "1234.5" }));
    expect(res.status).toBe(201);
    const { payment_id } = await res.json();
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: payment_id } });
    expect(payment.amount).toBe("1234.50");
  });

  it("rejects unsupported currencies but allows same-currency transfers", async () => {
    const badCurrency = await paymentsPOST(postJson({ ...VALID, source_currency: "EUR" }));
    expect(badCurrency.status).toBe(400);
    expect((await badCurrency.json()).message).toMatch(/unsupported currency/);

    // Whole yen, not the USD-shaped "100000.00" this used to send: JPY has no
    // minor unit, so two decimal places is now a 400 (see money.test.ts).
    const sameCurrency = await paymentsPOST(
      postJson({ ...VALID, source_currency: "JPY", destination_currency: "JPY", amount: "100000" })
    );
    expect(sameCurrency.status).toBe(201);
  });

  it("rejects unknown entities", async () => {
    const res = await paymentsPOST(postJson({ ...VALID, sender_id: "ent_ghost" }));
    expect(res.status).toBe(404);
  });
});
