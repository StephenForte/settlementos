import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatAmount } from "@/lib/assets";
import { explorerTxUrl } from "@/lib/networks";
import { usdEquivalent } from "@/lib/fx";
import { formatMinorUnits, parseAmount } from "@/lib/money";
import { stuckPayments } from "@/lib/executor";
import { isPlatformRole } from "@/lib/auth";
import { currentPrincipal } from "@/lib/session";
import { AuthRequired } from "@/components/auth-required";
import { Card, Stat, StatusBadge, Hash } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardHome() {
  // The dashboard aggregates platform-wide volume, the review queue, and the
  // stuck-payment count — an operations overview, so platform roles only. A
  // signed-in tenant works from /payments (scoped to its own rows); an anonymous
  // browser gets the sign-in wall instead of every tenant's data.
  const principal = await currentPrincipal();
  if (!principal || !isPlatformRole(principal)) {
    return <AuthRequired message="Operator or reviewer access is required to view the dashboard." />;
  }

  const payments = await prisma.payment.findMany({
    include: { sender: true, recipient: true },
    orderBy: { createdAt: "desc" },
  });
  // The same read the repair view does, so the count and the list can never
  // disagree. Chain reads, so it degrades to zero rather than breaking the page.
  const stuck = await stuckPayments().catch(() => []);

  const settled = payments.filter((p) => p.status === "SETTLED");
  const volumeUsd = settled.reduce((sum, p) => {
    try {
      return sum + usdEquivalent(parseAmount(p.amount, p.sourceCurrency), p.sourceCurrency);
    } catch {
      return sum;
    }
  }, 0n);
  const pending = payments.filter(
    (p) => !["SETTLED", "COMPENSATED", "REJECTED", "CANCELLED", "REFUNDED", "EXPIRED", "FAILED"].includes(p.status)
  );
  const failed = payments.filter((p) =>
    ["FAILED", "REJECTED", "REFUNDED", "COMPENSATION_PENDING", "COMPENSATED"].includes(p.status)
  );
  const inReview = payments.filter((p) => p.status === "MANUAL_REVIEW");
  const recent = payments.slice(0, 8);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Settlement Dashboard</h1>
          <p className="mt-1 text-sm text-body">
            Cross-border B2B stablecoin settlement · local EVM network (Base Sepolia–compatible)
          </p>
        </div>
        <Link
          href="/payments/new"
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90"
        >
          New Payment
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Settled Volume"
          value={`$${formatAmount(formatMinorUnits(volumeUsd, "USD"))}`}
          sub="USD equivalent"
        />
        <Stat label="Settled Payments" value={String(settled.length)} />
        <Stat label="In Flight" value={String(pending.length)} sub={`${inReview.length} awaiting review`} />
        <Stat label="Failed / Rejected" value={String(failed.length)} />
      </div>

      {stuck.length > 0 && (
        <Card title="Needs Attention">
          <div className="flex items-center justify-between text-sm">
            <span className="text-danger-fg">
              {stuck.length} payment{stuck.length === 1 ? "" : "s"} holding funds that were neither
              delivered nor returned
            </span>
            <Link href="/payments/stuck" className="text-primary hover:underline">
              Repair →
            </Link>
          </div>
        </Card>
      )}

      {inReview.length > 0 && (
        <Card title="Compliance Alerts">
          <ul className="space-y-2">
            {inReview.map((p) => (
              <li key={p.id} className="flex items-center justify-between text-sm">
                <span className="text-warning-fg">
                  {p.id} — {p.sender.name} → {p.recipient.name} ({p.sourceCurrency}{" "}
                  {formatAmount(p.amount, p.sourceCurrency)}) requires manual review
                </span>
                <Link href={`/payments/${p.id}`} className="text-primary hover:underline">
                  Review →
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Recent Payments">
        {recent.length === 0 ? (
          <p className="text-sm text-body">
            No payments yet.{" "}
            <Link href="/payments/new" className="text-primary hover:underline">
              Create the first one
            </Link>
            .
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-body">
              <tr>
                <th className="pb-2 pr-4">Payment</th>
                <th className="pb-2 pr-4">Corridor</th>
                <th className="pb-2 pr-4">Amount</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Escrow Tx</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-mute">
              {recent.map((p) => (
                <tr key={p.id}>
                  <td className="py-2.5 pr-4">
                    <span className="font-mono text-xs">{p.id}</span>
                    <div className="text-xs text-body">
                      {p.sender.name} → {p.recipient.name}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-ink-mid">
                    {p.sourceCurrency} → {p.destinationCurrency}
                    <div className="text-[10px] text-body">
                      {p.sourceNetwork === p.destinationNetwork
                        ? p.sourceNetwork
                        : `${p.sourceNetwork} ⇢ ${p.destinationNetwork}`}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-ink">
                    {formatAmount(p.amount, p.sourceCurrency)} {p.sourceCurrency}
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="py-2.5 pr-4">
                    <Hash value={p.txHash} href={explorerTxUrl(p.sourceNetwork, p.txHash)} />
                  </td>
                  <td className="py-2.5 text-right">
                    <Link href={`/payments/${p.id}`} className="text-primary hover:underline">
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
        <a href="/api/reconciliation" className="text-body underline-offset-4 hover:text-ink hover:underline">
          Export reconciliation CSV
        </a>
        <span className="text-mute" aria-hidden>
          ·
        </span>
        <Link href="/liquidity" className="text-body underline-offset-4 hover:text-ink hover:underline">
          Liquidity dashboard
        </Link>
      </div>
    </div>
  );
}
