#!/usr/bin/env node
// Preflight for `npm run setup`: refuse non-local DATABASE_URL before
// `prisma db push` or the wipe in setup.mjs can touch anything.
//
// Resolves DATABASE_URL the same way Prisma does (process env over `.env` in
// the project root), and refuses when the two disagree so the guard cannot
// approve a different string than the destructive command will use.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSetupDatabaseUrl } from "./local-database-url.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const envFileText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : null;

try {
  assertSetupDatabaseUrl({ processEnv: process.env, envFileText });
} catch (err) {
  console.error((err && err.message) || err);
  process.exit(1);
}
