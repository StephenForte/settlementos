// Deploy SettlementOS contracts to a REAL live network (Base Sepolia, Polygon
// Amoy, or ForteL2 Sepolia — pick via argv, each wired up as an npm script).
//
//   1. Deploys MockERC20 tokens + PaymentSettlement + TokenizedMMF using
//      DEPLOYER_PRIVATE_KEY (the deployer doubles as the settlement operator).
//   2. Generates local entity wallets + a treasury wallet (reused across re-runs)
//      and funds them with dust gas from the deployer. Entity wallets are NOT
//      pre-approved: the executor approves each payment's exact amount before
//      escrowing it, so their gas dust must cover an approve per payment.
//   3. Mints demo token balances (same distribution as the local chains) and the
//      MMF yield buffer, then has the treasury approve the fund (see step below).
//   4. Writes chain/deployments.<network>.json (gitignored — contains the
//      generated dust-wallet keys; the funded deployer key stays in .env only).
//   5. Registers the entity wallets in the app database (if entities are seeded).
//
// When an overlay already has PaymentSettlement + tokens but no TokenizedMMF
// (e.g. fortel2-sepolia deployed before F4), the script auto-selects MMF add-on
// mode: deploy only the fund, mint its yield buffer, treasury MAX-approve, and
// merge TokenizedMMF into the existing overlay without touching escrow/tokens.
// A re-run when TokenizedMMF is already present is a no-op.
//
// --adopt re-homes a live network whose overlay (and therefore its generated
// treasury/entity keys) was lost, while the contracts and DEPLOYER_PRIVATE_KEY
// survived. It never deploys PaymentSettlement or MockERC20 — those addresses
// come from ADOPTABLE_NETWORKS, and each is bytecode-verified on-chain before
// any wallet is generated. New treasury + entity wallets are minted (the old
// ones cannot sign), funded with gas dust, and demo-minted; if the adopted
// registry has no TokenizedMMF the existing MMF add-on path runs afterward.
//
//   node scripts/deploy-testnet.mjs <network> [--preflight-only] [--adopt]
//                                              [--force-full-deploy]
//
// --preflight-only runs RPC/chain-id/balance checks and prints the planned mode
// and actions without sending any transactions. With --adopt it also fetches
// bytecode for every registered address and aborts on empty code.
// A bare full deploy against a network in ADOPTABLE_NETWORKS with no overlay is
// refused (those contracts are already live) — use --adopt, or type
// --force-full-deploy deliberately if a genuine fresh deploy is intended.
//
// Run: npm run deploy:base-sepolia | deploy:polygon-amoy | deploy:fortel2-sepolia
//      (all load .env via node --env-file)
// Requires: DEPLOYER_PRIVATE_KEY in .env, funded with the network's native gas
//           token (same key works on every EVM chain).
// Optional: <NETWORK>_RPC_URL override, TREASURY_PRIVATE_KEY (default:
//           generated + stored in the JSON above).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain, formatEther, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// Gas-dust targets are per network: Base Sepolia gas is fractions of a gwei,
// while Polygon Amoy enforces a ~30 gwei floor (~100× pricier per tx), so Amoy
// targets are proportionally higher. Top-ups only happen when below target.
export const NETWORK_CONFIGS = {
  "base-sepolia": {
    chainId: 84532,
    name: "Base Sepolia",
    currency: "ETH",
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
    defaultRpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    entityGasTarget: parseEther("0.0002"),
    treasuryGasTarget: parseEther("0.001"),
    minDeployerBalance: parseEther("0.005"),
    funding: [
      "  https://portal.cdp.coinbase.com/products/faucet  (Coinbase, free)",
      "  https://www.alchemy.com/faucets/base-sepolia",
    ],
  },
  "polygon-amoy": {
    chainId: 80002,
    name: "Polygon Amoy",
    currency: "POL",
    rpcEnv: "POLYGON_AMOY_RPC_URL",
    defaultRpc: "https://rpc-amoy.polygon.technology",
    explorer: "https://amoy.polygonscan.com",
    entityGasTarget: parseEther("0.02"),
    treasuryGasTarget: parseEther("0.05"),
    minDeployerBalance: parseEther("0.4"),
    funding: [
      "  https://faucet.polygon.technology  (official)",
      "  https://www.alchemy.com/faucets/polygon-amoy",
    ],
  },
  // ForteL2 has no faucet and no explorer: L2 ETH arrives via an L1→L2 deposit
  // through the Sepolia Standard Bridge, and tx logs print raw hashes. Gas is
  // sub-gwei (quiet OP Stack chain), so dust targets mirror Base Sepolia.
  "fortel2-sepolia": {
    chainId: 852,
    name: "ForteL2 Sepolia",
    currency: "ETH",
    rpcEnv: "FORTEL2_SEPOLIA_RPC_URL",
    defaultRpc: "http://127.0.0.1:9545",
    explorer: null,
    entityGasTarget: parseEther("0.0002"),
    treasuryGasTarget: parseEther("0.001"),
    minDeployerBalance: parseEther("0.005"),
    funding: [
      "  No faucet — bridge from Sepolia L1: send ETH from the deployer to the",
      "  OptimismPortalProxy (0xb4679b1c65e5c07bac95988583c2d7a65108c624); the same",
      "  amount mints to the deployer on L2 852 once derivation catches up",
      "  (see ForteL2 deposit-eth-sepolia.sh / deployments/rail-interface.json).",
    ],
  },
};

export const TOKENS = [
  ["Mock USD Coin", "mockUSDC", 6],
  ["Mock JPY Token", "mockJPY", 0],
  ["Mock SGD Token", "mockSGD", 6],
];

// Pre-funded mockUSDC held by the MMF to pay simulated yield on redemption —
// accrual raises the redemption value without minting asset, so the yield is
// paid out of this buffer (mirrors scripts/setup.mjs + the test fixture).
export const MMF_YIELD_BUFFER = 50_000n * 10n ** 6n;
// The treasury is the platform's own parking account, so its approval to the
// fund stays MAX (unlike entity → escrow allowances, which are exact per payment).
export const MAX_UINT256 = 2n ** 256n - 1n;

// externalId → demo profile (mirrors scripts/setup.mjs; wallet risk attributes
// drive the compliance demo the same way they do on the local chains).
const ENTITY_PROFILES = {
  ent_acme_us: { label: "ACME operating wallet", allowlisted: true, riskScore: 5 },
  ent_tokyo_supplier: { label: "Tokyo Trading settlement wallet", allowlisted: true, riskScore: 10 },
  ent_sg_supplier: { label: "SG Imports settlement wallet", allowlisted: true, riskScore: 8 },
  ent_osaka_parts: { label: "Osaka Parts wallet (unverified)", allowlisted: false, riskScore: 55 },
};

