// Route quote engine. Generates route options for a payment based on network,
// gas, time, liquidity, and FX estimates (PRD section 12). The local demo runs
// single-chain, so routes differ in settlement strategy rather than network.

import { quoteFx, roundCurrency } from "./fx";
import { assetForCurrency, fromBaseUnits, toBaseUnits } from "./assets";
import { isChainReady, loadDeployments, tokenBalance } from "./chain";
import { prisma } from "./db";

export interface RouteOption {
  route_id: string;
  strategy: string;
  description: string;
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
  platform_fee: string;
  estimated_destination_amount: string;
  liquidity_available: boolean;
  compliance_required: boolean;
  recommended: boolean;
}

/** Destination-asset liquidity available to the treasury, minus active reservations. */
export async function availableLiquidity(assetSymbol: string): Promise<{
  onchain: string;
  reserved: string;
  available: string;
}> {
  const dep = loadDeployments();
  const token = dep.contracts.tokens[assetSymbol];
  if (!token) throw new Error(`Unknown asset ${assetSymbol}`);
  const balance = await tokenBalance(token.address, dep.accounts.treasury.address);
  const onchain = fromBaseUnits(balance, token.decimals);

  const reservations = await prisma.liquidityReservation.findMany({
    where: { asset: assetSymbol, status: "RESERVED" },
  });
  const reserved = reservations.reduce((sum, r) => sum + Number(r.amount), 0);
  const available = Number(onchain) - reserved;
  return { onchain, reserved: reserved.toString(), available: available.toString() };
}

export async function quoteRoutes(paymentId: string): Promise<RouteOption[]> {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const amount = Number(payment.amount);
  const src = payment.sourceCurrency;
  const dst = payment.destinationCurrency;
  const sourceAsset = assetForCurrency(src);
  const destAsset = assetForCurrency(dst);
  const fx = quoteFx(amount, src, dst);

  let liquidityOk = true;
  if (isChainReady()) {
    try {
      const liq = await availableLiquidity(destAsset.symbol);
      liquidityOk = Number(liq.available) >= fx.destinationAmount;
    } catch {
      liquidityOk = true; // chain not reachable during quoting → assume ok, execution re-checks
    }
  }

  const network = "local-anvil";
  const base: Omit<RouteOption, "route_id" | "strategy" | "description" | "estimated_gas_usd" | "estimated_time_seconds" | "recommended"> = {
    source_network: network,
    destination_network: network,
    source_asset: sourceAsset.symbol,
    destination_asset: destAsset.symbol,
    estimated_fx_rate: fx.effectiveRate.toFixed(6),
    mid_market_rate: fx.midRate.toFixed(6),
    fx_spread_bps: fx.spreadBps,
    slippage_bps: fx.slippageBps,
    platform_fee_bps: fx.platformFeeBps,
    platform_fee: roundCurrency(fx.platformFee, src),
    estimated_destination_amount: roundCurrency(fx.destinationAmount, dst),
    liquidity_available: liquidityOk,
    compliance_required: true,
  };

  return [
    {
      route_id: `route_${paymentId}_instant`,
      strategy: "INSTANT_ESCROW_SETTLEMENT",
      description: `Escrow ${sourceAsset.symbol} on PaymentSettlement, internal FX desk conversion, immediate ${dst} ledger credit`,
      estimated_gas_usd: "0.11",
      estimated_time_seconds: 15,
      recommended: true,
      ...base,
    },
    {
      route_id: `route_${paymentId}_batched`,
      strategy: "BATCHED_NETTING_WINDOW",
      description: `Queue into next 4-hour multilateral netting window, settle net position on-chain, ${dst} ledger credit after window close`,
      estimated_gas_usd: "0.03",
      estimated_time_seconds: 14_400,
      recommended: false,
      ...base,
    },
  ];
}

export { toBaseUnits };
