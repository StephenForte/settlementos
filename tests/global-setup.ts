// Vitest global setup: builds a fully isolated fixture under tests/.tmp —
// fresh SQLite DB, two Hardhat nodes on test-only ports (9545/9546), contracts
// deployed, deployments.json written, demo entities seeded. Torn down after.

import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { ROOT, TMP_DIR, CHAIN_DIR, BASE_RPC, POLYGON_RPC, FIXTURE_ENV, ACCOUNTS } from "./fixture";
import { deployChain, waitForRpc, ENTITIES } from "./helpers/deploy";

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

async function seedDb() {
  const prisma = new PrismaClient({ datasourceUrl: FIXTURE_ENV.DATABASE_URL });
  for (const e of ENTITIES) {
    const { wallet, ...data } = e;
    await prisma.entity.create({
      data: { ...data, wallets: { create: NETWORK_IDS.map((network) => ({ ...wallet, network })) } },
    });
  }
  await prisma.$disconnect();
}

export default async function setup() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(CHAIN_DIR, { recursive: true });

  execSync("npx hardhat compile --config hardhat.config.cjs", { cwd: ROOT, stdio: "inherit" });
  execSync("npx prisma db push --skip-generate", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: FIXTURE_ENV.DATABASE_URL },
  });

  const nodes = [
    startNode("hardhat.config.cjs", 9545),
    startNode("hardhat.config.polygon.cjs", 9546),
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

    await seedDb();
  } catch (err) {
    for (const n of nodes) if (n.pid) process.kill(-n.pid, "SIGTERM");
    throw err;
  }

  return () => {
    for (const n of nodes) {
      if (n.pid) {
        try {
          process.kill(-n.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
  };
}
