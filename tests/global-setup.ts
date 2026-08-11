// Vitest global setup: builds a fully isolated fixture under tests/.tmp —
// ephemeral Postgres database, two Hardhat nodes on test-only ports (19545/19546),
// contracts deployed, deployments.json written, demo entities seeded. Torn down after.

import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  ROOT,
  TMP_DIR,
  CHAIN_DIR,
  DATABASE_URL_FILE,
  BASE_RPC,
  POLYGON_RPC,
  ACCOUNTS,
  API_KEYS,
  TEST_PG_ADMIN_URL,
  TEST_PG_SCHEMA,
  fixtureEnv,
} from "./fixture";
import { deployChain, waitForRpc, ENTITIES } from "./helpers/deploy";
import {
  createEphemeralDatabase,
  databaseUrlFor,
  dropEphemeralDatabase,
  ephemeralDbName,
} from "./helpers/pg-ephemeral";
import { hashKey } from "../lib/auth";

const NETWORK_IDS = ["base-local", "polygon-local"];

function startNode(config: string, port: number): ChildProcess {
  const child = spawn("npx", ["hardhat", "node", "--config", config, "--port", String(port)], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true, // own process group, so teardown kills hardhat too, not just npx
  });
  child.unref();
  return child;
}

async function seedDb(databaseUrl: string) {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  for (const e of ENTITIES) {
    const { wallet, ...data } = e;
    const entity = await prisma.entity.create({
      data: { ...data, wallets: { create: NETWORK_IDS.map((network) => ({ ...wallet, network })) } },
    });
    // One ENTITY key per entity, scoped to that tenant (mirrors scripts/setup.mjs).
    const raw = API_KEYS.entities[e.externalId as keyof typeof API_KEYS.entities];
    await prisma.apiKey.create({
      data: { keyHash: hashKey(raw), role: "ENTITY", entityId: entity.id, label: `${e.name} API key` },
    });
  }
  await prisma.apiKey.create({
    data: { keyHash: hashKey(API_KEYS.operator), role: "OPERATOR", label: "Platform operator" },
  });
  await prisma.apiKey.create({
    data: { keyHash: hashKey(API_KEYS.reviewer), role: "REVIEWER", label: "Compliance reviewer" },
  });
  await prisma.$disconnect();
}

export default async function setup() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(CHAIN_DIR, { recursive: true });

  const dbName = ephemeralDbName();
  const databaseUrl = databaseUrlFor(TEST_PG_ADMIN_URL, dbName, TEST_PG_SCHEMA);
  let dbCreated = false;

  try {
    await createEphemeralDatabase(TEST_PG_ADMIN_URL, dbName);
    dbCreated = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to create ephemeral test database on ${TEST_PG_ADMIN_URL}: ${msg}\n` +
        `Postgres must be running locally (or set SETTLEMENTOS_TEST_PG_URL).`
    );
  }

  fs.writeFileSync(DATABASE_URL_FILE, databaseUrl, "utf8");
  Object.assign(process.env, fixtureEnv(databaseUrl));

  execSync("npx hardhat compile --config hardhat.config.cjs", { cwd: ROOT, stdio: "inherit" });
  // Schema apply for the fixture: migrate deploy is the deployed path; the
  // fixture uses the same migrations so CI exercises them. Never prisma db push
  // against a shared URL here — this URL is the ephemeral DB we just created.
  execSync("npx prisma migrate deploy", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const nodes = [
    startNode("hardhat.config.cjs", 19545),
    startNode("hardhat.config.polygon.cjs", 19546),
  ];

  try {
    await waitForRpc(BASE_RPC, 31337);
    await waitForRpc(POLYGON_RPC, 31338);

    const deployments = {
      networks: {
        "base-local": await deployChain(BASE_RPC, 31337),
        "polygon-local": await deployChain(POLYGON_RPC, 31338),
      },
      accounts: {
        operator: ACCOUNTS.operator,
        treasury: ACCOUNTS.treasury,
        entityWallets: {
          ent_acme_us: ACCOUNTS.acme,
          ent_tokyo_supplier: ACCOUNTS.tokyo,
          ent_sg_supplier: ACCOUNTS.singapore,
          ent_osaka_parts: ACCOUNTS.osaka,
        },
      },
    };
    fs.writeFileSync(path.join(CHAIN_DIR, "deployments.json"), JSON.stringify(deployments, null, 2));

    await seedDb(databaseUrl);
  } catch (err) {
    for (const n of nodes) if (n.pid) process.kill(-n.pid, "SIGTERM");
    if (dbCreated) await dropEphemeralDatabase(TEST_PG_ADMIN_URL, dbName).catch(() => {});
    throw err;
  }

  return async () => {
    for (const n of nodes) {
      if (n.pid) {
        try {
          process.kill(-n.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    // Checkpoints before events — same order as setup's wipe (dangling anchor ⇒ BROKEN).
    try {
      const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
      await prisma.auditCheckpoint.deleteMany();
      await prisma.auditEvent.deleteMany();
      await prisma.$disconnect();
    } catch {
      /* dropping the DB is enough; this is belt-and-suspenders */
    }
    if (dbCreated) await dropEphemeralDatabase(TEST_PG_ADMIN_URL, dbName);
  };
}
