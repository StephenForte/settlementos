import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatAmount } from "@/lib/assets";
import { explorerTxUrl } from "@/lib/networks";
import { DEFAULT_PAGE_LIMIT, parsePageRequest, toPage } from "@/lib/pagination";
import { Card, StatusBadge, Hash } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The same page bound the API applies, read off the URL. A hand-mangled query
 * string falls back to the defaults rather than 500ing a page — the API is
 * where a bad `limit` is a client error worth reporting; here it is a typo.
 */
function pageFromSearch(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const key of ["limit", "cursor"]) {
    const value = params[key];
    if (typeof value === "string") query.set(key, value);
  }
  try {
    return parsePageRequest(query);
  } catch {
    return { limit: DEFAULT_PAGE_LIMIT, cursor: null };
  }
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = pageFromSearch(await searchParams);

  const rows = await prisma.payment.findMany({
    include: { sender: true, recipient: true },
    // Tiebroken by id for the same reason GET /api/payments is: createdAt is not
    // unique, and an unstable sort makes a cursor walk skip or repeat rows.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const { rows: payments, nextCursor, hasMore } = toPage(rows, page.limit, (p) => p.id);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold text-white">Payments</h1>
        <Link
          href="/payments/new"
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400"
        >
          New Payment
        </Link>
      </header>
      <Card>
        {payments.length === 0 ? (
          <p className="text-sm text-slate-500">No payments yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="pb-2 pr-4">Payment</th>
                <th className="pb-2 pr-4">Reference</th>
                <th className="pb-2 pr-4">Corridor</th>
                <th className="pb-2 pr-4">Amount</th>
                <th className="pb-2 pr-4">Destination</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Escrow Tx</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="py-2.5 pr-4">
                    <span className="font-mono text-xs">{p.id}</span>
                    <div className="text-xs text-slate-500">
                      {p.sender.name} → {p.recipient.name}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-400">{p.referenceId || "—"}</td>
                  <td className="py-2.5 pr-4 text-slate-300">
                    {p.sourceCurrency} → {p.destinationCurrency}
                    <div className="text-[10px] text-slate-500">
                      {p.sourceNetwork === p.destinationNetwork
                        ? p.sourceNetwork
                        : `${p.sourceNetwork} ⇢ ${p.destinationNetwork}`}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-200">
                    {formatAmount(p.amount, p.sourceCurrency)} {p.sourceCurrency}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-300">
                    {p.destinationAmount
                      ? `${formatAmount(p.destinationAmount, p.destinationCurrency)} ${p.destinationCurrency}`
                      : "—"}
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="py-2.5 pr-4">
                    <Hash value={p.txHash} href={explorerTxUrl(p.sourceNetwork, p.txHash)} />
                  </td>
                  <td className="py-2.5 text-right">
                    <Link href={`/payments/${p.id}`} className="text-emerald-400 hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {(hasMore || page.cursor) && (
        <div className="flex items-center justify-between text-sm">
          {page.cursor ? (
            <Link href="/payments" className="text-slate-400 hover:text-white hover:underline">
              ← Newest
            </Link>
          ) : (
            <span />
          )}
          {hasMore && nextCursor && (
            <Link
              href={`/payments?cursor=${encodeURIComponent(nextCursor)}`}
              className="text-emerald-400 hover:underline"
            >
              Older →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
