// Route quote engine. Generates route options for a payment based on network,
// gas, time, liquidity, and FX estimates (PRD section 12). Cross-network
// payments get a simulated-bridge route with destination-chain payout plus a
// single-chain fallback that settles on the source network with a ledger credit.

import { applyBps, convert, formatRate, quoteFx, FX_SPREAD_BPS } from "./fx";
import { formatMinorUnits, parseAmount, parseScaledUnits, MoneyError } from "./money";
import { assetForCurrency, fromBaseUnits, type AssetSymbol } from "./assets";
import { isChainReady, loadDeployments } from "./chain";
import { networkInfo } from "./networks";
import { freeTreasuryBalance, parkedBalance, TreasuryError } from "./treasury";
import { prisma } from "./db";

export const BRIDGE_FEE_BPS = 5; // simulated bridge/liquidity-network fee

export interface RouteOption {
  route_id: string;
  strategy: string;
  description: string;
  hops: string[]; // human-readable route legs for visualization
  source_network: string;
  destination_network: string;
  source_asset: string;
  destination_asset: string;
  estimated_gas_usd: string;
  estimated_time_seconds: number;
  estimated_fx_rate: string;
  mid_market_rate: string;
  fx_spread_bps: number;
  slippage_bps: number;
  platform_fee_bps: number;
  bridge_fee_bps: number;
  platform_fee: string;
  estimated_destination_amount: string;
  liquidity_available: boolean;
  /** The route only clears because parked MMF liquidity gets recalled T+0 first. */
  recall_required: boolean;
  compliance_required: boolean;
  recommended: boolean;
}

export interface LiquiditySnapshot {
  /** Treasury's on-chain balance, token base units. */
  onchainUnits: bigint;
  /** Base units promised to in-flight payments. */
  reservedUnits: bigint;
  /** Balance minus reservations — what a new payment may draw on. */
  availableUnits: bigint;
  /** Base-unit precision of this token on this network. */
  decimals: number;
  /** Display/API forms of the three figures above. */
  onchain: string;
  reserved: string;
  available: string;
}

/** Destination-asset liquidity held by the treasury on a network, minus active reservations. */
export async function availableLiquidity(assetSymbol: string, networkId: string): Promise<LiquiditySnapshot> {
  const net = loadDeployments().networks[networkId];
  if (!net) throw new Error(`Unknown network ${networkId}`);
  const token = net.contracts.tokens[assetSymbol];
  if (!token) throw new Error(`Token ${assetSymbol} not deployed on ${networkId}`);

  // The arithmetic lives in lib/treasury, which already does it in bigint — this
  // is the display wrapper, not a second opinion. Import direction is
  // routing → treasury (AGENTS.md); never the reverse.
  const { balance, reserved, free } = await freeTreasuryBalance(networkId, assetSymbol as AssetSymbol);
  return {
    onchainUnits: balance,
    reservedUnits: reserved,
    availableUnits: free,
    decimals: token.decimals,
    onchain: fromBaseUnits(balance, token.decimals),
    reserved: fromBaseUnits(reserved, token.decimals),
    available: fromBaseUnits(free, token.decimals),
  };
}

/**
 * A destination amount (a canonical decimal string in the destination
 * *currency*) as base units of the *token* that settles it.
 *
 * The string is the exact bridge between the two scales, and they are not the
 * same number: USD counts cents (2dp) while mockUSDC counts millionths (6dp).
 */
export function destinationUnits(amount: string, decimals: number): bigint {
  return parseScaledUnits(amount, decimals, { what: "destination amount" });
}

export interface LiquidityCheck {
  /** The payment can be funded — possibly only after recalling from the MMF. */
  ok: boolean;
  /** Free liquidity alone falls short; parked liquidity has to be recalled first. */
  recallRequired: boolean;
}

/**
 * Can the treasury fund `needed` (a canonical destination-currency amount) of an
 * asset on a network? Parked MMF liquidity counts: it redeems T+0, so the quote
 * is still offered — flagged so the executor knows to recall before it reserves
 * and escrows.
 */
export async function liquidityCheck(
  assetSymbol: string,
  networkId: string,
  needed: string
): Promise<LiquidityCheck> {
  if (!isChainReady()) return { ok: true, recallRequired: false };
  try {
    const liq = await availableLiquidity(assetSymbol, networkId);
    const neededUnits = destinationUnits(needed, liq.decimals);
    if (liq.availableUnits >= neededUnits) return { ok: true, recallRequired: false };

    const parked = await parkedBalance(networkId, assetSymbol as AssetSymbol);
    if (liq.availableUnits + parked >= neededUnits) return { ok: true, recallRequired: true };
    return { ok: false, recallRequired: false };
  } catch (e) {
    // An unreadable amount is our own bug, not a flaky endpoint — quoting a
    // route as fundable because we could not parse what it needs is how a
    // payment gets to the executor with nothing behind it. A bad reservation
    // string surfaces from freeTreasuryBalance as TreasuryError("INVALID_AMOUNT")
    // (it re-types the MoneyError), so catch that too — otherwise the parse
    // failure the MoneyError branch is meant to stop slips through as ok:true.
    if (e instanceof MoneyError) throw e;
    if (e instanceof TreasuryError && e.code === "INVALID_AMOUNT") throw e;
    return { ok: true, recallRequired: false }; // chain unreachable while quoting → execution re-checks
  }
}

