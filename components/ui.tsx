// Small shared UI primitives (server-safe).

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-status-neutral-bg text-status-neutral-fg border-status-neutral-border",
  QUOTED: "bg-status-info-bg text-status-info-fg border-status-info-border",
  COMPLIANCE_PENDING: "bg-status-warn-bg text-status-warn-fg border-status-warn-border",
  MANUAL_REVIEW: "bg-status-warn-bg text-status-warn-fg border-status-warn-border",
  APPROVED: "bg-status-teal-bg text-status-teal-fg border-status-teal-border",
  LIQUIDITY_RESERVED: "bg-status-indigo-bg text-status-indigo-fg border-status-indigo-border",
  SUBMITTED_ONCHAIN: "bg-status-progress-bg text-status-progress-fg border-status-progress-border",
  CONFIRMED_ONCHAIN: "bg-status-progress-bg text-status-progress-fg border-status-progress-border",
  FX_OR_SWAP_COMPLETED: "bg-status-cyan-bg text-status-cyan-fg border-status-cyan-border",
  PAYOUT_PENDING: "bg-status-cyan-bg text-status-cyan-fg border-status-cyan-border",
  SETTLED: "bg-status-ok-bg text-status-ok-fg border-status-ok-border",
  COMPENSATION_PENDING: "bg-status-comp-bg text-status-comp-fg border-status-comp-border",
  COMPENSATED: "bg-status-comp-bg text-status-comp-fg border-status-comp-border",
  REJECTED: "bg-status-danger-bg text-status-danger-fg border-status-danger-border",
  FAILED: "bg-status-danger-bg text-status-danger-fg border-status-danger-border",
  CANCELLED: "bg-status-neutral-bg text-status-neutral-fg border-status-neutral-border",
  REFUNDED: "bg-status-comp-bg text-status-comp-fg border-status-comp-border",
  EXPIRED: "bg-status-neutral-bg text-status-neutral-fg border-status-neutral-border",
  PASS: "bg-status-ok-bg text-status-ok-fg border-status-ok-border",
  FAIL: "bg-status-danger-bg text-status-danger-fg border-status-danger-border",
  PASSED: "bg-status-ok-bg text-status-ok-fg border-status-ok-border",
  PENDING: "bg-status-warn-bg text-status-warn-fg border-status-warn-border",
  EXEMPT_TESTNET: "bg-status-neutral-bg text-status-neutral-fg border-status-neutral-border",
  ACTIVE: "bg-status-ok-bg text-status-ok-fg border-status-ok-border",
  RECALLED: "bg-status-neutral-bg text-status-neutral-fg border-status-neutral-border",
};

export function StatusBadge({ status }: { status: string }) {
  const style =
    STATUS_STYLES[status] ??
    "bg-status-neutral-bg text-status-neutral-fg border-status-neutral-border";
  return (
    <span
      className={`inline-flex items-center rounded-pill border px-2.5 py-0.5 text-[11px] font-medium tracking-wide ${style}`}
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
    <section className={`rounded-md border border-mute bg-canvas-soft p-6 ${className}`}>
      {title && (
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-body">{title}</h2>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-mute bg-canvas-soft p-6">
      <p className="text-xs font-medium uppercase tracking-widest text-body">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-ink">{value}</p>
      {sub && <p className="mt-1 text-xs text-body">{sub}</p>}
    </div>
  );
}

export function Hash({ value, href }: { value: string | null | undefined; href?: string | null }) {
  if (!value) return <span className="text-body">—</span>;
  const short = `${value.slice(0, 10)}…${value.slice(-8)}`;
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-primary underline decoration-primary/40 underline-offset-2 hover:text-ink"
        title={value}
      >
        {short} ↗
      </a>
    );
  }
  return (
    <span className="font-mono text-xs text-ink-mid" title={value}>
      {short}
    </span>
  );
}
