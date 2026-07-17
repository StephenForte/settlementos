import { NextRequest, NextResponse } from "next/server";
import { AuditAnchorError, createCheckpoint } from "@/lib/audit";
import { caughtErrorResponse, conflict, requireRole } from "../../guard";
import { enforceWriteRateLimit } from "../../limits";

/** Sign the audit chain at its current tip. OPERATOR only — this is the anchor
 * an auditor later checks the log against. */
export async function POST(req: NextRequest) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const limited = enforceWriteRateLimit(req, principal);
  if (limited) return limited;

  try {
    const checkpoint = await createCheckpoint();
    return NextResponse.json({
      id: checkpoint.id,
      last_event_id: checkpoint.lastEventId,
      chain_hash: checkpoint.chainHash,
      signature: checkpoint.signature,
      created_at: checkpoint.createdAt,
    });
  } catch (e) {
    // Both causes are states of the server, not faults in the request: no key
    // configured, or nothing to anchor yet. The messages are ours, so they are
    // safe to return.
    if (e instanceof AuditAnchorError) return conflict(e.message);
    return caughtErrorResponse(e, "internal", "POST /api/audit/checkpoint");
  }
}
