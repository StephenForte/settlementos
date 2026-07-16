// Fixed-precision money at the API boundary.
//
// Everything downstream of a payment treats `Payment.amount` as a well-formed
// decimal string: `toBaseUnits` will happily read "1e6" as 1, truncate the
// third yen decimal away, and turn "Infinity" into a throw three layers deep in
// the executor. This module is the gate that stops those inputs entering the
// system at all.
//
// Two rules drive it:
//
//  1. **Reject, never repair.** An over-precise amount (25000.001 JPY) is a
//     client bug about a real sum of money — silently truncating it would make
//     us settle an amount nobody asked for. `toBaseUnits` truncates by design
//     (it converts amounts we have already accepted); parseAmount does not.
//  2. **Only the canonical grammar.** `^[0-9]+(\.[0-9]+)?$` and nothing else:
//     no exponent, no leading `+`, no whitespace, no sign. Anything JS's Number
//     would generously coerce is a rejection here.
//
// Framework-free, like lib/api-errors.ts — routes map MoneyError to a 400.

/** Minor units per currency: what a JPY yen / a USD cent is. */
export const CURRENCY_DECIMALS: Record<string, number> = {
  USD: 2,
  JPY: 0,
  SGD: 2,
};

/**
 * Beyond this an "amount" is a typo or an attack, not a payment — and it keeps
 * the minor-unit bigint far away from any float that might touch it downstream.
 */
export const MAX_INTEGER_DIGITS = 15;

const CANONICAL_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

export type MoneyErrorCode =
  | "INVALID_FORMAT"
  | "EXCESS_PRECISION"
  | "TOO_LARGE"
  | "NOT_POSITIVE"
  | "UNSUPPORTED_CURRENCY";

/** Typed so a route can answer 400 with the message and never leak a stack. */
export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Minor-unit precision for a currency; throws rather than assuming 2. */
export function currencyDecimals(currency: string): number {
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals === undefined) {
    throw new MoneyError("UNSUPPORTED_CURRENCY", `unsupported currency: ${currency}`);
  }
  return decimals;
}

export interface ScaledParseOpts {
  /** Names the value in error messages. */
  what?: string;
  /** Overrides the excess-precision message where the caller has a better one. */
  excessPrecision?: string;
}

/**
 * A canonical decimal string to an integer scaled by 10^decimals — the parse
 * half of `formatScaledUnits`, and the strict counterpart of `toBaseUnits`
 * (lib/assets), which truncates. Zero is allowed: this parses quantities we
 * produced ourselves (a reservation row, a liquidity figure), where the
 * positivity rule of a client's payment amount does not apply.
 *
 * Takes `unknown` for the same reason parseAmount does — a string type on a
 * value read from JSON or a DB column is a hope, not a fact.
 */
export function parseScaledUnits(value: unknown, decimals: number, opts: ScaledParseOpts = {}): bigint {
  const what = opts.what ?? "value";

  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    throw new MoneyError(
      "INVALID_FORMAT",
      `${what} must be a plain decimal string, e.g. "25000.00" — no sign, exponent, or spaces`
    );
  }

  const [whole, frac = ""] = value.split(".");
  if (whole.length > MAX_INTEGER_DIGITS) {
    throw new MoneyError("TOO_LARGE", `${what} may have at most ${MAX_INTEGER_DIGITS} integer digits`);
  }
  if (frac.length > decimals) {
    throw new MoneyError(
      "EXCESS_PRECISION",
      opts.excessPrecision ??
        (decimals === 0 ? `${what} must be a whole number` : `${what} allows at most ${decimals} decimal places`)
    );
  }

  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/**
 * Parse a client-supplied amount into that currency's minor units.
 *
 * Takes `unknown` on purpose: this runs on unvalidated request bodies, where a
 * declared `amount?: string` is a hope, not a fact.
 */
export function parseAmount(amount: unknown, currency: string): bigint {
  const decimals = currencyDecimals(currency);
  const units = parseScaledUnits(amount, decimals, {
    what: "amount",
    excessPrecision:
      decimals === 0
        ? `${currency} amounts must be whole numbers`
        : `${currency} amounts allow at most ${decimals} decimal places`,
  });
  if (units <= 0n) throw new MoneyError("NOT_POSITIVE", "amount must be greater than zero");
  return units;
}

/**
 * A non-negative integer scaled by 10^decimals, back to its decimal string —
 * keeping trailing zeros. The generic half of `formatMinorUnits`; lib/fx.ts
 * uses it for FX rates, which are scaled integers but not money.
 */
export function formatScaledUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * Minor units back to the canonical string form stored on the row: always
 * exactly the currency's decimals ("25000.00", "100" JPY). Unlike
 * `fromBaseUnits` it keeps trailing zeros — this is the fixed-precision
 * representation, not a display shortening.
 */
export function formatMinorUnits(units: bigint, currency: string): string {
  return formatScaledUnits(units, currencyDecimals(currency));
}

/** Parse-and-normalize: the canonical string a validated amount is stored as. */
export function canonicalAmount(amount: unknown, currency: string): string {
  return formatMinorUnits(parseAmount(amount, currency), currency);
}
