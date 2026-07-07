// Simulated FX engine. Mid-market rates are static demo values; quotes apply a
// spread and an amount-tiered slippage estimate. No real FX execution occurs.

const MID_RATES: Record<string, number> = {
  "USD-JPY": 157.2,
  "USD-SGD": 1.35,
  "SGD-JPY": 116.44,
  "JPY-USD": 1 / 157.2,
  "SGD-USD": 1 / 1.35,
  "JPY-SGD": 1 / 116.44,
};

export const FX_SPREAD_BPS = 20; // platform FX spread
export const PLATFORM_FEE_BPS = 10; // settlement orchestration fee

export function corridorCode(source: string, dest: string): string {
  return `${source}-${dest}`;
}

export function midRate(source: string, dest: string): number {
  if (source === dest) return 1;
  const rate = MID_RATES[corridorCode(source, dest)];
  if (!rate) throw new Error(`Unsupported corridor ${source}→${dest}`);
  return rate;
}

export function supportedCorridors(): string[] {
  return Object.keys(MID_RATES);
}

/** Slippage estimate in bps, tiered by USD-equivalent notional. */
export function slippageBps(usdEquivalent: number): number {
  if (usdEquivalent <= 10_000) return 1;
  if (usdEquivalent <= 100_000) return 3;
  if (usdEquivalent <= 500_000) return 8;
  return 15;
}

export function usdEquivalent(amount: number, sourceCurrency: string): number {
  if (sourceCurrency === "USD") return amount;
  return amount * midRate(sourceCurrency, "USD");
}

export interface FxQuote {
  midRate: number;
  effectiveRate: number;
  spreadBps: number;
  slippageBps: number;
  platformFeeBps: number;
  destinationAmount: number;
  platformFee: number; // in source currency
}

export function quoteFx(amount: number, sourceCurrency: string, destCurrency: string): FxQuote {
  const mid = midRate(sourceCurrency, destCurrency);
  const slip = slippageBps(usdEquivalent(amount, sourceCurrency));
  const effective = mid * (1 - (FX_SPREAD_BPS + slip) / 10_000);
  const platformFee = (amount * PLATFORM_FEE_BPS) / 10_000;
  const destinationAmount = (amount - platformFee) * effective;
  return {
    midRate: mid,
    effectiveRate: effective,
    spreadBps: FX_SPREAD_BPS,
    slippageBps: slip,
    platformFeeBps: PLATFORM_FEE_BPS,
    destinationAmount,
    platformFee,
  };
}

/** Round a fiat amount to the currency's conventional precision. */
export function roundCurrency(amount: number, currency: string): string {
  return currency === "JPY" ? Math.round(amount).toString() : amount.toFixed(2);
}
