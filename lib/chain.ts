// Chain adapter for the local EVM settlement network (Hardhat node, Anvil-compatible).
// Implements the PRD's ChainAdapter/AssetAdapter surface with viem. Contract
// addresses and account roles are read from chain/deployments.json, written by
// scripts/setup.mjs.

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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface Deployments {
  network: string;
  chainId: number;
  rpcUrl: string;
  contracts: {
    PaymentSettlement: Address;
    tokens: Record<string, { address: Address; decimals: number }>;
  };
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
      "chain/deployments.json not found. Start the local chain (npm run chain) and run: npm run setup"
    );
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
}

export function isChainReady(): boolean {
  return fs.existsSync(DEPLOYMENTS_PATH);
}

const RPC_URL = process.env.CHAIN_RPC_URL || "http://127.0.0.1:8545";

export const localChain = defineChain({
  id: 31337,
  name: "Local Anvil (Base Sepolia-compatible)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const publicClient = createPublicClient({ chain: localChain, transport: http(RPC_URL) });

export function walletFor(privateKey: Hex) {
  return createWalletClient({
    chain: localChain,
    transport: http(RPC_URL),
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

export async function tokenBalance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({
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

/** Submit a settlement-contract write as the operator and wait for confirmation. */
export async function operatorWrite(
  functionName: "initiatePayment" | "settlePayment" | "cancelPayment" | "failAndRefund",
  args: readonly unknown[]
): Promise<TxResult> {
  const dep = loadDeployments();
  const wallet = walletFor(dep.accounts.operator.privateKey);
  const hash = await wallet.writeContract({
    address: dep.contracts.PaymentSettlement,
    abi: SETTLEMENT_ABI,
    functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}
