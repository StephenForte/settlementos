import { NextRequest, NextResponse } from "next/server";
import { NETWORKS } from "@/lib/networks";
import { park } from "@/lib/treasury";
import { treasuryErrorResponse } from "../errors";
import { invalidRequest, requireRole } from "../../guard";
import { withIdempotentWrite } from "../../idempotency";

/**
 * Park idle treasury liquidity into the network's tokenized MMF. Platform
 * treasury funds, so OPERATOR only. The entity must be MMF-eligible and opted
 * in — lib/treasury enforces that guardrail and the refusal surfaces here as a
 * 403.
 *
 * park() moves real funds and has no dedupe of its own, so a retried request
 * without idempotency would park a second position. The Idempotency-Key wrapper
 * makes the retry of a timed-out park replay the first response instead.
 */
export async function POST(req: NextRequest) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  return withIdempotentWrite(req, principal, "POST /api/treasury/park", async (raw) =>
    runPark((raw ?? {}) as Record<string, unknown>)
  );
}

async function runPark(body: Record<string, unknown>): Promise<NextResponse> {
  const { network, asset, amount, entity_id } = body;

  if (!network || !asset || amount === undefined || amount === null || !entity_id) {
    return invalidRequest("network, asset, amount, entity_id are required");
  }
  if (typeof network !== "string" || !NETWORKS[network]) {
    return invalidRequest(`unknown network — supported: ${Object.keys(NETWORKS).join(", ")}`);
  }

  try {
    const result = await park({
      networkId: network,
      asset: String(asset),
      amount: String(amount),
      entityId: String(entity_id),
    });
    return NextResponse.json({
      position_id: result.positionId,
      status: "ACTIVE",
      tx_hash: result.txHash,
      shares: result.shares.toString(),
      index_at_entry: result.indexAtEntry.toString(),
    });
  } catch (e) {
    return treasuryErrorResponse(e);
  }
}
