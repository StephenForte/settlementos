import { prisma } from "@/lib/db";
import {
  MMF_ABI,
  accountsFor,
  isChainReady,
  loadDeployments,
  mmfAddress,
  publicClientFor,
  tokenBalance,
} from "@/lib/chain";
import { explorerAddressUrl, networkInfo } from "@/lib/networks";
import { ASSETS, fromBaseUnits, type AssetSymbol } from "@/lib/assets";
import { parseScaledUnits } from "@/lib/money";
import {
  MMF_ANNUAL_RATE_BPS,
  currentIndexOf,
  freeTreasuryBalance,
  valueOfShares,
} from "@/lib/treasury";
import { isPlatformRole } from "@/lib/auth";
import { currentPrincipal } from "@/lib/session";
import { AuthRequired } from "@/components/auth-required";
import { Card } from "@/components/ui";
import { MmfCard, type MmfCardProps, type MmfPositionView } from "./mmf-card";

export const dynamic = "force-dynamic";

type PositionRow = Awaited<ReturnType<typeof prisma.treasuryPosition.findMany>>[number];
type EligibleEntity = { externalId: string; name: string } | null;

/** `fromBaseUnits` for a figure that may legitimately be below zero. */
function signedBaseUnits(units: bigint, decimals: number): string {
  return units < 0n ? `-${fromBaseUnits(-units, decimals)}` : fromBaseUnits(units, decimals);
}

/**
 * Per-network MMF view. Returns null where no fund is deployed (real testnets),
 * and `null` props where the fund exists but its RPC read failed — the page
 * degrades rather than 500s.
 */
async function mmfCardProps(
  networkId: string,
  positions: PositionRow[],
  entity: EligibleEntity
): Promise<MmfCardProps | null> {
  const fund = mmfAddress(networkId);
  if (!fund) return null;

  // The fund is single-asset: resolve the symbol it is actually backed by rather
  // than assuming, then read the live index and the unreserved treasury balance.
  let symbol: AssetSymbol;
  let index: bigint | null;
  let free: bigint;
  try {
    const assetAddress = (await publicClientFor(networkId).readContract({
      address: fund,
      abi: MMF_ABI,
      functionName: "asset",
    })) as string;
    const tokens = loadDeployments().networks[networkId].contracts.tokens;
    // Contracts hand back EIP-55 addresses; deployments.json stores them lowercase.
    const match = Object.entries(tokens).find(
      ([, t]) => t.address.toLowerCase() === assetAddress.toLowerCase()
    );
    if (!match) return null;
    symbol = match[0] as AssetSymbol;
    index = await currentIndexOf(networkId);
    free = (await freeTreasuryBalance(networkId, symbol)).free;
  } catch {
    return null; // RPC flaking — the caller renders a "fund unreachable" note
  }

  const decimals = ASSETS[symbol].decimals;
  let parked = 0n;
  let accrued = 0n;

  const views: MmfPositionView[] = positions.map((p) => {
    const shares = BigInt(p.shares);
    const principal = BigInt(p.assetAmountIn);
    const positionDecimals = ASSETS[p.asset as AssetSymbol]?.decimals ?? decimals;
    // Value is always DERIVED (shares x live index), never read off the row.
    const value = p.status === "ACTIVE" && index !== null ? valueOfShares(shares, index) : null;
    if (value !== null) {
      parked += value;
      accrued += value > principal ? value - principal : 0n;
    }
    return {
      positionId: p.id,
      asset: p.asset,
      status: p.status,
      shares: p.shares,
      amountIn: fromBaseUnits(principal, positionDecimals),
      currentValue: value === null ? null : fromBaseUnits(value, positionDecimals),
      accruedYield:
        value === null
          ? null
          : fromBaseUnits(value > principal ? value - principal : 0n, positionDecimals),
      indexAtEntry: p.indexAtEntry,
      createdAt: p.createdAt.toISOString(),
      txHashPark: p.txHashPark,
      txHashRecall: p.txHashRecall,
    };
  });

  return {
    networkId,
    asset: symbol,
    fundAddress: fund,
    fundUrl: explorerAddressUrl(networkId, fund),
    currentIndex: index === null ? null : index.toString(),
    parkedValue: index === null ? null : fromBaseUnits(parked, decimals),
    accruedYield: index === null ? null : fromBaseUnits(accrued, decimals),
    freeBalance: fromBaseUnits(free, decimals),
    annualRateBps: MMF_ANNUAL_RATE_BPS.toString(),
    entityId: entity?.externalId ?? null,
    entityName: entity?.name ?? null,
    positions: views,
  };
}

