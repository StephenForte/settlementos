import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ensureAdminCredential, verifyAdminLogin, verifyPassword } from "@/lib/admin-auth";

const ENV_KEYS = ["ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_API_KEY"] as const;

function setAdminEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    process.env[key] = values[key] ?? "";
  }
}

afterEach(async () => {
  setAdminEnv({});
  await prisma.adminCredential.deleteMany();
});

describe("AdminCredential bootstrap (AD1)", () => {
  it("seeds from env when no row exists", async () => {
    setAdminEnv({ ADMIN_USERNAME: "operator", ADMIN_PASSWORD: "first-password" });

    const row = await ensureAdminCredential();
    expect(row).not.toBeNull();
    expect(row!.username).toBe("operator");
    expect(row!.passwordHash).toMatch(/^[0-9a-f]+$/i);
    expect(row!.salt).toMatch(/^[0-9a-f]+$/i);
    expect(row!.passwordHash).not.toBe("first-password");

    await expect(verifyPassword("first-password", row!.passwordHash, row!.salt)).resolves.toBe(true);
    await expect(verifyAdminLogin("operator", "first-password")).resolves.toBe(true);
  });

  it("ignores env when a row already exists", async () => {
    setAdminEnv({ ADMIN_USERNAME: "operator", ADMIN_PASSWORD: "first-password" });
    const seeded = await ensureAdminCredential();
    expect(seeded?.username).toBe("operator");

    setAdminEnv({ ADMIN_USERNAME: "intruder", ADMIN_PASSWORD: "changed-on-deploy" });
    const again = await ensureAdminCredential();

    expect(again!.id).toBe(seeded!.id);
    expect(again!.username).toBe("operator");
    expect(again!.passwordHash).toBe(seeded!.passwordHash);
    expect(again!.salt).toBe(seeded!.salt);
    expect(await prisma.adminCredential.count()).toBe(1);

    await expect(verifyAdminLogin("operator", "first-password")).resolves.toBe(true);
    await expect(verifyAdminLogin("operator", "changed-on-deploy")).resolves.toBe(false);
    await expect(verifyAdminLogin("intruder", "changed-on-deploy")).resolves.toBe(false);
  });

  it("does not seed when bootstrap env is missing", async () => {
    setAdminEnv({});
    await expect(ensureAdminCredential()).resolves.toBeNull();
    expect(await prisma.adminCredential.count()).toBe(0);
  });
});
