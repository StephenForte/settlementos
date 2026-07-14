// Pure index math for simulated MMF yield (lib/treasury). No chain, no clock:
// a known index and rate must always produce the same next index.

import { describe, it, expect } from "vitest";
import { MMF_INDEX_SCALE } from "@/lib/chain";
import { dailyIndex, valueOfShares, MMF_ANNUAL_RATE_BPS, TreasuryError } from "@/lib/treasury";

const PAR = MMF_INDEX_SCALE; // 1e18

describe("dailyIndex", () => {
  it("adds one day of the default 3.5% APY to par", () => {
    // 1e18 * 350 / (10_000 * 365), floor-divided.
    expect(MMF_ANNUAL_RATE_BPS).toBe(350n);
    expect(dailyIndex(PAR)).toBe(1_000_095_890_410_958_904n);
  });

  it("scales with the rate and is deterministic", () => {
    expect(dailyIndex(PAR, 0n)).toBe(PAR);
    expect(dailyIndex(PAR, 730n) - PAR).toBe(2n * (dailyIndex(PAR, 365n) - PAR));
    expect(dailyIndex(PAR, 365n)).toBe(dailyIndex(PAR, 365n)); // no wall-clock input
  });

  it("compounds: two days of yield beat one, and beat simple doubling by dust", () => {
    const oneDay = dailyIndex(PAR);
    const twoDays = dailyIndex(oneDay);
    expect(twoDays).toBeGreaterThan(oneDay);
    expect(twoDays - oneDay).toBeGreaterThanOrEqual(oneDay - PAR);
  });

  it("never moves the index backwards — floor division only rounds the gain down", () => {
    // A dust index earns less than one wei of yield; the contract would revert
    // on any decrease, so the floor must land on "unchanged", not "lower".
    expect(dailyIndex(1n)).toBe(1n);
    expect(dailyIndex(PAR)).toBeGreaterThan(PAR);
  });

  it("rejects a negative rate", () => {
    expect(() => dailyIndex(PAR, -1n)).toThrow(TreasuryError);
    try {
      dailyIndex(PAR, -1n);
    } catch (err) {
      expect((err as TreasuryError).code).toBe("INVALID_RATE");
    }
  });
});

describe("valueOfShares", () => {
  it("prices shares at the index — par is 1:1, an accrued index is worth more", () => {
    const shares = 100_000n * 10n ** 6n; // 100,000 mockUSDC parked at par
    expect(valueOfShares(shares, PAR)).toBe(shares);

    const accrued = valueOfShares(shares, dailyIndex(PAR));
    expect(accrued).toBeGreaterThan(shares);
    // 3.5% APY on 100k for one day ≈ 9.58 mockUSDC (6 decimals).
    expect(accrued - shares).toBe(9_589_041n);
  });
});
