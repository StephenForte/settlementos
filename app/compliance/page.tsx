import Link from "next/link";
import { prisma } from "@/lib/db";
import { verifyAuditChain, type AuditIntegrity } from "@/lib/audit";
import { formatAmount } from "@/lib/assets";
import { excludeSupersededByRegenesisWhere } from "@/lib/networks";
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
      where: { AND: [{ status: "MANUAL_REVIEW" }, excludeSupersededByRegenesisWhere()] },
      include: { sender: true, recipient: true, complianceChecks: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.complianceCheck.findMany({
      where: { payment: excludeSupersededByRegenesisWhere() },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { payment: true },
    }),
    prisma.auditEvent.findMany({ orderBy: { id: "desc" }, take: 25 }),
    verifyAuditChain(),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Compliance Queue</h1>
          <p className="mt-1 text-sm text-body">
            Manual review queue, screening results, and the immutable audit log.
          </p>
        </div>
        <span
          className={`rounded-pill border px-3 py-1 text-xs font-medium ${
            integrity.valid
              ? "border-success-border bg-success-bg text-success-fg"
              : "border-danger-border bg-danger-bg text-danger-fg"
          }`}
        >
          Audit chain: {auditChainLabel(integrity)}
        </span>
      </header>

      <Card title={`Manual Review Queue (${queue.length})`}>
        {queue.length === 0 ? (
          <p className="text-sm text-body">No payments awaiting review.</p>
        ) : (
          <ul className="divide-y divide-mute">
            {queue.map((p) => {
              const flags = p.complianceChecks.filter((c) => c.status !== "PASS");
              return (
                <li key={p.id} className="flex items-center justify-between py-3">
                  <div>
                    <span className="font-mono text-sm text-ink">{p.id}</span>
                    <p className="text-xs text-body">
                      {p.sender.name} → {p.recipient.name} ·{" "}
                      {formatAmount(p.amount, p.sourceCurrency)} {p.sourceCurrency} →{" "}
                      {p.destinationCurrency}
                    </p>
                    <p className="mt-1 text-xs text-warning-fg">
                      {flags
                        .map((f) => `${f.checkType}: ${JSON.parse(f.reasonCodes).join("/") || f.status}`)
                        .join(" · ")}
                    </p>
                  </div>
                  <Link
                    href={`/payments/${p.id}`}
                    className="rounded-md border border-warning-border bg-warning-bg px-3 py-1.5 text-xs font-semibold text-warning-fg hover:opacity-90"
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
          <p className="text-sm text-body">No checks run yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-body">
              <tr>
                <th className="pb-2 pr-4">Payment</th>
                <th className="pb-2 pr-4">Check</th>
                <th className="pb-2 pr-4">Provider</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mute">
              {recentChecks.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-4">
                    <Link href={`/payments/${c.paymentId}`} className="font-mono text-xs text-primary hover:underline">
                      {c.paymentId}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-ink-mid">{c.checkType.replaceAll("_", " ")}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-body">{c.provider}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="py-2 text-ink-mid">{c.score}</td>
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
              <span className="shrink-0 font-mono text-body">#{e.id}</span>
              <span className="shrink-0 font-mono text-body">
                {new Date(e.createdAt).toLocaleTimeString()}
              </span>
              <span className="shrink-0 rounded-sm bg-canvas px-1.5 py-0.5 font-mono text-ink-mid">
                {e.action}
              </span>
              {e.paymentId && (
                <Link href={`/payments/${e.paymentId}`} className="shrink-0 font-mono text-primary hover:underline">
                  {e.paymentId}
                </Link>
              )}
              <span className="truncate text-body" title={e.detail}>
                {e.detail !== "{}" ? e.detail : ""}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-body">
                {e.hash.slice(0, 8)}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
