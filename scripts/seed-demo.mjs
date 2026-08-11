#!/usr/bin/env node
// Non-destructive, idempotent demo seed for a deployed (or shared) Postgres.
//
// Upserts demo entities + wallets from live-network overlays, and creates API
// keys only when missing. NEVER deletes payments, audit events, checkpoints,
// entities, wallets, or keys. Safe to re-run.
//
// This is NOT `npm run setup`:
//   - setup wipes the DB and refuses non-localhost DATABASE_URL
//   - this script has no wipe path and is the intended Render seed
//
// Run:  npm run seed:demo
//   or: node --env-file=.env scripts/seed-demo.mjs   (local, with .env)
//   or: node scripts/seed-demo.mjs                   (Render Shell — env already set)
//
// Requires DATABASE_URL with ?schema=settlementos. Reads overlays from
// SETTLEMENTOS_CHAIN_DIR (default ./chain) and/or SETTLEMENTOS_SECRET_OVERLAY_DIR
// (default /etc/secrets), same resolution as lib/chain.ts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { parseEnvFileText } from "./local-database-url.mjs";
import { registerEntityWallet } from "./deploy-testnet.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const LIVE_NETWORK_IDS = ["base-sepolia", "polygon-amoy", "fortel2-sepolia"];

// Keep in sync with lib/auth.ts / scripts/setup.mjs (mjs cannot import the TS module).
const generateKey = () => `sos_${randomBytes(24).toString("hex")}`;
const hashKey = (raw) => createHash("sha256").update(raw).digest("hex");

const ENTITIES = [
  {
    externalId: "ent_acme_us",
    name: "ACME US Inc",
    country: "US",
    role: "SENDER",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-JPY", "USD-SGD"]),
    mmfEligible: true,
    mmfOptIn: true,
    walletProfile: {
      label: "ACME operating wallet",
      allowlisted: true,
      riskScore: 5,
    },
  },
  {
    externalId: "ent_tokyo_supplier",
    name: "Tokyo Trading KK",
    country: "JP",
    role: "RECIPIENT",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-JPY", "SGD-JPY", "JPY-USD"]),
    walletProfile: {
      label: "Tokyo Trading settlement wallet",
      allowlisted: true,
      riskScore: 10,
    },
  },
  {
    externalId: "ent_sg_supplier",
    name: "Singapore Imports Pte Ltd",
    country: "SG",
    role: "BOTH",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-SGD", "SGD-JPY", "SGD-USD"]),
    walletProfile: {
      label: "SG Imports settlement wallet",
      allowlisted: true,
      riskScore: 8,
    },
  },
  {
    externalId: "ent_osaka_parts",
    name: "Osaka Parts Co",
    country: "JP",
    role: "RECIPIENT",
    kybStatus: "PENDING",
    riskRating: "MEDIUM",
    approvedCorridors: JSON.stringify(["USD-JPY"]),
    walletProfile: {
      label: "Osaka Parts wallet (unverified)",
      allowlisted: false,
      riskScore: 55,
    },
  },
];

function loadDotEnvIfPresent() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  const parsed = parseEnvFileText(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function assertSeedDatabaseUrl(databaseUrl) {
  if (!databaseUrl || !String(databaseUrl).trim()) {
    throw new Error("DATABASE_URL is required for npm run seed:demo");
  }
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`DATABASE_URL must be postgres(ql):, got ${url.protocol}`);
  }
  const schema = url.searchParams.get("schema");
  if (schema !== "settlementos") {
    throw new Error(
      `DATABASE_URL must include ?schema=settlementos (got schema=${schema ?? "<missing>"}). ` +
        "Refusing to seed another schema on a shared instance."
    );
  }
}

function chainDir() {
  return process.env.SETTLEMENTOS_CHAIN_DIR || path.join(root, "chain");
}

function secretOverlayDir() {
  return process.env.SETTLEMENTOS_SECRET_OVERLAY_DIR || path.join(path.sep, "etc", "secrets");
}

