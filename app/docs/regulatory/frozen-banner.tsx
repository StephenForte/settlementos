/**
 * Persistent chrome for the Track B pack. The same STATUS line opens every
 * memo as a markdown blockquote — this banner keeps it visible after a skim
 * past the first paragraph. Wording is frozen (PR #54); do not soften.
 */
export function FrozenTemplateBanner() {
  return (
    <aside
      role="note"
      className="rounded-md border border-warning-border bg-warning-bg p-4 text-sm leading-relaxed text-warning-fg"
    >
      <p className="font-semibold">STATUS: FROZEN TEMPLATE (2026-08-10).</p>
      <p className="mt-2">
        This memo is an <strong>unreviewed draft</strong>, frozen on this date. It is{" "}
        <strong>illustrative scaffolding</strong> for a bank or licensed partner evaluating
        SettlementOS — not legal, regulatory, or compliance advice, and not authoritative for any
        jurisdiction. An adopter is expected to <strong>replace</strong> this document with their
        own. Substitution points use <code className="font-mono text-[0.9em]">[[ADOPTER: …]]</code>{" "}
        (see README).
      </p>
      <p className="mt-2 font-semibold">Nothing here is legal advice.</p>
    </aside>
  );
}
