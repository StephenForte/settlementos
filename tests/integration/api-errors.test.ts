// US-005: what a caller is allowed to see when something goes wrong.
//
// The route handlers are invoked directly (no HTTP server), same as the other
// api tests. The load-bearing assertion is the negative one: a failed execute
// must not echo the executor's thrown message, which names assets, networks,
// and free balances — and on a real network would name contract addresses and
// RPC URLs.

import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as executePOST } from "@/app/api/payments/[id]/execute/route";
import { GET as paymentGET } from "@/app/api/payments/[id]/route";
import { GET as paymentsGET, POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as quotePOST } from "@/app/api/payments/[id]/quote/route";
import { prisma } from "@/lib/db";
import { API_KEY_HEADER } from "@/lib/auth";
import { SAFE_FAILURE_SUMMARY, ApiError, apiError, fromThrown } from "@/lib/api-errors";
import { API_KEYS } from "../fixture";
import { createApprovedPayment, createDraftPayment } from "../helpers/payments";

function req(url: string, key: string, method = "POST") {
  return new NextRequest(url, { method, headers: { [API_KEY_HEADER]: key } });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

// The executor logs the real error by design; keep the suite output readable.
afterEach(() => vi.restoreAllMocks());

describe("lib/api-errors", () => {
  it("maps each code to its status and a canned message", () => {
    expect(apiError("unauthorized")).toEqual({
      status: 401,
      body: { error_code: "unauthorized", message: "unauthorized" },
    });
    expect(apiError("conflict").status).toBe(409);
    expect(apiError("execution_failed").status).toBe(500);
    expect(apiError("invalid_request", "amount must be positive").body).toEqual({
      error_code: "invalid_request",
      message: "amount must be positive",
    });
  });

  it("swallows a thrown error's message and logs it server-side", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("connect ECONNREFUSED http://127.0.0.1:9545 at 0xdeadbeef");

    const { status, body } = fromThrown(boom, "execution_failed", "test");

    expect(status).toBe(500);
    expect(body).toEqual({ error_code: "execution_failed", message: "execution failed" });
    expect(JSON.stringify(body)).not.toMatch(/9545|0xdeadbeef|ECONNREFUSED/);
    expect(spy).toHaveBeenCalledWith("[api:test]", boom); // the detail is not lost, just not shipped
  });

  it("passes an ApiError's own message through — a route chose it deliberately", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = fromThrown(new ApiError("conflict", "payment already settled"), "internal", "test");
    expect(status).toBe(409);
    expect(body).toEqual({ error_code: "conflict", message: "payment already settled" });
  });
});

describe("POST /api/payments/[id]/execute — failure is opaque to the caller", () => {
  it("returns execution_failed with no internals in the body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // $800k → ~125M JPY, over the treasury's 100M mockJPY: the executor throws
    // "Insufficient mockJPY liquidity on base-local: need X, available Y".
    const payment = await createApprovedPayment({ amount: "800000.00" });

    const res = await executePOST(
      req(`http://test.local/api/payments/${payment.id}/execute`, API_KEYS.operator),
      ctx(payment.id)
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error_code).toBe("execution_failed");
    expect(body.message).toBe("execution failed");
    // The caller still learns where the payment landed — that is not a leak.
    expect(body).toMatchObject({ payment_id: payment.id, status: "FAILED" });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{40}/); // no contract/wallet address
    expect(serialized).not.toMatch(/https?:\/\//); // no RPC URL
    expect(serialized).not.toMatch(/\bat\s+\w+\s+\(|\.ts:\d+/); // no stack frame
    expect(serialized).not.toMatch(/Insufficient|liquidity|available/i); // no executor detail
    expect(body.stack).toBeUndefined();
  });

  it("409s a conflict without echoing the state machine's thrown message", async () => {
    const payment = await createDraftPayment();
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "SETTLED" } });

    const res = await quotePOST(
      req(`http://test.local/api/payments/${payment.id}/quote`, API_KEYS.operator),
      ctx(payment.id)
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error_code: "conflict",
      message: "the request conflicts with the current state of the resource",
    });
  });
});

describe("POST /api/payments — malformed body", () => {
  it("400s on unparseable JSON rather than throwing out of the handler", async () => {
    const res = await paymentsPOST(
      new NextRequest("http://test.local/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json", [API_KEY_HEADER]: API_KEYS.operator },
        body: "{not json",
        ...({ duplex: "half" } as object),
      })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error_code: "invalid_request",
      message: "body must be a JSON object",
    });
  });
});

describe("failureReason redaction", () => {
  it("shows the stored detail to a platform role and a summary to the tenant", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const payment = await createApprovedPayment({ amount: "800000.00" });
    await executePOST(
      req(`http://test.local/api/payments/${payment.id}/execute`, API_KEYS.operator),
      ctx(payment.id)
    );

    const stored = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.failureReason).toMatch(/Insufficient mockJPY liquidity/); // unchanged on the row

    const asOperator = await paymentGET(
      req(`http://test.local/api/payments/${payment.id}`, API_KEYS.operator, "GET"),
      ctx(payment.id)
    );
    expect((await asOperator.json()).payment.failureReason).toBe(stored.failureReason);

    const asReviewer = await paymentGET(
      req(`http://test.local/api/payments/${payment.id}`, API_KEYS.reviewer, "GET"),
      ctx(payment.id)
    );
    expect((await asReviewer.json()).payment.failureReason).toBe(stored.failureReason);

    // The sender is party to this payment, so it may read the row — but the
    // reason names treasury balances it has no business seeing.
    const asSender = await paymentGET(
      req(`http://test.local/api/payments/${payment.id}`, API_KEYS.entities.ent_acme_us, "GET"),
      ctx(payment.id)
    );
    const seen = (await asSender.json()).payment.failureReason;
    expect(seen).toBe(SAFE_FAILURE_SUMMARY);
    expect(seen).not.toMatch(/mockJPY|liquidity|available/i);
  });

  it("redacts in the list view too, not just the detail view", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const payment = await createApprovedPayment({ amount: "800000.00" });
    await executePOST(
      req(`http://test.local/api/payments/${payment.id}/execute`, API_KEYS.operator),
      ctx(payment.id)
    );

    const res = await paymentsGET(req("http://test.local/api/payments", API_KEYS.entities.ent_acme_us, "GET"));
    const listed = (await res.json()).payments.find((p: { id: string }) => p.id === payment.id);

    expect(listed.failureReason).toBe(SAFE_FAILURE_SUMMARY);
  });
});
