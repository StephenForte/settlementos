// F4 (US-F005) wiring: the seam that makes ForteL2 an MMF-capable network is the
// live-network overlay scripts/deploy-testnet.mjs now writes — a
// deployments.fortel2-sepolia.json carrying a TokenizedMMF address alongside the
// escrow + tokens. lib/treasury (park/recall/accrue) is already network-generic
// and proven on the local chains (tests/integration/mmf, tests/db/treasury), so
// the only ForteL2-specific thing to check is that a ForteL2 overlay carrying the
// fund is merged by loadDeployments() and resolved by mmfAddress() — and that an
// older overlay without one still resolves to "no fund" (backward compatible),
// exactly as base-sepolia / polygon-amoy do until they are re-deployed.
//
// Hermetic: no chain is dialed. lib/chain reads SETTLEMENTOS_CHAIN_DIR at import,
// so each case points it at a throwaway dir and re-imports a fresh copy.

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
  // The one bit F4 adds to the overlay contract set.
  if (withMmf) contracts.TokenizedMMF = ADDR.mmf;
  return {
    networks: {
      [FORTEL2]: {
        chainId: 852,
        rpcUrl: "http://127.0.0.1:9545",
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

/** Point lib/chain at a temp chain dir holding the given ForteL2 overlay, fresh import. */
async function chainWithOverlay(overlay: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-fortel2-"));
  fs.writeFileSync(path.join(dir, `deployments.${FORTEL2}.json`), JSON.stringify(overlay));
  vi.stubEnv("SETTLEMENTOS_CHAIN_DIR", dir);
  vi.resetModules();
  return import("@/lib/chain");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ForteL2 MMF deployment wiring (F4)", () => {
  it("an overlay carrying a TokenizedMMF makes ForteL2 an MMF-capable network", async () => {
    const chain = await chainWithOverlay(fortel2Overlay({ withMmf: true }));

    // The overlay is merged in like base-sepolia / polygon-amoy.
    const dep = chain.loadDeployments();
    expect(dep.networks[FORTEL2]).toBeDefined();
    expect(dep.networks[FORTEL2].chainId).toBe(852);

    // The fund resolves — this is what flips lib/treasury off its NO_FUND path.
    expect(chain.mmfAddress(FORTEL2)).toBe(ADDR.mmf);
    expect(chain.networkContracts(FORTEL2).TokenizedMMF).toBe(ADDR.mmf);
    expect(chain.networkContracts(FORTEL2).PaymentSettlement).toBe(ADDR.settlement);

    // ForteL2 carries its own account roles (its own operator/treasury), not the
    // shared local set — the executor and treasury sign as these.
    const accounts = chain.accountsFor(FORTEL2);
    expect(accounts.operator.address).toBe(ADDR.operator);
    expect(accounts.treasury.address).toBe(ADDR.treasury);
    expect(accounts.entityWallets.ent_acme_us.address).toBe(ADDR.acme);
  });

  it("an overlay without a TokenizedMMF resolves to no fund (older deploy, backward compatible)", async () => {
    const chain = await chainWithOverlay(fortel2Overlay({ withMmf: false }));

    // No fund, never a throw — the network stays fully usable for settlement.
    expect(chain.mmfAddress(FORTEL2)).toBeUndefined();
    expect(chain.networkContracts(FORTEL2).TokenizedMMF).toBeUndefined();
    expect(chain.networkContracts(FORTEL2).PaymentSettlement).toBe(ADDR.settlement);
  });
});
