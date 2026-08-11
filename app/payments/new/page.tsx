"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";
import { reconcileNetworkSelection } from "@/lib/network-selection";

interface EntityOption {
  externalId: string;
  name: string;
  country: string;
  role: string;
  kybStatus: string;
}

interface NetworkOption {
  id: string;
  label: string;
  live: boolean;
  available: boolean;
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
  // Empty until /api/networks resolves — do not claim local chains are available.
  const [networks, setNetworks] = useState<NetworkOption[]>([]);
  const [networksReady, setNetworksReady] = useState(false);
  const [form, setForm] = useState({
    sender_id: "",
    recipient_id: "",
    amount: "100000.00",
    source_currency: "USD",
    destination_currency: "JPY",
    source_network: "",
    destination_network: "",
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
    fetch("/api/networks")
      .then((r) => r.json())
      .then((data) => {
        const available: NetworkOption[] = (data.networks ?? []).filter((n: NetworkOption) => n.available);
        const ids = available.map((n) => n.id);
        setNetworks(available);
        setForm((f) => {
          const next = reconcileNetworkSelection(
            { source: f.source_network, destination: f.destination_network },
            ids
          );
          return { ...f, source_network: next.source, destination_network: next.destination };
        });
      })
      .catch(() => {
        setNetworks([]);
      })
      .finally(() => {
        setNetworksReady(true);
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
      setError(data.message ?? "Failed to create payment");
      setSubmitting(false);
      return;
    }
    router.push(`/payments/${data.payment_id}`);
  }

  const senders = entities.filter((e) => e.role !== "RECIPIENT");
  const recipients = entities.filter((e) => e.role !== "SENDER");
  const canSubmit =
    networksReady &&
    networks.length > 0 &&
    !!form.source_network &&
    !!form.destination_network &&
    !!form.sender_id &&
    !!form.recipient_id &&
    !submitting;

  const inputClass =
    "w-full rounded-md border border-mute bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none";
  const labelClass = "mb-1 block text-xs font-medium uppercase tracking-wider text-body";

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Create Payment</h1>
        <p className="mt-1 text-sm text-body">
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
              <p className="mt-1 text-[11px] text-body">Settles as {ASSET_FOR[form.source_currency]}</p>
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
              <p className="mt-1 text-[11px] text-body">
                Recipient credited in {form.destination_currency}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Source Chain</label>
              <select
                className={inputClass}
                value={form.source_network}
                onChange={(e) => set("source_network", e.target.value)}
                disabled={!networksReady || networks.length === 0}
              >
                {!networksReady && <option value="">Loading networks…</option>}
                {networksReady && networks.length === 0 && (
                  <option value="">No deployed networks</option>
                )}
                {networks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                    {n.live ? " — public testnet" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Destination Chain</label>
              <select
                className={inputClass}
                value={form.destination_network}
                onChange={(e) => set("destination_network", e.target.value)}
                disabled={!networksReady || networks.length === 0}
              >
                {!networksReady && <option value="">Loading networks…</option>}
                {networksReady && networks.length === 0 && (
                  <option value="">No deployed networks</option>
                )}
                {networks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                    {n.live ? " — public testnet" : ""}
                  </option>
                ))}
              </select>
              {form.source_network &&
                form.destination_network &&
                form.source_network !== form.destination_network && (
                <p className="mt-1 text-[11px] text-status-cyan-fg">Cross-chain route via simulated bridge</p>
              )}
              {networks.some(
                (n) => n.live && [form.source_network, form.destination_network].includes(n.id)
              ) && (
                <p className="mt-1 text-[11px] text-success-fg">
                  Real testnet — transactions get public Basescan links
                </p>
              )}
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
            <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create Draft Payment"}
          </button>
          <p className="text-xs text-body">
            Creating a payment does not move funds. You will review a route quote and compliance results
            before execution.
          </p>
        </form>
      </Card>
    </div>
  );
}
