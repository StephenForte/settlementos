import { NextRequest, NextResponse } from "next/server";
import { ASSETS, fromBaseUnits, type AssetSymbol } from "@/lib/assets";
import { prisma } from "@/lib/db";
import { recall } from "@/lib/treasury";
import { treasuryErrorResponse } from "../errors";
import { requireRole } from "../../guard";

/**
 * Recall a parked position T+0 — principal plus accrued yield back to the
 * treasury. Platform treasury funds, so OPERATOR only.
 */
export async function POST(req: NextRequest) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const body = await req.json().catch(() => ({}));
  const { position_id } = body;

  if (!position_id) {
    return NextResponse.json({ error: "position_id is required" }, { status: 400 });
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
