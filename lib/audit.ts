// Hash-chained, append-only audit log. Each event's hash covers its payload and
// the previous event's hash, so any tampering with history is detectable.
//
// The chain alone only detects an *edit*: an attacker with DB write access can
// re-hash every event from the tampered one forward and the log verifies clean.
// Checkpoints close that: every N events the tip hash is signed with
// AUDIT_ANCHOR_KEY, which lives in the environment and never in the database.
// Re-hashing history moves the tip, and the attacker cannot produce a signature
// for the tip they forged. Verification then only re-hashes events *after* the
// newest anchor, so cost stops growing with the log.

import type { Prisma } from "@prisma/client";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";

/**
 * A caller's open transaction. Passing one makes the event part of *that*
 * transaction, so the change and the record of it commit or roll back together —
 * an audit log that can disagree with state is worse than no log at all.
 */
export type AuditTx = Prisma.TransactionClient;

/** Events between automatic checkpoints. */
const DEFAULT_CHECKPOINT_INTERVAL = 100;

/** The signing key, read per call so tests (and a rotation) can change it. */
function anchorKey(): string | undefined {
  return process.env.AUDIT_ANCHOR_KEY || undefined;
}

function checkpointInterval(): number {
  const n = Number(process.env.AUDIT_CHECKPOINT_INTERVAL);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CHECKPOINT_INTERVAL;
}

function hashEvent(prevHash: string, e: { action: string; actor: string; paymentId: string | null; detail: string }) {
  return createHash("sha256")
    .update(`${prevHash}|${e.action}|${e.actor}|${e.paymentId ?? ""}|${e.detail}`)
    .digest("hex");
}

/**
 * Sign the anchor's *position* as well as its hash. Binding lastEventId is what
 * stops an attacker replaying the one signature they have against a different
 * event: with only the hash signed, they could truncate the log, stamp the
 * signed hash onto an earlier event's `hash` column, and re-chain forward.
 */
function signAnchor(lastEventId: number, chainHash: string, key: string): string {
  return createHmac("sha256", key).update(`${lastEventId}|${chainHash}`).digest("hex");
}

function signatureMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Append one event to the chain, inside `tx`.
 *
 * The read of the tip and the create of the new event must stay in the same
 * transaction: that is what serializes the chain. SQLite admits one writer at a
 * time, so a second appender's tip read cannot land between this one's read and
 * its create — it waits for this transaction to commit and then reads the event
 * it wrote. Split the two apart (or read the tip outside the tx) and two
 * appenders can both build on the same prevHash, forking the chain.
 */
async function appendEvent(
  tx: AuditTx,
  action: string,
  detail: Record<string, unknown>,
  paymentId: string | undefined,
  actor: string
) {
  const last = await tx.auditEvent.findFirst({ orderBy: { id: "desc" } });
  const prevHash = last?.hash ?? "GENESIS";
  const detailJson = JSON.stringify(detail);
  const hash = hashEvent(prevHash, { action, actor, paymentId: paymentId ?? null, detail: detailJson });
  const event = await tx.auditEvent.create({
    data: { action, actor, paymentId, detail: detailJson, prevHash, hash },
  });
  await maybeCheckpoint(tx, event);
  return event;
}

/**
 * Record an event. Pass `tx` to enlist in the caller's transaction — do that
 * whenever the event describes a domain change written in that same transaction.
 * Without one, the event gets a transaction of its own (a standalone event that
 * describes no row: an export, a quote).
 */
export async function audit(
  action: string,
  detail: Record<string, unknown> = {},
  paymentId?: string,
  actor = "system",
  tx?: AuditTx
) {
  if (tx) return appendEvent(tx, action, detail, paymentId, actor);
  return prisma.$transaction((t) => appendEvent(t, action, detail, paymentId, actor));
}

/**
 * Anchor the chain if enough events have accrued since the last one. Runs in the
 * appender's transaction, so a rolled-back event can never leave behind a
 * checkpoint pointing at an id that was never committed.
 *
 * With no key configured there is nothing to sign, and an unsigned checkpoint
 * would anchor nothing while making verification *look* anchored — so the demo
 * simply runs unanchored and `verifyAuditChain` says so.
 */
async function maybeCheckpoint(tx: AuditTx, event: { id: number; hash: string }) {
  const key = anchorKey();
  if (!key) return;
  const last = await tx.auditCheckpoint.findFirst({ orderBy: { id: "desc" } });
  const since = await tx.auditEvent.count({ where: { id: { gt: last?.lastEventId ?? 0 } } });
  if (since < checkpointInterval()) return;
  await writeCheckpoint(tx, event.id, event.hash, key);
}

async function writeCheckpoint(tx: AuditTx, lastEventId: number, chainHash: string, key: string) {
  return tx.auditCheckpoint.create({
    data: { lastEventId, chainHash, signature: signAnchor(lastEventId, chainHash, key) },
  });
}

