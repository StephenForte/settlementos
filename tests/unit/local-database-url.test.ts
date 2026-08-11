import { describe, it, expect } from "vitest";
import { checkLocalDatabaseUrl, assertLocalDatabaseUrl } from "../../scripts/local-database-url.mjs";

describe("checkLocalDatabaseUrl", () => {
  it("accepts localhost Postgres URLs", () => {
    expect(
      checkLocalDatabaseUrl("postgresql://user@localhost:5432/settlementos_dev?schema=settlementos")
    ).toEqual({ ok: true, host: "localhost" });
    expect(
      checkLocalDatabaseUrl("postgresql://127.0.0.1:5432/settlementos_dev?schema=settlementos")
    ).toEqual({ ok: true, host: "127.0.0.1" });
  });

  it("refuses a remote Render-style host and names the wipe", () => {
    const result = checkLocalDatabaseUrl(
      "postgresql://u:p@dpg-xxxx-a.oregon-postgres.render.com/chainbank?schema=settlementos"
    );
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
