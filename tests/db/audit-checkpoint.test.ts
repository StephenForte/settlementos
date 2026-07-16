// Signed audit checkpoints (US-017). The chain alone catches an edit; it does
// NOT catch an attacker with DB write access who re-hashes the whole log. These
// tests are mostly about that gap: the same forged log verifies clean without an
// anchor and fails with one.
//
// Like tests/db/audit.test.ts, this file rewrites history, so it owns the table
// for its duration and leaves it empty — including the checkpoints, since an
// anchor pointing at a deleted event reads as tampering to every later test.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit, createCheckpoint, verifyAuditChain, AuditAnchorError } from "@/lib/audit";
import { FIXTURE_ENV } from "../fixture";

const INTERVAL = 3;

async function clearChain() {
  await prisma.auditCheckpoint.deleteMany();
  await prisma.auditEvent.deleteMany();
}

/** Rebuild every hash from GENESIS, exactly as the appender would — the forgery
 * an attacker with a DB connection can carry out. */
async function rehashWholeChain() {
  const events = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
  let prevHash = "GENESIS";
  for (const e of events) {
    const hash = createHash("sha256")
      .update(`${prevHash}|${e.action}|${e.actor}|${e.paymentId ?? ""}|${e.detail}`)
      .digest("hex");
    await prisma.auditEvent.update({ where: { id: e.id }, data: { prevHash, hash } });
    prevHash = hash;
  }
}

const withoutKey = async <T>(fn: () => Promise<T>): Promise<T> => {
  delete process.env.AUDIT_ANCHOR_KEY;
  try {
    return await fn();
  } finally {
    process.env.AUDIT_ANCHOR_KEY = FIXTURE_ENV.AUDIT_ANCHOR_KEY;
  }
};

beforeAll(() => {
  process.env.AUDIT_CHECKPOINT_INTERVAL = String(INTERVAL);
});
beforeEach(clearChain);
afterAll(async () => {
  delete process.env.AUDIT_CHECKPOINT_INTERVAL;
  await clearChain();
});

describe("automatic checkpoints", () => {
  it("anchors the tip every INTERVAL events and not between them", async () => {
    await audit("test.1", {});
    await audit("test.2", {});
    expect(await prisma.auditCheckpoint.count()).toBe(0);

    const third = await audit("test.3", {});
    const checkpoint = await prisma.auditCheckpoint.findFirst({ orderBy: { id: "desc" } });
    expect(checkpoint).toMatchObject({ lastEventId: third.id, chainHash: third.hash });

    await audit("test.4", {});
    await audit("test.5", {});
    expect(await prisma.auditCheckpoint.count()).toBe(1);

    const sixth = await audit("test.6", {});
    expect(await prisma.auditCheckpoint.count()).toBe(2);
    expect(await prisma.auditCheckpoint.findFirst({ orderBy: { id: "desc" } })).toMatchObject({
      lastEventId: sixth.id,
    });
  });

  it("writes no checkpoint when no anchor key is configured", async () => {
    await withoutKey(async () => {
      for (let i = 0; i < INTERVAL + 1; i++) await audit(`test.${i}`, {});
    });
    expect(await prisma.auditCheckpoint.count()).toBe(0);
  });
});

describe("incremental verification", () => {
  it("re-hashes only the events after the anchor", async () => {
    for (let i = 0; i < INTERVAL; i++) await audit(`test.${i}`, {});
    const anchored = await prisma.auditEvent.findFirst({ orderBy: { id: "desc" } });
    await audit("test.after", {});

    const result = await verifyAuditChain();
    expect(result).toMatchObject({ valid: true, mode: "incremental", anchored: true });
    // Only the one event past the anchor was re-hashed; the other INTERVAL are
    // vouched for by the signature.
    expect(result.eventsVerified).toBe(1);
    expect(result.checkpoint).toMatchObject({ lastEventId: anchored!.id });
  });

  it("still catches tampering after the anchor", async () => {
    for (let i = 0; i < INTERVAL; i++) await audit(`test.${i}`, {});
    const after = await audit("test.after", {});
    await prisma.auditEvent.update({
      where: { id: after.id },
      data: { detail: JSON.stringify({ forged: true }) },
    });

    expect(await verifyAuditChain()).toMatchObject({ valid: false, brokenAtId: after.id });
  });
});