/**
 * Known live contract addresses that may be adopted when an overlay (and its
 * generated wallet keys) was lost but the deployer/operator key survived.
 * Network-generic: add an entry for a future ForteL2 re-genesis the same way.
 * TokenizedMMF is omitted when the original deploy predates F4 — adopt then
 * runs the MMF add-on path after writing the overlay.
 */
export const ADOPTABLE_NETWORKS = {
  "base-sepolia": {
    operator: "0x5128889F20Ec13e0Be38b2BeBC568594159B652d",
    contracts: {
      PaymentSettlement: "0x9d8b8b7c476ab02306046f3da719d380fa0456aa",
      tokens: {
        mockUSDC: { address: "0x2066738d535681d28d0841cc2503c1c531d4d6aa", decimals: 6 },
        mockJPY: { address: "0x7d7b168cfab3dba1afc41f6160e886ffe9997e63", decimals: 0 },
        mockSGD: { address: "0x0b6fa033c034d694e876b56f2dd8377a2be5691d", decimals: 6 },
      },
    },
  },
};

/** @typedef {"full" | "mmf_addon" | "noop" | "adopt"} DeployMode */

/**
 * Parse argv for network id, --preflight-only, --adopt, and --force-full-deploy.
 * @param {string[]} argv process.argv
 */
export function parseDeployArgs(argv) {
  const rest = argv.slice(2);
  const flags = new Set(["--preflight-only", "--adopt", "--force-full-deploy"]);
  const preflightOnly = rest.includes("--preflight-only");
  const adopt = rest.includes("--adopt");
  const forceFullDeploy = rest.includes("--force-full-deploy");
  const networkId = rest.find((a) => !flags.has(a));
  return { networkId, preflightOnly, adopt, forceFullDeploy };
}

/**
 * Read a live-network overlay slice for `networkId`, or null when missing.
 * @param {string | null | undefined} overlayJson raw file contents
 * @param {string} networkId
 */
