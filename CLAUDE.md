@AGENTS.md

# SettlementOS — project context

EVM stablecoin settlement MVP (see README.md for full docs + demo script). The PRD
lives at ~/Downloads/settlementos_evm_stablecoin_settlement_prd.md.

## State (2026-07-07)
- Phases 1–3 complete and pushed: single-chain settlement, FX/routing/compliance/
  liquidity, and multi-chain demo (two local Hardhat nodes: base-local 31337 on
  :8545, polygon-local 31338 on :8546) with a simulated bridge.
- Run: `npm run chain` + `npm run chain:polygon` + `npm run setup` (resets DB and
  redeploys) + `npm run dev`. Tests: none yet; verify via API curl + UI.
- Key modules: lib/networks.ts (registry), lib/chain.ts (viem adapter),
  lib/routing.ts (quotes), lib/executor.ts (lifecycle orchestration),
  lib/compliance.ts (mock providers), lib/audit.ts (hash-chained log),
  scripts/setup.mjs (deploy + seed both chains).

## Next phase (agreed with Stephen): real Base Sepolia deployment
Goal: same contracts on actual Base Sepolia with public Basescan links in the UI.
- Add "base-sepolia" to lib/networks.ts (chainId 84532, explorer https://sepolia.basescan.org).
- New deploy script for testnet: deployer key + RPC from env (.env, never commit
  keys); do NOT use the dev-mnemonic accounts on a public network.
- Rework account roles for testnet: operator + treasury from env keys; entity
  wallets can be fresh generated keys stored locally.
- Add explorer link support to Hash component / payment detail when the network
  has an explorer.
- Stephen has a mainnet-funded wallet, NOT Base Sepolia — he needs Base Sepolia
  ETH from a faucet (Coinbase/Alchemy faucet, or bridge Sepolia ETH). Only gas is
  needed (~0.05 ETH); mock tokens are self-deployed, no real USDC required.
