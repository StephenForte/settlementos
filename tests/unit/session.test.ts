// Page-side auth helpers. Server components read Prisma directly (no Request),
// so tenant isolation lives here — API route tests do not cover this module.

import { describe, it, expect, afterEach } from "vitest";
import {
  paymentScopeWhere,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/session";
import type { Principal } from "@/lib/auth";

const operator: Principal = { keyId: "k_op", role: "OPERATOR", label: "op" };
const reviewer: Principal = { keyId: "k_rev", role: "REVIEWER", label: "rev" };
const entity: Principal = {
  keyId: "k_ent",
  role: "ENTITY",
  entityId: "ent_row_1",
  label: "acme",
};

const previousNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = previousNodeEnv;
});

describe("paymentScopeWhere", () => {
  it("lets platform roles see every payment", () => {
    expect(paymentScopeWhere(operator)).toEqual({});
    expect(paymentScopeWhere(reviewer)).toEqual({});
  });

  it("scopes an ENTITY to payments it sends or receives", () => {
    expect(paymentScopeWhere(entity)).toEqual({
      OR: [{ senderId: "ent_row_1" }, { recipientId: "ent_row_1" }],
    });
  });
});

describe("sessionCookieOptions", () => {
  it("is httpOnly, lax, path-rooted, and lasts one week", () => {
    expect(sessionCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 7);
  });

  it("forces Secure only off localhost (production)", () => {
    process.env.NODE_ENV = "development";
    expect(sessionCookieOptions().secure).toBe(false);

    process.env.NODE_ENV = "production";
    expect(sessionCookieOptions().secure).toBe(true);
  });
});
