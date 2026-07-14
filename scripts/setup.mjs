// One-shot local environment setup (multi-chain):
//   1. Deploys MockERC20 tokens + PaymentSettlement to BOTH local chains:
//        base-local    (127.0.0.1:8545, chainId 31337) — simulates Base Sepolia
//        polygon-local (127.0.0.1:8546, chainId 31338) — simulates Polygon Amoy
//   2. Approves assets, funds entity wallets and the settlement treasury.
//   3. Resets and seeds the SQLite database with demo entities and wallets.
//   4. Writes chain/deployments.json for the app.
//
// Run: npm run setup   (requires `npm run chain` and `npm run chain:polygon`)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const CHAINS = {
  "base-local": {
    rpcUrl: process.env.BASE_LOCAL_RPC_URL || "http://127.0.0.1:8545",
    chainId: 31337,
    // Full asset set: USD home market + FX inventory.
    tokens: [
      ["Mock USD Coin", "mockUSDC", 6],
      ["Mock JPY Token", "mockJPY", 0],
      ["Mock SGD Token", "mockSGD", 6],
    ],
  },
  "polygon-local": {
    rpcUrl: process.env.POLYGON_LOCAL_RPC_URL || "http://127.0.0.1:8546",
    chainId: 31338,
    // Asia-corridor destination chain: JPY/SGD payout inventory + USDC for returns.
    tokens: [
      ["Mock USD Coin", "mockUSDC", 6],
      ["Mock JPY Token", "mockJPY", 0],
      ["Mock SGD Token", "mockSGD", 6],
    ],
  },
};

// Pre-funded mockUSDC held by the MMF to pay simulated yield on redemption.
const MMF_YIELD_BUFFER = 50_000n * 10n ** 6n;

