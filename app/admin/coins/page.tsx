import { prisma } from "@/lib/db";
import { accountsFor, isChainReady, loadDeployments, networkContracts, tokenBalance } from "@/lib/chain";
import { ASSETS, fromBaseUnits, formatAmount, type AssetSymbol } from "@/lib/assets";
import { explorerAddressUrl, networkInfo } from "@/lib/networks";
import { walletOnNetwork } from "@/lib/wallets";
import { Card } from "@/components/ui";
import { CopyAddress } from "./copy-address";

export const dynamic = "force-dynamic";

/** Exact operator hint from GET /api/balances when no deployments are present. */
const CHAIN_UNAVAILABLE_MESSAGE =
  "Chains not set up. Run: npm run chain, npm run chain:polygon, then npm run setup";

type HolderView = {
  label: string;
  kind: string;
  address: string;
  amount: string;
  formatted: string;
};

export type TokenView = {
  symbol: string;
  name: string;
  currency: string;
  address: string;
  decimals: number;
  explorerUrl: string | null;
  holders: HolderView[];
};

export type NetworkCoinsView = {
  networkId: string;
  label: string;
  chainId: number;
  error?: string;
  tokens: TokenView[];
};

export type CoinsPageData = {
  chainMessage?: string;
  networks: NetworkCoinsView[];
};

function isAssetSymbol(symbol: string): symbol is AssetSymbol {
  return Object.prototype.hasOwnProperty.call(ASSETS, symbol);
}

function tokenMeta(symbol: string): { name: string; currency: string } {
  if (isAssetSymbol(symbol)) {
    return { name: ASSETS[symbol].name, currency: ASSETS[symbol].currency };
  }
  return { name: symbol, currency: symbol };
}

/**
 * Same holder + tokenBalance reads as GET /api/balances, then pivoted by token.
 * Contract metadata comes from loadDeployments / networkContracts so a dead RPC
 * still shows the row.
 */
export async function loadCoinsData(): Promise<CoinsPageData> {
  if (!isChainReady()) {
    return { chainMessage: CHAIN_UNAVAILABLE_MESSAGE, networks: [] };
  }

  const dep = loadDeployments();
  const entities = await prisma.entity.findMany({ include: { wallets: true } });

  const networks: NetworkCoinsView[] = [];
  for (const networkId of Object.keys(dep.networks)) {
    const info = networkInfo(networkId);
    const contracts = networkContracts(networkId);
    const tokenEntries = Object.entries(contracts.tokens);

    const tokens: TokenView[] = tokenEntries.map(([symbol, token]) => {
      const meta = tokenMeta(symbol);
      return {
        symbol,
        name: meta.name,
        currency: meta.currency,
        address: token.address,
        decimals: token.decimals,
        explorerUrl: explorerAddressUrl(networkId, token.address),
        holders: [],
      };
    });

    const holders: { label: string; kind: string; address: string }[] = [
      { label: "Settlement Treasury", kind: "treasury", address: accountsFor(networkId).treasury.address },
      ...entities.flatMap((e) => {
        const w = walletOnNetwork(e.wallets, networkId);
        return w ? [{ label: e.name, kind: "entity", address: w.address }] : [];
      }),
    ];

    let error: string | undefined;
    try {
      const balances = await Promise.all(
        holders.map(async (h) => {
          const perToken: Record<string, string> = {};
          for (const [symbol, token] of tokenEntries) {
            const raw = await tokenBalance(networkId, token.address, h.address as `0x${string}`, {
              viaReadRpc: true,
            });
            perToken[symbol] = fromBaseUnits(raw, token.decimals);
          }
          return { ...h, tokens: perToken };
        })
      );
      for (const token of tokens) {
        token.holders = balances.map((h) => ({
          label: h.label,
          kind: h.kind,
          address: h.address,
          amount: h.tokens[token.symbol],
          formatted: formatAmount(h.tokens[token.symbol], token.currency),
        }));
      }
    } catch {
      error = `RPC unreachable for ${networkId}`;
    }

    networks.push({
      networkId,
      label: info.label,
      chainId: info.chainId,
      error,
      tokens,
    });
  }

  return { networks };
}

export function CoinsView({ data }: { data: CoinsPageData }) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Mock coins</h1>
        <p className="mt-1 text-sm text-body">
          Read-only view of mock token contracts and holders per network. Inspect only — no mint,
          burn, or transfer.
        </p>
      </header>

      {data.chainMessage && (
        <Card title="Mock coins">
          <p className="text-sm text-warning-fg">{data.chainMessage}</p>
        </Card>
      )}

      {data.networks.map((net) => (
        <section key={net.networkId} className="space-y-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-sm font-semibold text-ink">{net.label}</h2>
            <span className="text-xs text-body">
              {net.networkId} · chainId {net.chainId}
            </span>
          </div>
          {net.error && (
            <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
              {net.error}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {net.tokens.map((token) => (
              <Card key={token.symbol} title={token.symbol}>
                <p className="text-sm text-ink">{token.name}</p>
                <dl className="mt-3 space-y-1 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-body">Decimals</dt>
                    <dd className="text-ink">decimals {token.decimals}</dd>
                  </div>
                  <div>
                    <dt className="text-body">Contract</dt>
                    <dd className="mt-1 flex items-start gap-2">
                      {token.explorerUrl ? (
                        <a
                          href={token.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-all font-mono text-[11px] text-primary underline decoration-primary/40 underline-offset-2 hover:text-ink"
                        >
                          {token.address}
                        </a>
                      ) : (
                        <span className="break-all font-mono text-[11px] text-ink-mid">{token.address}</span>
                      )}
                      <CopyAddress address={token.address} />
                    </dd>
                  </div>
                </dl>
                <div className="mt-4">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-body">Holders</p>
                  {token.holders.length === 0 ? (
                    <p className="mt-2 text-xs text-body">
                      {net.error ? "Balances unavailable." : "No holders on this network."}
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1.5 text-xs">
                      {token.holders.map((h) => (
                        <li key={`${h.kind}:${h.address}`} className="flex justify-between gap-3">
                          <span className="text-ink-mid">{h.label}</span>
                          <span className="font-mono text-ink">{h.formatted}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default async function AdminCoinsPage() {
  const data = await loadCoinsData();
  return <CoinsView data={data} />;
}
