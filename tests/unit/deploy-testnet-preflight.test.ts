// T2: unit coverage for scripts/deploy-testnet.mjs preflight helpers and the
// auto-detected deploy-mode decision (full / mmf_addon / noop). J1 extends the
// same file for --adopt helpers (registry, bytecode gate, plan). No live RPC.

import { describe, it, expect } from "vitest";
import { parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  NETWORK_CONFIGS,
  ADOPTABLE_NETWORKS,
  MMF_YIELD_BUFFER,
  MAX_UINT256,
  parseDeployArgs,
  readNetworkOverlay,
  decideDeployMode,
  listAdoptContractAddresses,
  evaluateAdoptBytecode,
  adoptNeedsMmf,
  decideAdoptPlan,
  validateDeployerKey,
  validateChainId,
  validateDeployerBalance,
  runPreflightChecks,
  describePlannedActions,
  mmfYieldBufferSatisfied,
  treasuryMmfApprovalSatisfied,
  resolveAddonTreasuryKey,
} from "../../scripts/deploy-testnet.mjs";

const FORTEL2 = "fortel2-sepolia";
const BASE = "base-sepolia";
const CFG = NETWORK_CONFIGS[FORTEL2];
const DEPLOYER = "0x5128889F20Ec13e0Be38b2BeBC568594159B652d";
const SETTLEMENT = "0x1111111111111111111111111111111111111111";
const MMF = "0x2222222222222222222222222222222222222222";
const USDC = "0x3333333333333333333333333333333333333333";
const JPY = "0x4444444444444444444444444444444444444444";
const SGD = "0x5555555555555555555555555555555555555555";

function overlayJson({ withMmf }: { withMmf: boolean }) {
  const contracts: Record<string, unknown> = {
    PaymentSettlement: SETTLEMENT,
    tokens: {
      mockUSDC: { address: USDC, decimals: 6 },
      mockJPY: { address: "0x4444444444444444444444444444444444444444", decimals: 0 },
    },
  };
  if (withMmf) contracts.TokenizedMMF = MMF;
  return JSON.stringify({
    networks: {
      [FORTEL2]: {
        chainId: 852,
        contracts,
        accounts: {
          treasury: { address: "0x6666666666666666666666666666666666666666", privateKey: "0x" + "ab".repeat(32) },
        },
      },
    },
  });
}

describe("parseDeployArgs", () => {
  it("parses network id alone", () => {
    expect(parseDeployArgs(["node", "script", "fortel2-sepolia"])).toEqual({
      networkId: "fortel2-sepolia",
      preflightOnly: false,
      adopt: false,
    });
  });

  it("parses --preflight-only after network", () => {
    expect(parseDeployArgs(["node", "script", "fortel2-sepolia", "--preflight-only"])).toEqual({
      networkId: "fortel2-sepolia",
      preflightOnly: true,
      adopt: false,
    });
  });

  it("parses --preflight-only before network", () => {
    expect(parseDeployArgs(["node", "script", "--preflight-only", "base-sepolia"])).toEqual({
      networkId: "base-sepolia",
      preflightOnly: true,
      adopt: false,
    });
  });

  it("parses --adopt with optional --preflight-only in either order", () => {
    expect(parseDeployArgs(["node", "script", "base-sepolia", "--adopt"])).toEqual({
      networkId: "base-sepolia",
      preflightOnly: false,
      adopt: true,
    });
    expect(parseDeployArgs(["node", "script", "--adopt", "base-sepolia", "--preflight-only"])).toEqual({
      networkId: "base-sepolia",
      preflightOnly: true,
      adopt: true,
    });
    expect(parseDeployArgs(["node", "script", "--preflight-only", "--adopt", "base-sepolia"])).toEqual({
      networkId: "base-sepolia",
      preflightOnly: true,
      adopt: true,
    });
  });
});

