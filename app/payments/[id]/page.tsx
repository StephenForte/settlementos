"use client";

import { Fragment, use, useCallback, useEffect, useState } from "react";
import { Card, StatusBadge, Hash } from "@/components/ui";
import { explorerTxUrl } from "@/lib/networks";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LIFECYCLE = [
  "DRAFT",
  "QUOTED",
  "COMPLIANCE_PENDING",
  "APPROVED",
  "LIQUIDITY_RESERVED",
  "SUBMITTED_ONCHAIN",
  "CONFIRMED_ONCHAIN",
  "FX_OR_SWAP_COMPLETED",
  "PAYOUT_PENDING",
  "SETTLED",
];

function fmt(amount: string | null | undefined, currency?: string) {
  if (amount == null || amount === "") return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  const digits = currency === "JPY" ? 0 : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export default function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [payment, setPayment] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/payments/${id}`);
    if (res.ok) {
      const data = await res.json();
      setPayment(data.payment);
      setSelectedRoute((r) => r ?? data.payment.selectedRouteId);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount populates state
    refresh();
  }, [refresh]);

  async function action(label: string, path: string, body?: object) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json();
      if (!res.ok && data.message) setError(data.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      refresh();
    }
  }

  if (!payment) {
    return <p className="text-sm text-body">Loading payment…</p>;
  }

  const routes: any[] = payment.quoteJson ? JSON.parse(payment.quoteJson) : [];
  const fees = payment.feeJson ? JSON.parse(payment.feeJson) : null;
  const status: string = payment.status;
  const lifecycleIdx = LIFECYCLE.indexOf(status);
  const isTerminalBad = ["REJECTED", "FAILED", "CANCELLED", "REFUNDED", "EXPIRED", "COMPENSATED"].includes(
    status
  );

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-xl font-semibold text-ink">{payment.id}</h1>
            <StatusBadge status={status} />
          </div>
          <p className="mt-1 text-sm text-body">
            {payment.sender.name} ({payment.sender.country}) → {payment.recipient.name} (
            {payment.recipient.country}) · {payment.referenceId || "no reference"} ·{" "}
            {payment.purpose?.replaceAll("_", " ") || "unspecified purpose"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold text-ink">
            {fmt(payment.amount, payment.sourceCurrency)}{" "}
            <span className="text-base text-body">{payment.sourceCurrency}</span>
          </p>
          {payment.destinationAmount && (
            <p className="text-sm text-success-fg">
              → {fmt(payment.destinationAmount, payment.destinationCurrency)} {payment.destinationCurrency}
            </p>
          )}
        </div>
      </header>

      {/* Lifecycle timeline */}
      <Card title="Payment Lifecycle">
        <ol className="flex flex-wrap items-center gap-y-3">
          {LIFECYCLE.map((s, i) => {
            const reached = lifecycleIdx >= i && !isTerminalBad;
            const isCurrent = s === status;
            return (
              <li key={s} className="flex items-center">
                <span
                  className={`rounded-pill px-2 py-0.5 text-[10px] font-medium tracking-wide ${
                    isCurrent
                      ? "bg-primary text-ink"
                      : reached
                        ? "bg-success-bg text-success-fg"
                        : "bg-canvas-soft text-body"
                  }`}
                >
                  {s.replaceAll("_", " ")}
                </span>
                {i < LIFECYCLE.length - 1 && (
                  <span className={`mx-1 h-px w-3 ${reached && lifecycleIdx > i ? "bg-success-border" : "bg-mute"}`} />
                )}
              </li>
            );
          })}
        </ol>
        {isTerminalBad && (
          <p className="mt-3 text-sm text-danger-fg">
            Terminal state: {status}
            {payment.failureReason ? ` — ${payment.failureReason}` : ""}
          </p>
        )}
      </Card>

      {/* Actions */}
      <Card title="Actions">
        <div className="flex flex-wrap gap-3">
          {status === "DRAFT" && (
            <button
              onClick={() => action("quote", `/api/payments/${id}/quote`)}
              disabled={!!busy}
              className="rounded-md border border-info-border bg-info-bg px-4 py-2 text-sm font-semibold text-info-fg hover:opacity-90 disabled:opacity-50"
            >
              {busy === "quote" ? "Quoting…" : "Get Route Quote"}
            </button>
          )}
          {status === "QUOTED" && (
            <button
              onClick={() => action("execute", `/api/payments/${id}/execute`, { route_id: selectedRoute })}
              disabled={!!busy}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
            >
              {busy === "execute" ? "Running compliance + settlement…" : "Run Compliance & Execute"}
            </button>
          )}
          {status === "APPROVED" && (
            <button
              onClick={() => action("execute", `/api/payments/${id}/execute`)}
              disabled={!!busy}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
            >
              {busy === "execute" ? "Settling on-chain…" : "Execute Settlement"}
            </button>
          )}
          {status === "MANUAL_REVIEW" && (
            <>
              <button
                onClick={() => action("approve", `/api/payments/${id}/review`, { decision: "approve" })}
                disabled={!!busy}
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
              >
                Approve (Compliance Reviewer)
              </button>
              <button
                onClick={() => action("reject", `/api/payments/${id}/review`, { decision: "reject" })}
                disabled={!!busy}
                className="rounded-md border border-danger-border bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-fg hover:opacity-90 disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}
          {["DRAFT", "QUOTED", "COMPLIANCE_PENDING", "MANUAL_REVIEW", "APPROVED"].includes(status) && (
            <button
              onClick={() => action("cancel", `/api/payments/${id}/cancel`)}
              disabled={!!busy}
              className="rounded-md border border-mute px-4 py-2 text-sm text-ink-mid hover:bg-canvas-soft disabled:opacity-50"
            >
              Cancel Payment
            </button>
          )}
          {status === "SETTLED" && (
            <a
              href="/api/reconciliation"
              className="rounded-md border border-mute px-4 py-2 text-sm text-ink-mid hover:bg-canvas-soft"
            >
              Export Reconciliation CSV
            </a>
          )}
        </div>
        {error && (
          <p className="mt-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
            {error}
          </p>
        )}
      </Card>

      {/* Route options */}
      {routes.length > 0 && (
        <Card title="Route Options">
          <div className="grid gap-3 md:grid-cols-2">
            {routes.map((r) => {
              const selected = selectedRoute === r.route_id;
              const selectable = status === "QUOTED";
              return (
                <button
                  key={r.route_id}
                  type="button"
                  disabled={!selectable}
                  onClick={() => setSelectedRoute(r.route_id)}
                  className={`rounded-md border p-4 text-left transition-colors ${
                    selected ? "border-primary bg-primary/5" : "border-mute bg-canvas"
                  } ${selectable ? "cursor-pointer hover:border-primary" : "cursor-default"}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-ink">
                      {r.strategy.replaceAll("_", " ")}
                    </span>
                    {r.recommended && (
                      <span className="rounded-pill bg-success-bg px-2 py-0.5 text-[10px] font-medium text-success-fg">
                        RECOMMENDED
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-body">{r.description}</p>
                  {r.hops && (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {r.hops.map((hop: string, i: number) => (
                        <Fragment key={i}>
                          {i > 0 && <span className="text-body">→</span>}
                          <span className="rounded bg-canvas-soft px-1.5 py-0.5 text-[10px] text-ink-mid">
                            {hop}
                          </span>
                        </Fragment>
                      ))}
                    </div>
                  )}
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-body">FX rate</dt>
                    <dd className="text-ink">
                      {Number(r.estimated_fx_rate).toFixed(4)}{" "}
                      <span className="text-body">(mid {Number(r.mid_market_rate).toFixed(4)})</span>
                    </dd>
                    <dt className="text-body">Destination amount</dt>
                    <dd className="text-ink">
                      {fmt(r.estimated_destination_amount, payment.destinationCurrency)}{" "}
                      {payment.destinationCurrency}
                    </dd>
                    <dt className="text-body">Est. gas</dt>
                    <dd className="text-ink">${r.estimated_gas_usd}</dd>
                    <dt className="text-body">Est. time</dt>
                    <dd className="text-ink">
                      {r.estimated_time_seconds < 60
                        ? `${r.estimated_time_seconds}s`
                        : `${Math.round(r.estimated_time_seconds / 3600)}h`}
                    </dd>
                    <dt className="text-body">Liquidity</dt>
                    <dd
                      className={
                        !r.liquidity_available
                          ? "text-danger-fg"
                          : r.recall_required
                            ? "text-warning-fg"
                            : "text-success-fg"
                      }
                    >
                      {!r.liquidity_available
                        ? "Shortfall"
                        : r.recall_required
                          ? "Available — MMF recall (T+0)"
                          : "Available"}
                    </dd>
                    <dt className="text-body">Route</dt>
                    <dd className="text-ink">
                      {r.source_network === r.destination_network
                        ? r.source_network
                        : `${r.source_network} → ${r.destination_network}`}
                    </dd>
                    {r.bridge_fee_bps > 0 && (
                      <>
                        <dt className="text-body">Bridge fee</dt>
                        <dd className="text-ink">{r.bridge_fee_bps} bps</dd>
                      </>
                    )}
                  </dl>
                </button>
              );
            })}
          </div>
          {fees && (
            <div className="mt-4 rounded-md border border-mute bg-canvas-soft p-3 text-xs text-body">
              <span className="font-medium text-ink-mid">Fee breakdown:</span> platform fee{" "}
              {fmt(fees.platform_fee, payment.sourceCurrency)} {payment.sourceCurrency} (
              {fees.platform_fee_bps} bps) · FX spread {fees.fx_spread_bps} bps · slippage est.{" "}
              {fees.slippage_bps} bps · network gas ≈ ${fees.estimated_gas_usd}
            </div>
          )}
        </Card>
      )}

      {/* Compliance checks */}
      {payment.complianceChecks.length > 0 && (
        <Card title="Compliance Checks">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-body">
              <tr>
                <th className="pb-2 pr-4">Check</th>
                <th className="pb-2 pr-4">Provider</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Score</th>
                <th className="pb-2">Reason Codes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mute">
              {payment.complianceChecks.map((c: any) => (
                <tr key={c.id}>
                  <td className="py-2 pr-4 text-ink">{c.checkType.replaceAll("_", " ")}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-body">{c.provider}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="py-2 pr-4 text-ink-mid">{c.score}</td>
                  <td className="py-2 text-xs text-body">
                    {JSON.parse(c.reasonCodes).join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Settlement detail */}
      <Card title="Settlement Detail">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <dt className="text-body">Source asset</dt>
          <dd className="md:col-span-2 text-ink">
            {payment.sourceAsset} on {payment.sourceNetwork}
          </dd>
          <dt className="text-body">Destination asset</dt>
          <dd className="md:col-span-2 text-ink">
            {payment.destinationAsset} on {payment.destinationNetwork} → {payment.destinationCurrency}{" "}
            ledger credit
          </dd>
          <dt className="text-body">Escrow tx</dt>
          <dd className="md:col-span-2">
            <Hash value={payment.txHash} href={explorerTxUrl(payment.sourceNetwork, payment.txHash, payment.createdAt)} />
            {payment.txHash && <span className="ml-2 text-xs text-body">{payment.sourceNetwork}</span>}
          </dd>
          <dt className="text-body">Settlement tx</dt>
          <dd className="md:col-span-2">
            <Hash
              value={payment.settleTxHash}
              href={explorerTxUrl(payment.sourceNetwork, payment.settleTxHash, payment.createdAt)}
            />
            {payment.settleTxHash && (
              <span className="ml-2 text-xs text-body">{payment.sourceNetwork}</span>
            )}
          </dd>
          {payment.destinationTxHash && (
            <>
              <dt className="text-body">Bridge payout tx</dt>
              <dd className="md:col-span-2">
                <Hash
                  value={payment.destinationTxHash}
                  href={explorerTxUrl(payment.destinationNetwork, payment.destinationTxHash, payment.createdAt)}
                />
                <span className="ml-2 text-xs text-status-cyan-fg">{payment.destinationNetwork}</span>
              </dd>
            </>
          )}
          <dt className="text-body">On-chain payment ID</dt>
          <dd className="md:col-span-2">
            <Hash value={payment.onchainPaymentId} />
          </dd>
          <dt className="text-body">FX rate applied</dt>
          <dd className="md:col-span-2 text-ink">{payment.fxRate ?? "—"}</dd>
          {payment.reservation && (
            <>
              <dt className="text-body">Liquidity reservation</dt>
              <dd className="md:col-span-2 text-ink">
                {fmt(payment.reservation.amount, payment.destinationCurrency)} {payment.reservation.asset} ·{" "}
                {payment.reservation.status}
              </dd>
            </>
          )}
          {payment.ledgerCredits.map((c: any) => (
            <Fragment key={c.id}>
              <dt className="text-body">Ledger credit</dt>
              <dd className="md:col-span-2 text-success-fg">
                {fmt(c.amount, c.currency)} {c.currency} credited to {payment.recipient.name}
              </dd>
            </Fragment>
          ))}
        </dl>
      </Card>

      {/* Audit trail */}
      <Card title="Audit Trail">
        {payment.auditEvents.length === 0 ? (
          <p className="text-sm text-body">No events yet.</p>
        ) : (
          <ol className="space-y-2">
            {payment.auditEvents.map((e: any) => (
              <li key={e.id} className="flex items-baseline gap-3 text-sm">
                <span className="shrink-0 font-mono text-[11px] text-body">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>
                <span className="shrink-0 rounded bg-canvas-soft px-1.5 py-0.5 font-mono text-[11px] text-ink-mid">
                  {e.action}
                </span>
                <span className="truncate text-xs text-body" title={e.detail}>
                  {e.detail !== "{}" ? e.detail : ""}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-body" title={`hash ${e.hash}`}>
                  #{e.hash.slice(0, 8)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
