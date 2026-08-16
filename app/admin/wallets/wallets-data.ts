import { prisma } from "@/lib/db";
import { accountsFor, isChainReady, loadDeployments, nativeBalance, tokenBalance } from "@/lib/chain";
import { fromBaseUnits } from "@/lib/assets";
import { explorerAddressUrl, networkInfo } from "@/lib/networks";
import { walletOnNetwork } from "@/lib/wallets";
import { copyAddressProps, type CopyAddressProps } from "./props";

export type AdminWalletRow = {
  label: string;
  role: "treasury" | "entity";
  address: string | null;
  explorerUrl: string | null;
  nativeBalance: string | null;
  nativeSymbol: string;
  tokens: { symbol: string; amount: string }[];
};

export type AdminNetworkSection = {
  networkId: string;
  label: string;
  error: string | null;
  wallets: AdminWalletRow[];
};

export type AdminWalletsData =
  | { ready: false }
  | { ready: true; networks: AdminNetworkSection[] };

/**
 * Exact-network wallet address. `walletOnNetwork` falls back to `wallets[0]`;
 * that fallback is for payment flows, not this page — another network's
 * address must never render here.
 */
export function addressOnNetwork(
  wallets: { network: string; address: string }[],
  networkId: string
): string | undefined {
  const resolved = walletOnNetwork(wallets, networkId);
  if (!resolved || resolved.network !== networkId) return undefined;
  return resolved.address;
}

/** Every prop object this page will pass to the copy-address client child. */
export function clientPropsForWallets(wallets: AdminWalletRow[]): CopyAddressProps[] {
  return wallets.flatMap((w) => (w.address ? [copyAddressProps(w.address)] : []));
}

export async function loadAdminWallets(): Promise<AdminWalletsData> {
  if (!isChainReady()) return { ready: false };

  const dep = loadDeployments();
  const entities = await prisma.entity.findMany({
    include: { wallets: true },
    orderBy: { name: "asc" },
  });

  const networks: AdminNetworkSection[] = [];

  for (const [networkId, net] of Object.entries(dep.networks)) {
    const info = networkInfo(networkId);
    const nativeSymbol = info.nativeSymbol ?? "ETH";

    // Trap 1: accountsFor() returns signing material. Take `.address` only.
    const treasuryAddress: string = accountsFor(networkId).treasury.address;

    const holders: { label: string; role: "treasury" | "entity"; address: string | null }[] = [
      { label: "Settlement Treasury", role: "treasury", address: treasuryAddress },
      ...entities.map((e) => ({
        label: e.name,
        role: "entity" as const,
        address: addressOnNetwork(e.wallets, networkId) ?? null,
      })),
    ];

    const wallets: AdminWalletRow[] = holders.map((h) => ({
      label: h.label,
      role: h.role,
      address: h.address,
      explorerUrl: h.address ? explorerAddressUrl(networkId, h.address) : null,
      nativeBalance: null,
      nativeSymbol,
      tokens: [],
    }));

    try {
      for (const row of wallets) {
        if (!row.address) continue;
        const owner = row.address as `0x${string}`;
        const nativeRaw = await nativeBalance(networkId, owner, { viaReadRpc: true });
        row.nativeBalance = fromBaseUnits(nativeRaw, 18);
        const tokens: { symbol: string; amount: string }[] = [];
        for (const [symbol, token] of Object.entries(net.contracts.tokens)) {
          const raw = await tokenBalance(networkId, token.address, owner, { viaReadRpc: true });
          tokens.push({ symbol, amount: fromBaseUnits(raw, token.decimals) });
        }
        row.tokens = tokens;
      }
      networks.push({ networkId, label: info.label, error: null, wallets });
    } catch {
      networks.push({
        networkId,
        label: info.label,
        error: `RPC unreachable for ${networkId}`,
        wallets,
      });
    }
  }

  return { ready: true, networks };
}
