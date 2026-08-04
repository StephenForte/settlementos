// Multi-network chain adapter (PRD ChainAdapter/AssetAdapter surface, viem).
// Contract addresses and account roles are read from chain/deployments.json
// (local chains, written by scripts/setup.mjs) merged with one
// chain/deployments.<network>.json overlay per live network (real testnets,
// written by scripts/deploy-testnet.mjs). Real networks carry their own account
// set; hot keys for them live in .env and are referenced via privateKeyEnv.
//
// No key is resolved here: every write signs through lib/signers.ts, so custody
// has one seam. Server-only — this module reads the filesystem and .env.

import "server-only";
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
import { ERC20_ABI, MMF_ABI, SETTLEMENT_ABI } from "./abis";
import { LIVE_NETWORK_IDS, NETWORKS, networkInfo } from "./networks";
import { signerFor, type AccountRef, type Signer } from "./signers";

export type { AccountRef, Signer };
export { ERC20_ABI, MMF_ABI, SETTLEMENT_ABI };

export interface NetworkContracts {
  PaymentSettlement: Address;
  /** Tokenized MMF for parked treasury liquidity. Absent on networks without one. */
  TokenizedMMF?: Address;
  tokens: Record<string, { address: Address; decimals: number }>;
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

const readClients: Record<string, PublicClient> = {};

/**
 * Public client for balance/display reads. A network may declare a dedicated
 * read RPC (ForteL2's Render replica via FORTEL2_SEPOLIA_READ_RPC_URL); when it
 * does, these reads go there, otherwise this is exactly publicClientFor. Write
 * flows never use it: a replica can lag the sequencer by a block, so anything
 * that gates or measures a write — confirm(), an allowance check about to be
 * consumed, onchainPaymentState deciding refund-vs-compensate, the treasury's
 * balance deltas around a redeem — must read the node that executed the tx.
 */
export function readClientFor(networkId: string): PublicClient {
  const info = networkInfo(networkId);
  if (!info.readRpcUrl) return publicClientFor(networkId);
  if (!readClients[networkId]) {
    readClients[networkId] = createPublicClient({
      chain: viemChain(networkId),
      transport: http(info.readRpcUrl),
    });
  }
  return readClients[networkId];
}

/** A wallet client that signs as `signer`. Key material (if there is any) is the
 *  signer's business — see lib/signers.ts. */
export async function walletFor(networkId: string, signer: Signer) {
  const info = networkInfo(networkId);
  return createWalletClient({
    chain: viemChain(networkId),
    transport: http(info.rpcUrl),
    account: await signer.account(),
  });
}

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

/**
 * ERC-20 balance read. `viaReadRpc: true` routes through the network's read
 * replica when one is configured (display paths: balances API, liquidity page);
 * the default stays on the write RPC because lib/treasury measures balance
 * deltas around its own transactions.
 */
export async function tokenBalance(
  networkId: string,
  token: Address,
  owner: Address,
  opts: { viaReadRpc?: boolean } = {}
): Promise<bigint> {
  const client = opts.viaReadRpc ? readClientFor(networkId) : publicClientFor(networkId);
  return client.readContract({
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

/** A tx hash returned by writeContract before its receipt is awaited. */
export interface SubmittedTx {
  hash: Hex;
  confirm(): Promise<TxResult>;
}

/** Ground truth for a submitted tx hash on a network — read before undoing a payout. */
export type TransactionOutcome = "confirmed" | "reverted" | "absent" | "unknown";

async function confirm(networkId: string, hash: Hex): Promise<TxResult> {
  const receipt = await publicClientFor(networkId).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted on ${networkId}`);
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}

/**
 * What the destination chain says about a payout attempt. Callers must not
 * treat "unknown" as unpaid and auto-compensate.
 *
 * "absent" is deliberately near-unreachable from a live chain: viem's
 * getTransactionReceipt THROWS TransactionReceiptNotFoundError on a missing
 * receipt, and one read cannot distinguish "dropped forever" from "still in
 * the mempool" — so a missing receipt maps to "unknown" (operator decides),
 * never "absent". Do NOT "fix" this by catching NotFound → "absent": a caller
 * that compensates on "absent" would race a payout still waiting to mine and
 * pay the sender back while the recipient's transfer lands — the exact
 * double-pay this function exists to prevent. "absent" stays in the union for
 * test hooks (executorTestHooks.destinationPayoutOutcome) and any future
 * evidence source that can actually prove a tx will never mine.
 */
export async function transactionOutcome(
  networkId: string,
  hash: Hex
): Promise<TransactionOutcome> {
  try {
    const receipt = await publicClientFor(networkId).getTransactionReceipt({ hash });
    if (!receipt) return "absent";
    return receipt.status === "success" ? "confirmed" : "reverted";
  } catch {
    return "unknown";
  }
}

/** Public testnets use load-balanced RPCs where replica lag is real; ForteL2 and local chains do not. */
export function replicaLagRetries(networkId: string): number {
  if (networkId.startsWith("fortel2-")) return 0;
  if (networkInfo(networkId).live) return 4;
  return 0;
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
  const wallet = await walletFor(networkId, signerFor(operator, `${networkId} operator`));
  // Every call here depends on state a previous tx wrote, so the matching revert
  // right after that tx confirmed is replica lag rather than a real failure:
  // every function except initiatePayment needs the escrow row, and
  // initiatePayment needs the sender's allowance (approved one tx earlier — a
  // replica that hasn't seen that block yet estimates against a zero allowance).
  const dependsOnEscrowRow = functionName !== "initiatePayment";
  const retries = replicaLagRetries(networkId);
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
      dependsOnEscrowRow ? message.includes("not initiated") : message.includes("insufficient allowance"),
    { retries, delayMs: retries > 0 ? 2000 : 0 }
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
  const wallet = await walletFor(networkId, signerFor(operator, `${networkId} operator`));
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

  const wallet = await walletFor(networkId, signerFor(treasury, `${networkId} treasury`));
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

  const wallet = await walletFor(
    networkId,
    signerFor(sender, `${networkId} wallet for ${entityExternalId}`)
  );
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
): Promise<SubmittedTx> {
  const dep = loadDeployments();
  const token = dep.networks[networkId].contracts.tokens[tokenSymbol];
  if (!token) throw new Error(`Token ${tokenSymbol} not deployed on ${networkId}`);
  const treasury = accountsFor(networkId).treasury;
  const wallet = await walletFor(networkId, signerFor(treasury, `${networkId} treasury`));
  const hash = await wallet.writeContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
  return { hash, confirm: () => confirm(networkId, hash) };
}

export { NETWORKS };
