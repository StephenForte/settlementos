// Operator username/password for the admin UI. Parallel to API-key identity:
// a successful verify mints the existing `sos_key` cookie (AD3 option 1).
// Framework-free, like lib/auth.ts — the HTTP exchange lives in the route.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import { principalForKey } from "./auth";

/** Singleton row id — the table holds one credential. */
export const ADMIN_CREDENTIAL_ID = "admin";

const SALT_BYTES = 16;
const KEY_LEN = 64;
// Pinned so a future Node default change cannot invalidate stored hashes.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class AdminAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminAuthConfigError";
  }
}

export function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, SCRYPT_OPTS, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * scrypt-verify a password against a stored hex hash + salt. Rejects a
 * tampered hash, a tampered salt, and any malformed encoding — never throws
 * those as success, and never compares with `===`.
 */
export async function verifyPassword(password: string, hashHex: string, saltHex: string): Promise<boolean> {
  if (!isHex(hashHex) || !isHex(saltHex)) return false;
  const stored = Buffer.from(hashHex, "hex");
  const salt = Buffer.from(saltHex, "hex");
  if (stored.length === 0 || salt.length === 0) return false;
  try {
    const computed = await hashPassword(password, salt);
    if (computed.length !== stored.length) return false;
    return timingSafeEqual(computed, stored);
  } catch {
    return false;
  }
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Load the one credential row, seeding from ADMIN_USERNAME / ADMIN_PASSWORD
 * only when the table is empty. A row already present wins — env is ignored
 * (AD1). Returns null when there is nothing to seed from.
 */
export async function ensureAdminCredential() {
  const existing = await prisma.adminCredential.findFirst();
  if (existing) return existing;

  const username = (process.env.ADMIN_USERNAME ?? "").trim();
  // Password is not trimmed — leading/trailing spaces are legitimate characters.
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!username || !password) return null;

  const salt = randomBytes(SALT_BYTES);
  const passwordHash = (await hashPassword(password, salt)).toString("hex");
  try {
    return await prisma.adminCredential.create({
      data: {
        id: ADMIN_CREDENTIAL_ID,
        username,
        passwordHash,
        salt: salt.toString("hex"),
      },
    });
  } catch {
    // Lost the create race — the winner's row stands, env stays ignored.
    return prisma.adminCredential.findFirst();
  }
}

/**
 * Verify username + password against the stored row. Always runs scrypt when
 * a row exists (even on a wrong username) so the 401 is not a timing oracle.
 * Does not seed — the caller runs `ensureAdminCredential` first.
 */
export async function verifyAdminLogin(username: string, password: string): Promise<boolean> {
  const cred = await prisma.adminCredential.findFirst();
  if (!cred) {
    const dummySalt = Buffer.alloc(SALT_BYTES);
    const dummyHash = Buffer.alloc(KEY_LEN);
    const computed = await hashPassword(password, dummySalt);
    if (computed.length === dummyHash.length) timingSafeEqual(computed, dummyHash);
    return false;
  }
  const userOk = safeEqualString(username, cred.username);
  const passOk = await verifyPassword(password, cred.passwordHash, cred.salt);
  return userOk && passOk;
}

/**
 * The raw OPERATOR key that becomes the `sos_key` cookie. Throws a config
 * error (not a credential miss) when ADMIN_API_KEY is unset or does not
 * resolve to an OPERATOR principal — the route must not turn that into a 401.
 * Never include the key in the message.
 */
export async function resolveOperatorSessionKey(): Promise<{ raw: string; role: string; label: string }> {
  const raw = process.env.ADMIN_API_KEY?.trim() ?? "";
  if (!raw) {
    throw new AdminAuthConfigError("ADMIN_API_KEY is unset");
  }
  const principal = await principalForKey(raw);
  if (!principal || principal.role !== "OPERATOR") {
    throw new AdminAuthConfigError("ADMIN_API_KEY does not resolve to an OPERATOR principal");
  }
  return { raw, role: principal.role, label: principal.label };
}
