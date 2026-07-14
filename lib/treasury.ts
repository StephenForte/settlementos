// Tokenized-MMF treasury module (PRD section 24). Idle settlement liquidity is
// parked into TokenizedMMF share tokens and recalled T+0 when a payment needs
// it. Parked funds live in the fund contract and never pass through
// PaymentSettlement — the two contracts make no cross-calls.
//
// Money is bigint base units end to end; the decimal strings only exist at the
// API/DB boundary. A position row is append-only history: its current value is
// always derived (shares x live contract index), never stored.

import type { Address } from "viem";
import { prisma } from "./db";
import { audit } from "./audit";
import { ASSETS, fromBaseUnits, toBaseUnits, type AssetSymbol } from "./assets";
import {
  accountsFor,
  ensureTreasuryAllowance,
  mmfAddress,
  mmfOperatorWrite,
  networkContracts,
  publicClientFor,
  tokenBalance,
  MMF_ABI,
  MMF_INDEX_SCALE,
} from "./chain";

/** Audit actions for treasury/MMF activity (hash-chained like everything else). */
export const TREASURY_PARKED = "TREASURY_PARKED";
export const TREASURY_RECALLED = "TREASURY_RECALLED";
export const TREASURY_ACCRUED = "TREASURY_ACCRUED";

export type TreasuryErrorCode =
  | "NO_FUND"
  | "UNSUPPORTED_ASSET"
  | "INVALID_AMOUNT"
  | "INVALID_RATE"
  | "INSUFFICIENT_FREE_BALANCE"
  | "NOT_ELIGIBLE"
  | "POSITION_NOT_FOUND"
  | "POSITION_NOT_ACTIVE";

/** Typed failure so route handlers can map a cause to an HTTP status. */
export class TreasuryError extends Error {
  constructor(
    readonly code: TreasuryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TreasuryError";
  }
}

interface FundAsset {
  fund: Address;
  token: Address;
  symbol: AssetSymbol;
  decimals: number;
}

/** The network's fund, or a typed NO_FUND — live testnets legitimately have none. */
function fundFor(networkId: string): Address {
  const fund = mmfAddress(networkId);
  if (!fund) {
    throw new TreasuryError("NO_FUND", `No tokenized MMF is deployed on ${networkId}`);
  }
  return fund;
}

/** Resolve the network's fund and check it is actually backed by `assetSymbol`. */
async function fundAssetFor(networkId: string, assetSymbol: string): Promise<FundAsset> {
  const fund = fundFor(networkId);
  if (!(assetSymbol in ASSETS)) {
    throw new TreasuryError("UNSUPPORTED_ASSET", `Unknown settlement asset ${assetSymbol}`);
  }
  const symbol = assetSymbol as AssetSymbol;
  const token = networkContracts(networkId).tokens[symbol];
  if (!token) {
    throw new TreasuryError("UNSUPPORTED_ASSET", `Token ${symbol} is not deployed on ${networkId}`);
  }
  const backing = await publicClientFor(networkId).readContract({
    address: fund,
    abi: MMF_ABI,
    functionName: "asset",
  });
  // Contract reads are checksummed; deployments.json stores lowercase.
  if (String(backing).toLowerCase() !== token.address.toLowerCase()) {
    throw new TreasuryError(
      "UNSUPPORTED_ASSET",
      `The ${networkId} MMF is not backed by ${symbol} — it holds ${backing}`
    );
  }
  return { fund, token: token.address, symbol, decimals: token.decimals };
}

function parseAmount(amount: string, decimals: number): bigint {
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount.trim())) {
    throw new TreasuryError("INVALID_AMOUNT", `Amount must be a positive decimal string, got "${amount}"`);
  }
  const units = toBaseUnits(amount, decimals);
  if (units <= 0n) {
    throw new TreasuryError("INVALID_AMOUNT", `Amount must be greater than zero, got "${amount}"`);
  }
  return units;
}

export interface TreasuryBalance {
  /** Treasury's on-chain token balance, base units. */
  balance: bigint;
  /** Base units reserved against in-flight payments. */
  reserved: bigint;
  /** Balance minus reservations — the only thing that may be parked. */
  free: bigint;
}

/**
 * Unreserved treasury balance for an asset, in base units. Mirrors
 * `availableLiquidity()` in lib/routing (same balance, same RESERVED rows) but
 * stays in bigint so the park guard never rounds.
 */
