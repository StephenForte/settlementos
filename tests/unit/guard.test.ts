// Pure authorization and scrubbing decisions from app/api/guard.ts. Route tests
// exercise these through handlers; this locks the 404-vs-403 matrix and the
// "never mutate the prisma row" scrub copies.

import { describe, it, expect } from "vitest";
import {
  authorizePaymentWrite,
  scrubAuditDetail,
  scrubFailureReason,
} from "@/app/api/guard";
import { SAFE_FAILURE_SUMMARY } from "@/lib/api-errors";
import type { Principal } from "@/lib/auth";

const operator: Principal = { keyId: "k_op", role: "OPERATOR", label: "op" };
const reviewer: Principal = { keyId: "k_rev", role: "REVIEWER", label: "rev" };
const sender: Principal = {
  keyId: "k_sender",
  role: "ENTITY",
  entityId: "ent_sender",
  label: "sender",
};
const recipient: Principal = {
  keyId: "k_recipient",
  role: "ENTITY",
  entityId: "ent_recipient",
  label: "recipient",
};
const stranger: Principal = {
  keyId: "k_stranger",
  role: "ENTITY",
  entityId: "ent_other",
  label: "stranger",
};

const payment = { senderId: "ent_sender", recipientId: "ent_recipient" };

async function bodyOf(res: Response) {
  return res.json() as Promise<{ error_code: string; message: string }>;
}

describe("authorizePaymentWrite", () => {
  it("admits the OPERATOR and the sender", () => {
    expect(authorizePaymentWrite(operator, payment)).toBeNull();
    expect(authorizePaymentWrite(sender, payment)).toBeNull();
  });

  it("403s a REVIEWER and the recipient — they may watch, not drive", async () => {
    for (const principal of [reviewer, recipient]) {
      const res = authorizePaymentWrite(principal, payment)!;
      expect(res.status).toBe(403);
      expect(await bodyOf(res)).toMatchObject({ error_code: "forbidden" });
    }
  });

  it("404s a foreign ENTITY the same way a missing id would", async () => {
    const res = authorizePaymentWrite(stranger, payment)!;
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toMatchObject({ error_code: "not_found" });
  });
});

describe("scrubFailureReason", () => {
  it("leaves platform roles and null reasons untouched", () => {
    const withReason = { failureReason: "Insufficient mockJPY on polygon-local" };
    expect(scrubFailureReason(operator, withReason)).toBe(withReason);
    expect(scrubFailureReason(sender, { failureReason: null })).toEqual({ failureReason: null });
  });

  it("replaces a tenant-visible reason with the safe summary, without mutating", () => {
    const paymentRow = { failureReason: "rpc https://secret.example timed out" };
    const scrubbed = scrubFailureReason(sender, paymentRow);
    expect(scrubbed.failureReason).toBe(SAFE_FAILURE_SUMMARY);
    expect(paymentRow.failureReason).toBe("rpc https://secret.example timed out");
    expect(scrubbed).not.toBe(paymentRow);
  });
});

describe("scrubAuditDetail", () => {
  it("returns the same array for platform roles", () => {
    const events = [{ detail: '{"reason":"secret"}' }];
    expect(scrubAuditDetail(operator, events)).toBe(events);
  });

  it("redacts detail for tenants as valid JSON and does not mutate the input", () => {
    const events = [
      { id: 1, detail: '{"reason":"Insufficient mockJPY"}' },
      { id: 2, detail: '{"rpc":"https://secret.example"}' },
    ];
    const scrubbed = scrubAuditDetail(sender, events);

    expect(scrubbed).toHaveLength(2);
    for (const e of scrubbed) {
      expect(JSON.parse(e.detail)).toEqual({ redacted: true });
    }
    expect(events[0].detail).toContain("mockJPY");
    expect(scrubbed[0]).not.toBe(events[0]);
  });
});
