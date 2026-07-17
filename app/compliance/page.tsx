import Link from "next/link";
import { prisma } from "@/lib/db";
import { verifyAuditChain, type AuditIntegrity } from "@/lib/audit";
import { formatAmount } from "@/lib/assets";
import { isPlatformRole } from "@/lib/auth";
import { currentPrincipal } from "@/lib/session";
import { AuthRequired } from "@/components/auth-required";
import { Card, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Not every break has an event id to point at: a checkpoint whose signature does
 * not verify condemns the whole log before it, not one row. And an unanchored
 * chain is only self-consistent — worth saying out loud, since INTACT there is a
 * weaker claim than INTACT under a signature.
 */
function auditChainLabel(integrity: AuditIntegrity): string {
  if (!integrity.valid) {
    return integrity.brokenAtId ? `BROKEN at #${integrity.brokenAtId}` : `BROKEN (${integrity.reason})`;
  }
  return integrity.anchored ? "INTACT" : "INTACT (unanchored)";
}

export default async function CompliancePage() {
  // The review queue, screening results, and the audit log span every tenant —
  // platform roles only.
  const principal = await currentPrincipal();
  if (!principal || !isPlatformRole(principal)) {
    return <AuthRequired message="Operator or reviewer access is required to view the compliance queue." />;
  }

  const [queue, recentChecks, auditEvents, integrity] = await Promise.all([
    prisma.payment.findMany({
      where: { status: "MANUAL_REVIEW" },
      include: { sender: true, recipient: true, complianceChecks: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.complianceCheck.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { payment: true } }),
    prisma.auditEvent.findMany({ orderBy: { id: "desc" }, take: 25 }),
    verifyAuditChain(),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Compliance Queue</h1>
          <p className="mt-1 text-sm text-slate-400">
            Manual review queue, screening results, and the immutable audit log.
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            integrity.valid
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : "border-rose-500/40 bg-rose-500/10 text-rose-300"
          }`}
        >
          Audit chain: {auditChainLabel(integrity)}
        </span>
      </header>

      <Card title={`Manual Review Queue (${queue.length})`}>
        {queue.length === 0 ? (
          <p className="text-sm text-slate-500">No payments awaiting review.</p>
        ) : (
          <ul className="divide-y divide-slate-800/60">
            {queue.map((p) => {
              const flags = p.complianceChecks.filter((c) => c.status !== "PASS");
              return (
                <li key={p.id} className="flex items-center justify-between py-3">
                  <div>
                    <span className="font-mono text-sm text-white">{p.id}</span>
                    <p className="text-xs text-slate-400">
                      {p.sender.name} → {p.recipient.name} ·{" "}
                      {formatAmount(p.amount, p.sourceCurrency)} {p.sourceCurrency} →{" "}
                      {p.destinationCurrency}
                    </p>
                    <p className="mt-1 text-xs text-amber-300">
                      {flags
                        .map((f) => `${f.checkType}: ${JSON.parse(f.reasonCodes).join("/") || f.status}`)
                        .join(" · ")}
                    </p>
                  </div>
                  <Link
                    href={`/payments/${p.id}`}
                    className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-400"
                  >
                    Review
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Recent Screening Results">
        {recentChecks.length === 0 ? (
          <p className="text-sm text-slate-500">No checks run yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="pb-2 pr-4">Payment</th>
                <th className="pb-2 pr-4">Check</th>
                <th className="pb-2 pr-4">Provider</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {recentChecks.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-4">
                    <Link href={`/payments/${c.paymentId}`} className="font-mono text-xs text-emerald-400 hover:underline">
                      {c.paymentId}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-slate-300">{c.checkType.replaceAll("_", " ")}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">{c.provider}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="py-2 text-slate-300">{c.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Audit Log (latest 25)">
        <ol className="space-y-1.5">
          {auditEvents.map((e) => (
            <li key={e.id} className="flex items-baseline gap-3 text-xs">
              <span className="shrink-0 font-mono text-slate-600">#{e.id}</span>
              <span className="shrink-0 font-mono text-slate-500">
                {new Date(e.createdAt).toLocaleTimeString()}
              </span>
              <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-slate-300">
                {e.action}
              </span>
              {e.paymentId && (
                <Link href={`/payments/${e.paymentId}`} className="shrink-0 font-mono text-emerald-500 hover:underline">
                  {e.paymentId}
                </Link>
              )}
              <span className="truncate text-slate-500" title={e.detail}>
                {e.detail !== "{}" ? e.detail : ""}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-600">
                {e.hash.slice(0, 8)}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
