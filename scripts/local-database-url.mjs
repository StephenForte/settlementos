/**
 * Pure helpers that decide whether a DATABASE_URL is safe for `npm run setup`.
 * Setup wipes Entity / Payment / AuditEvent / AuditCheckpoint / etc. by design;
 * pointed at the shared Render Postgres it would destroy SettlementOS data on an
 * instance that also hosts chainbank. Localhost only.
 *
 * Resolution matches Prisma / Node `--env-file`: already-set process env wins
 * over a value parsed from `.env`. When both are present and disagree, we
 * refuse — that is the fail-open footgun (shell local + .env remote, or the
 * reverse) where the guard and the destructive command can otherwise see
 * different strings.
 */

/**
 * Minimal .env parser for DATABASE_URL (and friends). Handles optional export
 * prefix, single/double quotes, and ignores comments / blank lines. Enough to
 * match what Prisma's dotenv load does for this one key.
 *
 * @param {string | undefined | null} text
 * @returns {Record<string, string>}
 */
export function parseEnvFileText(text) {
  /** @type {Record<string, string>} */
  const out = {};
  if (text == null || text === "") return out;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

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
 * Resolve which DATABASE_URL the setup wipe would hit, matching Prisma's
 * precedence (process env over `.env`), then refuse conflicts and non-local hosts.
 *
 * @param {{
 *   processEnv?: Record<string, string | undefined>,
 *   envFileText?: string | null,
 * }} [input]
 * @returns {{
 *   ok: true,
 *   url: string,
 *   host: string,
 *   source: "env" | "envFile",
 * } | {
 *   ok: false,
 *   message: string,
 *   source: "env" | "envFile" | "conflict" | "unset",
 *   envUrl?: string,
 *   fileUrl?: string,
 * }}
 */
export function resolveSetupDatabaseUrl(input = {}) {
  const processEnv = input.processEnv ?? process.env;
  const fileVars = parseEnvFileText(input.envFileText ?? "");

  const envRaw = processEnv.DATABASE_URL;
  const fileRaw = fileVars.DATABASE_URL;
  const envUrl = envRaw != null && String(envRaw).trim() !== "" ? String(envRaw).trim() : undefined;
  const fileUrl = fileRaw != null && String(fileRaw).trim() !== "" ? String(fileRaw).trim() : undefined;

  if (envUrl !== undefined && fileUrl !== undefined && envUrl !== fileUrl) {
    return {
      ok: false,
      source: "conflict",
      envUrl,
      fileUrl,
      message:
        "npm run setup refuses to run: process env DATABASE_URL and .env DATABASE_URL disagree. " +
        `Shell/process has ${envUrl}; .env has ${fileUrl}. ` +
        "Prisma and Node --env-file let the process env win, so a local shell export " +
        "would make the guard pass while a later tool (or a cleared export) could still " +
        "hit the remote URL in .env — or the reverse. Align them on a localhost URL, or " +
        "unset one. It was about to wipe Entity, Wallet, Payment, AuditEvent, AuditCheckpoint, " +
        "and related tables (including on a shared Render Postgres that also hosts chainbank).",
    };
  }

  if (envUrl !== undefined) {
    const checked = checkLocalDatabaseUrl(envUrl);
    if (!checked.ok) return { ...checked, source: "env", envUrl, fileUrl };
    return { ok: true, url: envUrl, host: checked.host, source: "env" };
  }

  if (fileUrl !== undefined) {
    const checked = checkLocalDatabaseUrl(fileUrl);
    if (!checked.ok) return { ...checked, source: "envFile", envUrl, fileUrl };
    return { ok: true, url: fileUrl, host: checked.host, source: "envFile" };
  }

  const unset = checkLocalDatabaseUrl(undefined);
  return {
    ok: false,
    source: "unset",
    message: unset.ok ? "DATABASE_URL is unset" : unset.message,
  };
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

/**
 * Resolve + assert for setup. Throws the refusal message when not ok.
 *
 * @param {{
 *   processEnv?: Record<string, string | undefined>,
 *   envFileText?: string | null,
 * }} [input]
 * @returns {{ url: string, host: string, source: "env" | "envFile" }}
 */
export function assertSetupDatabaseUrl(input = {}) {
  const result = resolveSetupDatabaseUrl(input);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return { url: result.url, host: result.host, source: result.source };
}
