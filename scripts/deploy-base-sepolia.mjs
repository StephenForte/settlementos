// Deploy SettlementOS contracts to REAL Base Sepolia (chainId 84532).
//
//   1. Deploys MockERC20 tokens + PaymentSettlement using DEPLOYER_PRIVATE_KEY
//      (the deployer doubles as the settlement operator).
//   2. Generates local entity wallets + a treasury wallet (reused across re-runs),
//      funds them with dust ETH from the deployer, and pre-approves the
//      settlement contract for each token.
//   3. Mints demo token balances (same distribution as the local chains).
//   4. Writes chain/deployments.base-sepolia.json (gitignored — contains the
//      generated dust-wallet keys; the funded deployer key stays in .env only).
//   5. Registers the entity wallets in the app database (if entities are seeded).
//
// Run: npm run deploy:base-sepolia          (loads .env via node --env-file)
// Requires: DEPLOYER_PRIVATE_KEY in .env, funded with ~0.02 Base Sepolia ETH.
// Optional: BASE_SEPOLIA_RPC_URL (default https://sepolia.base.org),
//           TREASURY_PRIVATE_KEY (default: generated + stored in the JSON above).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain, formatEther, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const NETWORK_ID = "base-sepolia";
const CHAIN_ID = 84532;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const EXPLORER = "https://sepolia.basescan.org";
const OUT_PATH = path.join(root, "chain", "deployments.base-sepolia.json");

const TOKENS = [
  ["Mock USD Coin", "mockUSDC", 6],
  ["Mock JPY Token", "mockJPY", 0],
  ["Mock SGD Token", "mockSGD", 6],
];

// externalId → demo profile (mirrors scripts/setup.mjs; wallet risk attributes
// drive the compliance demo the same way they do on the local chains).
const ENTITY_PROFILES = {
  ent_acme_us: { label: "ACME operating wallet", allowlisted: true, riskScore: 5 },
  ent_tokyo_supplier: { label: "Tokyo Trading settlement wallet", allowlisted: true, riskScore: 10 },
  ent_sg_supplier: { label: "SG Imports settlement wallet", allowlisted: true, riskScore: 8 },
  ent_osaka_parts: { label: "Osaka Parts wallet (unverified)", allowlisted: false, riskScore: 55 },
};

// Gas dust targets. Base Sepolia gas is fractions of a gwei, so these cover
// dozens of approvals/payouts. Top-ups only happen when below the target.
const ENTITY_GAS_TARGET = parseEther("0.0002");
const TREASURY_GAS_TARGET = parseEther("0.001");
const MIN_DEPLOYER_BALANCE = parseEther("0.005");

function artifact(name) {
  const p = path.join(root, "chain", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function fail(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
}

async function main() {
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey || !deployerKey.startsWith("0x")) {
    fail(
      "DEPLOYER_PRIVATE_KEY is not set in .env.\n" +
        "Generate a fresh key (never reuse a mainnet key) and fund it with ~0.02 Base Sepolia ETH:\n" +
        "  https://portal.cdp.coinbase.com/products/faucet  (Coinbase, free)\n" +
        "  https://www.alchemy.com/faucets/base-sepolia"
    );
  }

  const chain = defineChain({
    id: CHAIN_ID,
    name: "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletFor = (pk) =>
    createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(pk) });

  const onchainId = await publicClient.getChainId().catch(() => null);
  if (onchainId === null) fail(`Base Sepolia RPC not reachable at ${RPC_URL}`);
  if (onchainId !== CHAIN_ID) fail(`Expected chainId ${CHAIN_ID} at ${RPC_URL}, found ${onchainId}`);

  const deployer = walletFor(deployerKey);
  const deployerAddr = deployer.account.address;
  const balance = await publicClient.getBalance({ address: deployerAddr });
  console.log(`Deployer ${deployerAddr} — ${formatEther(balance)} ETH on Base Sepolia`);
  if (balance < MIN_DEPLOYER_BALANCE) {
    fail(
      `Deployer balance too low (need ≥ ${formatEther(MIN_DEPLOYER_BALANCE)} ETH for deploy + wallet funding).\n` +
        `Fund ${deployerAddr} from a faucet:\n` +
        "  https://portal.cdp.coinbase.com/products/faucet  (Coinbase, free)\n" +
        "  https://www.alchemy.com/faucets/base-sepolia"
    );
  }

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
    if (receipt.status !== "success") fail(`${label} reverted: ${EXPLORER}/tx/${hash}`);
    console.log(`  ${label} → ${EXPLORER}/tx/${hash}`);
    return receipt;
  }

  // Fund treasury + entity wallets with gas dust for approvals/payouts.
  console.log("\nFunding role wallets with gas dust:");
  const fundTargets = [
    { label: "treasury", address: treasuryAddr, target: TREASURY_GAS_TARGET },
    ...Object.entries(entityWallets).map(([id, w]) => ({
      label: id,
      address: w.address,
      target: ENTITY_GAS_TARGET,
    })),
  ];
  for (const t of fundTargets) {
    const bal = await publicClient.getBalance({ address: t.address });
    if (bal >= t.target) {
      console.log(`  ${t.label} ${t.address} already funded (${formatEther(bal)} ETH)`);
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
    if (receipt.status !== "success") fail(`${name} deploy reverted: ${EXPLORER}/tx/${hash}`);
    console.log(`  ${name}${args[1] ? ` (${args[1]})` : ""} → ${EXPLORER}/address/${receipt.contractAddress}`);
    return { address: receipt.contractAddress, abi: art.abi };
  }

  const tokens = {};
  for (const [name, symbol, decimals] of TOKENS) {
    const t = await deploy("MockERC20", [name, symbol, decimals]);
    tokens[symbol] = { ...t, decimals };
  }
  const settlement = await deploy("PaymentSettlement", []);

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

  console.log("\nEntity wallets approving PaymentSettlement (max allowance):");
  const MAX = 2n ** 256n - 1n;
  for (const [externalId, w] of Object.entries(entityWallets)) {
    const entityWallet = walletFor(w.privateKey);
    for (const [symbol, t] of Object.entries(tokens)) {
      await send(
        () =>
          entityWallet.writeContract({
            address: t.address,
            abi: t.abi,
            functionName: "approve",
            args: [settlement.address, MAX],
          }),
        `approve ${symbol} for ${externalId}`
      );
    }
  }

  const deployments = {
    networks: {
      [NETWORK_ID]: {
        chainId: CHAIN_ID,
        rpcUrl: RPC_URL,
        explorerUrl: EXPLORER,
        contracts: {
          PaymentSettlement: settlement.address,
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

  // Register the entity wallets in the app DB so payments can use base-sepolia.
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
      "\nNote: no entities in the database yet — run `npm run setup` (it also registers these Base Sepolia wallets)."
    );
  } else {
    console.log(`Registered ${registered} entity wallets in the database for ${NETWORK_ID}.`);
  }

  const remaining = await publicClient.getBalance({ address: deployerAddr });
  console.log(`\nDone. Deployer gas remaining: ${formatEther(remaining)} ETH`);
  console.log(`PaymentSettlement: ${EXPLORER}/address/${settlement.address}`);
  console.log("Start the app (npm run dev) and pick Base Sepolia as source + destination chain.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
