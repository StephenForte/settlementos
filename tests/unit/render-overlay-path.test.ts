// Render Secret Files land at /etc/secrets/<filename>. lib/chain resolves live
// overlays from SETTLEMENTOS_CHAIN_DIR first, then SETTLEMENTOS_SECRET_OVERLAY_DIR
// (default /etc/secrets) so a dashboard-uploaded overlay is found even when the
// blueprint failed to set SETTLEMENTOS_CHAIN_DIR (trap A).

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "base-sepolia";

function baseSepoliaOverlay() {
  return {
    networks: {
      [BASE]: {
        chainId: 84532,
        rpcUrl: "https://sepolia.base.org",
        contracts: {
          PaymentSettlement: "0x9d8b8b7c476ab02306046f3da719d380fa0456aa",
          tokens: {
            mockUSDC: { address: "0x2066738d535681d28d0841cc2503c1c531d4d6aa", decimals: 6 },
          },
        },
        accounts: {
          operator: {
            address: "0x5128889f20ec13e0be38b2bebc568594159b652d",
            privateKeyEnv: "DEPLOYER_PRIVATE_KEY",
          },
          treasury: { address: "0x1111111111111111111111111111111111111111", privateKey: "0x" + "ab".repeat(32) },
          entityWallets: {
            ent_acme_us: {
              address: "0x2222222222222222222222222222222222222222",
              privateKey: "0x" + "cd".repeat(32),
            },
          },
        },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Render secret-file overlay resolution", () => {
  it("finds an overlay under SETTLEMENTOS_SECRET_OVERLAY_DIR when CHAIN_DIR is empty", async () => {
    const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-chain-"));
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-secrets-"));
    fs.writeFileSync(
      path.join(secretsDir, `deployments.${BASE}.json`),
      JSON.stringify(baseSepoliaOverlay())
    );

    vi.stubEnv("SETTLEMENTOS_CHAIN_DIR", chainDir);
    vi.stubEnv("SETTLEMENTOS_SECRET_OVERLAY_DIR", secretsDir);
    vi.resetModules();
    const chain = await import("@/lib/chain");

    expect(chain.isChainReady()).toBe(true);
    const dep = chain.loadDeployments();
    expect(dep.networks[BASE]?.chainId).toBe(84532);
    expect(dep.networks[BASE]?.contracts.PaymentSettlement).toBe(
      "0x9d8b8b7c476ab02306046f3da719d380fa0456aa"
    );
  });

  it("prefers CHAIN_DIR over the secret mount when both exist", async () => {
    const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-chain-"));
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sos-secrets-"));
    const preferred = baseSepoliaOverlay();
    preferred.networks[BASE].contracts.PaymentSettlement =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fallback = baseSepoliaOverlay();
    fallback.networks[BASE].contracts.PaymentSettlement =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    fs.writeFileSync(path.join(chainDir, `deployments.${BASE}.json`), JSON.stringify(preferred));
    fs.writeFileSync(path.join(secretsDir, `deployments.${BASE}.json`), JSON.stringify(fallback));

    vi.stubEnv("SETTLEMENTOS_CHAIN_DIR", chainDir);
    vi.stubEnv("SETTLEMENTOS_SECRET_OVERLAY_DIR", secretsDir);
    vi.resetModules();
    const chain = await import("@/lib/chain");

    expect(chain.loadDeployments().networks[BASE].contracts.PaymentSettlement).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });
});
