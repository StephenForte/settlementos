// Shared test-fixture constants. Everything lives under tests/.tmp (gitignored)
// and on dedicated ports so the suite never touches the dev DB, the dev chains,
// or chain/deployments*.json. The database is an ephemeral Postgres database
// created by global-setup and dropped on teardown.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TMP_DIR = path.join(ROOT, "tests", ".tmp");
export const CHAIN_DIR = path.join(TMP_DIR, "chain");
/** Written by global-setup; read by every worker via setup-env.ts. */
export const DATABASE_URL_FILE = path.join(TMP_DIR, "database-url");

export const BASE_RPC = "http://127.0.0.1:19545";
export const POLYGON_RPC = "http://127.0.0.1:19546";

/**
 * Admin URL used only to CREATE/DROP the ephemeral test database. Defaults to
 * local Homebrew peer-auth on loopback as the current OS user. CI overrides via
 * SETTLEMENTOS_TEST_PG_URL (the postgres service container).
 */
export const TEST_PG_ADMIN_URL =
  process.env.SETTLEMENTOS_TEST_PG_URL ??
  `postgresql://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:5432/postgres`;

/** Schema inside the ephemeral database — mirrors production's settlementos schema. */
export const TEST_PG_SCHEMA = "settlementos";

export function readFixtureDatabaseUrl(): string {
  if (!fs.existsSync(DATABASE_URL_FILE)) {
    throw new Error(
      `test fixture DATABASE_URL missing at ${DATABASE_URL_FILE} — is Postgres running and did global-setup start?`
    );
  }
  return fs.readFileSync(DATABASE_URL_FILE, "utf8").trim();
}

/**
 * Env applied in setup-env.ts (per worker) and global-setup.ts (fixture build).
 *
 * connection_limit: Postgres handles concurrent writers (unlike SQLite). We use
 * a small pool (5) rather than SQLite's connection_limit=1 — that setting existed
 * to queue writers behind SQLite's global lock / avoid P1008 busy timeouts. With
 * Postgres + the audit advisory lock, a tiny pool lets short concurrent
 * transactions proceed without opening dozens of connections per worker. Stay
 * well under the server's max_connections when CI runs one suite at a time.
 */
export function fixtureEnv(databaseUrl: string): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    SETTLEMENTOS_CHAIN_DIR: CHAIN_DIR,
    BASE_LOCAL_RPC_URL: BASE_RPC,
    POLYGON_LOCAL_RPC_URL: POLYGON_RPC,
    // ForteL2's default sequencer RPC is 127.0.0.1:9545 — which is why the test
    // chains live up on 19545/19546, clear of the ForteL2 stack's 954x ports.
    // Pin both fortel2 RPCs to a dead port so a test that accidentally dials
    // ForteL2 fails fast instead of silently reading the Hardhat fixture chain;
    // pin the replica read RPC off so the read/write split stays inert (its own
    // test stubs env and re-imports).
    FORTEL2_SEPOLIA_RPC_URL: "http://127.0.0.1:9599",
    FORTEL2_SEPOLIA_READ_RPC_URL: "",
    FORTEL2_LOCAL_RPC_URL: "http://127.0.0.1:9599",
    // Access service token is Render-only. Pin off so a dev .env cannot attach
    // CF-Access-* headers to local Hardhat / public-testnet write clients.
    CF_ACCESS_CLIENT_ID: "",
    CF_ACCESS_CLIENT_SECRET: "",
    // Compliance providers must never go live in tests — Vitest loads the dev
    // .env into process.env, so pin these off; provider tests stub them back on.
    OPENSANCTIONS_API_KEY: "",
    CHAINALYSIS_ORACLE_RPC_URL: "",
    CHAINALYSIS_ORACLE_ADDRESS: "",
    COMPLIANCE_PROVIDER_TIMEOUT_MS: "",
    // Audit anchoring is on for the suite (so the whole run verifies through the
    // checkpoint path), pinned to a fixed key rather than the dev .env's.
    AUDIT_ANCHOR_KEY: "test_anchor_key_not_for_any_real_deployment",
    // The write rate limiter is per-process and the whole suite shares one, so at
    // the real 30/min the operator key would start 429ing whichever test file
    // happened to run after the busy ones. Pinned effectively off; the limiter's
    // own test lowers it and resets the windows itself.
    RATE_LIMIT_WRITES_PER_MINUTE: "1000000",
  };
}

/** @deprecated Prefer fixtureEnv(readFixtureDatabaseUrl()) after global-setup. */
export const FIXTURE_ENV = new Proxy({} as Record<string, string>, {
  get(_t, prop: string) {
    return fixtureEnv(readFixtureDatabaseUrl())[prop];
  },
  ownKeys() {
    return Reflect.ownKeys(fixtureEnv(readFixtureDatabaseUrl()));
  },
  getOwnPropertyDescriptor(_t, prop) {
    const v = fixtureEnv(readFixtureDatabaseUrl())[prop as string];
    if (v === undefined) return undefined;
    return { configurable: true, enumerable: true, value: v };
  },
});

// Raw API keys seeded into the fixture DB by global-setup. Fixed rather than
// generated so tests can import them as constants (the dev-mnemonic pattern
// below) — the app only ever stores their sha256 hashes. Test-only, never on a
// public network. `entities` is keyed by Entity.externalId.
export const API_KEYS = {
  operator: "sos_test_00000000000000000000000000000000operator",
  reviewer: "sos_test_00000000000000000000000000000000reviewer",
  entities: {
    ent_acme_us: "sos_test_000000000000000000000000000000000000acme",
    ent_tokyo_supplier: "sos_test_00000000000000000000000000000000tokyo",
    ent_sg_supplier: "sos_test_0000000000000000000000000000000000sgp",
    ent_osaka_parts: "sos_test_0000000000000000000000000000000000osk",
  },
} as const;

// Standard Hardhat dev-mnemonic accounts — same roles as scripts/setup.mjs.
export const ACCOUNTS = {
  operator: {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  acme: {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  tokyo: {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
  singapore: {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    privateKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  },
  treasury: {
    address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    privateKey: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  },
  osaka: {
    address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    privateKey: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  },
} as const;
