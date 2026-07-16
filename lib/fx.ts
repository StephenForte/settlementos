// Simulated FX engine. Mid-market rates are static demo values; quotes apply a
// spread and an amount-tiered slippage estimate. No real FX execution occurs.
//
// All arithmetic here is bigint: amounts in the currency's **minor units**
// (lib/money.ts), rates as integers scaled by 10^RATE_DECIMALS. A float rate is
// fine to look at and wrong to quote with — 157.2 is not representable, so
// `(amount - fee) * rate` drifts by fractions of a yen that then disagree with
// the base units actually escrowed. Number appears below only for bps constants
// (small integers, never money) and never in a monetary expression.
//
// Rounding is floor, always, and always in the platform's favour: the effective
// rate rounds down, and so does the destination amount. A quote therefore never
// promises a recipient a minor unit the treasury has to find somewhere.

import { currencyDecimals, formatScaledUnits } from "./money";

/** Rate precision. 18 keeps ~15 significant digits on inverted corridors. */
export const RATE_DECIMALS = 18;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);
const BPS_SCALE = 10_000n;

export const FX_SPREAD_BPS = 20; // platform FX spread
export const PLATFORM_FEE_BPS = 10; // settlement orchestration fee

/** Demo mid-market rates, one direction each — inverses are derived below. */
const MID_RATE_DECIMALS: Record<string, string> = {
  "USD-JPY": "157.2",
  "USD-SGD": "1.35",
  "SGD-JPY": "116.44",
};

export function corridorCode(source: string, dest: string): string {
  return `${source}-${dest}`;
}

/** A decimal rate string ("157.2") to its RATE_SCALE integer. Exact. */
function scaleRate(rate: string): bigint {
  const [whole, frac = ""] = rate.split(".");
  return BigInt(whole + frac.padEnd(RATE_DECIMALS, "0").slice(0, RATE_DECIMALS));
}

const MID_RATES: Record<string, bigint> = Object.fromEntries(
  Object.entries(MID_RATE_DECIMALS).flatMap(([code, rate]) => {
    const [source, dest] = code.split("-");
    const scaled = scaleRate(rate);
    // 1/rate at rate scale, rounded to nearest rather than floored. The rate
    // table is *data*: it should be the closest representation of 157.2⁻¹ the
    // scale allows. Flooring it instead would bias every inverted corridor
    // downward — 157,200 JPY would round-trip to $999.99 — which is a
    // representation error masquerading as a fee. The floors that favour the
    // platform are applied to amounts and spreads, deliberately, further down.
    return [
      [code, scaled],
      [corridorCode(dest, source), (RATE_SCALE * RATE_SCALE + scaled / 2n) / scaled],
    ];
  })
);

/** Mid-market rate for a corridor, scaled by 10^RATE_DECIMALS. */
export function midRate(source: string, dest: string): bigint {
  if (source === dest) return RATE_SCALE;
  const rate = MID_RATES[corridorCode(source, dest)];
  if (!rate) throw new Error(`Unsupported corridor ${source}→${dest}`);
  return rate;
}

export function supportedCorridors(): string[] {
  return Object.keys(MID_RATES);
}

/** A scaled rate as a decimal string for display/API. Floors to `decimals`. */
export function formatRate(rateScaled: bigint, decimals = 6): string {
  if (decimals > RATE_DECIMALS) throw new Error(`rates carry at most ${RATE_DECIMALS} decimals`);
  return formatScaledUnits(rateScaled / 10n ** BigInt(RATE_DECIMALS - decimals), decimals);
}

/** Worsen a rate by `bps` (spread, slippage, bridge fee), rounding down. */
export function applyBps(rateScaled: bigint, bps: number): bigint {
  return (rateScaled * (BPS_SCALE - BigInt(bps))) / BPS_SCALE;
}

/**
 * Convert minor units across currencies at a scaled rate, rounding down.
 * The 10^dec factors are what make this a currency conversion rather than a
 * bare multiply: USD counts cents, JPY counts yen.
 */
export function convert(
  amountMinor: bigint,
  rateScaled: bigint,
  sourceCurrency: string,
  destCurrency: string
): bigint {
  const sourceScale = 10n ** BigInt(currencyDecimals(sourceCurrency));
  const destScale = 10n ** BigInt(currencyDecimals(destCurrency));
  return (amountMinor * rateScaled * destScale) / (RATE_SCALE * sourceScale);
}

/** Slippage tier boundaries, in USD minor units (cents). */
const SLIPPAGE_TIERS: [bigint, number][] = [
  [10_000_00n, 1],
  [100_000_00n, 3],
  [500_000_00n, 8],
];

/** Slippage estimate in bps, tiered by USD-equivalent notional. */
export function slippageBps(usdEquivalentMinor: bigint): number {
  for (const [ceiling, bps] of SLIPPAGE_TIERS) {
    if (usdEquivalentMinor <= ceiling) return bps;
  }
  return 15;
}

/** Notional in USD minor units, for tiering and risk thresholds. */
export function usdEquivalent(amountMinor: bigint, sourceCurrency: string): bigint {
  if (sourceCurrency === "USD") return amountMinor;
  return convert(amountMinor, midRate(sourceCurrency, "USD"), sourceCurrency, "USD");
}

export interface FxQuote {
  /** Scaled by 10^RATE_DECIMALS — format with `formatRate` for display. */
  midRate: bigint;
  effectiveRate: bigint;
  spreadBps: number;
  slippageBps: number;
  platformFeeBps: number;
  /** Destination-currency minor units. */
  destinationAmount: bigint;
  /** Source-currency minor units. */
  platformFee: bigint;
}

/** Quote a conversion of `amountMinor` source minor units. */
export function quoteFx(amountMinor: bigint, sourceCurrency: string, destCurrency: string): FxQuote {
  const mid = midRate(sourceCurrency, destCurrency);
  const slip = slippageBps(usdEquivalent(amountMinor, sourceCurrency));
  const effective = applyBps(mid, FX_SPREAD_BPS + slip);
  const platformFee = (amountMinor * BigInt(PLATFORM_FEE_BPS)) / BPS_SCALE;
  return {
    midRate: mid,
    effectiveRate: effective,
    spreadBps: FX_SPREAD_BPS,
    slippageBps: slip,
    platformFeeBps: PLATFORM_FEE_BPS,
    destinationAmount: convert(amountMinor - platformFee, effective, sourceCurrency, destCurrency),
    platformFee,
  };
}