// Standard Hardhat/Anvil dev mnemonic accounts — local use only.
const ACCOUNTS = {
  operator: {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  acme: {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  tokyo: {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
  singapore: {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    privateKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  },
  treasury: {
    address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    privateKey: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  },
  osaka: {
    address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    privateKey: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  },
};

function artifact(name) {
  const p = path.join(root, "chain", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function setupChain(networkId, cfg) {
  const chain = defineChain({
    id: cfg.chainId,
    name: networkId,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = (pk) =>
    createWalletClient({ chain, transport: http(cfg.rpcUrl), account: privateKeyToAccount(pk) });

  const reachable = await publicClient.getChainId().catch(() => null);
  if (reachable === null) {
    console.error(`\n${networkId} not reachable at ${cfg.rpcUrl}.`);
    console.error(
      networkId === "polygon-local"
        ? "Start it first: npm run chain:polygon"
        : "Start it first: npm run chain"
    );
    process.exit(1);
  }
  if (reachable !== cfg.chainId) {
    console.error(`\n${networkId}: expected chainId ${cfg.chainId} at ${cfg.rpcUrl}, found ${reachable}.`);
    process.exit(1);
  }

  const operator = wallet(ACCOUNTS.operator.privateKey);

  async function deploy(name, args) {
    const art = artifact(name);
    const hash = await operator.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  [${networkId}] ${name}${args[1] ? ` (${args[1]})` : ""} → ${receipt.contractAddress}`);
    return { address: receipt.contractAddress, abi: art.abi };
  }

  async function write(w, address, abi, functionName, args) {
    const hash = await w.writeContract({ address, abi, functionName, args });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const tokens = {};
  for (const [name, symbol, decimals] of cfg.tokens) {
    const t = await deploy("MockERC20", [name, symbol, decimals]);
    tokens[symbol] = { ...t, decimals };
  }
  const settlement = await deploy("PaymentSettlement", []);
  // Tokenized MMF for parked treasury liquidity — backed by mockUSDC, the settlement
  // asset. Its funds are strictly segregated from the escrow contract above.
  const mmf = await deploy("TokenizedMMF", [tokens.mockUSDC.address]);

  for (const t of Object.values(tokens)) {
    await write(operator, settlement.address, settlement.abi, "setApprovedAsset", [t.address, true]);
  }

  // Balances: ACME funds USD on both chains (so either can be a source);
  // treasury holds settlement liquidity in every asset on both chains.
  const mints = [
    ["mockUSDC", ACCOUNTS.acme.address, 1_000_000n * 10n ** 6n],
    ["mockUSDC", ACCOUNTS.treasury.address, 500_000n * 10n ** 6n],
    ["mockJPY", ACCOUNTS.treasury.address, 100_000_000n],
    ["mockSGD", ACCOUNTS.treasury.address, 1_000_000n * 10n ** 6n],
    ["mockSGD", ACCOUNTS.singapore.address, 200_000n * 10n ** 6n],
    ["mockJPY", ACCOUNTS.tokyo.address, 10_000_000n],
    // MMF yield buffer: accrual raises redemption value without adding asset to the
    // fund, so the simulated yield is paid out of this pre-funded balance.
    ["mockUSDC", mmf.address, MMF_YIELD_BUFFER],
  ];
  for (const [sym, to, amount] of mints) {
    if (tokens[sym]) {
      await write(operator, tokens[sym].address, tokens[sym].abi, "mint", [to, amount]);
    }
  }

  const MAX = 2n ** 256n - 1n;
  for (const who of ["acme", "tokyo", "singapore", "osaka"]) {
    const w = wallet(ACCOUNTS[who].privateKey);
    for (const t of Object.values(tokens)) {
      await write(w, t.address, t.abi, "approve", [settlement.address, MAX]);
    }
  }
  // The treasury is the parking account: subscribe() pulls via transferFrom.
  const treasuryWallet = wallet(ACCOUNTS.treasury.privateKey);
  await write(treasuryWallet, tokens.mockUSDC.address, tokens.mockUSDC.abi, "approve", [mmf.address, MAX]);

  return {
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl,
    contracts: {
      PaymentSettlement: settlement.address,
      TokenizedMMF: mmf.address,
      tokens: Object.fromEntries(
        Object.entries(tokens).map(([k, v]) => [k, { address: v.address, decimals: v.decimals }])
      ),
    },
  };
}

async function main() {
  console.log("Deploying to all networks:");
  const networks = {};
  for (const [networkId, cfg] of Object.entries(CHAINS)) {
    networks[networkId] = await setupChain(networkId, cfg);
  }

  const deployments = {
    networks,
    accounts: {
      operator: { address: ACCOUNTS.operator.address, privateKey: ACCOUNTS.operator.privateKey },
      treasury: { address: ACCOUNTS.treasury.address, privateKey: ACCOUNTS.treasury.privateKey },
      entityWallets: {
        ent_acme_us: { address: ACCOUNTS.acme.address, privateKey: ACCOUNTS.acme.privateKey },
        ent_tokyo_supplier: { address: ACCOUNTS.tokyo.address, privateKey: ACCOUNTS.tokyo.privateKey },
        ent_sg_supplier: { address: ACCOUNTS.singapore.address, privateKey: ACCOUNTS.singapore.privateKey },
        ent_osaka_parts: { address: ACCOUNTS.osaka.address, privateKey: ACCOUNTS.osaka.privateKey },
      },
    },
  };
  fs.writeFileSync(path.join(root, "chain", "deployments.json"), JSON.stringify(deployments, null, 2));
  console.log("Wrote chain/deployments.json");

  console.log("Seeding database...");
  const prisma = new PrismaClient();
  // Fresh chain state → fresh app state, in FK dependency order.
  // Parked MMF positions point at contracts that no longer exist after redeploy.
  await prisma.treasuryPosition.deleteMany();
  await prisma.ledgerCredit.deleteMany();
  await prisma.liquidityReservation.deleteMany();
  await prisma.complianceCheck.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.entity.deleteMany();

  // If real testnets have been deployed, re-register their entity wallets too
  // (the DB reset above wiped them; keys/addresses persist in the JSON files).
  const LIVE_NETWORK_IDS = ["base-sepolia", "polygon-amoy"];
  const liveWallets = {}; // networkId → { externalId → { address } }
  for (const id of LIVE_NETWORK_IDS) {
    const p = path.join(root, "chain", `deployments.${id}.json`);
    if (!fs.existsSync(p)) continue;
    const w = JSON.parse(fs.readFileSync(p, "utf8")).networks?.[id]?.accounts?.entityWallets;
    if (w) liveWallets[id] = w;
  }

  const networkIds = Object.keys(CHAINS);
  const entities = [
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
      // Intentionally incomplete onboarding — demos the manual-review path.
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

  for (const e of entities) {
    const { wallet: w, ...data } = e;
    // Same address is registered on every local network (dev accounts are shared);
    // each real testnet gets its own generated address with the same risk profile.
    const wallets = networkIds.map((network) => ({ ...w, network }));
    const liveNets = [];
    for (const [network, byEntity] of Object.entries(liveWallets)) {
      const lw = byEntity[e.externalId];
      if (!lw) continue;
      wallets.push({ ...w, address: lw.address, network });
      liveNets.push(network);
    }
    await prisma.entity.create({
      data: { ...data, wallets: { create: wallets } },
    });
    console.log(`  ${e.name} (${e.externalId})${liveNets.length ? ` + ${liveNets.join(", ")} wallet` : ""}`);
  }

  await prisma.$disconnect();
  console.log("\nSetup complete. Start the app with: npm run dev");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
