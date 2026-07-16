// Login/logout route handlers invoked directly (no HTTP server) — the cookie
// exchange that lets the browser demo act as a principal.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { API_KEY_COOKIE } from "@/lib/auth";
import { API_KEYS } from "../fixture";

function login(body: Record<string, unknown>) {
  return new NextRequest("http://test.local/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // undici requires duplex when a body is present on a constructed Request
    ...({ duplex: "half" } as object),
  });
}

describe("POST /api/auth/login", () => {
  it("sets an httpOnly session cookie holding the key for a valid principal", async () => {
    const res = await loginPOST(login({ api_key: API_KEYS.operator }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "OPERATOR", label: "Platform operator" });

    const cookie = res.cookies.get(API_KEY_COOKIE);
    expect(cookie?.value).toBe(API_KEYS.operator);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
  });

  it("resolves an ENTITY key to its own tenant", async () => {
    const res = await loginPOST(login({ api_key: API_KEYS.entities.ent_acme_us }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "ENTITY" });
  });

  it("rejects an unknown key with a generic 401 and no cookie", async () => {
    const res = await loginPOST(login({ api_key: "sos_not_a_real_key" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error_code: "unauthorized", message: "invalid api key" });
    expect(res.cookies.get(API_KEY_COOKIE)).toBeUndefined();
  });

  it("gives the same generic error for a missing, empty, and non-string key", async () => {
    // No oracle: an attacker must not learn which keys exist from the shape of the error.
    for (const body of [{}, { api_key: "" }, { api_key: "   " }, { api_key: 42 }]) {
      const res = await loginPOST(login(body));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error_code: "unauthorized", message: "invalid api key" });
    }
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const res = await logoutPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signed_out: true });
    // A delete is emitted as the cookie set to empty with maxAge 0.
    expect(res.cookies.get(API_KEY_COOKIE)?.value).toBe("");
  });
});
