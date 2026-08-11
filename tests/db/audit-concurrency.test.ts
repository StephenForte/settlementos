import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { audit, auditTestHooks, verifyAuditChain } from "@/lib/audit";

// Concurrent appenders under Postgres READ COMMITTED can fork the chain unless
// lockAuditChain serializes tip-read-plus-create. This test is the proof that
// the advisory lock holds the invariant SQLite's write lock used to give us.

const N = 40;

async function clearChain() {
  await prisma.auditCheckpoint.deleteMany();
  await prisma.auditEvent.deleteMany();
}

beforeAll(clearChain);
afterAll(clearChain);
afterEach(() => {
  delete auditTestHooks.skipChainLock;
});

describe("audit chain concurrency under Postgres", () => {
  it(`keeps the chain INTACT across ${N} concurrent audit() calls`, async () => {
    await clearChain();

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => audit("test.concurrent", { i }))
    );

    expect(results).toHaveLength(N);
    expect(new Set(results.map((e) => e.id)).size).toBe(N);

    const events = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
    expect(events).toHaveLength(N);

    // Structural: each prevHash is unique (no fork) and links to the prior tip.
    const prevHashes = events.map((e) => e.prevHash);
    expect(new Set(prevHashes).size).toBe(N);
    expect(events[0].prevHash).toBe("GENESIS");
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prevHash).toBe(events[i - 1].hash);
    }

    await expect(verifyAuditChain()).resolves.toMatchObject({
      valid: true,
      eventsVerified: N,
    });
  });
});
