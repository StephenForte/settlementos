// Multi-network chain adapter (PRD ChainAdapter/AssetAdapter surface, viem).
// Contract addresses and account roles are read from chain/deployments.json
// (local chains, written by scripts/setup.mjs) merged with
// chain/deployments.base-sepolia.json (real testnet, written by
// scripts/deploy-base-sepolia.mjs). Real networks carry their own account set;
// hot keys for them live in .env and are referenced via privateKeyEnv.

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

/** An account role. Either the key is stored inline (local dev chains, generated
 *  testnet wallets holding faucet dust) or referenced via an env var (funded keys). */
export interface AccountRef {
  address: Address;
  privateKey?: Hex;
  privateKeyEnv?: string;
}

export interface NetworkAccounts {
  operator: AccountRef;
  treasury: AccountRef;
  entityWallets: Record<string, AccountRef>;
}

export interface DeployedNetwork {
  chainId: number;
  rpcUrl: string;
  contracts: NetworkContracts;
  /** Real networks carry their own account roles; local chains share `accounts`. */
  accounts?: NetworkAccounts;
}

export interface Deployments {
  networks: Record<string, DeployedNetwork>;
  /** Shared dev-mnemonic accounts for the local chains (absent if only a real testnet is deployed). */
  accounts?: NetworkAccounts;
}

// Overridable so tests can point at an isolated fixture dir instead of chain/.
const CHAIN_DIR = process.env.SETTLEMENTOS_CHAIN_DIR || path.join(process.cwd(), "chain");
const DEPLOYMENTS_PATH = path.join(CHAIN_DIR, "deployments.json");
const SEPOLIA_DEPLOYMENTS_PATH = path.join(CHAIN_DIR, "deployments.base-sepolia.json");

function readJson(p: string) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function loadDeployments(): Deployments {
  const local = fs.existsSync(DEPLOYMENTS_PATH) ? readJson(DEPLOYMENTS_PATH) : null;
  if (local && !local.networks) {
    throw new Error("deployments.json is single-network (pre-Phase-3). Re-run: npm run setup");
  }
  const sepolia = fs.existsSync(SEPOLIA_DEPLOYMENTS_PATH) ? readJson(SEPOLIA_DEPLOYMENTS_PATH) : null;
  if (!local && !sepolia) {
    throw new Error(
      "No deployments found. For local chains: start them (npm run chain, npm run chain:polygon) and run npm run setup. For Base Sepolia: npm run deploy:base-sepolia"
    );
  }
  return {
    networks: { ...(local?.networks ?? {}), ...(sepolia?.networks ?? {}) },
    accounts: local?.accounts,
  };
}

export function isChainReady(): boolean {
  try {
    if (fs.existsSync(DEPLOYMENTS_PATH) && readJson(DEPLOYMENTS_PATH).networks) return true;
  } catch {
    /* fall through */
  }
  try {
    return fs.existsSync(SEPOLIA_DEPLOYMENTS_PATH) && !!readJson(SEPOLIA_DEPLOYMENTS_PATH).networks;
  } catch {
    return false;
  }
}

/** Account roles for a network: its own set if it has one, else the shared local set. */
export function accountsFor(networkId: string): NetworkAccounts {
  const dep = loadDeployments();
  const accounts = dep.networks[networkId]?.accounts ?? dep.accounts;
  if (!accounts) throw new Error(`No accounts configured for network ${networkId}`);
  return accounts;
}

/** Resolve an account's signing key (inline or from the env var it references). */
export function resolveKey(ref: AccountRef, role: string): Hex {
  const key = ref.privateKey ?? (ref.privateKeyEnv ? process.env[ref.privateKeyEnv] : undefined);
  if (!key || !key.startsWith("0x")) {
    throw new Error(
      `Missing private key for ${role} (${ref.address}). ${
        ref.privateKeyEnv ? `Set ${ref.privateKeyEnv} in .env` : "Re-run the deploy script"
      }`
    );
  }
  return key as Hex;
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
  const operator = accountsFor(networkId).operator;
  const wallet = walletFor(networkId, resolveKey(operator, `${networkId} operator`));
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
  const treasury = accountsFor(networkId).treasury;
  const wallet = walletFor(networkId, resolveKey(treasury, `${networkId} treasury`));
  const hash = await wallet.writeContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
  return confirm(networkId, hash);
}

export { NETWORKS };
