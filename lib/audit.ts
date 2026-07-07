// Hash-chained, append-only audit log. Each event's hash covers its payload and
// the previous event's hash, so any tampering with history is detectable.

import { createHash } from "node:crypto";
import { prisma } from "./db";

export async function audit(
  action: string,
  detail: Record<string, unknown> = {},
  paymentId?: string,
  actor = "system"
) {
  // Serialize writes so the hash chain stays linear.
  return prisma.$transaction(async (tx) => {
    const last = await tx.auditEvent.findFirst({ orderBy: { id: "desc" } });
    const prevHash = last?.hash ?? "GENESIS";
    const detailJson = JSON.stringify(detail);
    const hash = createHash("sha256")
      .update(`${prevHash}|${action}|${actor}|${paymentId ?? ""}|${detailJson}`)
      .digest("hex");
    return tx.auditEvent.create({
      data: { action, actor, paymentId, detail: detailJson, prevHash, hash },
    });
  });
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
