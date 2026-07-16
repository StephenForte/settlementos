// Hash-chained, append-only audit log. Each event's hash covers its payload and
// the previous event's hash, so any tampering with history is detectable.

import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "./db";

/**
 * A caller's open transaction. Passing one makes the event part of *that*
 * transaction, so the change and the record of it commit or roll back together —
 * an audit log that can disagree with state is worse than no log at all.
 */
export type AuditTx = Prisma.TransactionClient;

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
  const hash = createHash("sha256")
    .update(`${prevHash}|${action}|${actor}|${paymentId ?? ""}|${detailJson}`)
    .digest("hex");
  return tx.auditEvent.create({
    data: { action, actor, paymentId, detail: detailJson, prevHash, hash },
  });
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

/** Recompute the chain and report the first broken link, if any. */
export async function verifyAuditChain(): Promise<{ valid: boolean; brokenAtId?: number }> {
  const events = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
  let prevHash = "GENESIS";
  for (const e of events) {
    const expected = createHash("sha256")
      .update(`${prevHash}|${e.action}|${e.actor}|${e.paymentId ?? ""}|${e.detail}`)
      .digest("hex");
    if (e.prevHash !== prevHash || e.hash !== expected) {
      return { valid: false, brokenAtId: e.id };
    }
    prevHash = e.hash;
  }
  return { valid: true };
}
