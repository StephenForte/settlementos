// Property tests for npm run seed:demo against a *populated* fixture DB.
// Does NOT delete audited payments (AGENTS.md: that breaks the suite chain).
// Restores entity columns + the fixture ENTITY API key after mutations so later
// files that use API_KEYS.entities.* keep working.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db";
import { audit, verifyAuditChain } from "@/lib/audit";
import { hashKey } from "@/lib/auth";
import { ROOT, CHAIN_DIR, API_KEYS } from "../fixture";

const SEED = path.join(ROOT, "scripts", "seed-demo.mjs");

function runSeed(extraArgs: string[] = [], envOverrides: Record<string, string> = {}) {
  return execFileSync(process.execPath, [SEED, ...extraArgs], {
    cwd: ROOT,
    env: {
      ...process.env,
      SETTLEMENTOS_CHAIN_DIR: CHAIN_DIR,
      ...envOverrides,
    },
    encoding: "utf8",
  });
}

async function restoreFixtureEntityState() {
  await prisma.entity.update({
    where: { externalId: "ent_acme_us" },
    data: {
      kybStatus: "PASSED",
      riskRating: "LOW",
      mmfEligible: true,
      mmfOptIn: true,
    },
  });
  await prisma.entity.update({
    where: { externalId: "ent_osaka_parts" },
    data: {
      kybStatus: "PENDING",
      riskRating: "MEDIUM",
      mmfEligible: false,
      mmfOptIn: false,
    },
  });

  const acme = await prisma.entity.findUniqueOrThrow({ where: { externalId: "ent_acme_us" } });
  const existing = await prisma.apiKey.findFirst({
    where: { role: "ENTITY", entityId: acme.id },
  });
  const wantHash = hashKey(API_KEYS.entities.ent_acme_us);
  if (!existing || existing.keyHash !== wantHash) {
    if (existing) await prisma.apiKey.delete({ where: { id: existing.id } });
    await prisma.apiKey.create({
      data: {
        keyHash: wantHash,
        role: "ENTITY",
        entityId: acme.id,
        label: "ACME US Inc API key",
      },
    });
  }
}

afterEach(async () => {
  await restoreFixtureEntityState();
});

