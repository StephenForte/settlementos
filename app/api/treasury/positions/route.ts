import { NextRequest, NextResponse } from "next/server";
import { ASSETS, fromBaseUnits, type AssetSymbol } from "@/lib/assets";
import { prisma } from "@/lib/db";
import { PaginationError, parsePageRequest, toPage } from "@/lib/pagination";
import { currentIndexOf, valueOfShares } from "@/lib/treasury";
import { invalidRequest, requireRole } from "../../guard";

/**
 * Parked MMF positions, newest first. A position's value is always derived
 * (shares x the fund's live index), never stored on the row — so ACTIVE rows
 * carry a live value and accrued yield, RECALLED rows carry their history.
 */
export async function GET(req: NextRequest) {
  // Platform treasury positions, not a tenant's own funds.
  const principal = await requireRole(req, "OPERATOR", "REVIEWER");
  if (principal instanceof NextResponse) return principal;

  let page;
  try {
    page = parsePageRequest(req.nextUrl.searchParams);
  } catch (e) {
    if (e instanceof PaginationError) return invalidRequest(e.message);
    throw e;
  }

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
  // must never 500 on a flaky endpoint.
  const indexes = new Map<string, bigint | null>();
  for (const network of new Set(positions.filter((p) => p.status === "ACTIVE").map((p) => p.network))) {
    indexes.set(network, await currentIndexOf(network).catch(() => null));
  }

  return NextResponse.json({
    positions: positions.map((p) => {
      const decimals = ASSETS[p.asset as AssetSymbol]?.decimals ?? 0;
      const shares = BigInt(p.shares);
      const principal = BigInt(p.assetAmountIn);
      const index = p.status === "ACTIVE" ? (indexes.get(p.network) ?? null) : null;
      const value = index === null ? null : valueOfShares(shares, index);
      return {
        position_id: p.id,
        network: p.network,
        asset: p.asset,
        status: p.status,
        shares: p.shares,
        amount_in: fromBaseUnits(principal, decimals),
        index_at_entry: p.indexAtEntry,
        current_index: index === null ? null : index.toString(),
        current_value: value === null ? null : fromBaseUnits(value, decimals),
        accrued_yield:
          value === null ? null : fromBaseUnits(value > principal ? value - principal : 0n, decimals),
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
