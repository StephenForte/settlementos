// Safe retries for write endpoints: the same Idempotency-Key replays the first
// response instead of creating (or executing) a second time.
//
// The mechanism is reserve-then-stamp, not check-then-write. A caller's first
// request *creates* the record (the unique index on (principalId, key) is what
// decides the race), runs the handler, then stamps the response onto the row it
// reserved. A duplicate therefore always finds a row: either one still in flight
// (409 — the original is running; retry once it lands) or one already stamped
// (replay). A check-then-write would let two duplicates both pass the check.
//
// Framework-free like lib/auth.ts and lib/api-errors.ts — the NextResponse half
// lives in app/api/idempotency.ts, so this stays callable from plain vitest.

import { createHash } from "node:crypto";
import { prisma } from "./db";

export const IDEMPOTENCY_HEADER = "idempotency-key";

/** How long a key is honoured. Enforced at read time, so no cron is needed. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Keys are the caller's to choose, but not to use as storage. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * Serialize a request body so that two semantically identical bodies hash alike
 * regardless of key order — `{a:1,b:2}` and `{b:2,a:1}` are the same request.
 * JSON.stringify's key order is insertion order, which a client does not control.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Fingerprint of a request body, used to reject a key reused for a different request. */
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

export type IdempotencyOutcome =
  /** No prior record: the caller owns `recordId` and must complete or abandon it. */
  | { kind: "fresh"; recordId: string }
  /** The key has a stored response — return it verbatim, do not run the handler. */
  | { kind: "replay"; status: number; body: string }
  /** The key was reused for a different request. */
  | { kind: "mismatch" }
  /** The original request holding this key has not finished yet. */
  | { kind: "in_flight" };

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

function isExpired(createdAt: Date, now: number): boolean {
  return now - createdAt.getTime() >= IDEMPOTENCY_TTL_MS;
}

/**
 * Claim `key` for this principal, or report what the existing record says.
 *
 * The loop exists because the row can move under us: it may be abandoned between
 * our failed create and our read, or reclaimed by another expired-key handler.
 * Two passes is enough — a second failure means someone else holds a live
 * reservation, which is exactly the in-flight answer.
 */
export async function beginIdempotent(
  principalId: string,
  key: string,
  route: string,
  requestHash: string
): Promise<IdempotencyOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const created = await prisma.idempotencyRecord.create({
        data: { principalId, key, route, requestHash },
      });
      return { kind: "fresh", recordId: created.id };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }

    const existing = await prisma.idempotencyRecord.findUnique({
      where: { principalId_key: { principalId, key } },
    });
    if (!existing) continue; // abandoned since our create failed — claim it again

    if (isExpired(existing.createdAt, Date.now())) {
      // Reclaim in place, conditional on the row we actually read, so two
      // concurrent reclaimers cannot both believe they own the key.
      const claimed = await prisma.idempotencyRecord.updateMany({
        where: { id: existing.id, createdAt: existing.createdAt },
        data: { route, requestHash, responseStatus: null, responseBody: null, createdAt: new Date() },
      });
      if (claimed.count === 1) return { kind: "fresh", recordId: existing.id };
      continue; // lost the reclaim — re-read the winner's row
    }

    // A key is a promise about one specific request. Reusing it for another —
    // different body, or the same body aimed at a different payment — is a
    // client bug, and replaying the old response would hide it.
    if (existing.route !== route || existing.requestHash !== requestHash) return { kind: "mismatch" };
    if (existing.responseStatus === null || existing.responseBody === null) return { kind: "in_flight" };
    return { kind: "replay", status: existing.responseStatus, body: existing.responseBody };
  }
  return { kind: "in_flight" };
}

/** Stamp the handler's response onto a reservation, making it replayable. */
export async function completeIdempotent(recordId: string, status: number, body: string): Promise<void> {
  await prisma.idempotencyRecord.update({
    where: { id: recordId },
    data: { responseStatus: status, responseBody: body },
  });
}

/**
 * Drop a reservation whose handler threw. Nothing is known about what happened,
 * so the honest answer to a retry is "run it again" — a reservation left behind
 * would answer 409 in-flight forever, locking the key out until it expired.
 */
export async function abandonIdempotent(recordId: string): Promise<void> {
  await prisma.idempotencyRecord.deleteMany({ where: { id: recordId } });
}
