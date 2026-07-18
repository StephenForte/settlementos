import { NextRequest, NextResponse } from "next/server";
import { ASSETS, fromBaseUnits, type AssetSymbol } from "@/lib/assets";
import { prisma } from "@/lib/db";
import { toPage } from "@/lib/pagination";
import { currentIndexOf, positionDerivedValue } from "@/lib/treasury";
import { requireRole } from "../../guard";
import { parsePageOr400 } from "../../pagination";

/**
 * Parked MMF positions, newest first. A position's value is always derived
 * (shares x the fund's live index), never stored on the row — so ACTIVE rows
 * carry a live value and accrued yield, RECALLED rows carry their history.
 */
export async function GET(req: NextRequest) {
  // Platform treasury positions, not a tenant's own funds.
  const principal = await requireRole(req, "OPERATOR", "REVIEWER");
  if (principal instanceof NextResponse) return principal;

  const page = parsePageOr400(req.nextUrl.searchParams);
  if (page instanceof NextResponse) return page;

  // Bounded: the table is append-only history (recall flips status in place, rows
  // are never deleted), so it only grows — and each ACTIVE row costs a live index
  // read. Page it, tiebroken by id like the other list reads.
  const pageRows = await prisma.treasuryPosition.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const { rows: positions, nextCursor, hasMore } = toPage(pageRows, page.limit, (p) => p.id);

  // One index read per network rather than per row, and a network whose fund is
  // gone or whose RPC is unreachable simply reports no live value — the page
  // must never 500 on a flaky endpoint. Independent networks run in parallel.
  const networks = [...new Set(positions.filter((p) => p.status === "ACTIVE").map((p) => p.network))];
  const indexes = new Map(
    await Promise.all(
      networks.map(
        async (network) =>
          [network, await currentIndexOf(network).catch(() => null)] as const
      )
    )
  );

  return NextResponse.json({
    positions: positions.map((p) => {
      const decimals = ASSETS[p.asset as AssetSymbol]?.decimals ?? 0;
      const shares = BigInt(p.shares);
      const principalAmount = BigInt(p.assetAmountIn);
      const index = p.status === "ACTIVE" ? (indexes.get(p.network) ?? null) : null;
      const { value, accruedYield } = positionDerivedValue(shares, principalAmount, index);
      return {
        position_id: p.id,
        network: p.network,
        asset: p.asset,
        status: p.status,
        shares: p.shares,
        amount_in: fromBaseUnits(principalAmount, decimals),
        index_at_entry: p.indexAtEntry,
        current_index: index === null ? null : index.toString(),
        current_value: value === null ? null : fromBaseUnits(value, decimals),
        accrued_yield: accruedYield === null ? null : fromBaseUnits(accruedYield, decimals),
        tx_hash_park: p.txHashPark,
        tx_hash_recall: p.txHashRecall,
        created_at: p.createdAt.toISOString(),
        recalled_at: p.recalledAt ? p.recalledAt.toISOString() : null,
      };
    }),
    next_cursor: nextCursor,
    has_more: hasMore,
  });
}
