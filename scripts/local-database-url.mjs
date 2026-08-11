/**
 * Pure helpers that decide whether a DATABASE_URL is safe for `npm run setup`.
 * Setup wipes Entity / Payment / AuditEvent / AuditCheckpoint / etc. by design;
 * pointed at the shared Render Postgres it would destroy SettlementOS data on an
 * instance that also hosts chainbank. Localhost only.
 */

/**
 * @param {string | undefined | null} databaseUrl
 * @returns {{ ok: true, host: string } | { ok: false, message: string }}
 */
export function checkLocalDatabaseUrl(databaseUrl) {
  if (databaseUrl == null || String(databaseUrl).trim() === "") {
    return {
      ok: false,
      message:
        "npm run setup refuses to run: DATABASE_URL is unset. " +
        "It was about to wipe Entity, Wallet, Payment, AuditEvent, AuditCheckpoint, " +
        "LiquidityReservation, LedgerCredit, ComplianceCheck, TreasuryPosition, ApiKey, " +
        "and IdempotencyRecord. Set DATABASE_URL to a local Postgres URL " +
        "(host localhost or 127.0.0.1, with ?schema=settlementos).",
    };
  }

  const raw = String(databaseUrl).trim();

  if (raw.startsWith("file:")) {
    return {
      ok: false,
      message:
        `npm run setup refuses to run against DATABASE_URL=${raw} — SQLite file URLs ` +
        "are no longer supported. It was about to wipe Entity, Wallet, Payment, " +
        "AuditEvent, AuditCheckpoint, and related tables. " +
        "Use postgresql://USER@127.0.0.1:5432/settlementos_dev?schema=settlementos",
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      message:
        `npm run setup refuses to run: DATABASE_URL is not a valid URL (${raw}). ` +
        "It was about to wipe Entity, Wallet, Payment, AuditEvent, AuditCheckpoint, " +
        "and related tables.",
    };
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return {
      ok: false,
      message:
        `npm run setup refuses to run against protocol "${url.protocol}" — expected postgresql:. ` +
        "It was about to wipe Entity, Wallet, Payment, AuditEvent, AuditCheckpoint, " +
        "and related tables.",
    };
  }

  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (!local) {
    return {
      ok: false,
      message:
        `npm run setup refuses to run against host "${url.hostname}" (DATABASE_URL). ` +
        "It was about to wipe Entity, Wallet, Payment, AuditEvent, AuditCheckpoint, " +
        "LiquidityReservation, LedgerCredit, ComplianceCheck, TreasuryPosition, ApiKey, " +
        "and IdempotencyRecord — including on a shared Render Postgres that also hosts " +
        "chainbank. Point DATABASE_URL at localhost or 127.0.0.1 only.",
    };
  }

  return { ok: true, host: url.hostname };
}

/**
 * @param {string | undefined | null} databaseUrl
 * @returns {string} hostname when local
 */
export function assertLocalDatabaseUrl(databaseUrl) {
  const result = checkLocalDatabaseUrl(databaseUrl);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.host;
}
