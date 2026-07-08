import { describe, it, expect } from "vitest";
import {
  midRate,
  quoteFx,
  slippageBps,
  usdEquivalent,
  supportedCorridors,
  corridorCode,
  roundCurrency,
  FX_SPREAD_BPS,
  PLATFORM_FEE_BPS,
} from "@/lib/fx";

describe("midRate", () => {
  it("returns known corridor rates and identity for same-currency", () => {
    expect(midRate("USD", "JPY")).toBeCloseTo(157.2);
    expect(midRate("USD", "USD")).toBe(1);
  });

  it("inverse corridors are reciprocal", () => {
    expect(midRate("JPY", "USD")).toBeCloseTo(1 / midRate("USD", "JPY"), 10);
    expect(midRate("SGD", "USD")).toBeCloseTo(1 / midRate("USD", "SGD"), 10);
  });

  it("throws on unsupported corridors", () => {
    expect(() => midRate("USD", "EUR")).toThrow(/Unsupported corridor/);
  });

  it("supportedCorridors matches corridorCode format", () => {
    expect(supportedCorridors()).toContain(corridorCode("USD", "JPY"));
  });
});

describe("slippageBps tiers", () => {
  it("steps at the documented USD notional boundaries", () => {
    expect(slippageBps(10_000)).toBe(1);
    expect(slippageBps(10_001)).toBe(3);
    expect(slippageBps(100_000)).toBe(3);
    expect(slippageBps(100_001)).toBe(8);
    expect(slippageBps(500_000)).toBe(8);
    expect(slippageBps(500_001)).toBe(15);
  });
});

describe("usdEquivalent", () => {
  it("is identity for USD and converts others at mid", () => {
    expect(usdEquivalent(100_000, "USD")).toBe(100_000);
    expect(usdEquivalent(157_200, "JPY")).toBeCloseTo(1_000, 6);
  });
});

describe("quoteFx", () => {
  it("applies platform fee then spread+slippage to the FX rate", () => {
    const amount = 100_000;
    const q = quoteFx(amount, "USD", "JPY");
    const expectedFee = (amount * PLATFORM_FEE_BPS) / 10_000;
    expect(q.platformFee).toBeCloseTo(expectedFee, 10);
    const expectedEffective = q.midRate * (1 - (FX_SPREAD_BPS + q.slippageBps) / 10_000);
    expect(q.effectiveRate).toBeCloseTo(expectedEffective, 10);
    expect(q.destinationAmount).toBeCloseTo((amount - expectedFee) * expectedEffective, 6);
  });

  it("effective rate is always worse than mid (platform never gives price improvement)", () => {
    for (const [src, dst] of [
      ["USD", "JPY"],
      ["USD", "SGD"],
      ["SGD", "JPY"],
    ] as const) {
      const q = quoteFx(50_000, src, dst);
      expect(q.effectiveRate).toBeLessThan(q.midRate);
    }
  });

  it("larger notionals get worse slippage", () => {
    const small = quoteFx(5_000, "USD", "JPY");
    const large = quoteFx(600_000, "USD", "JPY");
    expect(large.slippageBps).toBeGreaterThan(small.slippageBps);
  });
});

describe("roundCurrency", () => {
  it("rounds JPY to whole units and others to cents", () => {
    expect(roundCurrency(15_668_160.7, "JPY")).toBe("15668161");
    expect(roundCurrency(1234.567, "USD")).toBe("1234.57");
  });
});
