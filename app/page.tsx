import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatAmount } from "@/lib/assets";
import { usdEquivalent } from "@/lib/fx";
import { Card, Stat, StatusBadge, Hash } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardHome() {
  const payments = await prisma.payment.findMany({
    include: { sender: true, recipient: true },
    orderBy: { createdAt: "desc" },
  });

  const settled = payments.filter((p) => p.status === "SETTLED");
  const volumeUsd = settled.reduce((sum, p) => {
    try {
      return sum + usdEquivalent(Number(p.amount), p.sourceCurrency);
    } catch {
      return sum;
    }
  }, 0);
  const pending = payments.filter(
    (p) => !["SETTLED", "REJECTED", "CANCELLED", "REFUNDED", "EXPIRED", "FAILED"].includes(p.status)
  );
  const failed = payments.filter((p) => ["FAILED", "REJECTED", "REFUNDED"].includes(p.status));
  const inReview = payments.filter((p) => p.status === "MANUAL_REVIEW");
  const recent = payments.slice(0, 8);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Settlement Dashboard</h1>
          <p className="mt-1 text-sm text-slate-400">
            Cross-border B2B stablecoin settlement · local EVM network (Base Sepolia–compatible)
          </p>
        </div>
        <Link
          href="/payments/new"
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400"
        >
          New Payment
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Settled Volume" value={`$${formatAmount(volumeUsd.toFixed(2))}`} sub="USD equivalent" />
        <Stat label="Settled Payments" value={String(settled.length)} />
        <Stat label="In Flight" value={String(pending.length)} sub={`${inReview.length} awaiting review`} />
        <Stat label="Failed / Rejected" value={String(failed.length)} />
      </div>

      {inReview.length > 0 && (
        <Card title="Compliance Alerts">
          <ul className="space-y-2">
            {inReview.map((p) => (
              <li key={p.id} className="flex items-center justify-between text-sm">
                <span className="text-amber-300">
                  {p.id} — {p.sender.name} → {p.recipient.name} ({p.sourceCurrency}{" "}
                  {formatAmount(p.amount, p.sourceCurrency)}) requires manual review
                </span>
                <Link href={`/payments/${p.id}`} className="text-emerald-400 hover:underline">
                  Review →
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Recent Payments">
        {recent.length === 0 ? (
          <p className="text-sm text-slate-500">
            No payments yet.{" "}
            <Link href="/payments/new" className="text-emerald-400 hover:underline">
              Create the first one
            </Link>
            .
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="pb-2 pr-4">Payment</th>
                <th className="pb-2 pr-4">Corridor</th>
                <th className="pb-2 pr-4">Amount</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Escrow Tx</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {recent.map((p) => (
                <tr key={p.id}>
                  <td className="py-2.5 pr-4">
                    <span className="font-mono text-xs">{p.id}</span>
                    <div className="text-xs text-slate-500">
                      {p.sender.name} → {p.recipient.name}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-300">
                    {p.sourceCurrency} → {p.destinationCurrency}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-200">
                    {formatAmount(p.amount, p.sourceCurrency)} {p.sourceCurrency}
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="py-2.5 pr-4">
                    <Hash value={p.txHash} />
                  </td>
                  <td className="py-2.5 text-right">
                    <Link href={`/payments/${p.id}`} className="text-emerald-400 hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex gap-3 text-sm">
        <a href="/api/reconciliation" className="text-slate-400 underline-offset-4 hover:text-white hover:underline">
          Export reconciliation CSV
        </a>
        <span className="text-slate-700">·</span>
        <Link href="/liquidity" className="text-slate-400 underline-offset-4 hover:text-white hover:underline">
          Liquidity dashboard
        </Link>
      </div>
    </div>
  );
}
