import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import {
  authenticate,
  principalForKey,
  generateKey,
  hashKey,
  API_KEY_HEADER,
  API_KEY_COOKIE,
} from "@/lib/auth";
import { API_KEYS } from "../fixture";

const withHeader = (key: string) =>
  new Request("http://test/api/payments", { headers: { [API_KEY_HEADER]: key } });
const withCookie = (cookie: string) =>
  new Request("http://test/api/payments", { headers: { cookie } });

describe("API-key identity", () => {
  it("resolves the seeded OPERATOR key from the x-api-key header", async () => {
    const principal = await authenticate(withHeader(API_KEYS.operator));
    // keyId is the ApiKey row's cuid, so it can only be matched loosely here.
    expect(principal).toEqual({ keyId: expect.any(String), role: "OPERATOR", label: "Platform operator" });
  });

  it("resolves the seeded REVIEWER key", async () => {
    const principal = await authenticate(withHeader(API_KEYS.reviewer));
    expect(principal).toEqual({ keyId: expect.any(String), role: "REVIEWER", label: "Compliance reviewer" });
  });

  it("identifies each key by its own ApiKey id", async () => {
    const [operator, reviewer] = await Promise.all([
      principalForKey(API_KEYS.operator),
      principalForKey(API_KEYS.reviewer),
    ]);
    const row = await prisma.apiKey.findFirstOrThrow({ where: { role: "OPERATOR" } });

    expect(operator?.keyId).toBe(row.id);
    expect(operator?.keyId).not.toBe(reviewer?.keyId);
  });

  it("scopes each ENTITY key to its own entity", async () => {
    const acme = await prisma.entity.findUnique({ where: { externalId: "ent_acme_us" } });
    const principal = await authenticate(withHeader(API_KEYS.entities.ent_acme_us));

    expect(principal?.role).toBe("ENTITY");
    expect(principal?.entityId).toBe(acme!.id);
    expect(principal?.label).toBe("ACME US Inc API key");
  });

  it("seeds one ENTITY key per entity, each pointing at a distinct tenant", async () => {
    const principals = await Promise.all(
      Object.values(API_KEYS.entities).map((k) => principalForKey(k))
    );
    expect(principals.every((p) => p?.role === "ENTITY")).toBe(true);
    const entityIds = principals.map((p) => p?.entityId);
    expect(new Set(entityIds).size).toBe(entityIds.length);
    expect(entityIds.every(Boolean)).toBe(true);
  });

  it("rejects an unknown key and an anonymous request", async () => {
    await expect(authenticate(withHeader(generateKey()))).resolves.toBeNull();
    await expect(authenticate(new Request("http://test/api/payments"))).resolves.toBeNull();
  });

  it("falls back to the sos_key cookie, but prefers the header", async () => {
    await expect(authenticate(withCookie(`${API_KEY_COOKIE}=${API_KEYS.operator}`))).resolves.toMatchObject({
      role: "OPERATOR",
    });
    // Other cookies alongside it must not confuse the parser.
    await expect(
      authenticate(withCookie(`theme=dark; ${API_KEY_COOKIE}=${API_KEYS.reviewer}; other=1`))
    ).resolves.toMatchObject({ role: "REVIEWER" });

    const both = new Request("http://test/api/payments", {
      headers: { [API_KEY_HEADER]: API_KEYS.operator, cookie: `${API_KEY_COOKIE}=${API_KEYS.reviewer}` },
    });
    await expect(authenticate(both)).resolves.toMatchObject({ role: "OPERATOR" });
  });

  it("stores only key hashes — no raw key is recoverable from the DB", async () => {
    const rows = await prisma.apiKey.findMany();
    const raws = [API_KEYS.operator, API_KEYS.reviewer, ...Object.values(API_KEYS.entities)];
    const serialized = JSON.stringify(rows);

    expect(rows.length).toBe(raws.length);
    for (const raw of raws) expect(serialized).not.toContain(raw);
    expect(rows.map((r) => r.keyHash).sort()).toEqual(raws.map(hashKey).sort());
  });

  it("fails closed on a malformed key row rather than granting an unscoped identity", async () => {
    // An ENTITY key with no entityId has no tenant to scope to; an unknown role
    // is not a role we can authorize. Both must resolve to null, not a principal.
    const orphan = generateKey();
    const badRole = generateKey();
    await prisma.apiKey.create({
      data: { keyHash: hashKey(orphan), role: "ENTITY", label: "orphaned entity key" },
    });
    await prisma.apiKey.create({
      data: { keyHash: hashKey(badRole), role: "SUPERUSER", label: "unknown role" },
    });

    await expect(principalForKey(orphan)).resolves.toBeNull();
    await expect(principalForKey(badRole)).resolves.toBeNull();

    await prisma.apiKey.deleteMany({ where: { keyHash: { in: [hashKey(orphan), hashKey(badRole)] } } });
  });

  it("generates unguessable keys and hashes them stably", () => {
    const key = generateKey();
    expect(key).toMatch(/^sos_[0-9a-f]{48}$/);
    expect(generateKey()).not.toBe(key);
    expect(hashKey(key)).toBe(hashKey(key));
    expect(hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(key)).not.toBe(hashKey(generateKey()));
  });
});
