// Deploys the contract set to a test chain and seeds the test DB — a compact
// mirror of scripts/setup.mjs for the vitest fixture (dev-mnemonic accounts,
// local nodes only).

import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, ACCOUNTS } from "../fixture";

const TOKENS: [string, string, number][] = [
  ["Mock USD Coin", "mockUSDC", 6],
  ["Mock JPY Token", "mockJPY", 0],
  ["Mock SGD Token", "mockSGD", 6],
];

/** Pre-funded mockUSDC held by the MMF to pay simulated yield (mirrors scripts/setup.mjs). */
export const MMF_YIELD_BUFFER = 50_000n * 10n ** 6n;

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const p = path.join(ROOT, "chain", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function clientsFor(rpcUrl: string, chainId: number) {
  const chain = defineChain({
    id: chainId,
    name: `test-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletFor = (pk: Hex) =>
    createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(pk) });
  return { publicClient, walletFor };
}

export async function waitForRpc(rpcUrl: string, chainId: number, timeoutMs = 60_000) {
  const { publicClient } = clientsFor(rpcUrl, chainId);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = await publicClient.getChainId().catch(() => null);
    if (id === chainId) return;
    if (id !== null) throw new Error(`Expected chainId ${chainId} at ${rpcUrl}, found ${id}`);
    if (Date.now() > deadline) throw new Error(`Chain at ${rpcUrl} not reachable after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function deployChain(rpcUrl: string, chainId: number) {
  const { publicClient, walletFor } = clientsFor(rpcUrl, chainId);
  const operator = walletFor(ACCOUNTS.operator.privateKey);

  async function deploy(name: string, args: unknown[]) {
    const art = artifact(name);
    const hash = await operator.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { address: receipt.contractAddress as Address, abi: art.abi };
  }

  async function write(
    wallet: ReturnType<typeof walletFor>,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[]
  ) {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const tokens: Record<string, { address: Address; abi: Abi; decimals: number }> = {};
  for (const [name, symbol, decimals] of TOKENS) {
    tokens[symbol] = { ...(await deploy("MockERC20", [name, symbol, decimals])), decimals };
  }
  const settlement = await deploy("PaymentSettlement", []);
  const mmf = await deploy("TokenizedMMF", [tokens.mockUSDC.address]);

  for (const t of Object.values(tokens)) {
    await write(operator, settlement.address, settlement.abi, "setApprovedAsset", [t.address, true]);
  }

  const mints: [string, Address, bigint][] = [
    ["mockUSDC", ACCOUNTS.acme.address, 1_000_000n * 10n ** 6n],
    ["mockUSDC", ACCOUNTS.treasury.address, 500_000n * 10n ** 6n],
    ["mockJPY", ACCOUNTS.treasury.address, 100_000_000n],
    ["mockSGD", ACCOUNTS.treasury.address, 1_000_000n * 10n ** 6n],
    ["mockSGD", ACCOUNTS.singapore.address, 200_000n * 10n ** 6n],
    ["mockJPY", ACCOUNTS.tokyo.address, 10_000_000n],
    // Buffer the MMF draws on to pay simulated yield (accrual mints no asset).
    ["mockUSDC", mmf.address, MMF_YIELD_BUFFER],
  ];
  for (const [symbol, to, amount] of mints) {
    await write(operator, tokens[symbol].address, tokens[symbol].abi, "mint", [to, amount]);
  }

  const MAX = 2n ** 256n - 1n;
  for (const who of ["acme", "tokyo", "singapore", "osaka"] as const) {
    const w = walletFor(ACCOUNTS[who].privateKey);
    for (const t of Object.values(tokens)) {
      await write(w, t.address, t.abi, "approve", [settlement.address, MAX]);
    }
  }
  // The treasury parks into the MMF, which pulls the asset via transferFrom.
  const treasury = walletFor(ACCOUNTS.treasury.privateKey);
  await write(treasury, tokens.mockUSDC.address, tokens.mockUSDC.abi, "approve", [mmf.address, MAX]);

  return {
    chainId,
    rpcUrl,
    contracts: {
      PaymentSettlement: settlement.address,
      TokenizedMMF: mmf.address,
      tokens: Object.fromEntries(
        Object.entries(tokens).map(([k, v]) => [k, { address: v.address, decimals: v.decimals }])
      ),
    },
  };
}

/** Demo entities, mirroring scripts/setup.mjs. */
export const ENTITIES = [
  {
    externalId: "ent_acme_us",
    name: "ACME US Inc",
    country: "US",
    role: "SENDER",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-JPY", "USD-SGD"]),
    // The one institution cleared for tokenized-MMF parking (Phase 8).
    mmfEligible: true,
    mmfOptIn: true,
    wallet: { address: ACCOUNTS.acme.address, label: "ACME operating wallet", allowlisted: true, riskScore: 5 },
  },
  {
    externalId: "ent_tokyo_supplier",
    name: "Tokyo Trading KK",
    country: "JP",
    role: "RECIPIENT",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-JPY", "SGD-JPY", "JPY-USD"]),
    wallet: { address: ACCOUNTS.tokyo.address, label: "Tokyo Trading settlement wallet", allowlisted: true, riskScore: 10 },
  },
  {
    externalId: "ent_sg_supplier",
    name: "Singapore Imports Pte Ltd",
    country: "SG",
    role: "BOTH",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-SGD", "SGD-JPY", "SGD-USD"]),
    wallet: { address: ACCOUNTS.singapore.address, label: "SG Imports settlement wallet", allowlisted: true, riskScore: 8 },
  },
  {
    externalId: "ent_osaka_parts",
    name: "Osaka Parts Co",
    country: "JP",
    role: "RECIPIENT",
    kybStatus: "PENDING",
    riskRating: "MEDIUM",
    approvedCorridors: JSON.stringify(["USD-JPY"]),
    wallet: { address: ACCOUNTS.osaka.address, label: "Osaka Parts wallet (unverified)", allowlisted: false, riskScore: 55 },
  },
];
