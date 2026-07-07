// Settlement asset metadata. Addresses come from chain/deployments.json at runtime.

export type AssetSymbol = "mockUSDC" | "mockJPY" | "mockSGD";

export interface AssetInfo {
  symbol: AssetSymbol;
  currency: string; // fiat currency the token represents
  decimals: number;
  name: string;
}

export const ASSETS: Record<AssetSymbol, AssetInfo> = {
  mockUSDC: { symbol: "mockUSDC", currency: "USD", decimals: 6, name: "Mock USD Coin" },
  mockJPY: { symbol: "mockJPY", currency: "JPY", decimals: 0, name: "Mock JPY Token" },
  mockSGD: { symbol: "mockSGD", currency: "SGD", decimals: 6, name: "Mock SGD Token" },
};

export const CURRENCY_TO_ASSET: Record<string, AssetSymbol> = {
  USD: "mockUSDC",
  JPY: "mockJPY",
  SGD: "mockSGD",
};

export function assetForCurrency(currency: string): AssetInfo {
  const symbol = CURRENCY_TO_ASSET[currency];
  if (!symbol) throw new Error(`No settlement asset for currency ${currency}`);
  return ASSETS[symbol];
}

/** Convert a decimal string ("100000.00") to on-chain base units. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

/** Convert on-chain base units back to a decimal string. */
export function fromBaseUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function formatAmount(amount: string | null | undefined, currency?: string): string {
  if (amount == null || amount === "") return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return amount;
  const digits = currency === "JPY" ? 0 : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
