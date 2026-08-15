import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as sessionPOST } from "@/app/api/auth/session/route";
import { API_KEY_COOKIE, authenticate } from "@/lib/auth";
import { ensureAdminCredential } from "@/lib/admin-auth";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";

const ENV_KEYS = ["ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_API_KEY"] as const;

function setAdminEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    process.env[key] = values[key] ?? "";
  }
}

function sessionRequest(body: unknown) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://test.local/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
    ...({ duplex: "half" } as object),
  });
}

afterEach(async () => {
  setAdminEnv({});
  await prisma.adminCredential.deleteMany();
});

describe("POST /api/auth/session", () => {
  it("sets the sos_key cookie to ADMIN_API_KEY and that cookie is an OPERATOR", async () => {
    setAdminEnv({
      ADMIN_USERNAME: "operator",
      ADMIN_PASSWORD: "correct-horse",
      ADMIN_API_KEY: API_KEYS.operator,
    });

    const res = await sessionPOST(sessionRequest({ username: "operator", password: "correct-horse" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "OPERATOR", label: "Platform operator" });

    const cookie = res.cookies.get(API_KEY_COOKIE);
    expect(cookie?.value).toBe(API_KEYS.operator);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");

    const principal = await authenticate(
      new Request("http://test/api/payments", { headers: { cookie: `${API_KEY_COOKIE}=${cookie!.value}` } })
    );
    expect(principal).toMatchObject({ role: "OPERATOR", label: "Platform operator" });
  });

  it("returns byte-identical 401 bodies for unknown username, wrong password, and missing field", async () => {
    setAdminEnv({
      ADMIN_USERNAME: "operator",
      ADMIN_PASSWORD: "correct-horse",
      ADMIN_API_KEY: API_KEYS.operator,
    });
    await ensureAdminCredential();

    const [unknownUser, wrongPassword, missingField, malformed] = await Promise.all([
      sessionPOST(sessionRequest({ username: "no-such-user", password: "correct-horse" })),
      sessionPOST(sessionRequest({ username: "operator", password: "wrong-password" })),
      sessionPOST(sessionRequest({ username: "operator" })),
      sessionPOST(sessionRequest("{")),
    ]);

    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(missingField.status).toBe(401);
    expect(malformed.status).toBe(401);

    const [unknownBody, wrongBody, missingBody, malformedBody] = await Promise.all([
      unknownUser.text(),
      wrongPassword.text(),
      missingField.text(),
      malformed.text(),
    ]);

    // Byte-equality — not just the same status. A differing body is a username oracle.
    expect(unknownBody).toBe(wrongBody);
    expect(wrongBody).toBe(missingBody);
    expect(missingBody).toBe(malformedBody);
    expect(unknownBody).toBe('{"error_code":"unauthorized","message":"invalid credentials"}');

    expect(unknownUser.cookies.get(API_KEY_COOKIE)).toBeUndefined();
    expect(wrongPassword.cookies.get(API_KEY_COOKIE)).toBeUndefined();
    expect(missingField.cookies.get(API_KEY_COOKIE)).toBeUndefined();
    expect(malformed.cookies.get(API_KEY_COOKIE)).toBeUndefined();
  });

  it("fails with a 500 (not a 401) when ADMIN_API_KEY is unset or not an OPERATOR", async () => {
    setAdminEnv({
      ADMIN_USERNAME: "operator",
      ADMIN_PASSWORD: "correct-horse",
      ADMIN_API_KEY: "",
    });
    await ensureAdminCredential();

    const unset = await sessionPOST(sessionRequest({ username: "operator", password: "correct-horse" }));
    expect(unset.status).toBe(500);
    expect(await unset.json()).toEqual({
      error_code: "internal",
      message: "admin session is not configured",
    });
    expect(unset.cookies.get(API_KEY_COOKIE)).toBeUndefined();

    process.env.ADMIN_API_KEY = API_KEYS.reviewer;
    const notOperator = await sessionPOST(sessionRequest({ username: "operator", password: "correct-horse" }));
    expect(notOperator.status).toBe(500);
    expect(await notOperator.json()).toEqual({
      error_code: "internal",
      message: "admin session is not configured",
    });
    expect(notOperator.cookies.get(API_KEY_COOKIE)).toBeUndefined();
  });
});
