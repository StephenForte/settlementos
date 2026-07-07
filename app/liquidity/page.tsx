import { prisma } from "@/lib/db";
import { isChainReady, loadDeployments, tokenBalance } from "@/lib/chain";
import { fromBaseUnits } from "@/lib/assets";
import { Card, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LiquidityPage() {
  if (!isChainReady()) {
    return (
      <Card title="Liquidity & Treasury">
        <p className="text-sm text-amber-300">
          Chain not set up. Run <code className="font-mono">npm run chain</code> then{" "}
          <code className="font-mono">npm run setup</code>.
        </p>
      </Card>
    );
  }

  const dep = loadDeployments();
  const tokens = Object.entries(dep.contracts.tokens);

  const treasury = await Promise.all(
    tokens.map(async ([symbol, t]) => {
      const raw = await tokenBalance(t.address, dep.accounts.treasury.address);
      return { symbol, address: t.address, balance: fromBaseUnits(raw, t.decimals) };
    })
  );

  const activeReservations = await prisma.liquidityReservation.findMany({
    where: { status: "RESERVED" },
    include: { payment: true },
  });
  const reservedByAsset: Record<string, number> = {};
  for (const r of activeReservations) {
    reservedByAsset[r.asset] = (reservedByAsset[r.asset] ?? 0) + Number(r.amount);
  }

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
          Settlement treasury balances on {dep.network} · contract{" "}
          <span className="font-mono text-xs">{dep.contracts.PaymentSettlement}</span>
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {treasury.map((t) => {
          const reserved = reservedByAsset[t.symbol] ?? 0;
          const available = Number(t.balance) - reserved;
          return (
            <Card key={t.symbol}>
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">{t.symbol}</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {Number(t.balance).toLocaleString("en-US")}
              </p>
              <dl className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Reserved</dt>
                  <dd className={reserved > 0 ? "text-indigo-300" : "text-slate-400"}>
                    {reserved.toLocaleString("en-US")}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Available</dt>
                  <dd className={available < 0 ? "text-rose-300" : "text-emerald-300"}>
                    {available.toLocaleString("en-US")}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 truncate font-mono text-[10px] text-slate-600" title={t.address}>
                {t.address}
              </p>
            </Card>
          );
        })}
      </div>

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
                    {Number(r.amount).toLocaleString("en-US")} {r.asset}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Tokenized Treasury Products">
        <div className="rounded-lg border border-dashed border-slate-700 bg-slate-900/40 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">Tokenized T-Bill Strategy</p>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
                Park idle stablecoin balances in approved tokenized T-bill or money-market products.
                Payment settlement balances remain legally and operationally separate from treasury
                products.
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-slate-600 bg-slate-800 px-3 py-1 text-[11px] text-slate-300">
              NOT ENABLED — FUTURE
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1 text-xs md:grid-cols-4">
            <dt className="text-slate-500">Eligibility</dt>
            <dd className="text-slate-300">Institutional only</dd>
            <dt className="text-slate-500">Estimated yield</dt>
            <dd className="text-slate-300">Simulated</dd>
            <dt className="text-slate-500">Risk</dt>
            <dd className="text-slate-300">Requires approval</dd>
            <dt className="text-slate-500">Status</dt>
            <dd className="text-slate-300">Placeholder</dd>
          </dl>
        </div>
      </Card>
    </div>
  );
}