export async function freeTreasuryBalance(networkId: string, symbol: AssetSymbol): Promise<TreasuryBalance> {
  const token = networkContracts(networkId).tokens[symbol];
  if (!token) throw new TreasuryError("UNSUPPORTED_ASSET", `Token ${symbol} is not deployed on ${networkId}`);

  const balance = await tokenBalance(networkId, token.address, accountsFor(networkId).treasury.address);
  const reservations = await prisma.liquidityReservation.findMany({
    where: { asset: symbol, network: networkId, status: "RESERVED" },
  });
  const reserved = reservations.reduce((sum, r) => sum + toBaseUnits(r.amount, token.decimals), 0n);
  return { balance, reserved, free: balance > reserved ? balance - reserved : 0n };
}

/** Institutional-only guardrail: an entity may park only if cleared AND opted in. */
async function assertEligible(entityId: string): Promise<void> {
  const entity = await prisma.entity.findFirst({
    where: { OR: [{ id: entityId }, { externalId: entityId }] },
  });
  if (!entity) throw new TreasuryError("NOT_ELIGIBLE", `Unknown entity ${entityId}`);
  if (!entity.mmfEligible || !entity.mmfOptIn) {
    throw new TreasuryError(
      "NOT_ELIGIBLE",
      `Entity ${entity.externalId} is not cleared for MMF parking (eligible=${entity.mmfEligible}, opted in=${entity.mmfOptIn})`
    );
  }
}

export interface ParkArgs {
  networkId: string;
  asset: string;
  /** Decimal string in asset units, e.g. "50000.00". */
  amount: string;
  /** When given, the institutional eligibility guardrail is enforced for it. */
  entityId?: string;
}

export interface ParkResult {
  positionId: string;
  shares: bigint;
  assetAmount: bigint;
  indexAtEntry: bigint;
  txHash: string;
}

/**
 * Park unreserved treasury liquidity into the network's MMF: subscribe at the
 * live index and record an ACTIVE position. Refuses to touch liquidity already
 * reserved for an in-flight payment.
 */
export async function park({ networkId, asset, amount, entityId }: ParkArgs): Promise<ParkResult> {
  if (entityId) await assertEligible(entityId);

  const { fund, symbol, decimals } = await fundAssetFor(networkId, asset);
  const assetAmount = parseAmount(amount, decimals);

  const { balance, reserved, free } = await freeTreasuryBalance(networkId, symbol);
  if (assetAmount > free) {
    throw new TreasuryError(
      "INSUFFICIENT_FREE_BALANCE",
      `Cannot park ${amount} ${symbol} on ${networkId}: only ${fromBaseUnits(free, decimals)} is unreserved ` +
        `(balance ${fromBaseUnits(balance, decimals)}, reserved ${fromBaseUnits(reserved, decimals)})`
    );
  }

  const treasury = accountsFor(networkId).treasury.address;
  await ensureTreasuryAllowance(networkId, symbol, fund, assetAmount);

  const client = publicClientFor(networkId);
  const sharesOf = () =>
    client.readContract({ address: fund, abi: MMF_ABI, functionName: "sharesOf", args: [treasury] });

  const indexAtEntry = await client.readContract({
    address: fund,
    abi: MMF_ABI,
    functionName: "currentIndex",
  });
  const sharesBefore = await sharesOf();
  // subscribe() returns the minted shares, but a write only yields a receipt —
  // the treasury's share delta is the same number.
  const tx = await mmfOperatorWrite(networkId, "subscribe", [treasury, assetAmount]);
  const shares = (await sharesOf()) - sharesBefore;

  const position = await prisma.treasuryPosition.create({
    data: {
      network: networkId,
      asset: symbol,
      shares: shares.toString(),
      assetAmountIn: assetAmount.toString(),
      indexAtEntry: indexAtEntry.toString(),
      txHashPark: tx.hash,
    },
  });

  await audit(TREASURY_PARKED, {
    positionId: position.id,
    network: networkId,
    asset: symbol,
    amount: fromBaseUnits(assetAmount, decimals),
    assetAmountUnits: assetAmount.toString(),
    shares: shares.toString(),
    indexAtEntry: indexAtEntry.toString(),
    fund,
    txHash: tx.hash,
    ...(entityId ? { entityId } : {}),
  });

  return { positionId: position.id, shares, assetAmount, indexAtEntry, txHash: tx.hash };
}

export interface RecallResult {
  positionId: string;
  shares: bigint;
  /** Asset returned to the treasury: principal plus any yield accrued since entry. */
  assetAmount: bigint;
  indexAtExit: bigint;
  txHash: string;
}

/**
 * Recall a parked position T+0: redeem its shares at the live index, returning
 * principal plus accrued yield to the treasury wallet, and mark the position
 * RECALLED. Positions are append-only history — the row is never deleted.
 */
