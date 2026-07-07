// Multi-network chain adapter (PRD ChainAdapter/AssetAdapter surface, viem).
// Contract addresses and account roles per network are read from
// chain/deployments.json, written by scripts/setup.mjs.

import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, networkInfo } from "./networks";

export interface NetworkContracts {
  PaymentSettlement: Address;
  tokens: Record<string, { address: Address; decimals: number }>;
}

export interface Deployments {
  networks: Record<string, { chainId: number; rpcUrl: string; contracts: NetworkContracts }>;
  accounts: {
    operator: { address: Address; privateKey: Hex };
    treasury: { address: Address; privateKey: Hex };
    entityWallets: Record<string, { address: Address; privateKey: Hex }>;
  };
}

const DEPLOYMENTS_PATH = path.join(process.cwd(), "chain", "deployments.json");

export function loadDeployments(): Deployments {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    throw new Error(
      "chain/deployments.json not found. Start both chains (npm run chain, npm run chain:polygon) and run: npm run setup"
    );
  }
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
  if (!dep.networks) {
    throw new Error("deployments.json is single-network (pre-Phase-3). Re-run: npm run setup");
  }
  return dep;
}

export function isChainReady(): boolean {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) return false;
  try {
    return !!JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8")).networks;
  } catch {
    return false;
  }
}

export function networkContracts(networkId: string): NetworkContracts {
  const dep = loadDeployments();
  const net = dep.networks[networkId];
  if (!net) throw new Error(`Network ${networkId} not in deployments.json — re-run npm run setup`);
  return net.contracts;
}

function viemChain(networkId: string) {
  const info = networkInfo(networkId);
  return defineChain({
    id: info.chainId,
    name: info.label,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [info.rpcUrl] } },
  });
}

const publicClients: Record<string, PublicClient> = {};

export function publicClientFor(networkId: string): PublicClient {
  if (!publicClients[networkId]) {
    const info = networkInfo(networkId);
    publicClients[networkId] = createPublicClient({
      chain: viemChain(networkId),
      transport: http(info.rpcUrl),
    });
  }
  return publicClients[networkId];
}

export function walletFor(networkId: string, privateKey: Hex) {
  const info = networkInfo(networkId);
  return createWalletClient({
    chain: viemChain(networkId),
    transport: http(info.rpcUrl),
    account: privateKeyToAccount(privateKey),
  });
}

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const SETTLEMENT_ABI = [
  {
    type: "function",
    name: "initiatePayment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentId", type: "bytes32" },
      { name: "sender", type: "address" },
      { name: "recipient", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "sourceCurrency", type: "string" },
      { name: "destinationCurrency", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settlePayment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentId", type: "bytes32" },
      { name: "routeId", type: "bytes32" },
      { name: "releaseTo", type: "address" },
      { name: "settledAmount", type: "uint256" },
      { name: "destinationAsset", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelPayment",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "failAndRefund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentId", type: "bytes32" },
      { name: "reason", type: "string" },
    ],
    outputs: [],
  },
] as const;

export function onchainPaymentId(paymentId: string): Hex {
  return keccak256(toHex(paymentId));
}

export async function tokenBalance(
  networkId: string,
  token: Address,
  owner: Address
): Promise<bigint> {
  return publicClientFor(networkId).readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

export interface TxResult {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

async function confirm(networkId: string, hash: Hex): Promise<TxResult> {
  const receipt = await publicClientFor(networkId).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted on ${networkId}`);
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}

/** Submit a settlement-contract write as the operator on the given network. */
export async function operatorWrite(
  networkId: string,
  functionName: "initiatePayment" | "settlePayment" | "cancelPayment" | "failAndRefund",
  args: readonly unknown[]
): Promise<TxResult> {
  const dep = loadDeployments();
  const wallet = walletFor(networkId, dep.accounts.operator.privateKey);
  const hash = await wallet.writeContract({
    address: dep.networks[networkId].contracts.PaymentSettlement,
    abi: SETTLEMENT_ABI,
    functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  });
  return confirm(networkId, hash);
}

/**
 * Simulated bridge payout leg: the treasury releases destination-asset tokens to
 * the recipient's wallet on the destination network. Stands in for a real bridge
 * adapter (which would lock/burn on source and mint/release on destination).
 */
export async function treasuryTokenTransfer(
  networkId: string,
  tokenSymbol: string,
  to: Address,
  amount: bigint
): Promise<TxResult> {
  const dep = loadDeployments();
  const token = dep.networks[networkId].contracts.tokens[tokenSymbol];
  if (!token) throw new Error(`Token ${tokenSymbol} not deployed on ${networkId}`);
  const wallet = walletFor(networkId, dep.accounts.treasury.privateKey);
  const hash = await wallet.writeContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
  return confirm(networkId, hash);
}

export { NETWORKS };
