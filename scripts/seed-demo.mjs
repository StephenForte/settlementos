#!/usr/bin/env node
// Non-destructive, idempotent demo seed for a deployed (or shared) Postgres.
//
// Creates missing demo entities, registers wallets from live-network overlays,
// and mints API keys only when missing. Safe to re-run:
//   - never deletes payments, audit events, checkpoints, entities, or API keys
//   - never overwrites an existing entity's columns unless --refresh-entities
//   - the only delete it can reach is registerEntityWallet's duplicate-wallet
//     consolidation (prisma.wallet.deleteMany), which is unreachable under the
//     current @@unique([entityId, network]) constraint
//
// This is NOT `npm run setup`:
//   - setup wipes the DB and refuses non-localhost DATABASE_URL
//   - this script has no wipe path and is the intended Render seed
//
// Run:  npm run seed:demo
//   or: node --env-file=.env scripts/seed-demo.mjs   (local, with .env)
//   or: node scripts/seed-demo.mjs [--refresh-entities]
//
// Requires DATABASE_URL with ?schema=settlementos. Overlay resolution is the
// single implementation in lib/overlay-paths.mjs (same as lib/chain.ts).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { parseEnvFileText } from "./local-database-url.mjs";
import { registerEntityWallet } from "./deploy-testnet.mjs";
import { DEMO_ENTITIES, ENTITY_REFRESH_COLUMNS, entityRowData } from "./seed-entities.mjs";
import {
  resolveChainDir,
  resolveLiveOverlayPath,
  resolveSecretOverlayDir,
} from "../lib/overlay-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const LIVE_NETWORK_IDS = ["base-sepolia", "polygon-amoy", "fortel2-sepolia"];

/** @type {readonly string[]} */
export const SEED_FLAGS = Object.freeze(["--refresh-entities"]);

// Keep in sync with lib/auth.ts / scripts/setup.mjs (mjs cannot import the TS module).
const generateKey = () => `sos_${randomBytes(24).toString("hex")}`;
const hashKey = (raw) => createHash("sha256").update(raw).digest("hex");

/**
 * Parse argv. Rejects unknown dash-tokens and unexpected positionals
 * (deploy-testnet.mjs convention from PR #57).
 * @param {string[]} argv process.argv
 */
export function parseSeedArgs(argv) {
  const rest = argv.slice(2);
  const flags = new Set(SEED_FLAGS);
  for (const token of rest) {
    if (token.startsWith("-") && !flags.has(token)) {
      throw new Error(`Unknown argument: ${token}. Valid flags: ${SEED_FLAGS.join(", ")}`);
    }
  }
  const positionals = rest.filter((a) => !flags.has(a));
  if (positionals.length > 0) {
    throw new Error(
      `Unexpected argument: ${positionals[0]}. Usage: node scripts/seed-demo.mjs [${SEED_FLAGS.join("] [")}]`
    );
  }
  return { refreshEntities: rest.includes("--refresh-entities") };
}

/**
 * Host / port / database name for the API-key banner. Never returns credentials
 * — DATABASE_URL passwords must not appear in operator logs or saved key notes.
 * @param {string} databaseUrl
 * @returns {{ host: string, port: string, database: string }}
 */