export function readNetworkOverlay(overlayJson, networkId) {
  if (!overlayJson) return null;
  try {
    const data = JSON.parse(overlayJson);
    return data.networks?.[networkId] ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide deploy mode from an existing overlay slice (pure — no I/O).
 * Auto-detect: full deploy when absent or incomplete; MMF add-on when
 * PaymentSettlement + mockUSDC exist but TokenizedMMF does not; no-op when
 * TokenizedMMF is already recorded.
 * @param {Record<string, unknown> | null | undefined} networkOverlay
 * @returns {{ mode: DeployMode, reason: string, mmfAddress?: string }}
 */
export function decideDeployMode(networkOverlay) {
  if (!networkOverlay) {
    return { mode: "full", reason: "no overlay — fresh full deploy" };
  }

  const contracts = /** @type {Record<string, unknown> | undefined} */ (networkOverlay.contracts);
  const settlement = contracts?.PaymentSettlement;
  const tokens = /** @type {Record<string, { address?: string }> | undefined} */ (contracts?.tokens);
  const mockUsdc = tokens?.mockUSDC?.address;

  if (!settlement || !mockUsdc) {
    return { mode: "full", reason: "overlay incomplete — missing PaymentSettlement or mockUSDC" };
  }

  const mmf = contracts?.TokenizedMMF;
  if (typeof mmf === "string" && mmf.length > 0) {
    return {
      mode: "noop",
      reason: "TokenizedMMF already present in overlay",
      mmfAddress: mmf,
    };
  }

  return {
    mode: "mmf_addon",
    reason: "PaymentSettlement + tokens present, TokenizedMMF missing — MMF add-on",
  };
}

/**
 * @typedef {{
 *   operator: string,
 *   contracts: {
 *     PaymentSettlement?: string,
 *     TokenizedMMF?: string,
 *     tokens?: Record<string, { address?: string, decimals?: number }>
 *   }
 * }} AdoptableNetwork
 */

/**
 * Flatten an adoptable-network registry entry into labeled addresses that must
 * hold bytecode (operator is an EOA — verified separately, not for code).
 * @param {AdoptableNetwork} adoptable
 * @returns {{ label: string, address: string }[]}
 */
export function listAdoptContractAddresses(adoptable) {
  /** @type {{ label: string, address: string }[]} */
  const out = [];
  const contracts = adoptable?.contracts;
  if (!contracts) return out;
  if (typeof contracts.PaymentSettlement === "string") {
    out.push({ label: "PaymentSettlement", address: contracts.PaymentSettlement });
  }
  if (typeof contracts.TokenizedMMF === "string") {
    out.push({ label: "TokenizedMMF", address: contracts.TokenizedMMF });
  }
  const tokens = contracts.tokens ?? {};
  for (const [symbol, meta] of Object.entries(tokens)) {
    if (meta?.address) out.push({ label: symbol, address: meta.address });
  }
  return out;
}

/**
 * Pure bytecode gate: every registered contract address must return non-empty
 * code. Call this *before* writing an overlay or generating wallets.
 * @param {{ label: string, address: string, code: string | null | undefined }[]} entries
 * @param {string} networkId
 * @returns {{ ok: true, results: { label: string, address: string, bytes: number }[] } | { ok: false, message: string, results: { label: string, address: string, bytes: number }[] }}
 */
export function evaluateAdoptBytecode(entries, networkId) {
  const results = entries.map(({ label, address, code }) => {
    const bytes =
      code && code !== "0x" && code !== "0x0" ? Math.floor((code.length - 2) / 2) : 0;
    return { label, address, bytes };
  });
  const empty = results.filter((r) => r.bytes === 0);
  if (empty.length > 0) {
    const detail = empty
      .map((r) => `  ${r.label} ${r.address} — 0 bytes (no code on ${networkId})`)
      .join("\n");
    return {
      ok: false,
      message:
        `Adopt aborted: one or more addresses hold no bytecode on ${networkId}.\n` +
        detail +
        "\nRefuse to write an overlay pointing at empty addresses.",
      results,
    };
  }
  return { ok: true, results };
}

/**
 * True when the adoptable registry has no TokenizedMMF — adopt must deploy one
 * via the MMF add-on path after the overlay is written.
 * @param {AdoptableNetwork | { contracts?: { TokenizedMMF?: string } } | null | undefined} adoptable
 */
export function adoptNeedsMmf(adoptable) {
  const mmf = adoptable?.contracts?.TokenizedMMF;
  return !(typeof mmf === "string" && mmf.length > 0);
}

/**
 * Diagnose why an overlay resolves to a full-deploy state — file absent,
 * unreadable JSON, missing networks[id], or an incomplete slice. Pure; does
 * not change readNetworkOverlay. Used only to make refusal messages actionable.
 *
 * @param {{
 *   networkId: string,
 *   overlayFilePresent: boolean,
 *   overlayJson: string | null | undefined,
 *   networkOverlay: Record<string, unknown> | null | undefined
 * }} input
 */
export function diagnoseAdoptableOverlayFinding({
  networkId,
  overlayFilePresent,
  overlayJson,
  networkOverlay,
}) {
  if (!overlayFilePresent || overlayJson == null) {
    return "no overlay file present";
  }
  try {
    JSON.parse(overlayJson);
  } catch {
    return "overlay file present but unreadable (malformed JSON)";
  }
  if (networkOverlay == null) {
    return `overlay file present but missing networks[${networkId}]`;
  }
  const contracts = /** @type {Record<string, unknown> | undefined} */ (networkOverlay.contracts);
  const settlement = contracts?.PaymentSettlement;
  const tokens = /** @type {Record<string, { address?: string }> | undefined} */ (contracts?.tokens);
  const mockUsdc = tokens?.mockUSDC?.address;
  if (!settlement && !mockUsdc) {
    return "overlay slice present but incomplete (missing PaymentSettlement and mockUSDC)";
  }
  if (!settlement) {
    return "overlay slice present but incomplete (missing PaymentSettlement)";
  }
  if (!mockUsdc) {
    return "overlay slice present but incomplete (missing mockUSDC)";
  }
  return "overlay resolves to a full-deploy state";
}

/**
 * Refuse a bare full deploy on a network in ADOPTABLE_NETWORKS when the
 * *resolved* deploy mode would be "full". Gates on decideDeployMode's output —
 * not file existence — so a present-but-unreadable / incomplete overlay cannot
 * bypass the guard and redeploy live escrow/tokens at NEW addresses.
 * Escape hatch: --force-full-deploy (must be typed deliberately).
 *
 * @param {{
 *   networkId: string,
 *   mode: DeployMode | string,
 *   forceFullDeploy: boolean,
 *   overlayFilePresent?: boolean,
 *   overlayJson?: string | null,
 *   networkOverlay?: Record<string, unknown> | null,
 *   adoptableNetworks?: Record<string, AdoptableNetwork>
 * }} input
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function assertAdoptableFullDeployAllowed({
  networkId,
  mode,
  forceFullDeploy,
  overlayFilePresent = false,
  overlayJson = null,
  networkOverlay = null,
  adoptableNetworks = ADOPTABLE_NETWORKS,
}) {
  if (forceFullDeploy) return { ok: true };
  if (!adoptableNetworks[networkId]) return { ok: true };
  if (mode !== "full") return { ok: true };

  const finding = diagnoseAdoptableOverlayFinding({
    networkId,
    overlayFilePresent,
    overlayJson,
    networkOverlay,
  });
  return {
    ok: false,
    message:
      `${networkId} is registered in ADOPTABLE_NETWORKS (${finding}) — ` +
      `a bare full deploy would redeploy PaymentSettlement and tokens at NEW addresses, ` +
      `breaking the same-address property.\n` +
      `Use --adopt to re-home the live contracts into a fresh overlay, or pass ` +
      `--force-full-deploy if you deliberately intend a destructive fresh deploy.`,
  };
}

/**
 * Gate --adopt before any transaction: registry present, no existing overlay
 * (would overwrite live keys), deployer is the on-chain operator.
 * @param {{ networkId: string, overlayExists: boolean, deployerAddress: string, adoptable: AdoptableNetwork | null | undefined }} input
 * @returns {{ ok: true, mode: "adopt", needsMmf: boolean, reason: string } | { ok: false, message: string }}
 */
export function decideAdoptPlan({ networkId, overlayExists, deployerAddress, adoptable }) {
  if (!adoptable) {
    return {
      ok: false,
      message:
        `No adoptable contract registry for ${networkId}. ` +
        `Add an entry to ADOPTABLE_NETWORKS (or omit --adopt for a full deploy).`,
    };
  }
  if (overlayExists) {
    return {
      ok: false,
      message:
        `Overlay already exists for ${networkId} (chain/deployments.${networkId}.json). ` +
        `Adopt refuses to overwrite existing treasury/entity keys — move the file aside to re-adopt.`,
    };
  }
  const expected = adoptable.operator;
  if (!expected) {
    return { ok: false, message: `Adoptable registry for ${networkId} is missing operator` };
  }
  if (!deployerAddress || deployerAddress.toLowerCase() !== expected.toLowerCase()) {
    return {
      ok: false,
      message:
        `Deployer ${deployerAddress || "(none)"} is not the on-chain operator ${expected} ` +
        `for ${networkId}. Adopt keeps the original operator (re-keying needs an on-chain grant).`,
    };
  }
  const needsMmf = adoptNeedsMmf(adoptable);
  return {
    ok: true,
    mode: "adopt",
    needsMmf,
    reason: needsMmf
      ? "adopt known contracts + generate new wallets; TokenizedMMF missing — MMF add-on after overlay"
      : "adopt known contracts (including TokenizedMMF) + generate new wallets",
  };
}

/**
 * Validate DEPLOYER_PRIVATE_KEY is present and well-formed.
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateDeployerKey(deployerKey, cfg) {
  if (!deployerKey || !deployerKey.startsWith("0x")) {
    return {
      ok: false,
      message:
        "DEPLOYER_PRIVATE_KEY is not set in .env.\n" +
        `Generate a fresh key (never reuse a mainnet key) and fund it with ~${formatEther(
          cfg.minDeployerBalance
        )} ${cfg.currency} on ${cfg.name}:\n` +
        cfg.funding.join("\n"),
    };
  }
  return { ok: true };
}

/**
 * Validate on-chain chain id matches the network config.
 * @param {number | null} onchainId null when RPC unreachable
 * @returns {{ ok: true, chainId: number } | { ok: false, message: string }}
 */
export function validateChainId(onchainId, cfg, rpcUrl) {
  if (onchainId === null) {
    return { ok: false, message: `${cfg.name} RPC not reachable at ${rpcUrl}` };
  }
  if (onchainId !== cfg.chainId) {
    return {
      ok: false,
      message: `Expected chainId ${cfg.chainId} at ${rpcUrl}, found ${onchainId}`,
    };
  }
  return { ok: true, chainId: onchainId };
}

/**
 * Validate deployer native balance meets the minimum for deploy + dust funding.
 * @param {bigint} balance
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateDeployerBalance(balance, cfg, deployerAddr) {
  if (balance < cfg.minDeployerBalance) {
    return {
      ok: false,
      message:
        `Deployer balance too low (need ≥ ${formatEther(cfg.minDeployerBalance)} ${cfg.currency} for deploy + wallet funding).\n` +
        `Fund ${deployerAddr}:\n` +
        cfg.funding.join("\n"),
    };
  }
  return { ok: true };
}

/**
 * Run all preflight checks (pure except the caller supplies RPC-derived values).
 * @param {{ deployerKey?: string, onchainId: number | null, balance: bigint, deployerAddr: string, cfg: typeof NETWORK_CONFIGS[string], rpcUrl?: string }} input
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function runPreflightChecks({ deployerKey, onchainId, balance, deployerAddr, cfg, rpcUrl }) {
  const keyCheck = validateDeployerKey(deployerKey, cfg);
  if (!keyCheck.ok) return keyCheck;

  const resolvedRpc = rpcUrl ?? process.env[cfg.rpcEnv] ?? cfg.defaultRpc;
  const chainCheck = validateChainId(onchainId, cfg, resolvedRpc);
  if (!chainCheck.ok) return chainCheck;

  return validateDeployerBalance(balance, cfg, deployerAddr);
}

/**
 * Human-readable plan for --preflight-only and logging.
 * @param {DeployMode} mode
 * @param {string} networkId
 * @param {Record<string, unknown> | null | undefined} networkOverlay
 * @param {{ needsMmf?: boolean, adoptable?: typeof ADOPTABLE_NETWORKS[string] | null }} [opts]
 */
export function describePlannedActions(mode, networkId, networkOverlay, opts = {}) {
  const lines = [`Deploy mode: ${mode}`];
  switch (mode) {
    case "full":
      lines.push(
        "- Deploy MockERC20 tokens (mockUSDC, mockJPY, mockSGD)",
        "- Deploy PaymentSettlement + TokenizedMMF",
        "- Fund treasury/entity wallets with gas dust",
        "- Mint demo balances + MMF yield buffer (50,000 mockUSDC)",
        "- Treasury MAX-approve mockUSDC → TokenizedMMF",
        `- Write chain/deployments.${networkId}.json`,
        "- Register entity wallets in the database (if seeded)"
      );
      break;
    case "mmf_addon":
      // Wording is deliberate: helpers check the *fresh* fund address and are
      // always empty on a new deploy — mode-level idempotency only (T2-2 / R3).
      lines.push(
        `- Reuse existing PaymentSettlement (${networkOverlay?.contracts?.PaymentSettlement})`,
        `- Reuse existing mockUSDC (${networkOverlay?.contracts?.tokens?.mockUSDC?.address})`,
        "- Deploy TokenizedMMF only",
        "- Mint MMF yield buffer (50,000 mockUSDC) to the new fund",
        "- Treasury MAX-approve mockUSDC → TokenizedMMF",
        `- Merge TokenizedMMF into chain/deployments.${networkId}.json (other entries untouched)`
      );
      break;
    case "noop":
      lines.push(
        `- TokenizedMMF already recorded (${networkOverlay?.contracts?.TokenizedMMF}) — no transactions`
      );
      break;
    case "adopt": {
      const adoptable = opts.adoptable;
      const settlement = adoptable?.contracts?.PaymentSettlement;
      const usdc = adoptable?.contracts?.tokens?.mockUSDC?.address;
      const jpy = adoptable?.contracts?.tokens?.mockJPY?.address;
      const sgd = adoptable?.contracts?.tokens?.mockSGD?.address;
      const needsMmf = opts.needsMmf ?? adoptNeedsMmf(adoptable);
      lines.push(
        `- Verify on-chain bytecode for PaymentSettlement (${settlement})`,
        `- Verify on-chain bytecode for mockUSDC (${usdc}), mockJPY (${jpy}), mockSGD (${sgd})`,
        "- Keep deployer as operator (no re-key)",
        "- Generate NEW treasury + entity wallets (old overlay keys are gone)",
        "- Fund new wallets with gas dust (per-network targets)",
        "- Mint demo token balances to new wallets (permissionless MockERC20.mint)",
        "- Do NOT deploy PaymentSettlement or MockERC20",
        "- Do NOT grant standing entity→escrow allowances"
      );
      if (needsMmf) {
        lines.push(
          "- Deploy TokenizedMMF (adopted registry has none)",
          "- Mint MMF yield buffer (50,000 mockUSDC) to the new fund",
          "- Treasury MAX-approve mockUSDC → TokenizedMMF"
        );
      } else {
        lines.push(`- Reuse existing TokenizedMMF (${adoptable?.contracts?.TokenizedMMF})`);
      }
      lines.push(
        `- Write chain/deployments.${networkId}.json`,
        "- Register entity wallets in the database (if seeded)"
      );
      break;
    }
    default:
      break;
  }
  return lines;
}

/**
 * True when the MMF already holds at least the yield buffer (idempotent skip).
 * @param {bigint} balance mockUSDC balance of the fund address
 */
export function mmfYieldBufferSatisfied(balance) {
  return balance >= MMF_YIELD_BUFFER;
}

/**
 * True when treasury already granted a MAX-style approval (idempotent skip).
 * @param {bigint} allowance treasury → MMF mockUSDC allowance
 */
export function treasuryMmfApprovalSatisfied(allowance) {
  // Any prior MAX approve leaves allowance at or near MAX_UINT256.
  return allowance >= MAX_UINT256 / 2n;
}

/**
 * Resolve the treasury private key for an MMF add-on approve, binding it to the
 * overlay treasury address. Prefers an inline overlay key (source of truth for
 * the recorded address); falls back to env. A key that derives a different
 * address fails closed — approving from the wrong wallet while merging the
 * overlay would leave park() talking to an unapproved treasury (T5-5).
 *
 * @param {{ address?: string, privateKey?: string, privateKeyEnv?: string } | null | undefined} treasuryAccount
 * @param {Record<string, string | undefined>} [envBag]
 * @returns {{ ok: true, key: string, address: string } | { ok: false, message: string }}
 */
export function resolveAddonTreasuryKey(treasuryAccount, envBag = process.env) {
  if (!treasuryAccount?.address) {
    return { ok: false, message: "Overlay missing treasury account — cannot approve MMF" };
  }
  const envName = treasuryAccount.privateKeyEnv || "TREASURY_PRIVATE_KEY";
  const key = treasuryAccount.privateKey || envBag[envName];
  if (!key) {
    return {
      ok: false,
      message: `Overlay treasury has no privateKey and ${envName} is not set`,
    };
  }
  let derived;
  try {
    derived = privateKeyToAccount(/** @type {`0x${string}`} */ (key)).address;
  } catch {
    return { ok: false, message: "Treasury private key is malformed" };
  }
  if (derived.toLowerCase() !== treasuryAccount.address.toLowerCase()) {
    return {
      ok: false,
      message:
        `Treasury key does not match overlay treasury address ${treasuryAccount.address} ` +
        `(derived ${derived})`,
    };
  }
  return { ok: true, key, address: treasuryAccount.address };
}

function artifact(name) {
  const p = path.join(root, "chain", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function fail(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
}

async function main() {
  const { networkId: NETWORK_ID, preflightOnly, adopt, forceFullDeploy } = parseDeployArgs(
    process.argv
  );
  const CFG = NETWORK_CONFIGS[NETWORK_ID];
  if (!CFG) {
    console.error(
      `Usage: node scripts/deploy-testnet.mjs <network> [--preflight-only] [--adopt] [--force-full-deploy]\nSupported: ${Object.keys(NETWORK_CONFIGS).join(", ")}`
    );
    process.exit(1);
  }

  const RPC_URL = process.env[CFG.rpcEnv] || CFG.defaultRpc;
  const EXPLORER = CFG.explorer;
  const txLink = (hash) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : hash);
  const addressLink = (addr) => (EXPLORER ? `${EXPLORER}/address/${addr}` : addr);
  const OUT_PATH = path.join(root, "chain", `deployments.${NETWORK_ID}.json`);

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const deployerAddr = deployerKey?.startsWith("0x")
    ? privateKeyToAccount(deployerKey).address
    : "0x0000000000000000000000000000000000000000";

  const chain = defineChain({
    id: CFG.chainId,
    name: CFG.name,
    nativeCurrency: { name: CFG.currency, symbol: CFG.currency, decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletFor = (pk) =>
    createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(pk) });

  const onchainId = await publicClient.getChainId().catch(() => null);
  const balance =
    onchainId !== null && deployerKey?.startsWith("0x")
      ? await publicClient.getBalance({ address: deployerAddr })
      : 0n;

  const preflight = runPreflightChecks({
    deployerKey,
    onchainId,
    balance,
    deployerAddr,
    cfg: CFG,
  });
  if (!preflight.ok) fail(preflight.message);

  const overlayExists = fs.existsSync(OUT_PATH);
  const overlayJson = overlayExists ? fs.readFileSync(OUT_PATH, "utf8") : null;
  const networkOverlay = readNetworkOverlay(overlayJson, NETWORK_ID);

  /** @type {DeployMode} */
  let mode;
  /** @type {string} */
  let reason;
  /** @type {boolean | undefined} */
  let needsMmf;
  /** @type {typeof ADOPTABLE_NETWORKS[string] | undefined} */
  let adoptable;

  if (adopt) {
    adoptable = ADOPTABLE_NETWORKS[NETWORK_ID];
    const planDecision = decideAdoptPlan({
      networkId: NETWORK_ID,
      overlayExists,
      deployerAddress: deployerAddr,
      adoptable,
    });
    if (!planDecision.ok) fail(planDecision.message);
    mode = planDecision.mode;
    reason = planDecision.reason;
    needsMmf = planDecision.needsMmf;

    // Bytecode verification is part of adopt preflight — fail before any plan
    // that would write empty addresses into an overlay.
    const toCheck = listAdoptContractAddresses(adoptable);
    const withCode = [];
    for (const { label, address } of toCheck) {
      const code = await publicClient.getBytecode({ address: /** @type {`0x${string}`} */ (address) });
      withCode.push({ label, address, code });
    }
    const codeCheck = evaluateAdoptBytecode(withCode, NETWORK_ID);
    console.log("\nOn-chain bytecode verification:");
    for (const r of codeCheck.results) {
      console.log(`  ${r.label} ${r.address} — ${r.bytes} bytes — ${r.bytes > 0 ? "ok" : "EMPTY"}`);
    }
    if (!codeCheck.ok) fail(codeCheck.message);
  } else {
    // Resolve mode first, then refuse if an adoptable network would full-deploy.
    // Gate on the resolved mode (not file existence) so a present-but-invalid
    // overlay cannot bypass the guard. --force-full-deploy is the only escape.
    const decided = decideDeployMode(networkOverlay);
    const fullGuard = assertAdoptableFullDeployAllowed({
      networkId: NETWORK_ID,
      mode: decided.mode,
      forceFullDeploy,
      overlayFilePresent: overlayExists,
      overlayJson,
      networkOverlay,
    });
    if (!fullGuard.ok) fail(fullGuard.message);

    mode = decided.mode;
    reason = decided.reason;
  }

  console.log(`\n${CFG.name} (${NETWORK_ID}) — ${reason}`);
  const plan = describePlannedActions(mode, NETWORK_ID, networkOverlay, { needsMmf, adoptable });
  for (const line of plan) console.log(line);

  if (preflightOnly) {
    console.log("\n--preflight-only: no transactions sent.");
    return;
  }

  if (mode === "adopt") {
    await runAdopt({
      NETWORK_ID,
      CFG,
      OUT_PATH,
      RPC_URL,
      EXPLORER,
      deployerKey,
      publicClient,
      walletFor,
      txLink,
      addressLink,
      adoptable,
      needsMmf: !!needsMmf,
    });
    return;
  }

  if (mode === "noop") {
    console.log("\nNothing to do — overlay already includes TokenizedMMF.");
    return;
  }

  if (mode === "mmf_addon") {
    await runMmfAddon({
      NETWORK_ID,
      CFG,
      OUT_PATH,
      overlayJson,
      networkOverlay,
      deployerKey,
      publicClient,
      walletFor,
      txLink,
      addressLink,
    });
    return;
  }

  await runFullDeploy({
    NETWORK_ID,
    CFG,
    OUT_PATH,
    RPC_URL,
    EXPLORER,
    deployerKey,
    publicClient,
    walletFor,
    txLink,
    addressLink,
  });
}

/**
 * Adopt known live contracts into a fresh overlay with new signable wallets.
 * Never deploys PaymentSettlement or MockERC20. Deploys TokenizedMMF only when
 * the adoptable registry omits it (pre-F4 networks).
 */
async function runAdopt({
  NETWORK_ID,
  CFG,
  OUT_PATH,
  RPC_URL,
  EXPLORER,
  deployerKey,
  publicClient,
  walletFor,
  txLink,
  addressLink,
  adoptable,
  needsMmf,
}) {
  const deployer = walletFor(deployerKey);
  const deployerAddr = deployer.account.address;
  const balance = await publicClient.getBalance({ address: deployerAddr });
  console.log(`Deployer ${deployerAddr} — ${formatEther(balance)} ${CFG.currency} on ${CFG.name}`);

  // Always generate fresh keys — the lost overlay's addresses cannot sign, and
  // their mock balances are worthless (mint is permissionless). Never reuse,
  // recover, or sweep old treasury/entity addresses.
  const treasuryEnvKey = process.env.TREASURY_PRIVATE_KEY;
  const treasuryKey = treasuryEnvKey || generatePrivateKey();
  const treasuryAddr = privateKeyToAccount(treasuryKey).address;

  const entityWallets = {};
  for (const [externalId, profile] of Object.entries(ENTITY_PROFILES)) {
    const pk = generatePrivateKey();
    entityWallets[externalId] = {
      privateKey: pk,
      address: privateKeyToAccount(pk).address,
      profile,
    };
  }

  console.log("\nNew wallets (addresses only — keys written to overlay, not logged):");
  console.log(`  treasury ${treasuryAddr}`);
  for (const [id, w] of Object.entries(entityWallets)) {
    console.log(`  ${id} ${w.address}`);
  }

  async function send(fn, label) {
    const hash = await fn();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") fail(`${label} reverted: ${txLink(hash)}`);
    console.log(`  ${label} → ${txLink(hash)}`);
    return { hash, receipt };
  }

  console.log("\nFunding role wallets with gas dust:");
  const fundTargets = [
    { label: "treasury", address: treasuryAddr, target: CFG.treasuryGasTarget },
    ...Object.entries(entityWallets).map(([id, w]) => ({
      label: id,
      address: w.address,
      target: CFG.entityGasTarget,
    })),
  ];
  for (const t of fundTargets) {
    const bal = await publicClient.getBalance({ address: t.address });
    if (bal >= t.target) {
      console.log(`  ${t.label} ${t.address} already funded (${formatEther(bal)} ${CFG.currency})`);
      continue;
    }
    await send(
      () => deployer.sendTransaction({ to: t.address, value: t.target - bal }),
      `fund ${t.label} ${t.address}`
    );
  }

  const tokenArt = artifact("MockERC20");
  const tokenAbi = tokenArt.abi;
  const tokens = adoptable.contracts.tokens;
  const settlementAddress = adoptable.contracts.PaymentSettlement;

  // Same demo balance distribution as the full deploy / local chains.
  console.log("\nMinting demo balances to new wallets:");
  const mints = [
    ["mockUSDC", entityWallets.ent_acme_us.address, 1_000_000n * 10n ** 6n, "ACME 1,000,000 mockUSDC"],
    ["mockUSDC", treasuryAddr, 500_000n * 10n ** 6n, "treasury 500,000 mockUSDC"],
    ["mockJPY", treasuryAddr, 100_000_000n, "treasury 100,000,000 mockJPY"],
    ["mockSGD", treasuryAddr, 1_000_000n * 10n ** 6n, "treasury 1,000,000 mockSGD"],
    ["mockSGD", entityWallets.ent_sg_supplier.address, 200_000n * 10n ** 6n, "SG Imports 200,000 mockSGD"],
    ["mockJPY", entityWallets.ent_tokyo_supplier.address, 10_000_000n, "Tokyo 10,000,000 mockJPY"],
  ];
  for (const [symbol, to, amount, label] of mints) {
    await send(
      () =>
        deployer.writeContract({
          address: tokens[symbol].address,
          abi: tokenAbi,
          functionName: "mint",
          args: [to, amount],
        }),
      `mint ${label}`
    );
  }

  // No entity→escrow approvals — exact per-payment allowance at execute time.

  let mmfAddress = typeof adoptable.contracts.TokenizedMMF === "string" ? adoptable.contracts.TokenizedMMF : null;
  let approvalTxHash = null;

  if (needsMmf) {
    console.log("\nDeploying TokenizedMMF (adopt add-on):");
    const mmfArt = artifact("TokenizedMMF");
    const mmfHash = await deployer.deployContract({
      abi: mmfArt.abi,
      bytecode: mmfArt.bytecode,
      args: [tokens.mockUSDC.address],
    });
    const mmfReceipt = await publicClient.waitForTransactionReceipt({ hash: mmfHash });
    if (mmfReceipt.status !== "success") fail(`TokenizedMMF deploy reverted: ${txLink(mmfHash)}`);
    mmfAddress = mmfReceipt.contractAddress;
    console.log(`  TokenizedMMF → ${addressLink(mmfAddress)}`);
  } else {
    console.log(`\nReusing adopted TokenizedMMF → ${addressLink(mmfAddress)}`);
  }

  const mmfUsdcBalance = await publicClient.readContract({
    address: tokens.mockUSDC.address,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [mmfAddress],
  });

  if (mmfYieldBufferSatisfied(mmfUsdcBalance)) {
    console.log(
      `\nMMF yield buffer already funded (${mmfUsdcBalance.toString()} base units ≥ ${MMF_YIELD_BUFFER.toString()}) — skip mint`
    );
  } else {
    console.log("\nMinting MMF yield buffer:");
    await send(
      () =>
        deployer.writeContract({
          address: tokens.mockUSDC.address,
          abi: tokenAbi,
          functionName: "mint",
          args: [mmfAddress, MMF_YIELD_BUFFER],
        }),
      "mint MMF yield buffer 50,000 mockUSDC"
    );
  }

  const allowance = await publicClient.readContract({
    address: tokens.mockUSDC.address,
    abi: tokenAbi,
    functionName: "allowance",
    args: [treasuryAddr, mmfAddress],
  });

  if (treasuryMmfApprovalSatisfied(allowance)) {
    console.log(`\nTreasury already approved mockUSDC → TokenizedMMF — skip approve`);
  } else {
    console.log("\nApproving the MMF as treasury:");
    const treasuryWallet = walletFor(treasuryKey);
    const { hash } = await send(
      () =>
        treasuryWallet.writeContract({
          address: tokens.mockUSDC.address,
          abi: tokenAbi,
          functionName: "approve",
          args: [mmfAddress, MAX_UINT256],
        }),
      "treasury approve mockUSDC → TokenizedMMF"
    );
    approvalTxHash = hash;
  }

  const deployments = {
    networks: {
      [NETWORK_ID]: {
        chainId: CFG.chainId,
        rpcUrl: RPC_URL,
        ...(EXPLORER ? { explorerUrl: EXPLORER } : {}),
        contracts: {
          PaymentSettlement: settlementAddress,
          TokenizedMMF: mmfAddress,
          tokens: Object.fromEntries(
            Object.entries(tokens).map(([k, v]) => [k, { address: v.address, decimals: v.decimals }])
          ),
        },
        accounts: {
          operator: { address: deployerAddr, privateKeyEnv: "DEPLOYER_PRIVATE_KEY" },
          treasury: treasuryEnvKey
            ? { address: treasuryAddr, privateKeyEnv: "TREASURY_PRIVATE_KEY" }
            : { address: treasuryAddr, privateKey: treasuryKey },
          entityWallets: Object.fromEntries(
            Object.entries(entityWallets).map(([id, w]) => [
              id,
              { address: w.address, privateKey: w.privateKey },
            ])
          ),
        },
      },
    },
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(deployments, null, 2));
  console.log(`\nWrote ${path.relative(root, OUT_PATH)}`);

  const prisma = new PrismaClient();
  let registered = 0;
  for (const [externalId, w] of Object.entries(entityWallets)) {
    const entity = await prisma.entity.findUnique({ where: { externalId } });
    if (!entity) continue;
    await prisma.wallet.upsert({
      where: { address_network: { address: w.address, network: NETWORK_ID } },
      create: {
        entityId: entity.id,
        address: w.address,
        network: NETWORK_ID,
        label: w.profile.label,
        allowlisted: w.profile.allowlisted,
        riskScore: w.profile.riskScore,
      },
      update: {
        label: w.profile.label,
        allowlisted: w.profile.allowlisted,
        riskScore: w.profile.riskScore,
      },
    });
    registered++;
  }
  await prisma.$disconnect();
  if (registered === 0) {
    console.log(
      `\nNote: no entities in the database yet — run \`npm run setup\` (it also registers these ${CFG.name} wallets).`
    );
  } else {
    console.log(`Registered ${registered} entity wallets in the database for ${NETWORK_ID}.`);
  }

  const remaining = await publicClient.getBalance({ address: deployerAddr });
  console.log(`\nDone (adopt). Deployer gas remaining: ${formatEther(remaining)} ${CFG.currency}`);
  console.log(`PaymentSettlement: ${addressLink(settlementAddress)} (adopted)`);
  console.log(`TokenizedMMF: ${addressLink(mmfAddress)} (${needsMmf ? "new" : "adopted"})`);
  if (approvalTxHash) console.log(`Treasury MMF approval: ${txLink(approvalTxHash)}`);
  console.log(`Start the app (npm run dev) and pick ${CFG.name} as source and/or destination chain.`);
}

/**
 * MMF add-on: deploy fund + buffer + treasury approval, merge into overlay.
 */
async function runMmfAddon({
  NETWORK_ID,
  CFG,
  OUT_PATH,
  overlayJson,
  networkOverlay,
  deployerKey,
  publicClient,
  walletFor,
  txLink,
  addressLink,
}) {
  const deployer = walletFor(deployerKey);
  const contracts = networkOverlay.contracts;
  const mockUsdc = contracts.tokens.mockUSDC;

  // Resolve the treasury signer BEFORE any transaction: the overlay merge is the
  // last step, so an abort after the fund deploys leaves the overlay without a
  // TokenizedMMF entry and a re-run would deploy a second, orphaned fund. Every
  // check that can fail without a chain must run while nothing has been spent.
  // Bind the key to the overlay treasury address (T5-5) — a mismatched env key
  // must not approve from a stranger wallet while the merge still succeeds.
  const treasuryAccount = networkOverlay.accounts?.treasury;
  const treasuryResolved = resolveAddonTreasuryKey(treasuryAccount);
  if (!treasuryResolved.ok) fail(treasuryResolved.message);
  const treasuryKey = treasuryResolved.key;
  const treasuryAddr = treasuryResolved.address;

  async function send(fn, label) {
    const hash = await fn();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") fail(`${label} reverted: ${txLink(hash)}`);
    console.log(`  ${label} → ${txLink(hash)}`);
    return receipt;
  }

  console.log("\nDeploying TokenizedMMF (add-on):");
  const mmfArt = artifact("TokenizedMMF");
  const mmfHash = await deployer.deployContract({
    abi: mmfArt.abi,
    bytecode: mmfArt.bytecode,
    args: [mockUsdc.address],
  });
  const mmfReceipt = await publicClient.waitForTransactionReceipt({ hash: mmfHash });
  if (mmfReceipt.status !== "success") fail(`TokenizedMMF deploy reverted: ${txLink(mmfHash)}`);
  const mmfAddress = mmfReceipt.contractAddress;
  console.log(`  TokenizedMMF → ${addressLink(mmfAddress)}`);

  const tokenArt = artifact("MockERC20");
  const tokenAbi = tokenArt.abi;

  const mmfUsdcBalance = await publicClient.readContract({
    address: mockUsdc.address,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [mmfAddress],
  });

  if (mmfYieldBufferSatisfied(mmfUsdcBalance)) {
    console.log(
      `\nMMF yield buffer already funded (${mmfUsdcBalance.toString()} base units ≥ ${MMF_YIELD_BUFFER.toString()}) — skip mint`
    );
  } else {
    console.log("\nMinting MMF yield buffer:");
    await send(
      () =>
        deployer.writeContract({
          address: mockUsdc.address,
          abi: tokenAbi,
          functionName: "mint",
          args: [mmfAddress, MMF_YIELD_BUFFER],
        }),
      "mint MMF yield buffer 50,000 mockUSDC"
    );
  }

  const allowance = await publicClient.readContract({
    address: mockUsdc.address,
    abi: tokenAbi,
    functionName: "allowance",
    args: [treasuryAddr, mmfAddress],
  });

  if (treasuryMmfApprovalSatisfied(allowance)) {
    console.log(`\nTreasury already approved mockUSDC → TokenizedMMF — skip approve`);
  } else {
    console.log("\nApproving the MMF as treasury:");
    const treasuryWallet = walletFor(treasuryKey);
    await send(
      () =>
        treasuryWallet.writeContract({
          address: mockUsdc.address,
          abi: tokenAbi,
          functionName: "approve",
          args: [mmfAddress, MAX_UINT256],
        }),
      "treasury approve mockUSDC → TokenizedMMF"
    );
  }

  const existing = JSON.parse(overlayJson);
  existing.networks[NETWORK_ID].contracts.TokenizedMMF = mmfAddress;
  fs.writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2));
  console.log(`\nMerged TokenizedMMF into ${path.relative(root, OUT_PATH)}`);

  const deployerAddr = deployer.account.address;
  const remaining = await publicClient.getBalance({ address: deployerAddr });
  console.log(`\nDone. Deployer gas remaining: ${formatEther(remaining)} ${CFG.currency}`);
  console.log(`PaymentSettlement: ${addressLink(contracts.PaymentSettlement)} (unchanged)`);
  console.log(`TokenizedMMF: ${addressLink(mmfAddress)} (new)`);
}

/**
 * Full deploy path (original behavior).
 */
async function runFullDeploy({
  NETWORK_ID,
  CFG,
  OUT_PATH,
  RPC_URL,
  EXPLORER,
  deployerKey,
  publicClient,
  walletFor,
  txLink,
  addressLink,
}) {
  const deployer = walletFor(deployerKey);
  const deployerAddr = deployer.account.address;
  const balance = await publicClient.getBalance({ address: deployerAddr });
  console.log(`Deployer ${deployerAddr} — ${formatEther(balance)} ${CFG.currency} on ${CFG.name}`);

  // Reuse previously generated wallets so re-deploys don't strand funded dust wallets.
  const existing = fs.existsSync(OUT_PATH)
    ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8")).networks?.[NETWORK_ID]?.accounts
    : null;

  const treasuryEnvKey = process.env.TREASURY_PRIVATE_KEY;
  const treasuryKey = treasuryEnvKey || existing?.treasury?.privateKey || generatePrivateKey();
  const treasuryAddr = privateKeyToAccount(treasuryKey).address;

  const entityWallets = {};
  for (const [externalId, profile] of Object.entries(ENTITY_PROFILES)) {
    const pk = existing?.entityWallets?.[externalId]?.privateKey || generatePrivateKey();
    entityWallets[externalId] = { privateKey: pk, address: privateKeyToAccount(pk).address, profile };
  }

  async function send(fn, label) {
    const hash = await fn();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") fail(`${label} reverted: ${txLink(hash)}`);
    console.log(`  ${label} → ${txLink(hash)}`);
    return receipt;
  }

  // Fund treasury + entity wallets with gas dust for approvals/payouts.
  console.log("\nFunding role wallets with gas dust:");
  const fundTargets = [
    { label: "treasury", address: treasuryAddr, target: CFG.treasuryGasTarget },
    ...Object.entries(entityWallets).map(([id, w]) => ({
      label: id,
      address: w.address,
      target: CFG.entityGasTarget,
    })),
  ];
  for (const t of fundTargets) {
    const bal = await publicClient.getBalance({ address: t.address });
    if (bal >= t.target) {
      console.log(`  ${t.label} ${t.address} already funded (${formatEther(bal)} ${CFG.currency})`);
      continue;
    }
    await send(
      () => deployer.sendTransaction({ to: t.address, value: t.target - bal }),
      `fund ${t.label} ${t.address}`
    );
  }

  // Deploy contracts (deployer = operator).
  console.log("\nDeploying contracts:");
  async function deploy(name, args) {
    const art = artifact(name);
    const hash = await deployer.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") fail(`${name} deploy reverted: ${txLink(hash)}`);
    console.log(`  ${name}${args[1] ? ` (${args[1]})` : ""} → ${addressLink(receipt.contractAddress)}`);
    return { address: receipt.contractAddress, abi: art.abi };
  }

  const tokens = {};
  for (const [name, symbol, decimals] of TOKENS) {
    const t = await deploy("MockERC20", [name, symbol, decimals]);
    tokens[symbol] = { ...t, decimals };
  }
  const settlement = await deploy("PaymentSettlement", []);
  // Tokenized MMF for parked treasury liquidity — backed by mockUSDC (the
  // settlement asset). Segregated from escrow: the two contracts never cross-call.
  const mmf = await deploy("TokenizedMMF", [tokens.mockUSDC.address]);

  console.log("\nApproving assets on PaymentSettlement:");
  for (const [symbol, t] of Object.entries(tokens)) {
    await send(
      () =>
        deployer.writeContract({
          address: settlement.address,
          abi: settlement.abi,
          functionName: "setApprovedAsset",
          args: [t.address, true],
        }),
      `setApprovedAsset ${symbol}`
    );
  }

  // Same demo balance distribution as the local chains.
  console.log("\nMinting demo balances:");
  const mints = [
    ["mockUSDC", entityWallets.ent_acme_us.address, 1_000_000n * 10n ** 6n, "ACME 1,000,000 mockUSDC"],
    ["mockUSDC", treasuryAddr, 500_000n * 10n ** 6n, "treasury 500,000 mockUSDC"],
    ["mockJPY", treasuryAddr, 100_000_000n, "treasury 100,000,000 mockJPY"],
    ["mockSGD", treasuryAddr, 1_000_000n * 10n ** 6n, "treasury 1,000,000 mockSGD"],
    ["mockSGD", entityWallets.ent_sg_supplier.address, 200_000n * 10n ** 6n, "SG Imports 200,000 mockSGD"],
    ["mockJPY", entityWallets.ent_tokyo_supplier.address, 10_000_000n, "Tokyo 10,000,000 mockJPY"],
    // MMF yield buffer: accrual raises redemption value without adding asset to
    // the fund, so simulated yield is paid out of this pre-funded balance.
    ["mockUSDC", mmf.address, MMF_YIELD_BUFFER, "MMF yield buffer 50,000 mockUSDC"],
  ];
  for (const [symbol, to, amount, label] of mints) {
    await send(
      () =>
        deployer.writeContract({
          address: tokens[symbol].address,
          abi: tokens[symbol].abi,
          functionName: "mint",
          args: [to, amount],
        }),
      `mint ${label}`
    );
  }

  // No entity approvals here by design: an unlimited standing allowance lets a
  // compromised escrow drain a wallet's whole balance. The executor approves the
  // exact amount per payment instead (lib/chain.ts ensureSenderAllowance), which
  // costs one extra tx of the wallet's dust per settlement.

  // The treasury parks into the MMF, which pulls the asset via transferFrom, so
  // it must approve the fund. This is the platform's own account (not a
  // customer's), so a MAX approval is fine — park() also self-heals a missing
  // allowance (ensureTreasuryAllowance), but approving here mirrors the local
  // setup so the very first park needs no extra tx.
  console.log("\nApproving the MMF as treasury:");
  const treasuryWallet = walletFor(treasuryKey);
  await send(
    () =>
      treasuryWallet.writeContract({
        address: tokens.mockUSDC.address,
        abi: tokens.mockUSDC.abi,
        functionName: "approve",
        args: [mmf.address, MAX_UINT256],
      }),
    "treasury approve mockUSDC → TokenizedMMF"
  );

  const deployments = {
    networks: {
      [NETWORK_ID]: {
        chainId: CFG.chainId,
        rpcUrl: RPC_URL,
        ...(EXPLORER ? { explorerUrl: EXPLORER } : {}),
        contracts: {
          PaymentSettlement: settlement.address,
          TokenizedMMF: mmf.address,
          tokens: Object.fromEntries(
            Object.entries(tokens).map(([k, v]) => [k, { address: v.address, decimals: v.decimals }])
          ),
        },
        accounts: {
          // Funded key stays in .env; only the address is recorded here.
          operator: { address: deployerAddr, privateKeyEnv: "DEPLOYER_PRIVATE_KEY" },
          treasury: treasuryEnvKey
            ? { address: treasuryAddr, privateKeyEnv: "TREASURY_PRIVATE_KEY" }
            : { address: treasuryAddr, privateKey: treasuryKey },
          entityWallets: Object.fromEntries(
            Object.entries(entityWallets).map(([id, w]) => [
              id,
              { address: w.address, privateKey: w.privateKey },
            ])
          ),
        },
      },
    },
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(deployments, null, 2));
  console.log(`\nWrote ${path.relative(root, OUT_PATH)}`);

  // Register the entity wallets in the app DB so payments can use this network.
  const prisma = new PrismaClient();
  let registered = 0;
  for (const [externalId, w] of Object.entries(entityWallets)) {
    const entity = await prisma.entity.findUnique({ where: { externalId } });
    if (!entity) continue;
    await prisma.wallet.upsert({
      where: { address_network: { address: w.address, network: NETWORK_ID } },
      create: {
        entityId: entity.id,
        address: w.address,
        network: NETWORK_ID,
        label: w.profile.label,
        allowlisted: w.profile.allowlisted,
        riskScore: w.profile.riskScore,
      },
      update: { label: w.profile.label, allowlisted: w.profile.allowlisted, riskScore: w.profile.riskScore },
    });
    registered++;
  }
  await prisma.$disconnect();
  if (registered === 0) {
    console.log(
      `\nNote: no entities in the database yet — run \`npm run setup\` (it also registers these ${CFG.name} wallets).`
    );
  } else {
    console.log(`Registered ${registered} entity wallets in the database for ${NETWORK_ID}.`);
  }

  const remaining = await publicClient.getBalance({ address: deployerAddr });
  console.log(`\nDone. Deployer gas remaining: ${formatEther(remaining)} ${CFG.currency}`);
  console.log(`PaymentSettlement: ${addressLink(settlement.address)}`);
  console.log(`TokenizedMMF: ${addressLink(mmf.address)}`);
  console.log(`Start the app (npm run dev) and pick ${CFG.name} as source and/or destination chain.`);
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
