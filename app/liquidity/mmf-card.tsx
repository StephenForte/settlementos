"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, StatusBadge, Hash } from "@/components/ui";

export interface MmfPositionView {
  positionId: string;
  asset: string;
  status: string;
  shares: string;
  /** Decimal string — principal subscribed at entry. */
  amountIn: string;
  /** Decimal string — shares x live index. Null when the fund could not be read. */
  currentValue: string | null;
  /** Decimal string — currentValue minus principal. Null when the fund could not be read. */
  accruedYield: string | null;
  indexAtEntry: string;
  createdAt: string;
  txHashPark: string;
  txHashRecall: string | null;
}

export interface MmfCardProps {
  networkId: string;
  /** Asset backing the fund, e.g. "mockUSDC". */
  asset: string;
  fundAddress: string;
  fundUrl: string | null;
  /** 1e18-scaled share index, or null when the RPC read failed. */
  currentIndex: string | null;
  /** Decimal string — total derived value of ACTIVE positions. */
  parkedValue: string | null;
  /** Decimal string — total yield accrued across ACTIVE positions. */
  accruedYield: string | null;
  /** Decimal string — unreserved treasury balance, the ceiling on a park. */
  freeBalance: string;
  annualRateBps: string;
  /** Eligible + opted-in institution, or null — park controls are disabled without one. */
  entityId: string | null;
  entityName: string | null;
  positions: MmfPositionView[];
}

const INDEX_SCALE = 10n ** 18n;

/** Exact 6-dp rendering of the 1e18-scaled index — Number() would lose the low digits. */
function fmtIndex(index: string | null): string {
  if (!index) return "—";
  const value = BigInt(index);
  const frac = ((value % INDEX_SCALE) * 1_000_000n) / INDEX_SCALE;
  return `${value / INDEX_SCALE}.${frac.toString().padStart(6, "0")}`;
}

function fmtAmount(amount: string | null): string {
  if (amount == null) return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return amount;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function MmfCard(props: MmfCardProps) {
  const router = useRouter();
  const [amount, setAmount] = useState("50000.00");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const eligible = props.entityId !== null;
  const active = props.positions.filter((p) => p.status === "ACTIVE");
  const apy = (Number(props.annualRateBps) / 100).toFixed(2);

  /** Every mutation goes through a treasury API route, then re-renders the server
   *  page (balances, positions, index) in place — no full reload. */
  async function post(
    label: string,
    path: string,
    body: object,
    ok: (data: Record<string, string>) => string
  ) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) setError(data.message ?? `${label} failed`);
      else setNotice(ok(data));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  const park = () =>
    post(
      "park",
      "/api/treasury/park",
      { network: props.networkId, asset: props.asset, amount, entity_id: props.entityId },
      (d) => `Parked ${fmtAmount(amount)} ${props.asset} — position ${d.position_id}`
    );

  const recall = (positionId: string) =>
    post("recall", "/api/treasury/recall", { position_id: positionId }, (d) =>
      `Recalled ${fmtAmount(d.amount)} ${props.asset} (T+0) — position ${d.position_id}`
    );

  const accrue = () =>
    post("accrue", "/api/treasury/accrue", { network: props.networkId }, (d) =>
      `Accrued one day — index ${fmtIndex(d.old_index)} → ${fmtIndex(d.new_index)}`
    );

  const inputClass =
    "w-40 rounded-md border border-mute bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none disabled:opacity-50";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Tokenized MMF</p>
          <p className="mt-1 text-xs text-body">
            Overnight parking of idle {props.asset} at {apy}% APY. Redeemable T+0 — the route engine
            auto-recalls when a payment needs the liquidity.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <span className="rounded-pill border border-mute bg-canvas-soft px-3 py-1 text-[11px] text-ink-mid">
            Institutional only
          </span>
          <span className="rounded-pill border border-warning-border bg-warning-bg px-3 py-1 text-[11px] text-warning-fg">
            Simulated yield — testnet only
          </span>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div>
          <dt className="text-xs text-body">Parked value</dt>
          <dd className="mt-1 text-xl font-semibold text-ink">{fmtAmount(props.parkedValue)}</dd>
        </div>
        <div>
          <dt className="text-xs text-body">Accrued yield</dt>
          <dd className="mt-1 text-xl font-semibold text-success-fg">
            {props.accruedYield == null ? "—" : `+${fmtAmount(props.accruedYield)}`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-body">Share index</dt>
          <dd className="mt-1 font-mono text-xl text-ink">{fmtIndex(props.currentIndex)}</dd>
        </div>
        <div>
          <dt className="text-xs text-body">Free to park</dt>
          <dd className="mt-1 text-xl font-semibold text-ink">{fmtAmount(props.freeBalance)}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-mute pt-4">
        <input
          className={inputClass}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          disabled={!eligible}
          aria-label={`Amount to park in ${props.asset}`}
        />
        <button
          onClick={park}
          disabled={!eligible || busy !== null}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
        >
          {busy === "park" ? "Parking…" : `Park ${props.asset}`}
        </button>
        <button
          onClick={accrue}
          disabled={busy !== null}
          className="rounded-md border border-ink bg-canvas px-4 py-2 text-sm font-medium text-ink hover:bg-canvas-soft disabled:opacity-50"
        >
          {busy === "accrue" ? "Accruing…" : "Accrue 1 day"}
        </button>
        <span className="text-xs text-body">
          {eligible ? (
            <>
              Parking as <span className="text-ink-mid">{props.entityName}</span> · fund{" "}
              {props.fundUrl ? (
                <Hash value={props.fundAddress} href={props.fundUrl} />
              ) : (
                <Hash value={props.fundAddress} />
              )}
            </>
          ) : (
            <span className="text-warning-fg">
              No institution is MMF-eligible and opted in — parking is disabled.
            </span>
          )}
        </span>
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success-fg">
          {notice}
        </p>
      )}

      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-body">
          Positions ({active.length} active)
        </p>
        {props.positions.length === 0 ? (
          <p className="text-sm text-body">Nothing parked on this network.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-body">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Position</th>
                  <th className="pb-2 pr-4 font-medium">Principal</th>
                  <th className="pb-2 pr-4 font-medium">Shares</th>
                  <th className="pb-2 pr-4 font-medium">Value</th>
                  <th className="pb-2 pr-4 font-medium">Yield</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody className="text-ink-mid">
                {props.positions.map((p) => (
                  <tr key={p.positionId} className="border-t border-mute">
                    <td className="py-2 pr-4 font-mono text-[11px]">{p.positionId}</td>
                    <td className="py-2 pr-4">{fmtAmount(p.amountIn)}</td>
                    <td className="py-2 pr-4 font-mono text-[11px]">{p.shares}</td>
                    <td className="py-2 pr-4">{fmtAmount(p.currentValue)}</td>
                    <td className="py-2 pr-4 text-success-fg">
                      {p.accruedYield == null ? "—" : `+${fmtAmount(p.accruedYield)}`}
                    </td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="py-2">
                      {p.status === "ACTIVE" ? (
                        <button
                          onClick={() => recall(p.positionId)}
                          disabled={busy !== null}
                          className="rounded-md border border-info-border bg-info-bg px-3 py-1 text-[11px] font-medium text-info-fg hover:bg-info-bg disabled:opacity-50"
                        >
                          {busy === "recall" ? "Recalling…" : "Recall T+0"}
                        </button>
                      ) : (
                        <span className="text-body">recalled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
