import { Fragment } from "react";
import { prisma } from "@/lib/db";
import { isPlatformRole } from "@/lib/auth";
import { currentPrincipal } from "@/lib/session";
import { AuthRequired } from "@/components/auth-required";
import { Card, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function EntitiesPage() {
  // Scoped like GET /api/entities: platform roles see every onboarded business, a
  // tenant sees only itself, an anonymous browser none.
  const principal = await currentPrincipal();
  if (!principal) {
    return <AuthRequired message="Sign in to view entities." />;
  }

  const entities = await prisma.entity.findMany({
    where: isPlatformRole(principal) ? {} : { id: principal.entityId },
    include: { wallets: true, ledgerCredits: true },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Entities</h1>
        <p className="mt-1 text-sm text-body">
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
                  <h2 className="text-base font-semibold text-ink">{e.name}</h2>
                  <p className="font-mono text-xs text-body">{e.externalId}</p>
                </div>
                <div className="flex gap-2">
                  <StatusBadge status={e.kybStatus} />
                  <span className="rounded-pill border border-mute bg-canvas px-2.5 py-0.5 text-[11px] text-ink-mid">
                    {e.role}
                  </span>
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
                <dt className="text-body">Country</dt>
                <dd className="col-span-2 text-ink">{e.country}</dd>
                <dt className="text-body">Risk rating</dt>
                <dd className="col-span-2 text-ink">{e.riskRating}</dd>
                <dt className="text-body">Corridors</dt>
                <dd className="col-span-2 text-ink">
                  {corridors.length ? corridors.join(", ") : "none approved"}
                </dd>
                {e.wallets.map((w) => (
                  <Fragment key={w.id}>
                    <dt className="text-body">Wallet</dt>
                    <dd className="col-span-2">
                      <span className="font-mono text-xs text-ink-mid">{w.address}</span>
                      <div className="mt-0.5 text-xs text-body">
                        {w.allowlisted ? (
                          <span className="text-success-fg">allowlisted</span>
                        ) : (
                          <span className="text-warning-fg">not allowlisted</span>
                        )}{" "}
                        · risk score {w.riskScore} · {w.network}
                      </div>
                    </dd>
                  </Fragment>
                ))}
                {Object.entries(ledger).map(([cur, amt]) => (
                  <Fragment key={cur}>
                    <dt className="text-body">Ledger balance</dt>
                    <dd className="col-span-2 text-success-fg">
                      {amt.toLocaleString("en-US", { maximumFractionDigits: cur === "JPY" ? 0 : 2 })} {cur}{" "}
                      <span className="text-xs text-body">(simulated payout ledger)</span>
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
