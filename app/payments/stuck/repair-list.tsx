"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge, Hash } from "@/components/ui";

export interface StuckPaymentView {
  id: string;
  status: string;
  senderName: string;
  recipientName: string;
  /** Decimal string, in the source currency. */
  amount: string;
  sourceCurrency: string;
  sourceNetwork: string;
  /** Live escrow state on the source chain, or null when the RPC read failed. */
  escrowState: string | null;
  /** Operator detail — this view is OPERATOR-only, so it is not scrubbed. */
  failureReason: string | null;
  settleTxHash: string | null;
  settleTxUrl: string | null;
  settleTxNote: string | null;
  createdAt: string;
}

/** Why this payment is listed, in the operator's terms. */
function diagnosis(p: StuckPaymentView): string {
  if (p.escrowState === null) return "Escrow state unreadable — the source network did not answer.";
  if (p.status === "COMPENSATION_PENDING") {
    return "Escrow was released to treasury but the compensation transfer failed. The sender is still short.";
  }
  if (p.escrowState === "SETTLED") return "Escrow released to treasury on a payment that never settled.";
  if (p.escrowState === "INITIATED") return "Funds are still escrowed on-chain — the refund never landed.";
  return `Escrow reads ${p.escrowState} on a failed payment.`;
}

export function RepairList({ payments }: { payments: StuckPaymentView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function repair(id: string) {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/payments/${id}/repair`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setError(data.message ?? "repair failed");
      else setNotice(`${id} compensated — tx ${data.compensation_transaction_hash}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      // Re-render the server page so the repaired payment leaves the list.
      router.refresh();
    }
  }

  if (payments.length === 0) {
    return <p className="text-sm text-body">Nothing needs attention — no payment is holding funds.</p>;
  }

  return (
    <div className="space-y-3">
      {notice && (
        <p className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-xs text-success-fg">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {payments.map((p) => (
          <li key={p.id} className="rounded-md border border-mute bg-canvas p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Link href={`/payments/${p.id}`} className="font-mono text-xs text-primary hover:underline">
                    {p.id}
                  </Link>
                  <StatusBadge status={p.status} />
                  <span className="rounded-pill border border-mute bg-canvas-soft px-2.5 py-0.5 text-[11px] text-ink-mid">
                    escrow {p.escrowState ?? "unknown"}
                  </span>
                </div>
                <p className="text-xs text-body">
                  {p.senderName} → {p.recipientName} · {p.amount} {p.sourceCurrency} on {p.sourceNetwork}
                </p>
                <p className="text-xs text-warning-fg">{diagnosis(p)}</p>
                {p.failureReason && <p className="text-xs text-body">{p.failureReason}</p>}
                {p.settleTxHash && (
                  <div className="text-xs text-body">
                    Settlement tx <Hash value={p.settleTxHash} href={p.settleTxUrl} note={p.settleTxNote} />
                  </div>
                )}
              </div>
              {p.status === "COMPENSATION_PENDING" && (
                <button
                  onClick={() => repair(p.id)}
                  disabled={busy !== null}
                  className="shrink-0 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-ink hover:opacity-90 disabled:opacity-50"
                >
                  {busy === p.id ? "Compensating…" : "Retry compensation"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
