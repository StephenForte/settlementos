import { describe, it, expect } from "vitest";
import {
  checkLocalDatabaseUrl,
  assertLocalDatabaseUrl,
  parseEnvFileText,
  resolveSetupDatabaseUrl,
  assertSetupDatabaseUrl,
} from "../../scripts/local-database-url.mjs";

const LOCAL = "postgresql://user@127.0.0.1:5432/settlementos_dev?schema=settlementos";
const LOCAL_LOCALHOST = "postgresql://user@localhost:5432/settlementos_dev?schema=settlementos";
const REMOTE =
  "postgresql://u:p@dpg-xxxx-a.oregon-postgres.render.com/chainbank?schema=settlementos";

describe("checkLocalDatabaseUrl", () => {
  it("accepts localhost Postgres URLs", () => {
    expect(checkLocalDatabaseUrl(LOCAL_LOCALHOST)).toEqual({ ok: true, host: "localhost" });
    expect(checkLocalDatabaseUrl(LOCAL)).toEqual({ ok: true, host: "127.0.0.1" });
  });

  it("refuses a remote Render-style host and names the wipe", () => {
    const result = checkLocalDatabaseUrl(REMOTE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.message).toMatch(/refuses to run against host/i);
    expect(result.message).toMatch(/AuditEvent/);
    expect(result.message).toMatch(/chainbank/);
  });

  it("refuses SQLite file URLs", () => {
    const result = checkLocalDatabaseUrl("file:./dev.db");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.message).toMatch(/SQLite/);
  });

  it("refuses unset DATABASE_URL", () => {
    const result = checkLocalDatabaseUrl(undefined);
    expect(result.ok).toBe(false);
  });

  it("assertLocalDatabaseUrl throws the refusal message", () => {
    expect(() => assertLocalDatabaseUrl("postgresql://db.example.com/x")).toThrow(/refuses to run/);
  });
});

describe("resolveSetupDatabaseUrl (Prisma-matched resolution)", () => {
  // Prisma / Node --env-file: process env wins over .env when both are set.
  // We add a conflict refusal when they disagree so the guard cannot green-light
  // a different string than the wipe will use.

  it.each([
    {
      name: "env-only (shell set, no .env key) — process env wins, proceed when local",
      processEnv: { DATABASE_URL: LOCAL },
      envFileText: "",
      expectOk: true,
      source: "env",
      url: LOCAL,
    },
    {
      name: ".env-only — file wins (Prisma would load it), proceed when local",
      processEnv: {},
      envFileText: `DATABASE_URL="${LOCAL}"\n`,
      expectOk: true,
      source: "envFile",
      url: LOCAL,
    },
    {
      name: "both agreeing on local — proceed",
      processEnv: { DATABASE_URL: LOCAL },
      envFileText: `DATABASE_URL=${LOCAL}\n`,
      expectOk: true,
      source: "env",
      url: LOCAL,
    },
    {
      name: "both disagreeing: shell local + .env remote — REFUSE (fail-open footgun)",
      processEnv: { DATABASE_URL: LOCAL },
      envFileText: `DATABASE_URL="${REMOTE}"\n`,
      expectOk: false,
      source: "conflict",
      messageMatch: /disagree/i,
    },
    {
      name: "both disagreeing: shell remote + .env local — REFUSE",
      processEnv: { DATABASE_URL: REMOTE },
      envFileText: `DATABASE_URL="${LOCAL}"\n`,
      expectOk: false,
      source: "conflict",
      messageMatch: /disagree/i,
    },
    {
      name: "neither — REFUSE unset",
      processEnv: {},
      envFileText: "# no DATABASE_URL\n",
      expectOk: false,
      source: "unset",
      messageMatch: /DATABASE_URL is unset/,
    },
    {
      name: ".env-only remote — REFUSE non-local",
      processEnv: {},
      envFileText: `DATABASE_URL="${REMOTE}"\n`,
      expectOk: false,
      source: "envFile",
      messageMatch: /refuses to run against host/,
    },
    {
      name: "env-only remote — REFUSE non-local",
      processEnv: { DATABASE_URL: REMOTE },
      envFileText: "",
      expectOk: false,
      source: "env",
      messageMatch: /refuses to run against host/,
    },
  ])("$name", ({ processEnv, envFileText, expectOk, source, url, messageMatch }) => {
    const result = resolveSetupDatabaseUrl({ processEnv, envFileText });
    expect(result.source).toBe(source);
    expect(result.ok).toBe(expectOk);
    if (expectOk) {
      if (!result.ok) throw new Error("expected ok");
      expect(result.url).toBe(url);
    } else {
      if (result.ok) throw new Error("expected refusal");
      if (messageMatch) expect(result.message).toMatch(messageMatch);
    }
  });

  it("assertSetupDatabaseUrl throws on shell-local + .env-remote", () => {
    expect(() =>
      assertSetupDatabaseUrl({
        processEnv: { DATABASE_URL: LOCAL },
        envFileText: `DATABASE_URL="${REMOTE}"\n`,
      })
    ).toThrow(/disagree/i);
  });

  it("parseEnvFileText reads quoted DATABASE_URL", () => {
    expect(parseEnvFileText(`# comment\nDATABASE_URL="${LOCAL}"\n`).DATABASE_URL).toBe(LOCAL);
  });
});