describe("tamper detection through the signature", () => {
  it("catches a fully re-hashed history that the chain alone accepts", async () => {
    const first = await audit("test.first", { amount: "1.00" });
    for (let i = 0; i < INTERVAL; i++) await audit(`test.${i}`, {});
    expect(await verifyAuditChain()).toMatchObject({ valid: true });

    // The attacker edits an event before the checkpoint and re-hashes the whole
    // log forward, so every prev-link lines up again.
    await prisma.auditEvent.update({
      where: { id: first.id },
      data: { detail: JSON.stringify({ amount: "1000000.00" }) },
    });
    await rehashWholeChain();

    // Chain-only verification is fooled — this is the attack checkpoints exist for.
    await withoutKey(async () => {
      expect(await verifyAuditChain()).toMatchObject({ valid: true, mode: "full", anchored: false });
    });

    // The signed anchor is not: re-hashing moved the tip, and the attacker
    // cannot produce a signature over the tip they made.
    expect(await verifyAuditChain()).toMatchObject({
      valid: false,
      reason: "checkpoint_chain_hash_mismatch",
    });
  });

  it("catches a forged signature", async () => {
    for (let i = 0; i < INTERVAL; i++) await audit(`test.${i}`, {});
    const checkpoint = await prisma.auditCheckpoint.findFirst({ orderBy: { id: "desc" } });
    await prisma.auditCheckpoint.update({
      where: { id: checkpoint!.id },
      data: { signature: "0".repeat(64) },
    });

    expect(await verifyAuditChain()).toMatchObject({
      valid: false,
      reason: "checkpoint_signature_mismatch",
    });
  });

  it("catches the signed hash pasted onto an event whose content does not produce it", async () => {
    for (let i = 0; i < INTERVAL; i++) await audit(`test.${i}`, {});
    const anchor = await prisma.auditEvent.findFirst({ orderBy: { id: "desc" } });
    // Content edited, stored hash left alone: chainHash still matches the row,
    // but the row no longer hashes to it.
    await prisma.auditEvent.update({
      where: { id: anchor!.id },
      data: { detail: JSON.stringify({ forged: true }) },
    });

    expect(await verifyAuditChain()).toMatchObject({
      valid: false,
      reason: "checkpoint_anchor_forged",
      brokenAtId: anchor!.id,
    });
  });

  it("catches a deleted anchor event", async () => {
    for (let i = 0; i < INTERVAL; i++) await audit(`test.${i}`, {});
    const anchor = await prisma.auditEvent.findFirst({ orderBy: { id: "desc" } });
    await prisma.auditEvent.delete({ where: { id: anchor!.id } });

    expect(await verifyAuditChain()).toMatchObject({
      valid: false,
      reason: "checkpoint_anchor_missing",
    });
  });
});

describe("degrading without an anchor key", () => {
  it("verifies the full chain and flags that nothing is signed", async () => {
    await withoutKey(async () => {
      await audit("test.a", {});
      await audit("test.b", {});
      expect(await verifyAuditChain()).toMatchObject({
        valid: true,
        mode: "full",
        anchored: false,
        checkpoint: null,
        eventsVerified: 2,
      });
    });
  });

  it("reports full-chain mode when a key is set but nothing is anchored yet", async () => {
    await audit("test.a", {});
    expect(await verifyAuditChain()).toMatchObject({ valid: true, mode: "full", anchored: true });
  });
});

describe("checkpoints on demand", () => {
  it("anchors the current tip", async () => {
    await audit("test.a", {});
    const tip = await audit("test.b", {});

    const checkpoint = await createCheckpoint();
    expect(checkpoint).toMatchObject({ lastEventId: tip.id, chainHash: tip.hash });
    expect(await verifyAuditChain()).toMatchObject({ valid: true, mode: "incremental", eventsVerified: 0 });
  });

  it("returns the existing anchor rather than duplicating one at the same tip", async () => {
    await audit("test.a", {});
    const first = await createCheckpoint();
    const second = await createCheckpoint();

    expect(second.id).toBe(first.id);
    expect(await prisma.auditCheckpoint.count()).toBe(1);
  });

  it("refuses when there is nothing to anchor or no key to sign with", async () => {
    await expect(createCheckpoint()).rejects.toThrow(AuditAnchorError);

    await audit("test.a", {});
    await withoutKey(async () => {
      await expect(createCheckpoint()).rejects.toMatchObject({ code: "not_configured" });
    });
  });
});
