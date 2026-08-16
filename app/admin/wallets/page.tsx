import { Card } from "@/components/ui";
import { CopyAddress } from "./copy-address";
import { copyAddressProps } from "./props";
import { loadAdminWallets, type AdminWalletRow } from "./wallets-data";

export const dynamic = "force-dynamic";

function WalletCard({ wallet }: { wallet: AdminWalletRow }) {
  if (!wallet.address) {
    return (
      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink">{wallet.label}</h3>
          <span className="text-[11px] uppercase tracking-widest text-body">{wallet.role}</span>
        </div>
        <p className="mt-3 text-sm text-body" data-wallet-absent={wallet.label}>
          No wallet on this network.
        </p>
      </Card>
    );
  }

  // Client child props: `{ address }` only — built field-by-field, never spread.
  const copyProps = copyAddressProps(wallet.address);

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">{wallet.label}</h3>
        <span className="text-[11px] uppercase tracking-widest text-body">{wallet.role}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-xs text-ink-mid">{wallet.address}</span>
        <CopyAddress address={copyProps.address} />
        {wallet.explorerUrl ? (
          <a
            href={wallet.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary underline decoration-primary/40 underline-offset-2 hover:text-ink"
          >
            Explorer ↗
          </a>
        ) : null}
      </div>
      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-body">Gas ({wallet.nativeSymbol})</dt>
          <dd className="font-mono text-ink">{wallet.nativeBalance ?? "—"}</dd>
        </div>
        {wallet.tokens.map((t) => (
          <div key={t.symbol} className="flex justify-between gap-4">
            <dt className="text-body">{t.symbol}</dt>
            <dd className="font-mono text-ink" data-token={t.symbol}>
              {t.amount}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default async function AdminWalletsPage() {
  const data = await loadAdminWallets();

  if (!data.ready) {
    return (
      <Card title="Wallets">
        <p className="text-sm text-warning-fg">
          Chains not set up. Run: npm run chain, npm run chain:polygon, then npm run setup
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Wallets</h1>
        <p className="mt-1 text-sm text-body">
          Treasury and entity wallets per network. Read-only — addresses and balances only.
        </p>
      </header>

      {data.networks.map((section) => (
        <section key={section.networkId} data-network={section.networkId} className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">{section.label}</h2>
          {section.error && (
            <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
              {section.error}
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {section.wallets.map((wallet) => (
              <WalletCard
                key={`${section.networkId}:${wallet.role}:${wallet.label}`}
                wallet={wallet}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
