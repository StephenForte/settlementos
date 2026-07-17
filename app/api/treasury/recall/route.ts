import { NextRequest, NextResponse } from "next/server";
import { ASSETS, fromBaseUnits, type AssetSymbol } from "@/lib/assets";
import { prisma } from "@/lib/db";
import { recall } from "@/lib/treasury";
import { treasuryErrorResponse } from "../errors";
import { invalidRequest, requireRole } from "../../guard";
import { beginIdempotency } from "../../idempotency";
import { beginWrite } from "../../limits";

/**
 * Recall a parked position T+0 — principal plus accrued yield back to the
 * treasury. Platform treasury funds, so OPERATOR only. Wrapped in the
 * Idempotency-Key scope so a retried recall replays rather than redeeming twice
 * (recall itself flips the position to RECALLED, so a same-position retry already
 * errors, but the wrapper keeps every treasury write uniform).
 */
export async function POST(req: NextRequest) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const gate = await beginWrite(req, principal);
  if (gate instanceof NextResponse) return gate;
  const body = (gate.body ?? {}) as Record<string, unknown>;

  const idem = await beginIdempotency(req, principal, "POST /api/treasury/recall", body);
  if (idem instanceof NextResponse) return idem;
  try {
    return await idem.complete(await runRecall(body));
  } catch (e) {
    await idem.abandon();
    throw e;
  }
}

async function runRecall(body: Record<string, unknown>): Promise<NextResponse> {
  const { position_id } = body;

  if (!position_id) {
    return invalidRequest("position_id is required");
  }

  try {
    const result = await recall(String(position_id));
    const position = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: result.positionId } });
    const decimals = ASSETS[position.asset as AssetSymbol].decimals;
    return NextResponse.json({
      position_id: result.positionId,
      status: position.status,
      tx_hash: result.txHash,
      shares: result.shares.toString(),
      amount: fromBaseUnits(result.assetAmount, decimals),
      index_at_exit: result.indexAtExit.toString(),
    });
  } catch (e) {
    return treasuryErrorResponse(e);
  }
}
