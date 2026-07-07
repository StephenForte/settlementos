// Network registry. The two local Hardhat nodes stand in for real L2 testnets;
// base-sepolia is the real public testnet (deployed via npm run deploy:base-sepolia).
// This module is client-safe — no node imports, no secrets (non-public env vars
// resolve to their defaults in the browser bundle).

export interface NetworkInfo {
  id: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  /** Real testnet this local chain simulates (absent for real networks). */
  simulates?: string;
  /** Block explorer base URL (no trailing slash), e.g. https://sepolia.basescan.org */
  explorerUrl?: string;
  /** True for real public networks (as opposed to local simulation chains). */
  live?: boolean;
}

export const NETWORKS: Record<string, NetworkInfo> = {
  "base-local": {
    id: "base-local",
    label: "Base (local)",
    chainId: 31337,
    rpcUrl: process.env.BASE_LOCAL_RPC_URL || "http://127.0.0.1:8545",
    simulates: "Base Sepolia",
  },
  "polygon-local": {
    id: "polygon-local",
    label: "Polygon Amoy (local)",
    chainId: 31338,
    rpcUrl: process.env.POLYGON_LOCAL_RPC_URL || "http://127.0.0.1:8546",
    simulates: "Polygon Amoy",
  },
  "base-sepolia": {
    id: "base-sepolia",
    label: "Base Sepolia",
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    live: true,
  },
};

export const NETWORK_IDS = Object.keys(NETWORKS);

export function networkInfo(id: string): NetworkInfo {
  const n = NETWORKS[id];
  if (!n) throw new Error(`Unknown network ${id}`);
  return n;
}

export function explorerTxUrl(networkId: string, txHash?: string | null): string | null {
  const n = NETWORKS[networkId];
  if (!n?.explorerUrl || !txHash) return null;
  return `${n.explorerUrl}/tx/${txHash}`;
}

export function explorerAddressUrl(networkId: string, address?: string | null): string | null {
  const n = NETWORKS[networkId];
  if (!n?.explorerUrl || !address) return null;
  return `${n.explorerUrl}/address/${address}`;
}
