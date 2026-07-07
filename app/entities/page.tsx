import { Fragment } from "react";
import { prisma } from "@/lib/db";
import { Card, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function EntitiesPage() {
  const entities = await prisma.entity.findMany({
    include: { wallets: true, ledgerCredits: true },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Entities</h1>
        <p className="mt-1 text-sm text-slate-400">
          Onboarded businesses, KYB status, wallets, and approved corridors.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {entities.map((e) => {
          const corridors = JSON.parse(e.approvedCorridors) as string[];
          const ledger: Record<string, number> = {};
          for (const c of e.ledgerCredits) {
            ledger[c.currency] = (ledger[c.currency] ?? 0) + Number(c.amount);
          }
          return (
            <Card key={e.id}>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-base font-semibold text-white">{e.name}</h2>
                  <p className="font-mono text-xs text-slate-500">{e.externalId}</p>
                </div>
                <div className="flex gap-2">
                  <StatusBadge status={e.kybStatus} />
                  <span className="rounded-full border border-slate-600 bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-300">
                    {e.role}
                  </span>
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
                <dt className="text-slate-500">Country</dt>
                <dd className="col-span-2 text-slate-200">{e.country}</dd>
                <dt className="text-slate-500">Risk rating</dt>
                <dd className="col-span-2 text-slate-200">{e.riskRating}</dd>
                <dt className="text-slate-500">Corridors</dt>
                <dd className="col-span-2 text-slate-200">
                  {corridors.length ? corridors.join(", ") : "none approved"}
                </dd>
                {e.wallets.map((w) => (
                  <Fragment key={w.id}>
                    <dt className="text-slate-500">Wallet</dt>
                    <dd className="col-span-2">
                      <span className="font-mono text-xs text-slate-300">{w.address}</span>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {w.allowlisted ? (
                          <span className="text-emerald-400">allowlisted</span>
                        ) : (
                          <span className="text-amber-400">not allowlisted</span>
                        )}{" "}
                        · risk score {w.riskScore} · {w.network}
                      </div>
                    </dd>
                  </Fragment>
                ))}
                {Object.entries(ledger).map(([cur, amt]) => (
                  <Fragment key={cur}>
                    <dt className="text-slate-500">Ledger balance</dt>
                    <dd className="col-span-2 text-emerald-300">
                      {amt.toLocaleString("en-US", { maximumFractionDigits: cur === "JPY" ? 0 : 2 })} {cur}{" "}
                      <span className="text-xs text-slate-500">(simulated payout ledger)</span>
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
