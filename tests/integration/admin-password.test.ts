import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as changePasswordPOST } from "@/app/api/admin/password/route";
import { POST as sessionPOST } from "@/app/api/auth/session/route";
import { API_KEY_HEADER } from "@/lib/auth";
import { ADMIN_CREDENTIAL_ID, ensureAdminCredential, verifyPassword } from "@/lib/admin-auth";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";

const ENV_KEYS = ["ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_API_KEY"] as const;

function setAdminEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    process.env[key] = values[key] ?? "";
  }
}

function changeRequest(body: unknown, key: string) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://test.local/api/admin/password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [API_KEY_HEADER]: key,
    },
    body: raw,
    ...({ duplex: "half" } as object),
  });
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

async function seedCredential(password = "correct-horse") {
  setAdminEnv({
    ADMIN_USERNAME: "operator",
    ADMIN_PASSWORD: password,
    ADMIN_API_KEY: API_KEYS.operator,
  });
  const row = await ensureAdminCredential();
  if (!row) throw new Error("failed to seed AdminCredential");
  return row;
}

afterEach(async () => {
  setAdminEnv({});
  await prisma.adminCredential.deleteMany();
});

describe("POST /api/admin/password", () => {
  it("rejects a wrong current_password and leaves the stored hash unchanged", async () => {
    const before = await seedCredential("correct-horse");
    expect(await prisma.adminCredential.count()).toBe(1);

    const res = await changePasswordPOST(
      changeRequest({ current_password: "wrong-horse", new_password: "should-not-land" }, API_KEYS.operator)
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error_code: "unauthorized", message: "unauthorized" });

    const after = await prisma.adminCredential.findUniqueOrThrow({ where: { id: ADMIN_CREDENTIAL_ID } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.salt).toBe(before.salt);
    expect(await prisma.adminCredential.count()).toBe(1);
    await expect(verifyPassword("correct-horse", after.passwordHash, after.salt)).resolves.toBe(true);
    await expect(verifyPassword("should-not-land", after.passwordHash, after.salt)).resolves.toBe(false);
  });

  it("accepts the current password, rotates the salt, keeps a single row, and switches session login", async () => {
    const before = await seedCredential("correct-horse");
    expect(await prisma.adminCredential.count()).toBe(1);

    const res = await changePasswordPOST(
      changeRequest({ current_password: "correct-horse", new_password: "new-correct-horse" }, API_KEYS.operator)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await prisma.adminCredential.count()).toBe(1);
    const after = await prisma.adminCredential.findUniqueOrThrow({ where: { id: ADMIN_CREDENTIAL_ID } });
    expect(after.id).toBe(ADMIN_CREDENTIAL_ID);
    expect(after.salt).not.toBe(before.salt);
    expect(after.passwordHash).not.toBe(before.passwordHash);

    const oldLogin = await sessionPOST(sessionRequest({ username: "operator", password: "correct-horse" }));
    expect(oldLogin.status).toBe(401);
    expect(await oldLogin.text()).toBe('{"error_code":"unauthorized","message":"invalid credentials"}');

    const newLogin = await sessionPOST(sessionRequest({ username: "operator", password: "new-correct-horse" }));
    expect(newLogin.status).toBe(200);
    expect(await newLogin.json()).toEqual({ role: "OPERATOR", label: "Platform operator" });
  });

  it("authenticates a new_password ending in a space and rejects the trimmed form", async () => {
    await seedCredential("correct-horse");

    const res = await changePasswordPOST(
      changeRequest({ current_password: "correct-horse", new_password: "new pass " }, API_KEYS.operator)
    );
    expect(res.status).toBe(200);
    expect(await prisma.adminCredential.count()).toBe(1);

    const withSpace = await sessionPOST(sessionRequest({ username: "operator", password: "new pass " }));
    expect(withSpace.status).toBe(200);

    const trimmed = await sessionPOST(sessionRequest({ username: "operator", password: "new pass" }));
    expect(trimmed.status).toBe(401);
  });

  it("refuses REVIEWER and ENTITY keys", async () => {
    await seedCredential("correct-horse");
    const body = { current_password: "correct-horse", new_password: "should-not-land" };

    const reviewer = await changePasswordPOST(changeRequest(body, API_KEYS.reviewer));
    expect(reviewer.status).toBe(403);
    expect(await reviewer.json()).toEqual({ error_code: "forbidden", message: "forbidden" });

    const entity = await changePasswordPOST(changeRequest(body, API_KEYS.entities.ent_acme_us));
    expect(entity.status).toBe(403);
    expect(await entity.json()).toEqual({ error_code: "forbidden", message: "forbidden" });

    expect(await prisma.adminCredential.count()).toBe(1);
    const row = await prisma.adminCredential.findUniqueOrThrow({ where: { id: ADMIN_CREDENTIAL_ID } });
    await expect(verifyPassword("correct-horse", row.passwordHash, row.salt)).resolves.toBe(true);
  });

  it("rejects an empty new_password without writing", async () => {
    const before = await seedCredential("correct-horse");

    const empty = await changePasswordPOST(
      changeRequest({ current_password: "correct-horse", new_password: "" }, API_KEYS.operator)
    );
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error_code: "invalid_request" });

    const missing = await changePasswordPOST(
      changeRequest({ current_password: "correct-horse" }, API_KEYS.operator)
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error_code: "invalid_request" });

    const after = await prisma.adminCredential.findUniqueOrThrow({ where: { id: ADMIN_CREDENTIAL_ID } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.salt).toBe(before.salt);
    expect(await prisma.adminCredential.count()).toBe(1);
  });

  it("returns 500 (not 401) when no credential row exists", async () => {
    setAdminEnv({ ADMIN_API_KEY: API_KEYS.operator });
    expect(await prisma.adminCredential.count()).toBe(0);

    const res = await changePasswordPOST(
      changeRequest({ current_password: "anything", new_password: "whatever" }, API_KEYS.operator)
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error_code: "internal",
      message: "admin session is not configured",
    });
    expect(await prisma.adminCredential.count()).toBe(0);
  });
});
