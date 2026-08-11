// Network registry. The two local Hardhat nodes stand in for real L2 testnets;
// base-sepolia and polygon-amoy are the real public testnets (deployed via
// npm run deploy:base-sepolia / deploy:polygon-amoy). The fortel2-* entries are
// the ForteL2 OP Stack rail, operated OUTSIDE this repo (Mac sequencer +
// optional Render read replica) — canonical chain facts come from ForteL2's
// deployments/rail-interface.json, not from anything this repo runs.
// This module is client-safe — no node imports, no secrets (non-public env vars
// resolve to their defaults in the browser bundle).

export interface NetworkInfo {
  id: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  /**
   * Optional read-only RPC (ForteL2's Render replica). Balance/display reads
   * may prefer it via readClientFor (lib/chain.ts); writes, tx confirmation,
   * and any read that gates a write always use rpcUrl — a replica can lag the
   * node that executed the tx.
   */
  readRpcUrl?: string;
  /** Real testnet this local chain simulates (absent for real networks). */
  simulates?: string;
  /** Block explorer base URL (no trailing slash), e.g. https://sepolia.basescan.org */
  explorerUrl?: string;
  /** True for real external networks (as opposed to local simulation chains). */
  live?: boolean;
  /** Native gas currency symbol (defaults to ETH). */
  nativeSymbol?: string;
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
  "polygon-amoy": {
    id: "polygon-amoy",
    label: "Polygon Amoy",
    chainId: 80002,
    rpcUrl: process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
    explorerUrl: "https://amoy.polygonscan.com",
    live: true,
    nativeSymbol: "POL",
  },
  // ForteL2 (OP Stack, Sepolia L1) — the long-term home settlement rail, run
  // outside this repo. `live: true` because it is a real external chain even
  // though the sequencer RPC is usually loopback to the operator's Mac. No
  // block explorer yet, so tx links stay null (raw hashes only). Defaults from
  // ForteL2 deployments/rail-interface.json.
  "fortel2-sepolia": {
    id: "fortel2-sepolia",
    label: "ForteL2 Sepolia",
    chainId: 852,
    rpcUrl: process.env.FORTEL2_SEPOLIA_RPC_URL || "http://127.0.0.1:9545",
    readRpcUrl: process.env.FORTEL2_SEPOLIA_READ_RPC_URL || undefined,
    live: true,
  },
  // Offline ForteL2 devnet (Anvil L1) — optional experiments only, resets
  // freely; fortel2-sepolia is the integration path. Also operated outside
  // this repo (not one of our Hardhat nodes).
  "fortel2-local": {
    id: "fortel2-local",
    label: "ForteL2 (local)",
    chainId: 901,
    rpcUrl: process.env.FORTEL2_LOCAL_RPC_URL || "http://127.0.0.1:9545",
    simulates: "ForteL2 Sepolia",
  },
};

/** Real public networks (deployments live in chain/deployments.<id>.json overlays). */
export const LIVE_NETWORK_IDS = Object.values(NETWORKS)
  .filter((n) => n.live)
  .map((n) => n.id);

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

/**
 * Dashboard subtitle naming the rails that actually have deployments.
 * Pass registry labels for deployed network ids (empty → honest "none").
 * Pure so a host with only Base Sepolia cannot keep shipping a "local EVM"
 * string that was true in one environment and false in the next.
 */
export function settlementRailCaption(labels: readonly string[]): string {
  if (labels.length === 0) {
    return "Cross-border B2B stablecoin settlement · no deployed rails";
  }
  return `Cross-border B2B stablecoin settlement · ${labels.join(", ")}`;
}