export function describeSeedTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent((url.pathname.replace(/^\//, "").split("/")[0] ?? "").split("?")[0]);
  const port = url.port || "5432";
  return { host: url.hostname, port, database };
}

/**
 * Banner printed when new API keys are minted. Names the seeded host so a
 * saved `sos_…` key is self-identifying across local / Render / test DBs.
 * @param {string} databaseUrl
 * @param {Record<string, string>} newKeys
 */
export function formatApiKeyBanner(databaseUrl, newKeys) {
  const { host, port, database } = describeSeedTarget(databaseUrl);
  const lines = [
    `Seeded database: ${host}:${port}/${database}`,
    "NEW API keys (save these — they are not stored in the DB and will not be re-printed):",
  ];
  for (const [label, raw] of Object.entries(newKeys)) {
    lines.push(`  ${label}  ${raw}`);
  }
  return lines.join("\n");
}

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

function warnIfCwdDivergesFromRepoRoot() {
  if (process.env.SETTLEMENTOS_CHAIN_DIR) return;
  const cwd = path.resolve(process.cwd());
  const repoRoot = path.resolve(root);
  if (cwd === repoRoot) return;
  console.warn(
    `WARNING: SETTLEMENTOS_CHAIN_DIR is unset and process.cwd() (${cwd}) differs from ` +
      `the repo root (${repoRoot}). Overlay resolution uses process.cwd()/chain — the same ` +
      `rule as the running app (lib/overlay-paths.mjs). Candidate directories:\n` +
      `  cwd/chain:  ${path.join(cwd, "chain")}\n` +
      `  repo/chain: ${path.join(repoRoot, "chain")}\n` +
      `Set SETTLEMENTOS_CHAIN_DIR to the directory that holds deployments.*.json.`
  );
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

/**
 * Create-only by default. With --refresh-entities, overwrite columns after
 * printing exactly which entities and columns will change. Wallet registration
 * and key minting always continue for existing entities.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("./seed-entities.mjs").DemoEntity} e
 * @param {{ refreshEntities: boolean }} opts
 */
async function ensureEntity(prisma, e, { refreshEntities }) {
  const data = entityRowData(e);
  const existing = await prisma.entity.findUnique({ where: { externalId: e.externalId } });
  if (!existing) {
    const entity = await prisma.entity.create({ data });
    return { entity, created: true, refreshed: false };
  }

  if (!refreshEntities) {
    return { entity: existing, created: false, refreshed: false };
  }

  /** @type {string[]} */
  const changing = [];
  for (const col of ENTITY_REFRESH_COLUMNS) {
    if (existing[col] !== data[col]) changing.push(col);
  }
  if (changing.length === 0) {
    console.log(`  entity ${e.externalId}: --refresh-entities (no column changes)`);
    return { entity: existing, created: false, refreshed: false };
  }

  console.log(`  REFRESH ${e.externalId}: overwriting columns: ${changing.join(", ")}`);
  for (const col of changing) {
    console.log(`    ${col}: ${JSON.stringify(existing[col])} → ${JSON.stringify(data[col])}`);
  }

  const update = {};
  for (const col of ENTITY_REFRESH_COLUMNS) update[col] = data[col];
  const entity = await prisma.entity.update({ where: { id: existing.id }, data: update });
  return { entity, created: false, refreshed: true };
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
  const { refreshEntities } = parseSeedArgs(process.argv);

  console.log("=== SettlementOS non-destructive demo seed ===");
  console.log(
    "Never deletes payments, audit events, checkpoints, entities, or API keys. " +
      "Existing entity columns are left alone unless --refresh-entities. " +
      "The only delete path is registerEntityWallet's duplicate-wallet consolidation, " +
      "unreachable under @@unique([entityId, network])."
  );
  console.log("For a full local wipe+redeploy use: npm run setup (localhost only).\n");
  if (refreshEntities) {
    console.log("Flag --refresh-entities: will overwrite existing entity columns after printing diffs.\n");
  }

  loadDotEnvIfPresent();
  assertSeedDatabaseUrl(process.env.DATABASE_URL);
  warnIfCwdDivergesFromRepoRoot();

  const chainDir = resolveChainDir();
  const secretDir = resolveSecretOverlayDir();
  const { liveWallets, found } = loadLiveWallets();
  if (found.length === 0) {
    console.warn(
      "WARNING: no live-network overlay found under " +
        `${chainDir} or ${secretDir}. ` +
        "Entities will be created without wallets — upload deployments.base-sepolia.json " +
        "as a Render Secret File (or place it in chain/) and re-run."
    );
  } else {
    console.log("Overlays (absolute paths):");
    for (const f of found) console.log(`  ${f.id} ← ${f.path}`);
  }

  const prisma = new PrismaClient();
  /** @type {Record<string, string>} */
  const newKeys = {};

  try {
    for (const e of DEMO_ENTITIES) {
      const { entity, created, refreshed } = await ensureEntity(prisma, e, { refreshEntities });
      if (created) console.log(`  entity ${e.externalId}: created`);
      else if (!refreshed) console.log(`  entity ${e.externalId}: already present, unchanged`);

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
      console.log("\n" + formatApiKeyBanner(process.env.DATABASE_URL, newKeys));
    } else {
      const { host, port, database } = describeSeedTarget(process.env.DATABASE_URL);
      console.log(`\nNo new API keys created (idempotent re-run) — database ${host}:${port}/${database}.`);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log("\nseed:demo complete.");
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
