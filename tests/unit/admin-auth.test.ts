import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/admin-auth";

describe("scrypt password verify", () => {
  it("accepts the matching password and rejects a wrong one", async () => {
    const salt = randomBytes(16);
    const hash = (await hashPassword("correct", salt)).toString("hex");
    const saltHex = salt.toString("hex");

    await expect(verifyPassword("correct", hash, saltHex)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash, saltHex)).resolves.toBe(false);
  });

  it("rejects a tampered hash", async () => {
    const salt = randomBytes(16);
    const hash = (await hashPassword("correct", salt)).toString("hex");
    const tampered = `${hash.startsWith("aa") ? "bb" : "aa"}${hash.slice(2)}`;

    await expect(verifyPassword("correct", tampered, salt.toString("hex"))).resolves.toBe(false);
  });

  it("rejects a tampered salt", async () => {
    const salt = randomBytes(16);
    const hash = (await hashPassword("correct", salt)).toString("hex");
    const saltHex = salt.toString("hex");
    const tampered = `${saltHex.startsWith("aa") ? "bb" : "aa"}${saltHex.slice(2)}`;

    await expect(verifyPassword("correct", hash, tampered)).resolves.toBe(false);
  });
});
