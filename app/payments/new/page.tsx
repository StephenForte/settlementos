"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";

interface EntityOption {
  externalId: string;
  name: string;
  country: string;
  role: string;
  kybStatus: string;
}

const CURRENCIES = ["USD", "JPY", "SGD"];
const ASSET_FOR: Record<string, string> = { USD: "mockUSDC", JPY: "mockJPY", SGD: "mockSGD" };
const PURPOSES = [
  "supplier_payment",
  "intercompany_transfer",
  "payroll_funding",
  "treasury_rebalance",
  "invoice_settlement",
];

export default function NewPaymentPage() {
  const router = useRouter();
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [form, setForm] = useState({
    sender_id: "",
    recipient_id: "",
    amount: "100000.00",
    source_currency: "USD",
    destination_currency: "JPY",
    purpose: "supplier_payment",
    reference_id: "INV-2026-001",
    memo: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/entities")
      .then((r) => r.json())
      .then((data) => {
        const list: EntityOption[] = data.entities ?? [];
        setEntities(list);
        const sender = list.find((e) => e.role !== "RECIPIENT");
        const recipient = list.find((e) => e.role !== "SENDER" && e.externalId !== sender?.externalId);
        setForm((f) => ({
          ...f,
          sender_id: sender?.externalId ?? "",
          recipient_id: recipient?.externalId ?? "",
        }));
      });
  }, []);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to create payment");
      setSubmitting(false);
      return;
    }
    router.push(`/payments/${data.payment_id}`);
  }

  const senders = entities.filter((e) => e.role !== "RECIPIENT");
  const recipients = entities.filter((e) => e.role !== "SENDER");

  const inputClass =
    "w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none";
  const labelClass = "mb-1 block text-xs font-medium uppercase tracking-wider text-slate-500";

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Create Payment</h1>
        <p className="mt-1 text-sm text-slate-400">
          Initiate a cross-border B2B settlement over EVM stablecoin rails.
        </p>
      </header>

      <Card>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Sender</label>
              <select className={inputClass} value={form.sender_id} onChange={(e) => set("sender_id", e.target.value)}>
                {senders.map((e) => (
                  <option key={e.externalId} value={e.externalId}>
                    {e.name} ({e.country}) {e.kybStatus !== "PASSED" ? "— KYB pending" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Recipient</label>
              <select
                className={inputClass}
                value={form.recipient_id}
                onChange={(e) => set("recipient_id", e.target.value)}
              >
                {recipients.map((e) => (
                  <option key={e.externalId} value={e.externalId}>
                    {e.name} ({e.country}) {e.kybStatus !== "PASSED" ? "— KYB pending" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>Amount ({form.source_currency})</label>
              <input
                className={inputClass}
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
                inputMode="decimal"
              />
            </div>
            <div>
              <label className={labelClass}>Source Currency</label>
              <select
                className={inputClass}
                value={form.source_currency}
                onChange={(e) => set("source_currency", e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">Settles as {ASSET_FOR[form.source_currency]}</p>
            </div>
            <div>
              <label className={labelClass}>Destination Currency</label>
              <select
                className={inputClass}
                value={form.destination_currency}
                onChange={(e) => set("destination_currency", e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                Recipient credited in {form.destination_currency}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Purpose</label>
              <select className={inputClass} value={form.purpose} onChange={(e) => set("purpose", e.target.value)}>
                {PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {p.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Reference / Invoice ID</label>
              <input
                className={inputClass}
                value={form.reference_id}
                onChange={(e) => set("reference_id", e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Memo (optional)</label>
            <input className={inputClass} value={form.memo} onChange={(e) => set("memo", e.target.value)} />
          </div>

          {error && (
            <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !form.sender_id || !form.recipient_id}
            className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-medium text-emerald-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create Draft Payment"}
          </button>
          <p className="text-xs text-slate-500">
            Creating a payment does not move funds. You will review a route quote and compliance results
            before execution.
          </p>
        </form>
      </Card>
    </div>
  );
}
