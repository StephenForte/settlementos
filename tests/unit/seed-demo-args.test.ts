import { describe, it, expect } from "vitest";
import { parseSeedArgs, SEED_FLAGS } from "../../scripts/seed-demo.mjs";

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