export class AuditAnchorError extends Error {
  constructor(readonly code: "not_configured" | "no_events", message: string) {
    super(message);
    this.name = "AuditAnchorError";
  }
}

/**
 * Anchor the chain at its current tip, on demand.
 *
 * Deliberately writes no audit event of its own: an event describing the
 * checkpoint would extend the chain past the tip the checkpoint just signed,
 * leaving the anchor stale the instant it was made. The row *is* the record.
 */
export async function createCheckpoint() {
  const key = anchorKey();
  if (!key) {
    throw new AuditAnchorError("not_configured", "audit anchoring is not configured (AUDIT_ANCHOR_KEY)");
  }
  return prisma.$transaction(async (tx) => {
    const tip = await tx.auditEvent.findFirst({ orderBy: { id: "desc" } });
    if (!tip) throw new AuditAnchorError("no_events", "there are no audit events to anchor");
    const last = await tx.auditCheckpoint.findFirst({ orderBy: { id: "desc" } });
    // Already anchored at this tip — re-signing the same hash would just add a
    // duplicate row.
    if (last?.lastEventId === tip.id) return last;
    return writeCheckpoint(tx, tip.id, tip.hash, key);
  });
}

export type AuditIntegrity = {
  valid: boolean;
  /** The first event that failed to verify, when the break is in the chain itself. */
  brokenAtId?: number;
  /** Machine-readable cause when `valid` is false. */
  reason?: string;
  /** Whether verification could start from a signed anchor or had to re-hash everything. */
  mode: "incremental" | "full";
  /** False when AUDIT_ANCHOR_KEY is unset: the chain is self-consistent but nothing is signed. */
  anchored: boolean;
  checkpoint: { id: number; lastEventId: number; createdAt: Date } | null;
  /** Events re-hashed by this call (the rest are covered by the anchor). */
  eventsVerified: number;
};

/** Re-hash every event after `afterId`, chaining from `prevHash`. */
async function verifyFrom(prevHash: string, afterId: number) {
  const events = await prisma.auditEvent.findMany({
    where: { id: { gt: afterId } },
    orderBy: { id: "asc" },
  });
  for (const e of events) {
    if (e.prevHash !== prevHash || e.hash !== hashEvent(prevHash, e)) {
      return { valid: false, brokenAtId: e.id, eventsVerified: events.length };
    }
    prevHash = e.hash;
  }
  return { valid: true, eventsVerified: events.length };
}

/**
 * Verify the chain and report the first broken link, if any.
 *
 * With an anchor, only events after it are re-hashed — the anchor's signature is
 * what vouches for everything before it. Note the residual limit: an attacker who
 * deletes the checkpoint rows outright drops us back to full verification of a
 * chain they may have re-hashed. Detecting *that* needs the anchor published
 * somewhere we do not control (a counterparty, a public chain), which is the
 * next step beyond this one.
 */
export async function verifyAuditChain(): Promise<AuditIntegrity> {
  const key = anchorKey();
  const fullVerify = async (anchored: boolean): Promise<AuditIntegrity> => ({
    ...(await verifyFrom("GENESIS", 0)),
    mode: "full",
    anchored,
    checkpoint: null,
  });
  if (!key) return fullVerify(false);

  const checkpoint = await prisma.auditCheckpoint.findFirst({ orderBy: { id: "desc" } });
  if (!checkpoint) return fullVerify(true);

  const anchor = { id: checkpoint.id, lastEventId: checkpoint.lastEventId, createdAt: checkpoint.createdAt };
  const base = { mode: "incremental" as const, anchored: true, checkpoint: anchor, eventsVerified: 0 };

  if (!signatureMatches(signAnchor(checkpoint.lastEventId, checkpoint.chainHash, key), checkpoint.signature)) {
    return { ...base, valid: false, reason: "checkpoint_signature_mismatch" };
  }

  const anchorEvent = await prisma.auditEvent.findUnique({ where: { id: checkpoint.lastEventId } });
  if (!anchorEvent) {
    return { ...base, valid: false, reason: "checkpoint_anchor_missing" };
  }
  // The signed hash must still be the log's own hash at that position — this is
  // the check a re-hashed history fails, since the attacker cannot re-sign the
  // tip they produced.
  if (anchorEvent.hash !== checkpoint.chainHash) {
    return { ...base, valid: false, reason: "checkpoint_chain_hash_mismatch", brokenAtId: anchorEvent.id };
  }
  // ...and it must be a hash the anchor event's own content actually produces,
  // so the signed value cannot simply be pasted into the `hash` column.
  if (hashEvent(anchorEvent.prevHash, anchorEvent) !== anchorEvent.hash) {
    return { ...base, valid: false, reason: "checkpoint_anchor_forged", brokenAtId: anchorEvent.id };
  }

  return { ...base, ...(await verifyFrom(checkpoint.chainHash, checkpoint.lastEventId)) };
}