/** Same overlay resolution as lib/chain.ts (CHAIN_DIR, then secret mount). */
function resolveLiveOverlayPath(networkId) {
  const candidates = [path.join(chainDir(), `deployments.${networkId}.json`)];
  const secrets = secretOverlayDir();
  if (path.resolve(chainDir()) !== path.resolve(secrets)) {
    candidates.push(path.join(secrets, `deployments.${networkId}.json`));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadLiveWallets() {
  /** @type {Record<string, Record<string, { address: string }>>} */
  const liveWallets = {};
  const found = [];
  for (const id of LIVE_NETWORK_IDS) {
    const p = resolveLiveOverlayPath(id);
    if (!p) continue;
    found.push({ id, path: p });
    const w = JSON.parse(fs.readFileSync(p, "utf8")).networks?.[id]?.accounts?.entityWallets;
    if (w) liveWallets[id] = w;
  }
  return { liveWallets, found };
}

function entityFields(e) {
  return {
    externalId: e.externalId,
    name: e.name,
    country: e.country,
    role: e.role,
    kybStatus: e.kybStatus,
    riskRating: e.riskRating,
    approvedCorridors: e.approvedCorridors,
    mmfEligible: e.mmfEligible ?? false,
    mmfOptIn: e.mmfOptIn ?? false,
  };
}

async function ensureEntity(prisma, e) {
  const data = entityFields(e);
  const existing = await prisma.entity.findUnique({ where: { externalId: e.externalId } });
  if (existing) {
    await prisma.entity.update({
      where: { id: existing.id },
      data: {
        name: data.name,
        country: data.country,
        role: data.role,
        kybStatus: data.kybStatus,
        riskRating: data.riskRating,
        approvedCorridors: data.approvedCorridors,
        mmfEligible: data.mmfEligible,
        mmfOptIn: data.mmfOptIn,
      },
    });
    return { entity: await prisma.entity.findUniqueOrThrow({ where: { id: existing.id } }), created: false };
  }
  const entity = await prisma.entity.create({ data });
  return { entity, created: true };
}

async function ensurePlatformKey(prisma, role, label) {
  const existing = await prisma.apiKey.findFirst({ where: { role, entityId: null } });
  if (existing) return { created: false, raw: null, id: existing.id };
  const raw = generateKey();
  const row = await prisma.apiKey.create({
    data: { keyHash: hashKey(raw), role, label },
  });
  return { created: true, raw, id: row.id };
}

async function ensureEntityKey(prisma, entity, label) {
  const existing = await prisma.apiKey.findFirst({
    where: { role: "ENTITY", entityId: entity.id },
  });
  if (existing) return { created: false, raw: null, id: existing.id };
  const raw = generateKey();
  const row = await prisma.apiKey.create({
    data: { keyHash: hashKey(raw), role: "ENTITY", entityId: entity.id, label },
  });
  return { created: true, raw, id: row.id };
}

async function main() {
  console.log("=== SettlementOS non-destructive demo seed ===");
  console.log("This script NEVER deletes payments, audit events, entities, or API keys.");
  console.log("For a full local wipe+redeploy use: npm run setup (localhost only).\n");

  loadDotEnvIfPresent();
  assertSeedDatabaseUrl(process.env.DATABASE_URL);

  const { liveWallets, found } = loadLiveWallets();
  if (found.length === 0) {
    console.warn(
      "WARNING: no live-network overlay found under " +
        `${chainDir()} or ${secretOverlayDir()}. ` +
        "Entities will be created without wallets — upload deployments.base-sepolia.json " +
        "as a Render Secret File (or place it in chain/) and re-run."
    );
  } else {
    console.log("Overlays:");
    for (const f of found) console.log(`  ${f.id} ← ${f.path}`);
  }

  const prisma = new PrismaClient();
  /** @type {Record<string, string>} */
  const newKeys = {};

  try {
    for (const e of ENTITIES) {
      const { entity, created } = await ensureEntity(prisma, e);
      console.log(`  entity ${e.externalId}: ${created ? "created" : "updated"}`);

      for (const [networkId, byEntity] of Object.entries(liveWallets)) {
        const lw = byEntity[e.externalId];
        if (!lw?.address) continue;
        await registerEntityWallet(prisma, {
          externalId: e.externalId,
          networkId,
          address: lw.address,
          profile: e.walletProfile,
        });
        console.log(`    wallet ${networkId}: ${lw.address}`);
      }

      const key = await ensureEntityKey(prisma, entity, `${e.name} API key`);
      if (key.created && key.raw) newKeys[`ENTITY:${e.externalId}`] = key.raw;
      else console.log(`    ENTITY key: already present`);
    }

    const op = await ensurePlatformKey(prisma, "OPERATOR", "Platform operator");
    if (op.created && op.raw) newKeys.OPERATOR = op.raw;
    else console.log("  OPERATOR key: already present");

    const rev = await ensurePlatformKey(prisma, "REVIEWER", "Compliance reviewer");
    if (rev.created && rev.raw) newKeys.REVIEWER = rev.raw;
    else console.log("  REVIEWER key: already present");

    const counts = {
      entities: await prisma.entity.count(),
      wallets: await prisma.wallet.count(),
      apiKeys: await prisma.apiKey.count(),
      payments: await prisma.payment.count(),
      auditEvents: await prisma.auditEvent.count(),
    };
    console.log("\nRow counts after seed:");
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

    if (Object.keys(newKeys).length > 0) {
      console.log("\nNEW API keys (save these — they are not stored in the DB and will not be re-printed):");
      for (const [label, raw] of Object.entries(newKeys)) {
        console.log(`  ${label}  ${raw}`);
      }
    } else {
      console.log("\nNo new API keys created (idempotent re-run).");
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log("\nseed:demo complete.");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
