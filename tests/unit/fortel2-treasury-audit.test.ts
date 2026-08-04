// T3 / US-F005 follow-up: treasury-layer behavior is network-generic for
// fortel2-sepolia where that can be shown without dialing a chain.
//
// Complements tests/unit/fortel2-mmf-wiring.test.ts (overlay merge +
// mmfAddress / accountsFor shape) and tests/unit/treasury.test.ts (full pure
// math matrix). This file only covers:
//   - parkedBalance() → 0n, never a throw, when the overlay has no fund
//   - mmfAddress() resolves when the overlay carries TokenizedMMF (the seam
//     parkedBalance / park / recall all gate on)
//   - the +3.5%/365 floor math the live park→accrue→recall runbook asserts
//   - TREASURY_* audit action constants the runbook's audit-trail checks cite
//
// Hermetic: no chain is dialed. Same SETTLEMENTOS_CHAIN_DIR temp-overlay
// pattern as fortel2-mmf-wiring.test.ts.

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FORTEL2 = "fortel2-sepolia";

// Placeholder addresses in the shape lib/chain expects (40 hex chars, lowercase
// like deployments.json). Values are arbitrary — nothing here touches a chain.
const ADDR = {
  settlement: "0x1111111111111111111111111111111111111111",
  mmf: "0x2222222222222222222222222222222222222222",
  usdc: "0x3333333333333333333333333333333333333333",
  jpy: "0x4444444444444444444444444444444444444444",
  operator: "0x5128889f20ec13e0be38b2bebc568594159b652d",
  treasury: "0x6666666666666666666666666666666666666666",
  acme: "0x7777777777777777777777777777777777777777",
} as const;

/** A live-network overlay exactly as scripts/deploy-testnet.mjs writes it. */
function fortel2Overlay({ withMmf }: { withMmf: boolean }) {
  const contracts: Record<string, unknown> = {
    PaymentSettlement: ADDR.settlement,
    tokens: {
      mockUSDC: { address: ADDR.usdc, decimals: 6 },
      mockJPY: { address: ADDR.jpy, decimals: 0 },
    },
  };
  if (withMmf) contracts.TokenizedMMF = ADDR.mmf;
  return {
    networks: {
      [FORTEL2]: {
        chainId: 852,
        // Not the ForteL2 sequencer port — fixture / sequencer ports must stay
        // out of this file (hermetic; nothing dials this URL).
        rpcUrl: "http://127.0.0.1:1",
        contracts,
        accounts: {
          operator: { address: ADDR.operator, privateKeyEnv: "DEPLOYER_PRIVATE_KEY" },
          treasury: { address: ADDR.treasury, privateKey: "0x" + "ab".repeat(32) },
          entityWallets: {
            ent_acme_us: { address: ADDR.acme, privateKey: "0x" + "cd".repeat(32) },
          },
        },
      },
    },
  };
}

/** Point lib/chain (and anything that imports it) at a temp ForteL2 overlay. */
async function withOverlay(overlay: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-fortel2-treasury-"));
  fs.writeFileSync(path.join(dir, `deployments.${FORTEL2}.json`), JSON.stringify(overlay));
  vi.stubEnv("SETTLEMENTOS_CHAIN_DIR", dir);
  vi.resetModules();
  const chain = await import("@/lib/chain");
  const treasury = await import("@/lib/treasury");
  return { chain, treasury };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ForteL2 treasury seam (hermetic, no chain)", () => {
  it("parkedBalance returns 0n and never throws when fortel2-sepolia has no fund", async () => {
    const { chain, treasury } = await withOverlay(fortel2Overlay({ withMmf: false }));

    // Wiring test already asserts mmfAddress → undefined; here we care that the
    // treasury display/quote path degrades the same way for this network id.
    expect(chain.mmfAddress(FORTEL2)).toBeUndefined();
    await expect(treasury.parkedBalance(FORTEL2, "mockUSDC")).resolves.toBe(0n);
  });

  it("mmfAddress resolves for fortel2-sepolia when the overlay carries TokenizedMMF", async () => {
    // Thin affirmative for the treasury gate: park/recall/accrue leave NO_FUND
    // once this returns. Overlay-merge detail lives in fortel2-mmf-wiring.
    const { chain } = await withOverlay(fortel2Overlay({ withMmf: true }));
    expect(chain.mmfAddress(FORTEL2)).toBe(ADDR.mmf);
  });
});

describe("ForteL2 park→accrue→recall yield math (pure)", () => {
  it("50k mockUSDC at par earns exactly one day of 3.5%/365 (runbook figure)", async () => {
    // Re-import so this file stays self-contained if earlier cases reset modules.
    const { MMF_INDEX_SCALE } = await import("@/lib/chain");
    const { dailyIndex, valueOfShares, MMF_ANNUAL_RATE_BPS } = await import("@/lib/treasury");

    expect(MMF_ANNUAL_RATE_BPS).toBe(350n);
    const par = MMF_INDEX_SCALE;
    const principal = 50_000n * 10n ** 6n; // 50,000.000000 mockUSDC at 6 decimals
    const afterOneDay = valueOfShares(principal, dailyIndex(par));
    // 50000 * 350 / (10000 * 365) = 4.794520… → 4_794_520 base units floored.
    expect(afterOneDay - principal).toBe(4_794_520n);
  });
});

describe("ForteL2 treasury audit action vocabulary", () => {
  it("exports the TREASURY_* actions the live runbook's audit checks look for", async () => {
    const {
      TREASURY_PARKED,
      TREASURY_RECALLED,
      TREASURY_ACCRUED,
      TREASURY_AUTO_RECALLED,
    } = await import("@/lib/treasury");

    expect(TREASURY_PARKED).toBe("TREASURY_PARKED");
    expect(TREASURY_RECALLED).toBe("TREASURY_RECALLED");
    expect(TREASURY_ACCRUED).toBe("TREASURY_ACCRUED");
    expect(TREASURY_AUTO_RECALLED).toBe("TREASURY_AUTO_RECALLED");
  });
});
