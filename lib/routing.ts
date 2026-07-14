// Route quote engine. Generates route options for a payment based on network,
// gas, time, liquidity, and FX estimates (PRD section 12). Cross-network
// payments get a simulated-bridge route with destination-chain payout plus a
// single-chain fallback that settles on the source network with a ledger credit.

import { quoteFx, roundCurrency } from "./fx";
import { assetForCurrency, fromBaseUnits, toBaseUnits, type AssetSymbol } from "./assets";
import { accountsFor, isChainReady, loadDeployments, tokenBalance } from "./chain";
import { networkInfo } from "./networks";
import { parkedBalance } from "./treasury";
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

/** Destination-asset liquidity held by the treasury on a network, minus active reservations. */
export async function availableLiquidity(
  assetSymbol: string,
  networkId: string
): Promise<{ onchain: string; reserved: string; available: string }> {
  const dep = loadDeployments();
  const net = dep.networks[networkId];
  if (!net) throw new Error(`Unknown network ${networkId}`);
  const token = net.contracts.tokens[assetSymbol];
  if (!token) throw new Error(`Token ${assetSymbol} not deployed on ${networkId}`);
  const balance = await tokenBalance(networkId, token.address, accountsFor(networkId).treasury.address);
  const onchain = fromBaseUnits(balance, token.decimals);

  const reservations = await prisma.liquidityReservation.findMany({
    where: { asset: assetSymbol, network: networkId, status: "RESERVED" },
  });
  const reserved = reservations.reduce((sum, r) => sum + Number(r.amount), 0);
  const available = Number(onchain) - reserved;
  return { onchain, reserved: reserved.toString(), available: available.toString() };
}

/** Treasury liquidity parked in the network's tokenized MMF — recallable T+0. */
export async function parkedLiquidity(assetSymbol: string, networkId: string): Promise<string> {
  const token = loadDeployments().networks[networkId]?.contracts.tokens[assetSymbol];
  if (!token) return "0";
  const units = await parkedBalance(networkId, assetSymbol as AssetSymbol);
  return fromBaseUnits(units, token.decimals);
}

interface LiquidityCheck {
  /** The payment can be funded — possibly only after recalling from the MMF. */
  ok: boolean;
  /** Free liquidity alone falls short; parked liquidity has to be recalled first. */
  recallRequired: boolean;
}

/**
 * Can the treasury fund `needed` of an asset on a network? Parked MMF liquidity
 * counts: it redeems T+0, so the quote is still offered — flagged so the
 * executor knows to recall before it reserves and escrows.
 */
async function liquidityCheck(
  assetSymbol: string,
  networkId: string,
  needed: number
): Promise<LiquidityCheck> {
  if (!isChainReady()) return { ok: true, recallRequired: false };
  try {
    const liq = await availableLiquidity(assetSymbol, networkId);
    if (Number(liq.available) >= needed) return { ok: true, recallRequired: false };

    const parked = await parkedLiquidity(assetSymbol, networkId);
    if (Number(liq.available) + Number(parked) >= needed) return { ok: true, recallRequired: true };
    return { ok: false, recallRequired: false };
  } catch {
    return { ok: true, recallRequired: false }; // chain unreachable while quoting → execution re-checks
  }
}

export async function quoteRoutes(paymentId: string): Promise<RouteOption[]> {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const amount = Number(payment.amount);
  const src = payment.sourceCurrency;
  const dst = payment.destinationCurrency;
  const sourceNet = payment.sourceNetwork;
  const destNet = payment.destinationNetwork;
  const sourceAsset = assetForCurrency(src);
  const destAsset = assetForCurrency(dst);
  const fx = quoteFx(amount, src, dst);

  const common = {
    source_asset: sourceAsset.symbol,
    destination_asset: destAsset.symbol,
    mid_market_rate: fx.midRate.toFixed(6),
    fx_spread_bps: fx.spreadBps,
    slippage_bps: fx.slippageBps,
    platform_fee_bps: fx.platformFeeBps,
    platform_fee: roundCurrency(fx.platformFee, src),
    liquidity_available: true,
    recall_required: false,
    compliance_required: true,
  };

  if (sourceNet === destNet) {
    const effective = fx.effectiveRate;
    const destAmount = roundCurrency(fx.destinationAmount, dst);
    const liq = await liquidityCheck(destAsset.symbol, destNet, fx.destinationAmount);
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
        estimated_fx_rate: effective.toFixed(6),
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
        estimated_fx_rate: effective.toFixed(6),
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

  const bridgedEffective = fx.midRate * (1 - (fx.spreadBps + fx.slippageBps + BRIDGE_FEE_BPS) / 10_000);
  const bridgedDestAmount = (amount - fx.platformFee) * bridgedEffective;
  const bridgedLiq = await liquidityCheck(destAsset.symbol, destNet, bridgedDestAmount);

  const fallbackDestAmount = roundCurrency(fx.destinationAmount, dst);
  const fallbackLiq = await liquidityCheck(destAsset.symbol, sourceNet, fx.destinationAmount);

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
      estimated_fx_rate: bridgedEffective.toFixed(6),
      bridge_fee_bps: BRIDGE_FEE_BPS,
      estimated_destination_amount: roundCurrency(bridgedDestAmount, dst),
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
      estimated_fx_rate: fx.effectiveRate.toFixed(6),
      bridge_fee_bps: 0,
      estimated_destination_amount: fallbackDestAmount,
      liquidity_available: fallbackLiq.ok,
      recall_required: fallbackLiq.recallRequired,
      recommended: false,
    },
  ];
}

export { toBaseUnits };
