import { NextRequest, NextResponse } from "next/server";
import { NETWORKS } from "@/lib/networks";
import { park } from "@/lib/treasury";
import { treasuryErrorResponse } from "../errors";

/**
 * Park idle treasury liquidity into the network's tokenized MMF. The entity must
 * be MMF-eligible and opted in — lib/treasury enforces that guardrail and the
 * refusal surfaces here as a 403.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { network, asset, amount, entity_id } = body;

  if (!network || !asset || amount === undefined || amount === null || !entity_id) {
    return NextResponse.json({ error: "network, asset, amount, entity_id are required" }, { status: 400 });
  }
  if (!NETWORKS[network]) {
    return NextResponse.json(
      { error: `unknown network — supported: ${Object.keys(NETWORKS).join(", ")}` },
      { status: 400 }
    );
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
