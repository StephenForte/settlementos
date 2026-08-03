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
// The TokenizedMMF (overnight liquidity parking, PRD §24) deploys on live
// networks the same way it always has on the local chains — mint its mockUSDC
// yield buffer to the fund AND have the treasury approve the fund, or parking
// reverts (AGENTS.md gotcha). mmfAddress() returns undefined for any network
// whose overlay predates this, so older deploys keep settling untouched.
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
const NETWORK_CONFIGS = {
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

const NETWORK_ID = process.argv[2];
const CFG = NETWORK_CONFIGS[NETWORK_ID];
if (!CFG) {
  console.error(
    `Usage: node scripts/deploy-testnet.mjs <network>\nSupported: ${Object.keys(NETWORK_CONFIGS).join(", ")}`
  );
  process.exit(1);
}
const RPC_URL = process.env[CFG.rpcEnv] || CFG.defaultRpc;
const EXPLORER = CFG.explorer;
const txLink = (hash) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : hash);
const addressLink = (addr) => (EXPLORER ? `${EXPLORER}/address/${addr}` : addr);
const OUT_PATH = path.join(root, "chain", `deployments.${NETWORK_ID}.json`);

const TOKENS = [
  ["Mock USD Coin", "mockUSDC", 6],
  ["Mock JPY Token", "mockJPY", 0],
  ["Mock SGD Token", "mockSGD", 6],
];

// Pre-funded mockUSDC held by the MMF to pay simulated yield on redemption —
// accrual raises the redemption value without minting asset, so the yield is
// paid out of this buffer (mirrors scripts/setup.mjs + the test fixture).
const MMF_YIELD_BUFFER = 50_000n * 10n ** 6n;
// The treasury is the platform's own parking account, so its approval to the
// fund stays MAX (unlike entity → escrow allowances, which are exact per payment).
const MAX_UINT256 = 2n ** 256n - 1n;

// externalId → demo profile (mirrors scripts/setup.mjs; wallet risk attributes
// drive the compliance demo the same way they do on the local chains).
const ENTITY_PROFILES = {
  ent_acme_us: { label: "ACME operating wallet", allowlisted: true, riskScore: 5 },
  ent_tokyo_supplier: { label: "Tokyo Trading settlement wallet", allowlisted: true, riskScore: 10 },
  ent_sg_supplier: { label: "SG Imports settlement wallet", allowlisted: true, riskScore: 8 },
  ent_osaka_parts: { label: "Osaka Parts wallet (unverified)", allowlisted: false, riskScore: 55 },
};

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
        `Generate a fresh key (never reuse a mainnet key) and fund it with ~${formatEther(
          CFG.minDeployerBalance
        )} ${CFG.currency} on ${CFG.name}:\n` +
        CFG.funding.join("\n")
    );
  }

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
  if (onchainId === null) fail(`${CFG.name} RPC not reachable at ${RPC_URL}`);
  if (onchainId !== CFG.chainId) fail(`Expected chainId ${CFG.chainId} at ${RPC_URL}, found ${onchainId}`);

  const deployer = walletFor(deployerKey);
  const deployerAddr = deployer.account.address;
  const balance = await publicClient.getBalance({ address: deployerAddr });
  console.log(`Deployer ${deployerAddr} — ${formatEther(balance)} ${CFG.currency} on ${CFG.name}`);
  if (balance < CFG.minDeployerBalance) {
    fail(
      `Deployer balance too low (need ≥ ${formatEther(CFG.minDeployerBalance)} ${CFG.currency} for deploy + wallet funding).\n` +
        `Fund ${deployerAddr}:\n` +
        CFG.funding.join("\n")
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