export async function quoteRoutes(paymentId: string): Promise<RouteOption[]> {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const src = payment.sourceCurrency;
  const dst = payment.destinationCurrency;
  // Payment.amount is canonical (lib/money.ts gates the create route), so this
  // re-parse is exact — quoting works in the same minor units the row stores.
  const amountMinor = parseAmount(payment.amount, src);
  const sourceNet = payment.sourceNetwork;
  const destNet = payment.destinationNetwork;
  const sourceAsset = assetForCurrency(src);
  const destAsset = assetForCurrency(dst);
  const fx = quoteFx(amountMinor, src, dst);

  const common = {
    source_asset: sourceAsset.symbol,
    destination_asset: destAsset.symbol,
    mid_market_rate: formatRate(fx.midRate),
    fx_spread_bps: fx.spreadBps,
    slippage_bps: fx.slippageBps,
    platform_fee_bps: fx.platformFeeBps,
    platform_fee: formatMinorUnits(fx.platformFee, src),
    liquidity_available: true,
    recall_required: false,
    compliance_required: true,
  };

  if (sourceNet === destNet) {
    const effective = formatRate(fx.effectiveRate);
    const destAmount = formatMinorUnits(fx.destinationAmount, dst);
    const liq = await liquidityCheck(destAsset.symbol, destNet, destAmount);
    const net = networkInfo(sourceNet).label;
    return [
      {
        ...common,
        route_id: `route_${paymentId}_instant`,
        strategy: "INSTANT_ESCROW_SETTLEMENT",
        description: `Escrow ${sourceAsset.symbol} on PaymentSettlement (${net}), internal FX desk conversion, immediate ${dst} ledger credit`,
        hops: [`${sourceAsset.symbol} · ${net}`, "Internal FX desk", `${dst} ledger credit`],
        source_network: sourceNet,
        destination_network: destNet,
        estimated_gas_usd: "0.11",
        estimated_time_seconds: 15,
        estimated_fx_rate: effective,
        bridge_fee_bps: 0,
        estimated_destination_amount: destAmount,
        liquidity_available: liq.ok,
        recall_required: liq.recallRequired,
        recommended: true,
      },
      {
        ...common,
        route_id: `route_${paymentId}_batched`,
        strategy: "BATCHED_NETTING_WINDOW",
        description: `Queue into next 4-hour multilateral netting window on ${net}, settle net position on-chain, ${dst} ledger credit after window close`,
        hops: [`${sourceAsset.symbol} · ${net}`, "4h netting window", `${dst} ledger credit`],
        source_network: sourceNet,
        destination_network: destNet,
        estimated_gas_usd: "0.03",
        estimated_time_seconds: 14_400,
        estimated_fx_rate: effective,
        bridge_fee_bps: 0,
        estimated_destination_amount: destAmount,
        liquidity_available: liq.ok,
        recall_required: liq.recallRequired,
        recommended: false,
      },
    ];
  }

  // Cross-network: bridged route (recommended) + single-chain fallback on source.
  const srcLabel = networkInfo(sourceNet).label;
  const dstLabel = networkInfo(destNet).label;

  // The bridge leg costs the corridor an extra fee, so it re-quotes off mid
  // rather than compounding the instant route's already-worsened rate.
  const bridgedEffective = applyBps(fx.midRate, FX_SPREAD_BPS + fx.slippageBps + BRIDGE_FEE_BPS);
  const bridgedDestAmount = formatMinorUnits(
    convert(amountMinor - fx.platformFee, bridgedEffective, src, dst),
    dst
  );
  const fallbackDestAmount = formatMinorUnits(fx.destinationAmount, dst);
  // Independent RPC/DB reads — run together so a flaky destination does not
  // serialise behind a healthy source (and vice versa).
  const [bridgedLiq, fallbackLiq] = await Promise.all([
    liquidityCheck(destAsset.symbol, destNet, bridgedDestAmount),
    liquidityCheck(destAsset.symbol, sourceNet, fallbackDestAmount),
  ]);

  return [
    {
      ...common,
      route_id: `route_${paymentId}_bridge`,
      strategy: "BRIDGE_AND_SETTLE",
      description: `Escrow ${sourceAsset.symbol} on ${srcLabel}, simulated bridge to ${dstLabel}, on-chain ${destAsset.symbol} payout to recipient wallet, ${dst} ledger credit`,
      hops: [
        `${sourceAsset.symbol} · ${srcLabel}`,
        "FX + simulated bridge",
        `${destAsset.symbol} · ${dstLabel}`,
        `${dst} ledger credit`,
      ],
      source_network: sourceNet,
      destination_network: destNet,
      estimated_gas_usd: "0.26",
      estimated_time_seconds: 90,
      estimated_fx_rate: formatRate(bridgedEffective),
      bridge_fee_bps: BRIDGE_FEE_BPS,
      estimated_destination_amount: bridgedDestAmount,
      liquidity_available: bridgedLiq.ok,
      recall_required: bridgedLiq.recallRequired,
      recommended: true,
    },
    {
      ...common,
      route_id: `route_${paymentId}_srcchain`,
      strategy: "SOURCE_CHAIN_LEDGER_SETTLEMENT",
      description: `Settle entirely on ${srcLabel}: escrow, internal FX conversion, ${dst} ledger credit — no destination-chain payout`,
      hops: [`${sourceAsset.symbol} · ${srcLabel}`, "Internal FX desk", `${dst} ledger credit`],
      source_network: sourceNet,
      destination_network: sourceNet,
      estimated_gas_usd: "0.11",
      estimated_time_seconds: 15,
      estimated_fx_rate: formatRate(fx.effectiveRate),
      bridge_fee_bps: 0,
      estimated_destination_amount: fallbackDestAmount,
      liquidity_available: fallbackLiq.ok,
      recall_required: fallbackLiq.recallRequired,
      recommended: false,
    },
  ];
}
