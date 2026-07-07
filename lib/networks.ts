// Network registry for the multi-chain demo. Both networks are local Hardhat
// nodes standing in for real L2 testnets — same contracts, same tooling.

export interface NetworkInfo {
  id: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  /** Real testnet this local chain simulates. */
  simulates: string;
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
};

export const NETWORK_IDS = Object.keys(NETWORKS);

export function networkInfo(id: string): NetworkInfo {
  const n = NETWORKS[id];
  if (!n) throw new Error(`Unknown network ${id}`);
  return n;
}
