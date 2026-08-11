#!/usr/bin/env node
// Preflight for `npm run setup`: refuse non-local DATABASE_URL before
// `prisma db push` or the wipe in setup.mjs can touch anything.
import { assertLocalDatabaseUrl } from "./local-database-url.mjs";

try {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
} catch (err) {
  console.error((err && err.message) || err);
  process.exit(1);
}
