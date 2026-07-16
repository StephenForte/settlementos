import { NextRequest, NextResponse } from "next/server";
import { NETWORKS } from "@/lib/networks";
import { accrueDaily } from "@/lib/treasury";
import { treasuryErrorResponse } from "../errors";
import { invalidRequest, requireRole } from "../../guard";

/**
 * Demo control: advance the network's fund by one day of simulated yield.
 * OPERATOR only, and the index is monotonic, so this is one-way — there is no
 * un-accrue.
 */
export async function POST(req: NextRequest) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const body = await req.json().catch(() => ({}));
  const { network } = body;

  if (!network) {
    return invalidRequest("network is required");
  }
  if (!NETWORKS[network]) {
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