describe("readNetworkOverlay", () => {
  it("returns null for missing file contents", () => {
    expect(readNetworkOverlay(null, FORTEL2)).toBeNull();
    expect(readNetworkOverlay(undefined, FORTEL2)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(readNetworkOverlay("{not json", FORTEL2)).toBeNull();
  });

  it("extracts the network slice", () => {
    const json = overlayJson({ withMmf: false });
    const slice = readNetworkOverlay(json, FORTEL2);
    expect(slice?.contracts?.PaymentSettlement).toBe(SETTLEMENT);
    expect(slice?.contracts?.TokenizedMMF).toBeUndefined();
  });
});

describe("decideDeployMode", () => {
  it("selects full when no overlay exists", () => {
    expect(decideDeployMode(null)).toEqual({
      mode: "full",
      reason: "no overlay — fresh full deploy",
    });
  });

  it("selects full when overlay lacks settlement or mockUSDC", () => {
    expect(decideDeployMode({ contracts: { tokens: { mockUSDC: { address: USDC } } } })).toEqual({
      mode: "full",
      reason: "overlay incomplete — missing PaymentSettlement or mockUSDC",
    });
    expect(decideDeployMode({ contracts: { PaymentSettlement: SETTLEMENT } })).toEqual({
      mode: "full",
      reason: "overlay incomplete — missing PaymentSettlement or mockUSDC",
    });
  });

  it("selects mmf_addon for pre-F4 overlay (settlement + tokens, no fund)", () => {
    const slice = readNetworkOverlay(overlayJson({ withMmf: false }), FORTEL2);
    expect(decideDeployMode(slice)).toEqual({
      mode: "mmf_addon",
      reason: "PaymentSettlement + tokens present, TokenizedMMF missing — MMF add-on",
    });
  });

  it("selects noop when TokenizedMMF is already recorded", () => {
    const slice = readNetworkOverlay(overlayJson({ withMmf: true }), FORTEL2);
    expect(decideDeployMode(slice)).toEqual({
      mode: "noop",
      reason: "TokenizedMMF already present in overlay",
      mmfAddress: MMF,
    });
  });
});

describe("validateDeployerKey", () => {
  it("rejects missing or malformed keys", () => {
    expect(validateDeployerKey(undefined, CFG).ok).toBe(false);
    expect(validateDeployerKey("deadbeef", CFG).ok).toBe(false);
  });

  it("accepts a 0x-prefixed key", () => {
    expect(validateDeployerKey("0x" + "11".repeat(32), CFG)).toEqual({ ok: true });
  });
});

describe("validateChainId", () => {
  it("fails closed when RPC is unreachable", () => {
    const result = validateChainId(null, CFG, "http://127.0.0.1:9545");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not reachable/);
  });

  it("fails on chain id mismatch", () => {
    const result = validateChainId(84532, CFG, "http://127.0.0.1:9545");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Expected chainId 852/);
  });

  it("passes when chain id matches", () => {
    expect(validateChainId(852, CFG, "http://127.0.0.1:9545")).toEqual({ ok: true, chainId: 852 });
  });
});

describe("validateDeployerBalance", () => {
  it("rejects balance below minimum", () => {
    const result = validateDeployerBalance(1n, CFG, DEPLOYER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/balance too low/);
  });

  it("accepts balance at or above minimum", () => {
    expect(validateDeployerBalance(CFG.minDeployerBalance, CFG, DEPLOYER)).toEqual({ ok: true });
    expect(validateDeployerBalance(parseEther("1"), CFG, DEPLOYER)).toEqual({ ok: true });
  });
});

