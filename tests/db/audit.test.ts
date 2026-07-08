import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { audit, verifyAuditChain } from "@/lib/audit";

// This file rewrites audit history to test tamper detection, so it owns the
// table for its duration and leaves it empty (next audit() restarts at GENESIS).
beforeAll(async () => {
  await prisma.auditEvent.deleteMany();
});
afterAll(async () => {
  await prisma.auditEvent.deleteMany();
});

describe("hash-chained audit log", () => {
  it("chains each event to the previous one's hash", async () => {
    const first = await audit("test.first", { n: 1 });
    const second = await audit("test.second", { n: 2 });
    const third = await audit("test.third", { n: 3 });

    expect(first.prevHash).toBe("GENESIS");
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    expect(new Set([first.hash, second.hash, third.hash]).size).toBe(3);
  });

  it("verifies an untampered chain as valid", async () => {
    await expect(verifyAuditChain()).resolves.toEqual({ valid: true });
  });

  it("detects tampering with an event's payload", async () => {
    const events = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
    const middle = events[1];

    await prisma.auditEvent.update({
      where: { id: middle.id },
      data: { detail: JSON.stringify({ n: 999, forged: true }) },
    });

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(middle.id);
  });

  it("detects a re-hashed forgery via the broken prev-link", async () => {
    // Attacker recomputes the tampered event's own hash to look consistent —
    // the NEXT event's prevHash no longer matches, so the chain still breaks.
    await prisma.auditEvent.deleteMany();
    const a = await audit("test.a", {});
    const b = await audit("test.b", {});
    await audit("test.c", {});

    const { createHash } = await import("node:crypto");
    const forgedDetail = JSON.stringify({ forged: true });
    const forgedHash = createHash("sha256")
      .update(`${a.hash}|test.b|system||${forgedDetail}`)
      .digest("hex");
    await prisma.auditEvent.update({
      where: { id: b.id },
      data: { detail: forgedDetail, hash: forgedHash },
    });

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
  });
});
