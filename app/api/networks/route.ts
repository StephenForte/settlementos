import { NextResponse } from "next/server";
import { NETWORKS } from "@/lib/networks";
import { isChainReady, loadDeployments } from "@/lib/chain";

/** Registry networks with deployment availability (only deployed ones accept payments). */
export async function GET() {
  const deployed = isChainReady() ? new Set(Object.keys(loadDeployments().networks)) : new Set<string>();
  const networks = Object.values(NETWORKS).map((n) => ({
    id: n.id,
    label: n.label,
    chain_id: n.chainId,
    live: !!n.live,
    explorer_url: n.explorerUrl ?? null,
    available: deployed.has(n.id),
  }));
  return NextResponse.json({ networks });
}
