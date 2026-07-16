import { describe, it, expect } from "vitest";
import {
  parseAmount,
  formatMinorUnits,
  canonicalAmount,
  currencyDecimals,
  MoneyError,
} from "@/lib/money";

describe("parseAmount", () => {
  it("accepts canonical amounts and returns minor units", () => {
    expect(parseAmount("25000.00", "USD")).toBe(2_500_000n);
    expect(parseAmount("0.01", "USD")).toBe(1n);
    expect(parseAmount("1", "USD")).toBe(100n);
    expect(parseAmount("1.5", "USD")).toBe(150n);
    expect(parseAmount("100", "JPY")).toBe(100n);
    expect(parseAmount("15668160", "JPY")).toBe(15_668_160n);
    expect(parseAmount("1000.00", "SGD")).toBe(100_000n);
  });

  it("rejects anything Number() would coerce but a decimal string is not", () => {
    for (const bad of ["1e6", "1E6", "Infinity", "-Infinity", "NaN", "0x10", "1,000", "1_000"]) {
      expect(() => parseAmount(bad, "USD"), bad).toThrow(MoneyError);
    }
  });

  it("rejects signs, whitespace, and empty input", () => {
    for (const bad of ["+100.00", "-5.00", " 100.00", "100.00 ", "", ".", ".5", "5.", "100.0.0"]) {
      expect(() => parseAmount(bad, "USD"), bad).toThrow(MoneyError);
    }
  });

  it("rejects non-string input", () => {
    for (const bad of [25000, null, undefined, {}, ["100.00"], true]) {
      expect(() => parseAmount(bad, "USD"), String(bad)).toThrow(MoneyError);
    }
  });

  it("rejects excess precision rather than truncating it", () => {
    // The whole point: toBaseUnits would silently make this 25000 yen.
    expect(() => parseAmount("25000.001", "JPY")).toThrow(/whole numbers/);
    expect(() => parseAmount("25000.1", "JPY")).toThrow(MoneyError);
    expect(() => parseAmount("0.001", "USD")).toThrow(/at most 2 decimal places/);
    expect(() => parseAmount("1.234567", "SGD")).toThrow(MoneyError);
  });

  it("rejects zero and caps integer digits", () => {
    expect(() => parseAmount("0", "USD")).toThrow(/greater than zero/);
    expect(() => parseAmount("0.00", "USD")).toThrow(/greater than zero/);
    expect(() => parseAmount("0", "JPY")).toThrow(/greater than zero/);

    expect(parseAmount("999999999999999", "JPY")).toBe(999_999_999_999_999n); // 15 digits
    expect(() => parseAmount("1000000000000000", "JPY")).toThrow(/15 integer digits/);
  });

  it("rejects currencies with no defined precision", () => {
    expect(() => parseAmount("100.00", "EUR")).toThrow(/unsupported currency/);
  });

  it("stays exact past Number.MAX_SAFE_INTEGER", () => {
    // 90071992547409.93 USD is 9007199254740993 cents — unrepresentable as a float.
    expect(parseAmount("90071992547409.93", "USD")).toBe(9_007_199_254_740_993n);
  });

  it("carries a typed code for every rejection", () => {
    const codes = (["1e6", "0.001", "1000000000000000", "0", "100.00"] as const).map((a, i) => {
      try {
        parseAmount(a, i === 4 ? "EUR" : "USD");
        return "accepted";
      } catch (e) {
        return (e as MoneyError).code;
      }
    });
    expect(codes).toEqual([
      "INVALID_FORMAT",
      "EXCESS_PRECISION",
      "TOO_LARGE",
      "NOT_POSITIVE",
      "UNSUPPORTED_CURRENCY",
    ]);
  });
});

describe("formatMinorUnits", () => {
  it("keeps the currency's full precision, trailing zeros included", () => {
    expect(formatMinorUnits(2_500_000n, "USD")).toBe("25000.00");
    expect(formatMinorUnits(1n, "USD")).toBe("0.01");
    expect(formatMinorUnits(150n, "SGD")).toBe("1.50");
    expect(formatMinorUnits(100n, "JPY")).toBe("100");
  });

  it("round-trips with parseAmount", () => {
    for (const [amount, currency] of [
      ["25000.00", "USD"],
      ["0.01", "USD"],
      ["15668160", "JPY"],
      ["1.50", "SGD"],
    ] as [string, string][]) {
      expect(formatMinorUnits(parseAmount(amount, currency), currency)).toBe(amount);
    }
  });
});

describe("canonicalAmount", () => {
  it("normalizes accepted input to the stored form", () => {
    expect(canonicalAmount("1000", "USD")).toBe("1000.00");
    expect(canonicalAmount("1000.5", "USD")).toBe("1000.50");
    expect(canonicalAmount("1000.00", "USD")).toBe("1000.00");
    expect(canonicalAmount("100", "JPY")).toBe("100");
  });

  it("throws on input parseAmount would reject", () => {
    expect(() => canonicalAmount("1e6", "USD")).toThrow(MoneyError);
  });
});

describe("currencyDecimals", () => {
  it("knows the supported corridor currencies", () => {
    expect(currencyDecimals("USD")).toBe(2);
    expect(currencyDecimals("JPY")).toBe(0);
    expect(currencyDecimals("SGD")).toBe(2);
  });

  it("throws rather than defaulting for an unknown currency", () => {
    expect(() => currencyDecimals("EUR")).toThrow(MoneyError);
  });
});
