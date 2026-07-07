// Small shared UI primitives (server-safe).

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-700/50 text-slate-300 border-slate-600",
  QUOTED: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  COMPLIANCE_PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  MANUAL_REVIEW: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  APPROVED: "bg-teal-500/15 text-teal-300 border-teal-500/40",
  LIQUIDITY_RESERVED: "bg-indigo-500/15 text-indigo-300 border-indigo-500/40",
  SUBMITTED_ONCHAIN: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  CONFIRMED_ONCHAIN: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  FX_OR_SWAP_COMPLETED: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  PAYOUT_PENDING: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  SETTLED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  REJECTED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  FAILED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  CANCELLED: "bg-slate-700/50 text-slate-400 border-slate-600",
  REFUNDED: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  EXPIRED: "bg-slate-700/50 text-slate-400 border-slate-600",
  PASS: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  FAIL: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  PASSED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  EXEMPT_TESTNET: "bg-slate-700/50 text-slate-300 border-slate-600",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-slate-700/50 text-slate-300 border-slate-600";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide ${style}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-slate-800 bg-slate-900/50 p-5 ${className}`}>
      {title && (
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-slate-500">{title}</h2>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <p className="text-xs font-medium uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export function Hash({ value, href }: { value: string | null | undefined; href?: string | null }) {
  if (!value) return <span className="text-slate-600">—</span>;
  const short = `${value.slice(0, 10)}…${value.slice(-8)}`;
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-sky-300 underline decoration-sky-500/40 underline-offset-2 hover:text-sky-200"
        title={value}
      >
        {short} ↗
      </a>
    );
  }
  return (
    <span className="font-mono text-xs text-slate-300" title={value}>
      {short}
    </span>
  );
}