export async function recall(positionId: string): Promise<RecallResult> {
  const position = await prisma.treasuryPosition.findUnique({ where: { id: positionId } });
  if (!position) {
    throw new TreasuryError("POSITION_NOT_FOUND", `No treasury position ${positionId}`);
  }
  if (position.status !== "ACTIVE") {
    throw new TreasuryError(
      "POSITION_NOT_ACTIVE",
      `Position ${positionId} is ${position.status} and cannot be recalled again`
    );
  }

  const { fund, symbol, token, decimals } = await fundAssetFor(position.network, position.asset);
  const shares = BigInt(position.shares);
  const treasury = accountsFor(position.network).treasury.address;

  const indexAtExit = await publicClientFor(position.network).readContract({
    address: fund,
    abi: MMF_ABI,
    functionName: "currentIndex",
  });
  // redeem() returns the asset paid out, but a write only yields a receipt — the
  // treasury's balance delta is the same number.
  const balanceBefore = await tokenBalance(position.network, token, treasury);
  const tx = await mmfOperatorWrite(position.network, "redeem", [treasury, shares]);
  const assetAmount = (await tokenBalance(position.network, token, treasury)) - balanceBefore;

  const recalled = await prisma.treasuryPosition.update({
    where: { id: position.id },
    data: { status: "RECALLED", recalledAt: new Date(), txHashRecall: tx.hash },
  });

  const assetAmountIn = BigInt(position.assetAmountIn);
  await audit(TREASURY_RECALLED, {
    positionId: position.id,
    network: position.network,
    asset: symbol,
    shares: shares.toString(),
    amount: fromBaseUnits(assetAmount, decimals),
    assetAmountUnits: assetAmount.toString(),
    principal: fromBaseUnits(assetAmountIn, decimals),
    yield: fromBaseUnits(assetAmount > assetAmountIn ? assetAmount - assetAmountIn : 0n, decimals),
    indexAtEntry: position.indexAtEntry,
    indexAtExit: indexAtExit.toString(),
    fund,
    txHash: tx.hash,
    recalledAt: recalled.recalledAt?.toISOString(),
  });

  return { positionId: position.id, shares, assetAmount, indexAtExit, txHash: tx.hash };
}

/** Simulated annual yield on parked liquidity: 3.5% APY, in basis points. */
export const MMF_ANNUAL_RATE_BPS = 350n;

const BPS_SCALE = 10_000n;
const DAYS_PER_YEAR = 365n;

/**
 * One day of yield applied to a share index — pure integer math, no wall clock
 * and no floats. Floor division means the index never moves backwards (the
 * contract would revert if it did), it just gains nothing on a dust index.
 */
export function dailyIndex(currentIndex: bigint, annualRateBps: bigint = MMF_ANNUAL_RATE_BPS): bigint {
  if (annualRateBps < 0n) {
    throw new TreasuryError("INVALID_RATE", `Annual rate must be >= 0 bps, got ${annualRateBps}`);
  }
  return currentIndex + (currentIndex * annualRateBps) / (BPS_SCALE * DAYS_PER_YEAR);
}

/**
 * Asset value of a holding of shares at an index. A position's current value is
 * always derived this way — it is never stored on the position row, which keeps
 * only the shares it bought and the index it entered at.
 */
export function valueOfShares(shares: bigint, index: bigint): bigint {
  return (shares * index) / MMF_INDEX_SCALE;
}

/** Live share index of the network's fund (1e18 = par). */
export async function currentIndexOf(networkId: string): Promise<bigint> {
  return publicClientFor(networkId).readContract({
    address: fundFor(networkId),
    abi: MMF_ABI,
    functionName: "currentIndex",
  });
}

export interface AccrueResult {
  network: string;
  oldIndex: bigint;
  newIndex: bigint;
  annualRateBps: bigint;
  txHash: string;
}

/**
 * Advance the network's fund by one day of simulated yield. Every ACTIVE
 * position gains value implicitly — the index rises, so the same shares redeem
 * for more asset (paid out of the fund's yield buffer, see AGENTS.md).
 */
export async function accrueDaily(
  networkId: string,
  annualRateBps: bigint = MMF_ANNUAL_RATE_BPS
): Promise<AccrueResult> {
  const fund = fundFor(networkId);
  const oldIndex = await currentIndexOf(networkId);
  const newIndex = dailyIndex(oldIndex, annualRateBps);

  const tx = await mmfOperatorWrite(networkId, "accrue", [newIndex]);

  await audit(TREASURY_ACCRUED, {
    network: networkId,
    fund,
    oldIndex: oldIndex.toString(),
    newIndex: newIndex.toString(),
    annualRateBps: annualRateBps.toString(),
    days: 1,
    txHash: tx.hash,
  });

  return { network: networkId, oldIndex, newIndex, annualRateBps, txHash: tx.hash };
}
