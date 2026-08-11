// Create / drop an ephemeral Postgres database for the vitest fixture.
// Uses the admin URL (SETTLEMENTOS_TEST_PG_URL) and never touches the dev DB.

import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

function parseAdminUrl(adminUrl: string): URL {
  return new URL(adminUrl);
}

/** Build a database URL pointing at `dbName` with `?schema=`. */
export function databaseUrlFor(adminUrl: string, dbName: string, schema: string): string {
  const u = parseAdminUrl(adminUrl);
  u.pathname = `/${dbName}`;
  u.searchParams.set("schema", schema);
  // Small pool — see fixtureEnv comment. Prisma reads this from the URL.
  u.searchParams.set("connection_limit", "5");
  return u.toString();
}

export function ephemeralDbName(): string {
  // Postgres identifiers: keep it short, safe, unique across concurrent runs.
  return `sos_test_${randomBytes(8).toString("hex")}`;
}

export async function createEphemeralDatabase(adminUrl: string, dbName: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(dbName)) {
    throw new Error(`refusing unsafe database name: ${dbName}`);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.$disconnect();
  }
}

export async function dropEphemeralDatabase(adminUrl: string, dbName: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(dbName)) {
    throw new Error(`refusing unsafe database name: ${dbName}`);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    // FORCE disconnects leftover fixture clients so teardown cannot hang.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}
