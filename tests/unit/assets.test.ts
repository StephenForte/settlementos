import { describe, it, expect } from "vitest";
import { toBaseUnits, fromBaseUnits, assetForCurrency, formatAmount } from "@/lib/assets";

describe("toBaseUnits", () => {
  it("converts decimal strings to 6-decimal base units", () => {
    expect(toBaseUnits("100000.00", 6)).toBe(100_000_000_000n);
    expect(toBaseUnits("1", 6)).toBe(1_000_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
  });

  it("handles 0-decimal tokens (mockJPY)", () => {
    expect(toBaseUnits("15668160", 0)).toBe(15_668_160n);
    // Fractional yen must truncate, not crash or round up.
    expect(toBaseUnits("100.9", 0)).toBe(100n);
  });

  it("truncates excess precision instead of rounding", () => {
    expect(toBaseUnits("0.1234567", 6)).toBe(123_456n);
  });

  it("handles edge inputs", () => {
    expect(toBaseUnits("0", 6)).toBe(0n);
    expect(toBaseUnits(".5", 6)).toBe(500_000n);
    expect(toBaseUnits(" 42.00 ", 6)).toBe(42_000_000n);
  });

  it("does not lose precision on amounts beyond Number.MAX_SAFE_INTEGER", () => {
    expect(toBaseUnits("9007199254.740993", 6)).toBe(9_007_199_254_740_993n);
  });
});

describe("fromBaseUnits", () => {
  it("round-trips with toBaseUnits", () => {
    for (const [amount, decimals] of [
      ["100000", 6],
      ["0.5", 6],
      ["12345678", 0],
      ["0.000001", 6],
    ] as [string, number][]) {
      expect(fromBaseUnits(toBaseUnits(amount, decimals), decimals)).toBe(amount);
    }
  });

  it("strips trailing zeros in the fraction", () => {
    expect(fromBaseUnits(1_500_000n, 6)).toBe("1.5");
    expect(fromBaseUnits(1_000_000n, 6)).toBe("1");
  });

  it("handles 0 decimals directly", () => {
    expect(fromBaseUnits(42n, 0)).toBe("42");
  });
});

describe("assetForCurrency", () => {
  it("maps supported fiat currencies to settlement assets", () => {
    expect(assetForCurrency("USD").symbol).toBe("mockUSDC");
    expect(assetForCurrency("JPY")).toMatchObject({ symbol: "mockJPY", decimals: 0 });
    expect(assetForCurrency("SGD").decimals).toBe(6);
  });

  it("throws on unsupported currencies", () => {
    expect(() => assetForCurrency("EUR")).toThrow(/No settlement asset/);
  });
});

describe("formatAmount", () => {
  it("formats JPY with no decimal places and others with two", () => {
    expect(formatAmount("15668160", "JPY")).toBe("15,668,160");
    expect(formatAmount("100000", "USD")).toBe("100,000.00");
  });

  it("degrades gracefully on missing/invalid values", () => {
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount("")).toBe("—");
    expect(formatAmount("not-a-number")).toBe("not-a-number");
  });
});
