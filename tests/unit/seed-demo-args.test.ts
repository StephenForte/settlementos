import { describe, it, expect } from "vitest";
import {
  parseSeedArgs,
  SEED_FLAGS,
  describeSeedTarget,
  formatApiKeyBanner,
} from "../../scripts/seed-demo.mjs";

describe("seed-demo parseSeedArgs", () => {
  it("defaults to create-only (no refresh)", () => {
    expect(parseSeedArgs(["node", "scripts/seed-demo.mjs"])).toEqual({
      refreshEntities: false,
    });
  });

  it("accepts --refresh-entities", () => {
    expect(parseSeedArgs(["node", "scripts/seed-demo.mjs", "--refresh-entities"])).toEqual({
      refreshEntities: true,
    });
  });

  it("rejects unknown flags with a non-empty message naming valid flags", () => {
    expect(() => parseSeedArgs(["node", "scripts/seed-demo.mjs", "--bogus"])).toThrow(
      /Unknown argument: --bogus/
    );
    expect(() => parseSeedArgs(["node", "scripts/seed-demo.mjs", "--bogus"])).toThrow(
      SEED_FLAGS[0]
    );
  });

  it("rejects unexpected positionals", () => {
    expect(() => parseSeedArgs(["node", "scripts/seed-demo.mjs", "extra"])).toThrow(
      /Unexpected argument: extra/
    );
  });
});

describe("seed-demo API-key banner (host self-identification)", () => {
  const PASSWORD = "s3cret-do-not-print";
  const URL =
    `postgresql://settlementos_user:${PASSWORD}@dpg-d9taan2d0e5s738m7l1g-a.oregon-postgres.render.com:5432/chainbank?schema=settlementos`;

  it("describeSeedTarget returns host, port, and database only", () => {
    expect(describeSeedTarget(URL)).toEqual({
      host: "dpg-d9taan2d0e5s738m7l1g-a.oregon-postgres.render.com",
      port: "5432",
      database: "chainbank",
    });
  });

  it("formatApiKeyBanner names the seeded database and never prints the password", () => {
    const banner = formatApiKeyBanner(URL, {
      OPERATOR: "sos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(banner).toContain(
      "Seeded database: dpg-d9taan2d0e5s738m7l1g-a.oregon-postgres.render.com:5432/chainbank"
    );
    expect(banner).toContain("NEW API keys");
    expect(banner).toContain("OPERATOR");
    expect(banner).toContain("sos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(banner).not.toContain(PASSWORD);
    expect(banner).not.toContain("settlementos_user");
    expect(banner).not.toMatch(/postgresql:\/\//);
  });
});