describe("runPreflightChecks", () => {
  const goodKey = "0x" + "11".repeat(32);

  it("returns first failure (missing key before RPC)", () => {
    const result = runPreflightChecks({
      deployerKey: undefined,
      onchainId: null,
      balance: 0n,
      deployerAddr: DEPLOYER,
      cfg: CFG,
      rpcUrl: "http://127.0.0.1:9545",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/DEPLOYER_PRIVATE_KEY/);
  });

  it("returns RPC failure when key is valid", () => {
    const result = runPreflightChecks({
      deployerKey: goodKey,
      onchainId: null,
      balance: parseEther("1"),
      deployerAddr: DEPLOYER,
      cfg: CFG,
      rpcUrl: "http://127.0.0.1:9545",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not reachable/);
  });

  it("passes when all checks succeed", () => {
    expect(
      runPreflightChecks({
        deployerKey: goodKey,
        onchainId: 852,
        balance: parseEther("0.1"),
        deployerAddr: DEPLOYER,
        cfg: CFG,
        rpcUrl: "http://127.0.0.1:9545",
      })
    ).toEqual({ ok: true });
  });
});

describe("describePlannedActions", () => {
  it("lists full-deploy steps", () => {
    const lines = describePlannedActions("full", FORTEL2, null);
    expect(lines[0]).toBe("Deploy mode: full");
    expect(lines.some((l) => l.includes("PaymentSettlement"))).toBe(true);
    expect(lines.some((l) => l.includes("deployments.fortel2-sepolia.json"))).toBe(true);
  });

  it("lists MMF add-on steps without redeploying escrow", () => {
    const slice = readNetworkOverlay(overlayJson({ withMmf: false }), FORTEL2);
    const lines = describePlannedActions("mmf_addon", FORTEL2, slice);
    expect(lines[0]).toBe("Deploy mode: mmf_addon");
    expect(lines.some((l) => l.includes("Reuse existing PaymentSettlement"))).toBe(true);
    expect(lines.some((l) => l.includes("Deploy TokenizedMMF only"))).toBe(true);
    expect(lines.some((l) => l.includes("Merge TokenizedMMF"))).toBe(true);
    // Must not claim per-step idempotency the helpers do not deliver (T2-2 / R3).
    expect(lines.some((l) => /if not already/i.test(l))).toBe(false);
  });

  it("states no-op when fund already present", () => {
    const slice = readNetworkOverlay(overlayJson({ withMmf: true }), FORTEL2);
    const lines = describePlannedActions("noop", FORTEL2, slice);
    expect(lines.some((l) => l.includes("no transactions"))).toBe(true);
  });

  it("lists adopt steps without redeploying escrow/tokens", () => {
    const adoptable = ADOPTABLE_NETWORKS[BASE];
    const lines = describePlannedActions("adopt", BASE, null, { needsMmf: true, adoptable });
    expect(lines[0]).toBe("Deploy mode: adopt");
    expect(lines.some((l) => l.includes("Do NOT deploy PaymentSettlement or MockERC20"))).toBe(true);
    expect(lines.some((l) => l.includes("Generate NEW treasury"))).toBe(true);
    expect(lines.some((l) => l.includes("Deploy TokenizedMMF (adopted registry has none)"))).toBe(true);
    expect(lines.some((l) => /Deploy MockERC20 tokens/.test(l))).toBe(false);
  });
});

describe("MMF add-on idempotency helpers", () => {
  it("skips buffer mint when balance meets target", () => {
    expect(mmfYieldBufferSatisfied(MMF_YIELD_BUFFER - 1n)).toBe(false);
    expect(mmfYieldBufferSatisfied(MMF_YIELD_BUFFER)).toBe(true);
    expect(mmfYieldBufferSatisfied(MMF_YIELD_BUFFER + 1n)).toBe(true);
  });

  it("skips treasury approve when allowance is already MAX-scale", () => {
    expect(treasuryMmfApprovalSatisfied(0n)).toBe(false);
    expect(treasuryMmfApprovalSatisfied(MMF_YIELD_BUFFER)).toBe(false);
    expect(treasuryMmfApprovalSatisfied(MAX_UINT256 / 2n)).toBe(true);
    expect(treasuryMmfApprovalSatisfied(MAX_UINT256)).toBe(true);
  });
});

describe("resolveAddonTreasuryKey (T5-5)", () => {
  it("prefers the overlay inline key and binds it to the recorded address", () => {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const envPk = generatePrivateKey();
    const resolved = resolveAddonTreasuryKey(
      { address, privateKey: pk },
      { TREASURY_PRIVATE_KEY: envPk }
    );
    expect(resolved).toEqual({ ok: true, key: pk, address });
  });

  it("falls back to env when the overlay has only privateKeyEnv", () => {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const resolved = resolveAddonTreasuryKey(
      { address, privateKeyEnv: "TREASURY_PRIVATE_KEY" },
      { TREASURY_PRIVATE_KEY: pk }
    );
    expect(resolved).toEqual({ ok: true, key: pk, address });
  });

  it("fails closed when the env key does not derive the overlay treasury address", () => {
    const overlayPk = generatePrivateKey();
    const address = privateKeyToAccount(overlayPk).address;
    const wrongPk = generatePrivateKey();
    const resolved = resolveAddonTreasuryKey(
      { address, privateKeyEnv: "TREASURY_PRIVATE_KEY" },
      { TREASURY_PRIVATE_KEY: wrongPk }
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toMatch(/does not match overlay treasury address/);
  });

  it("fails closed when no key is available", () => {
    const resolved = resolveAddonTreasuryKey(
      { address: "0x6666666666666666666666666666666666666666" },
      {}
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toMatch(/TREASURY_PRIVATE_KEY is not set/);
  });
});

describe("adopt mode helpers (J1)", () => {
  const baseAdoptable = ADOPTABLE_NETWORKS[BASE];

  it("registers Base Sepolia adoptable addresses (inherited settlement + tokens)", () => {
    expect(baseAdoptable.operator.toLowerCase()).toBe(DEPLOYER.toLowerCase());
    expect(baseAdoptable.contracts.PaymentSettlement).toBe(
      "0x9d8b8b7c476ab02306046f3da719d380fa0456aa"
    );
    expect(baseAdoptable.contracts.tokens.mockUSDC.decimals).toBe(6);
    expect(baseAdoptable.contracts.tokens.mockJPY.decimals).toBe(0);
    expect(baseAdoptable.contracts.TokenizedMMF).toBeUndefined();
  });

  it("lists contract addresses to bytecode-verify (excludes operator EOA)", () => {
    const listed = listAdoptContractAddresses(baseAdoptable);
    expect(listed.map((e) => e.label).sort()).toEqual(
      ["PaymentSettlement", "mockJPY", "mockSGD", "mockUSDC"].sort()
    );
    expect(listed.every((e) => e.address.startsWith("0x"))).toBe(true);
  });

  it("includes TokenizedMMF in the verify list when the registry carries one", () => {
    const withMmf = {
      operator: DEPLOYER,
      contracts: {
        PaymentSettlement: SETTLEMENT,
        TokenizedMMF: MMF,
        tokens: { mockUSDC: { address: USDC, decimals: 6 } },
      },
    };
    expect(listAdoptContractAddresses(withMmf).some((e) => e.label === "TokenizedMMF")).toBe(true);
    expect(adoptNeedsMmf(withMmf)).toBe(false);
  });

  it("detects pre-F4 registries need an MMF add-on", () => {
    expect(adoptNeedsMmf(baseAdoptable)).toBe(true);
    expect(adoptNeedsMmf({ contracts: { TokenizedMMF: MMF } })).toBe(false);
  });

  it("evaluateAdoptBytecode aborts on empty code and names the address", () => {
    const result = evaluateAdoptBytecode(
      [
        { label: "PaymentSettlement", address: SETTLEMENT, code: "0x60806040" },
        { label: "mockJPY", address: JPY, code: "0x" },
        { label: "mockSGD", address: SGD, code: null },
      ],
      BASE
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/mockJPY/);
      expect(result.message).toMatch(/mockSGD/);
      expect(result.message).toMatch(/Adopt aborted/);
    }
    expect(result.results.find((r) => r.label === "PaymentSettlement")?.bytes).toBe(4);
  });

  it("evaluateAdoptBytecode passes when every address has code", () => {
    const result = evaluateAdoptBytecode(
      [
        { label: "PaymentSettlement", address: SETTLEMENT, code: "0x" + "ab".repeat(100) },
        { label: "mockUSDC", address: USDC, code: "0x" + "cd".repeat(50) },
      ],
      BASE
    );
    expect(result.ok).toBe(true);
    expect(result.results.every((r) => r.bytes > 0)).toBe(true);
  });

  it("decideAdoptPlan refuses unknown networks and existing overlays", () => {
    expect(
      decideAdoptPlan({
        networkId: FORTEL2,
        overlayExists: false,
        deployerAddress: DEPLOYER,
        adoptable: null,
      }).ok
    ).toBe(false);

    const existing = decideAdoptPlan({
      networkId: BASE,
      overlayExists: true,
      deployerAddress: DEPLOYER,
      adoptable: baseAdoptable,
    });
    expect(existing.ok).toBe(false);
    if (!existing.ok) expect(existing.message).toMatch(/already exists/);
  });

  it("decideAdoptPlan refuses a deployer that is not the recorded operator", () => {
    const wrong = decideAdoptPlan({
      networkId: BASE,
      overlayExists: false,
      deployerAddress: "0x0000000000000000000000000000000000000001",
      adoptable: baseAdoptable,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.message).toMatch(/not the on-chain operator/);
  });

  it("decideAdoptPlan selects adopt + needsMmf for Base Sepolia", () => {
    expect(
      decideAdoptPlan({
        networkId: BASE,
        overlayExists: false,
        deployerAddress: DEPLOYER,
        adoptable: baseAdoptable,
      })
    ).toEqual({
      ok: true,
      mode: "adopt",
      needsMmf: true,
      reason:
        "adopt known contracts + generate new wallets; TokenizedMMF missing — MMF add-on after overlay",
    });
  });

  it("without --adopt, missing overlay still decides full (the redeploy trap)", () => {
    // Guardrail: adopt is opt-in. Auto-detect must keep choosing full when
    // there is no overlay — that is why --adopt exists.
    expect(decideDeployMode(null).mode).toBe("full");
  });
});
