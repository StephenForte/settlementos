import { NextRequest, NextResponse } from "next/server";
import { NETWORKS } from "@/lib/networks";
import { accrueDaily } from "@/lib/treasury";
import { treasuryErrorResponse } from "../errors";
import { invalidRequest, requireRole } from "../../guard";
import { withIdempotentWrite } from "../../idempotency";

/**
 * Demo control: advance the network's fund by one day of simulated yield.
 * OPERATOR only, and the index is monotonic, so this is one-way — there is no
 * un-accrue. Idempotency-wrapped so a retried accrue does not advance the index
 * twice.
 */
export async function POST(req: NextRequest) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  return withIdempotentWrite(req, principal, "POST /api/treasury/accrue", async (raw) =>
    runAccrue((raw ?? {}) as Record<string, unknown>)
  );
}

async function runAccrue(body: Record<string, unknown>): Promise<NextResponse> {
  const { network } = body;

  if (!network) {
    return invalidRequest("network is required");
  }
  if (typeof network !== "string" || !NETWORKS[network]) {
    return invalidRequest(`unknown network — supported: ${Object.keys(NETWORKS).join(", ")}`);
  }

  try {
    const result = await accrueDaily(network);
    return NextResponse.json({
      network: result.network,
      old_index: result.oldIndex.toString(),
      new_index: result.newIndex.toString(),
      annual_rate_bps: result.annualRateBps.toString(),
      tx_hash: result.txHash,
    });
  } catch (e) {
    return treasuryErrorResponse(e);
  }
}
