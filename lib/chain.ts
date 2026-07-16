// Multi-network chain adapter (PRD ChainAdapter/AssetAdapter surface, viem).
// Contract addresses and account roles are read from chain/deployments.json
// (local chains, written by scripts/setup.mjs) merged with one
// chain/deployments.<network>.json overlay per live network (real testnets,
// written by scripts/deploy-testnet.mjs). Real networks carry their own account
// set; hot keys for them live in .env and are referenced via privateKeyEnv.

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
import { LIVE_NETWORK_IDS, NETWORKS, networkInfo } from "./networks";

export interface NetworkContracts {
  PaymentSettlement: Address;
  /** Tokenized MMF for parked treasury liquidity. Absent on networks without one. */
  TokenizedMMF?: Address;
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
const liveOverlayPath = (networkId: string) => path.join(CHAIN_DIR, `deployments.${networkId}.json`);

function readJson(p: string) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function loadDeployments(): Deployments {
  const local = fs.existsSync(DEPLOYMENTS_PATH) ? readJson(DEPLOYMENTS_PATH) : null;
  if (local && !local.networks) {
    throw new Error("deployments.json is single-network (pre-Phase-3). Re-run: npm run setup");
  }
  const overlays = LIVE_NETWORK_IDS.map(liveOverlayPath)
    .filter((p) => fs.existsSync(p))
    .map(readJson);
  if (!local && overlays.length === 0) {
    throw new Error(
      "No deployments found. For local chains: start them (npm run chain, npm run chain:polygon) and run npm run setup. For a real testnet: npm run deploy:base-sepolia or deploy:polygon-amoy"
    );
  }
  return {
    networks: Object.assign({}, local?.networks ?? {}, ...overlays.map((o) => o.networks ?? {})),
    accounts: local?.accounts,
  };
}

export function isChainReady(): boolean {
  for (const p of [DEPLOYMENTS_PATH, ...LIVE_NETWORK_IDS.map(liveOverlayPath)]) {
    try {
      if (fs.existsSync(p) && readJson(p).networks) return true;
    } catch {
      /* try the next file */
    }
  }
  return false;
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
    nativeCurrency: { name: info.nativeSymbol ?? "Ether", symbol: info.nativeSymbol ?? "ETH", decimals: 18 },
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
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
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
  {
    type: "function",
    name: "getPayment",
    stateMutability: "view",
    inputs: [{ name: "paymentId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "recipient", type: "address" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "state", type: "uint8" },
        ],
      },
    ],
  },
] as const;

/** PaymentSettlement.PaymentState, by enum ordinal. */
export const ONCHAIN_PAYMENT_STATES = [
  "NONE",
  "INITIATED",
  "SETTLED",
  "CANCELLED",
  "REFUNDED",
  "FAILED",
] as const;

export type OnchainPaymentState = (typeof ONCHAIN_PAYMENT_STATES)[number];

