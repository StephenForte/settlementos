import { NextRequest, NextResponse } from "next/server";
import { NETWORKS } from "@/lib/networks";
import { accrueDaily } from "@/lib/treasury";
import { treasuryErrorResponse } from "../errors";
import { requirePrincipal } from "../../guard";

/**
 * Demo control: advance the network's fund by one day of simulated yield. The
 * index is monotonic, so this is one-way — there is no un-accrue.
 */
export async function POST(req: NextRequest) {
  // Identity only — OPERATOR-gating lands in US-004.
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const body = await req.json().catch(() => ({}));
  const { network } = body;

  if (!network) {
    return NextResponse.json({ error: "network is required" }, { status: 400 });
  }
  if (!NETWORKS[network]) {
    return NextResponse.json(
      { error: `unknown network — supported: ${Object.keys(NETWORKS).join(", ")}` },
      { status: 400 }
    );
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