export default async function LiquidityPage() {
  // Treasury balances and MMF positions are platform funds — operator/reviewer
  // only, and park/recall (the card's controls) are OPERATOR-gated at the API.
  const principal = await currentPrincipal();
  if (!principal || !isPlatformRole(principal)) {
    return <AuthRequired message="Operator or reviewer access is required to view treasury liquidity." />;
  }

  if (!isChainReady()) {
    return (
      <Card title="Liquidity & Treasury">
        <p className="text-sm text-amber-300">
          Chains not set up. Run <code className="font-mono">npm run chain</code>,{" "}
          <code className="font-mono">npm run chain:polygon</code>, then{" "}
          <code className="font-mono">npm run setup</code>.
        </p>
      </Card>
    );
  }

  const dep = loadDeployments();

  const activeReservations = await prisma.liquidityReservation.findMany({
    where: { status: "RESERVED" },
  });
  // Base units, like every other figure on this page — a float sum here would
  // disagree with the bigint free balance the MMF card shows right beside it.
  const reservedBy: Record<string, bigint> = {};
  for (const r of activeReservations) {
    const decimals = dep.networks[r.network]?.contracts.tokens[r.asset]?.decimals;
    if (decimals === undefined) continue; // reserved on a network this deploy does not carry
    const key = `${r.network}:${r.asset}`;
    reservedBy[key] = (reservedBy[key] ?? 0n) + parseScaledUnits(r.amount, decimals, { what: "reserved amount" });
  }

  // Institutional-only guardrail: parking is offered only when a cleared,
  // opted-in institution exists. The API re-checks server-side regardless.
  const eligible = await prisma.entity.findFirst({
    where: { mmfEligible: true, mmfOptIn: true },
    select: { externalId: true, name: true },
  });
  const allPositions = await prisma.treasuryPosition.findMany({ orderBy: { createdAt: "desc" } });

  const networkSections = await Promise.all(
    Object.entries(dep.networks).map(async ([networkId, net]) => {
      const treasury = accountsFor(networkId).treasury.address;
      const section = {
        networkId,
        info: networkInfo(networkId),
        settlement: net.contracts.PaymentSettlement,
        tokens: [] as { symbol: string; address: string; balance: string; reserved: string; available: string }[],
        unreachable: false,
        hasFund: mmfAddress(networkId) !== undefined,
        mmf: await mmfCardProps(
          networkId,
          allPositions.filter((p) => p.network === networkId),
          eligible
        ),
      };
      try {
        section.tokens = await Promise.all(
          Object.entries(net.contracts.tokens).map(async ([symbol, t]) => {
            const raw = await tokenBalance(networkId, t.address, treasury);
            const reserved = reservedBy[`${networkId}:${symbol}`] ?? 0n;
            return {
              symbol,
              address: t.address,
              balance: fromBaseUnits(raw, t.decimals),
              reserved: fromBaseUnits(reserved, t.decimals),
              // Unclamped, unlike treasury.freeTreasuryBalance's guard: a treasury
              // that has promised more than it holds is an anomaly an operator has
              // to see, and showing it as zero is how it stays unseen.
              available: signedBaseUnits(raw - reserved, t.decimals),
            };
          })
        );
      } catch {
        section.unreachable = true; // e.g. public testnet RPC flaking — keep the page up
      }
      return section;
    })
  );

  const pendingOut = await prisma.payment.findMany({
    where: {
      status: {
        in: [
          "QUOTED",
          "COMPLIANCE_PENDING",
          "MANUAL_REVIEW",
          "APPROVED",
          "LIQUIDITY_RESERVED",
          "SUBMITTED_ONCHAIN",
          "CONFIRMED_ONCHAIN",
          "FX_OR_SWAP_COMPLETED",
          "PAYOUT_PENDING",
        ],
      },
    },
    include: { recipient: true },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Liquidity & Treasury</h1>
        <p className="mt-1 text-sm text-slate-400">
          Settlement treasury balances across {networkSections.length} EVM networks.
        </p>
      </header>

      {networkSections.map((section) => (
        <div key={section.networkId}>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="text-sm font-semibold text-white">{section.info.label}</h2>
            <span className="text-xs text-slate-500">
              chainId {section.info.chainId} ·{" "}
              {section.info.simulates ? `simulates ${section.info.simulates}` : "public testnet"} ·
              settlement{" "}
              {explorerAddressUrl(section.networkId, section.settlement) ? (
                <a
                  href={explorerAddressUrl(section.networkId, section.settlement)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sky-300 underline decoration-sky-500/40 underline-offset-2 hover:text-sky-200"
                >
                  {section.settlement.slice(0, 10)}… ↗
                </a>
              ) : (
                <span className="font-mono">{section.settlement.slice(0, 10)}…</span>
              )}
            </span>
          </div>
          {section.unreachable && (
            <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              RPC unreachable — balances unavailable right now.
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {section.tokens.map((t) => (
              <Card key={t.symbol}>
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">{t.symbol}</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {Number(t.balance).toLocaleString("en-US")}
                </p>
                <dl className="mt-3 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Reserved</dt>
                    <dd className={Number(t.reserved) > 0 ? "text-indigo-300" : "text-slate-400"}>
                      {Number(t.reserved).toLocaleString("en-US")}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Available</dt>
                    <dd className={t.available.startsWith("-") ? "text-rose-300" : "text-emerald-300"}>
                      {Number(t.available).toLocaleString("en-US")}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 truncate font-mono text-[10px] text-slate-600" title={t.address}>
                  {t.address}
                </p>
              </Card>
            ))}
          </div>

          <div className="mt-4">
            {section.mmf ? (
              <MmfCard {...section.mmf} />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-5 py-4">
                <p className="text-sm font-semibold text-slate-300">Tokenized MMF</p>
                <p className="mt-1 text-xs text-slate-500">
                  {section.hasFund
                    ? "Fund deployed but unreachable right now — live values unavailable."
                    : "Not deployed on this network. Idle-balance parking is available where a fund exists."}
                </p>
              </div>
            )}
          </div>
        </div>
      ))}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pending Outgoing Payments">
          {pendingOut.length === 0 ? (
            <p className="text-sm text-slate-500">None in flight.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {pendingOut.map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span className="text-slate-300">
                    <span className="font-mono text-xs">{p.id}</span> → {p.recipient.name}
                  </span>
                  <span className="text-slate-400">
                    {Number(p.amount).toLocaleString("en-US")} {p.sourceCurrency} · {p.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Active Liquidity Reservations">
          {activeReservations.length === 0 ? (
            <p className="text-sm text-slate-500">No active reservations.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {activeReservations.map((r) => (
                <li key={r.id} className="flex justify-between">
                  <span className="font-mono text-xs text-slate-300">{r.paymentId}</span>
                  <span className="text-indigo-300">
                    {Number(r.amount).toLocaleString("en-US")} {r.asset} · {r.network}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
