// T2: unit coverage for scripts/deploy-testnet.mjs preflight helpers and the
// auto-detected deploy-mode decision (full / mmf_addon / noop). No live RPC.

import { describe, it, expect } from "vitest";
import { parseEther } from "viem";
import {
  NETWORK_CONFIGS,
  MMF_YIELD_BUFFER,
  MAX_UINT256,
  parseDeployArgs,
  readNetworkOverlay,
  decideDeployMode,
  validateDeployerKey,
  validateChainId,
  validateDeployerBalance,
  runPreflightChecks,
  describePlannedActions,
  mmfYieldBufferSatisfied,
  treasuryMmfApprovalSatisfied,
} from "../../scripts/deploy-testnet.mjs";

const FORTEL2 = "fortel2-sepolia";
const CFG = NETWORK_CONFIGS[FORTEL2];
const DEPLOYER = "0x5128889F20Ec13e0Be38b2BeBC568594159B652d";
const SETTLEMENT = "0x1111111111111111111111111111111111111111";
const MMF = "0x2222222222222222222222222222222222222222";
const USDC = "0x3333333333333333333333333333333333333333";

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
    });
  });

  it("parses --preflight-only after network", () => {
    expect(parseDeployArgs(["node", "script", "fortel2-sepolia", "--preflight-only"])).toEqual({
      networkId: "fortel2-sepolia",
      preflightOnly: true,
    });
  });

  it("parses --preflight-only before network", () => {
    expect(parseDeployArgs(["node", "script", "--preflight-only", "base-sepolia"])).toEqual({
      networkId: "base-sepolia",
      preflightOnly: true,
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
  });

  it("states no-op when fund already present", () => {
    const slice = readNetworkOverlay(overlayJson({ withMmf: true }), FORTEL2);
    const lines = describePlannedActions("noop", FORTEL2, slice);
    expect(lines.some((l) => l.includes("no transactions"))).toBe(true);
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
