import { describe, it, expect } from "vitest";
import {
  midRate,
  quoteFx,
  slippageBps,
  usdEquivalent,
  supportedCorridors,
  corridorCode,
  convert,
  applyBps,
  formatRate,
  RATE_DECIMALS,
  FX_SPREAD_BPS,
  PLATFORM_FEE_BPS,
} from "@/lib/fx";

const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);

describe("midRate", () => {
  it("returns known corridor rates and identity for same-currency", () => {
    expect(midRate("USD", "JPY")).toBe(157_200_000_000_000_000_000n);
    expect(midRate("USD", "USD")).toBe(RATE_SCALE);
  });

  it("inverse corridors are reciprocal to within a part in 1e15", () => {
    // The inverse is a real division, exact only to RATE_DECIMALS — but it is
    // rounded to nearest, so the error stays symmetric around 1 instead of
    // always biasing the inverted corridor down.
    const tolerance = RATE_SCALE / 1_000_000_000_000_000n;
    for (const [src, dst] of [
      ["USD", "JPY"],
      ["USD", "SGD"],
      ["SGD", "JPY"],
    ] as const) {
      const roundTrip = (midRate(src, dst) * midRate(dst, src)) / RATE_SCALE;
      const drift = roundTrip > RATE_SCALE ? roundTrip - RATE_SCALE : RATE_SCALE - roundTrip;
      expect(drift).toBeLessThanOrEqual(tolerance);
    }
  });

  it("throws on unsupported corridors", () => {
    expect(() => midRate("USD", "EUR")).toThrow(/Unsupported corridor/);
  });

  it("supportedCorridors matches corridorCode format", () => {
    expect(supportedCorridors()).toContain(corridorCode("USD", "JPY"));
  });
});

describe("formatRate", () => {
  it("renders a scaled rate at the requested precision, flooring", () => {
    expect(formatRate(midRate("USD", "JPY"))).toBe("157.200000");
    expect(formatRate(midRate("USD", "SGD"))).toBe("1.350000");
    // 1/157.2 = 0.00636132315521628… → floored, never rounded up.
    expect(formatRate(midRate("JPY", "USD"), 12)).toBe("0.006361323155");
  });

  it("refuses more precision than a rate carries", () => {
    expect(() => formatRate(RATE_SCALE, RATE_DECIMALS + 1)).toThrow(/at most/);
  });
});

describe("applyBps", () => {
  it("worsens a rate by the given bps, exactly", () => {
    // 157.2 less 23bps = 156.83844 — exact at this scale.
    expect(applyBps(midRate("USD", "JPY"), 23)).toBe(156_838_440_000_000_000_000n);
    expect(applyBps(midRate("USD", "JPY"), 0)).toBe(midRate("USD", "JPY"));
  });
});

describe("convert", () => {
  it("respects each currency's minor-unit scale", () => {
    // 1000.00 USD (100_000 cents) at mid → 157,200 JPY (0 decimals).
    expect(convert(100_000n, midRate("USD", "JPY"), "USD", "JPY")).toBe(157_200n);
    // …and back.
    expect(convert(157_200n, midRate("JPY", "USD"), "JPY", "USD")).toBe(100_000n);
  });

  it("floors rather than rounding to the nearest minor unit", () => {
    // 1 yen at 0.00636… USD/JPY is well under a cent: floors to zero, not up.
    expect(convert(1n, midRate("JPY", "USD"), "JPY", "USD")).toBe(0n);
  });
});

describe("slippageBps tiers", () => {
  it("steps at the documented USD notional boundaries", () => {
    expect(slippageBps(10_000_00n)).toBe(1);
    expect(slippageBps(10_000_01n)).toBe(3);
    expect(slippageBps(100_000_00n)).toBe(3);
    expect(slippageBps(100_000_01n)).toBe(8);
    expect(slippageBps(500_000_00n)).toBe(8);
    expect(slippageBps(500_000_01n)).toBe(15);
  });
});

describe("usdEquivalent", () => {
  it("is identity for USD and converts others at mid", () => {
    expect(usdEquivalent(100_000_00n, "USD")).toBe(100_000_00n);
    expect(usdEquivalent(157_200n, "JPY")).toBe(1_000_00n);
  });
});

describe("quoteFx", () => {
  it("applies the platform fee, then spread+slippage, in exact minor units", () => {
    // 100,000.00 USD → JPY. Fee 10bps = 100.00 USD, leaving 99,900.00.
    // Slippage tier for $100k is 3bps, so the effective rate is
    // 157.2 × (1 − 23/10000) = 156.83844, and 99,900 × 156.83844 = 15,668,160.156 JPY.
    const q = quoteFx(100_000_00n, "USD", "JPY");
    expect(q.platformFee).toBe(100_00n);
    expect(q.slippageBps).toBe(3);
    expect(q.spreadBps).toBe(FX_SPREAD_BPS);
    expect(q.platformFeeBps).toBe(PLATFORM_FEE_BPS);
    expect(q.effectiveRate).toBe(156_838_440_000_000_000_000n);
    expect(q.destinationAmount).toBe(15_668_160n); // .156 of a yen floored away
  });

  it("quotes JPY source amounts with no phantom sub-yen precision", () => {
    // 157,200 JPY: fee 10bps = 157.2 yen, which floors to 157 — a yen is atomic.
    const q = quoteFx(157_200n, "JPY", "USD");
    expect(q.platformFee).toBe(157n);
    expect(q.destinationAmount).toBe(
      convert(157_200n - 157n, q.effectiveRate, "JPY", "USD")
    );
  });

  it("is exact past 2^53 minor units, where a float silently is not", () => {
    // 100,000,000,000,000.00 USD = 1e16 cents — above Number.MAX_SAFE_INTEGER,
    // so the old float path could not even represent the input, let alone the result.
    const amount = 10_000_000_000_000_000n;
    expect(amount).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const q = quoteFx(amount, "USD", "JPY");
    expect(q.platformFee).toBe(amount / 1000n);
    // Recomputed independently from the definition, not from the implementation.
    const net = amount - amount / 1000n;
    const expected = (net * q.effectiveRate * 1n) / (RATE_SCALE * 100n);
    expect(q.destinationAmount).toBe(expected);
    expect(q.destinationAmount % 1n).toBe(0n);
  });

  it("effective rate is always worse than mid (platform never gives price improvement)", () => {
    for (const [src, dst] of [
      ["USD", "JPY"],
      ["USD", "SGD"],
      ["SGD", "JPY"],
    ] as const) {
      const q = quoteFx(50_000_00n, src, dst);
      expect(q.effectiveRate).toBeLessThan(q.midRate);
    }
  });

  it("larger notionals get worse slippage", () => {
    const small = quoteFx(5_000_00n, "USD", "JPY");
    const large = quoteFx(600_000_00n, "USD", "JPY");
    expect(large.slippageBps).toBeGreaterThan(small.slippageBps);
  });
});
