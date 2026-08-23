// Page-side auth helpers. Server components read Prisma directly (no Request),
// so tenant isolation lives here — API route tests do not cover this module.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  paymentScopeWhere,
  visiblePaymentsWhere,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/session";
import { excludeSupersededByRegenesisWhere } from "@/lib/networks";
import type { Principal } from "@/lib/auth";

const operator: Principal = { keyId: "k_op", role: "OPERATOR", label: "op" };
const reviewer: Principal = { keyId: "k_rev", role: "REVIEWER", label: "rev" };
const entity: Principal = {
  keyId: "k_ent",
  role: "ENTITY",
  entityId: "ent_row_1",
  label: "acme",
};

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("visiblePaymentsWhere", () => {
  it("AND-composes tenant scope with the post-re-genesis hide", () => {
    expect(visiblePaymentsWhere(entity)).toEqual({
      AND: [paymentScopeWhere(entity), excludeSupersededByRegenesisWhere()],
    });
    expect(visiblePaymentsWhere(operator)).toEqual({
      AND: [{}, excludeSupersededByRegenesisWhere()],
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
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionCookieOptions().secure).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieOptions().secure).toBe(true);
  });
});