export const MMF_ABI = [
  {
    type: "function",
    name: "subscribe",
    stateMutability: "nonpayable",
    inputs: [
      { name: "onBehalfOf", type: "address" },
      { name: "assetAmount", type: "uint256" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "onBehalfOf", type: "address" },
      { name: "shares", type: "uint256" },
    ],
    outputs: [{ name: "assetAmount", type: "uint256" }],
  },
  {
    type: "function",
    name: "accrue",
    stateMutability: "nonpayable",
    inputs: [{ name: "newIndex", type: "uint256" }],
    outputs: [],
  },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "currentIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "INDEX_SCALE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalShares", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "sharesOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "assetValueOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "yieldBuffer", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Fixed-point scale of the MMF share index (1e18 == par), mirroring TokenizedMMF.INDEX_SCALE. */
export const MMF_INDEX_SCALE = 10n ** 18n;

/**
 * TokenizedMMF address for a network, or undefined where no fund is deployed
 * (real testnets before a fund deploy, or an unknown network id). Never throws —
 * callers treat "no MMF here" as a normal, non-fatal state.
 */
export function mmfAddress(networkId: string): Address | undefined {
  try {
    return loadDeployments().networks[networkId]?.contracts?.TokenizedMMF;
  } catch {
    return undefined;
  }
}

export function onchainPaymentId(paymentId: string): Hex {
  return keccak256(toHex(paymentId));
}

/**
 * What the escrow contract itself says about a payment. The ground truth when a
 * DB status and a chain may disagree — an execution that threw mid-flight knows
 * what it *attempted*, not what landed, so a recovery path must read this before
 * deciding whether to refund (escrow still held) or compensate (already released).
 * "NONE" means the escrow was never initiated for this id.
 */
export async function onchainPaymentState(
  networkId: string,
  paymentId: Hex
): Promise<OnchainPaymentState> {
  const dep = loadDeployments();
  const p = await publicClientFor(networkId).readContract({
    address: dep.networks[networkId].contracts.PaymentSettlement,
    abi: SETTLEMENT_ABI,
    functionName: "getPayment",
    args: [paymentId],
  });
  return ONCHAIN_PAYMENT_STATES[p.state] ?? "NONE";
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

/**
 * Retry an on-chain call whose failure is transient replica lag. Public RPC
 * endpoints are load-balanced: a write that depends on state from a
 * just-confirmed tx can be gas-estimated against a replica that hasn't seen
 * that block yet and revert (e.g. settlePayment → "not initiated" seconds
 * after the escrow confirmed). `isTransient` decides from the error message
 * whether waiting can help; anything else is rethrown immediately.
 */
export async function retryOnReplicaLag<T>(
  fn: () => Promise<T>,
  isTransient: (message: string) => boolean,
  { retries = 4, delayMs = 2000 }: { retries?: number; delayMs?: number } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= retries || !isTransient(message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
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
  // Every call here depends on state a previous tx wrote, so the matching revert
  // right after that tx confirmed is replica lag rather than a real failure:
  // every function except initiatePayment needs the escrow row, and
  // initiatePayment needs the sender's allowance (approved one tx earlier — a
  // replica that hasn't seen that block yet estimates against a zero allowance).
  const dependsOnEscrowRow = functionName !== "initiatePayment";
  const hash = await retryOnReplicaLag(
    () =>
      wallet.writeContract({
        address: dep.networks[networkId].contracts.PaymentSettlement,
        abi: SETTLEMENT_ABI,
        functionName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: args as any,
      }),
    (message) =>
      dependsOnEscrowRow ? message.includes("not initiated") : message.includes("insufficient allowance")
  );
  return confirm(networkId, hash);
}

/**
 * Submit a TokenizedMMF write as the operator on the given network. The fund is
 * a separate contract from PaymentSettlement (parked funds never pass through
 * escrow), so it gets its own operator-signed write path.
 */
export async function mmfOperatorWrite(
  networkId: string,
  functionName: "subscribe" | "redeem" | "accrue",
  args: readonly unknown[]
): Promise<TxResult> {
  const fund = mmfAddress(networkId);
  if (!fund) throw new Error(`No TokenizedMMF deployed on ${networkId}`);
  const operator = accountsFor(networkId).operator;
  const wallet = walletFor(networkId, resolveKey(operator, `${networkId} operator`));
  const hash = await wallet.writeContract({
    address: fund,
    abi: MMF_ABI,
    functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  });
  return confirm(networkId, hash);
}

export async function tokenAllowance(
  networkId: string,
  token: Address,
  owner: Address,
  spender: Address
): Promise<bigint> {
  return publicClientFor(networkId).readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });
}

/**
 * Ensure the treasury has approved `spender` for at least `amount` of a token,
 * approving MAX if not. The MMF pulls the asset via transferFrom on subscribe;
 * the deploy scripts pre-approve, but a fund redeployed under an existing DB
 * would not be, so parking self-heals rather than reverting.
 */
export async function ensureTreasuryAllowance(
  networkId: string,
  tokenSymbol: string,
  spender: Address,
  amount: bigint
): Promise<void> {
  const token = networkContracts(networkId).tokens[tokenSymbol];
  if (!token) throw new Error(`Token ${tokenSymbol} not deployed on ${networkId}`);
  const treasury = accountsFor(networkId).treasury;
  if ((await tokenAllowance(networkId, token.address, treasury.address, spender)) >= amount) return;

  const wallet = walletFor(networkId, resolveKey(treasury, `${networkId} treasury`));
  const hash = await wallet.writeContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, 2n ** 256n - 1n],
  });
  await confirm(networkId, hash);
}

/**
 * Approve the escrow contract for exactly `amount` of the sender's token, right
 * before the escrow pulls it. Never an unlimited approval: a standing MAX
 * allowance leaves an entity wallet drainable for its whole balance by whatever
 * the escrow address turns out to be, whereas an exact one caps the loss at the
 * payment in flight and `initiatePayment` consumes it back to zero.
 *
 * An allowance that already covers the amount short-circuits with no tx, so
 * networks deployed before this — whose entity wallets hold MAX approvals from
 * the old deploy scripts — keep settling untouched.
 *
 * Returns the approval tx, or null when none was needed.
 */
export async function ensureSenderAllowance(
  networkId: string,
  entityExternalId: string,
  tokenSymbol: string,
  amount: bigint
): Promise<TxResult | null> {
  const contracts = networkContracts(networkId);
  const token = contracts.tokens[tokenSymbol];
  if (!token) throw new Error(`Token ${tokenSymbol} not deployed on ${networkId}`);
  const spender = contracts.PaymentSettlement;
  const sender = accountsFor(networkId).entityWallets[entityExternalId];
  if (!sender) throw new Error(`No wallet configured for ${entityExternalId} on ${networkId}`);
  if ((await tokenAllowance(networkId, token.address, sender.address, spender)) >= amount) return null;

  const wallet = walletFor(networkId, resolveKey(sender, `${networkId} wallet for ${entityExternalId}`));
  const hash = await wallet.writeContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
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
