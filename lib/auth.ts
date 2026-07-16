// API-key identity model. Every API caller presents a raw key; only its sha256
// hash is ever stored, so a DB leak does not hand out usable credentials.
//
// This module is foundation only — it resolves *who* a caller is. Enforcing what
// each role may do lives in the route handlers (US-003/US-004).

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";

export type Role = "OPERATOR" | "REVIEWER" | "ENTITY";

const ROLES: readonly Role[] = ["OPERATOR", "REVIEWER", "ENTITY"];

export type Principal = {
  role: Role;
  /** Set only for role=ENTITY — the Entity.id this key acts as. */
  entityId?: string;
  label: string;
};

export const API_KEY_HEADER = "x-api-key";
export const API_KEY_COOKIE = "sos_key";

/** Raw key format: `sos_` + 48 hex chars. Generated at seed time only. */
export function generateKey(): string {
  return `sos_${randomBytes(24).toString("hex")}`;
}

/**
 * Hash a raw key for storage/lookup. Keep this in sync with the inline copy in
 * scripts/setup.mjs (a .mjs seed script cannot import this TS module).
 */
export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Resolve a raw key to its principal, or null if the key is unknown or the row
 * is malformed. Lookup is by hash, so the raw key never needs a constant-time
 * compare — an attacker cannot steer a sha256 preimage toward an indexed match.
 */
export async function principalForKey(raw: string): Promise<Principal | null> {
  const record = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(raw) } });
  if (!record || !isRole(record.role)) return null;
  // Fail closed on a misconfigured key: an ENTITY key with no tenant to scope to
  // would otherwise be an unscoped identity.
  if (record.role === "ENTITY" && !record.entityId) return null;
  return {
    role: record.role,
    ...(record.entityId ? { entityId: record.entityId } : {}),
    label: record.label,
  };
}

function keyFromCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== API_KEY_COOKIE) continue;
    return decodeURIComponent(part.slice(eq + 1).trim()) || null;
  }
  return null;
}

/**
 * Identify the caller of an API request: `x-api-key` header first, then the
 * `sos_key` cookie (which the browser demo UI sets — see US-002). Returns null
 * for anonymous or invalid callers; callers decide the status code.
 */
export async function authenticate(request: Request): Promise<Principal | null> {
  const raw = request.headers.get(API_KEY_HEADER) ?? keyFromCookie(request);
  if (!raw) return null;
  return principalForKey(raw);
}