describe("seed:demo populated-database safety", () => {
  it("leaves payments, audit events, and checkpoints untouched; chain stays INTACT", async () => {
    const beforePayments = await prisma.payment.count();
    const beforeEvents = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
    const beforeCheckpoints = await prisma.auditCheckpoint.findMany({
      orderBy: { id: "asc" },
    });

    const marker = await audit("test.seed_demo_safety", { probe: true });
    const integrityBefore = await verifyAuditChain();
    expect(integrityBefore.valid).toBe(true);

    runSeed();
    runSeed();

    expect(await prisma.payment.count()).toBe(beforePayments);
    const afterEvents = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
    for (const ev of beforeEvents) {
      const still = afterEvents.find((a) => a.id === ev.id);
      expect(still?.hash).toBe(ev.hash);
      expect(still?.prevHash).toBe(ev.prevHash);
      expect(still?.detail).toBe(ev.detail);
    }
    expect(afterEvents.some((e) => e.id === marker.id && e.hash === marker.hash)).toBe(true);

    const afterCheckpoints = await prisma.auditCheckpoint.findMany({
      orderBy: { id: "asc" },
    });
    expect(afterCheckpoints.map((c) => c.id)).toEqual(beforeCheckpoints.map((c) => c.id));
    for (const cp of beforeCheckpoints) {
      const still = afterCheckpoints.find((c) => c.id === cp.id);
      expect(still?.chainHash).toBe(cp.chainHash);
      expect(still?.signature).toBe(cp.signature);
    }

    await expect(verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });

  it("does not clobber operator KYB / MMF decisions on a default re-run", async () => {
    await prisma.entity.update({
      where: { externalId: "ent_osaka_parts" },
      data: {
        kybStatus: "PASSED",
        riskRating: "LOW",
        mmfEligible: true,
        mmfOptIn: true,
      },
    });
    await prisma.entity.update({
      where: { externalId: "ent_acme_us" },
      data: { mmfOptIn: false },
    });

    const out1 = runSeed();
    expect(out1).toMatch(/already present, unchanged/);
    const out2 = runSeed();
    expect(out2).toMatch(/already present, unchanged/);

    const osaka = await prisma.entity.findUniqueOrThrow({
      where: { externalId: "ent_osaka_parts" },
    });
    const acme = await prisma.entity.findUniqueOrThrow({
      where: { externalId: "ent_acme_us" },
    });
    expect(osaka).toMatchObject({
      kybStatus: "PASSED",
      riskRating: "LOW",
      mmfEligible: true,
      mmfOptIn: true,
    });
    expect(acme.mmfOptIn).toBe(false);
  });

  it("--refresh-entities overwrites columns only when passed, after naming them", async () => {
    await prisma.entity.update({
      where: { externalId: "ent_acme_us" },
      data: { mmfOptIn: false },
    });

    const without = runSeed();
    expect(without).not.toMatch(/REFRESH ent_acme_us/);
    expect(
      (await prisma.entity.findUniqueOrThrow({ where: { externalId: "ent_acme_us" } })).mmfOptIn
    ).toBe(false);

    const withFlag = runSeed(["--refresh-entities"]);
    expect(withFlag).toMatch(/REFRESH ent_acme_us: overwriting columns:.*mmfOptIn/);
    expect(withFlag).toMatch(/mmfOptIn: false → true/);
    expect(
      (await prisma.entity.findUniqueOrThrow({ where: { externalId: "ent_acme_us" } })).mmfOptIn
    ).toBe(true);
  });

  it("still registers a missing wallet and mints a missing ENTITY key for an existing entity", async () => {
    const acme = await prisma.entity.findUniqueOrThrow({
      where: { externalId: "ent_acme_us" },
    });

    const networkId = "polygon-amoy";
    await prisma.wallet.deleteMany({ where: { entityId: acme.id, network: networkId } });
    await prisma.apiKey.deleteMany({ where: { role: "ENTITY", entityId: acme.id } });

    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-seed-overlay-"));
    const overlay = {
      networks: {
        [networkId]: {
          chainId: 80002,
          rpcUrl: "https://rpc-amoy.polygon.technology",
          contracts: {
            PaymentSettlement: "0x9d8b8b7c476ab02306046f3da719d380fa0456aa",
            tokens: {
              mockUSDC: { address: "0x2066738d535681d28d0841cc2503c1c531d4d6aa", decimals: 6 },
            },
          },
          accounts: {
            operator: {
              address: "0x5128889f20ec13e0be38b2bebc568594159b652d",
              privateKeyEnv: "DEPLOYER_PRIVATE_KEY",
            },
            treasury: {
              address: "0x1111111111111111111111111111111111111111",
              privateKey: "0x" + "ab".repeat(32),
            },
            entityWallets: {
              ent_acme_us: {
                address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                privateKey: "0x" + "cd".repeat(32),
              },
              ent_tokyo_supplier: {
                address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                privateKey: "0x" + "ef".repeat(32),
              },
              ent_sg_supplier: {
                address: "0xcccccccccccccccccccccccccccccccccccccccc",
                privateKey: "0x" + "11".repeat(32),
              },
              ent_osaka_parts: {
                address: "0xdddddddddddddddddddddddddddddddddddddddd",
                privateKey: "0x" + "22".repeat(32),
              },
            },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(secretsDir, `deployments.${networkId}.json`),
      JSON.stringify(overlay)
    );

    const emptyChain = fs.mkdtempSync(path.join(os.tmpdir(), "sos-empty-chain-"));
    const out = runSeed([], {
      SETTLEMENTOS_CHAIN_DIR: emptyChain,
      SETTLEMENTOS_SECRET_OVERLAY_DIR: secretsDir,
    });

    expect(out).toContain(`${networkId} ← ${path.resolve(secretsDir)}`);
    expect(out).toMatch(/entity ent_acme_us: already present, unchanged/);
    expect(out).toMatch(/NEW API keys/);

    const wallet = await prisma.wallet.findUnique({
      where: { entityId_network: { entityId: acme.id, network: networkId } },
    });
    expect(wallet?.address.toLowerCase()).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const key = await prisma.apiKey.findFirst({
      where: { role: "ENTITY", entityId: acme.id },
    });
    expect(key).not.toBeNull();
  });

  it("exits non-zero on unknown arguments", () => {
    try {
      execFileSync(process.execPath, [SEED, "--not-a-real-flag"], {
        cwd: ROOT,
        env: { ...process.env, SETTLEMENTOS_CHAIN_DIR: CHAIN_DIR },
        encoding: "utf8",
      });
      expect.fail("expected non-zero exit");
    } catch (err) {
      const e = err as { status?: number; stderr?: string; stdout?: string; message?: string };
      expect(e.status).toBe(1);
      const text = `${e.stderr ?? ""}${e.stdout ?? ""}${e.message ?? ""}`;
      expect(text).toMatch(/Unknown argument: --not-a-real-flag/);
    }
  });
});
