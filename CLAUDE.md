@AGENTS.md

# SettlementOS — project status notes

Engineering guide (architecture, run/verify, invariants, gotchas) lives in
AGENTS.md above. README.md has full docs, DEMO.md the demo script, PRD.md the
product requirements + phase roadmap (canonical; updated 2026-07-08 with
implementation status and the JLTXX-inspired tokenized-MMF phase).

## State (2026-07-13)
- Phases 1–4 complete: single-chain settlement; FX/routing/compliance/liquidity;
  multi-chain demo (base-local 31337 + polygon-local 31338, simulated bridge);
  real Base Sepolia (84532) with public Basescan links.
- Phase 5 complete: vitest suite (unit/DB/on-chain integration, see AGENTS.md
  "Tests") + GitHub Actions CI. Lint, tsc, and tests all green.
- Phase 6 complete (2026-07-10): compliance-provider sandbox — OpenSanctions
  (sanctions match API) + Chainalysis sanctions oracle (keyless on-chain
  `isSanctioned()` wallet screening — the free HTTP API's signup no longer
  exists, so we read the public contract instead) in `lib/providers/`,
  env-driven dispatch with mock fallback (`OPENSANCTIONS_API_KEY` /
  `CHAINALYSIS_ORACLE_RPC_URL` in .env), fail-safe to MANUAL_REVIEW, raw
  provider evidence persisted on `ComplianceCheck.rawResponse`. Suite now 91
  tests; FIXTURE_ENV pins provider env off so tests stay hermetic (Vitest
  loads dev .env). Both providers smoke-tested LIVE (2026-07-10): oracle on
  Ethereum mainnet (Chatex SDN address → true, vitalik.eth → false);
  OpenSanctions match with Stephen's trial key (gmail-registered) — Rosneft
  score=1 match=true, clean name 0 results. .env has both
  `CHAINALYSIS_ORACLE_RPC_URL` and `OPENSANCTIONS_API_KEY`, so dev-server
  compliance runs are now real for sanctions + wallet checks. KYB stays
  mocked.
- Phase 7 code complete (2026-07-13, branch phase-7-polygon-amoy): polygon-amoy
  (80002) in the network registry, `loadDeployments()` generalized to one
  `deployments.<id>.json` overlay per live network, parameterized
  `scripts/deploy-testnet.mjs` (replaces deploy-base-sepolia.mjs; per-network
  gas-dust targets — Amoy enforces ~30 gwei so dust is ~100× Base Sepolia's),
  setup.mjs re-registers all live-network wallets. Suite now 93 tests.
- NEXT: fund deployer 0x5128889F20Ec13e0Be38b2BeBC568594159B652d with ≥0.4 POL
  on Polygon Amoy (faucet.polygon.technology / Alchemy), then
  `npm run deploy:polygon-amoy` and verify with a bridged
  base-sepolia → polygon-amoy payment (public explorer links on both chains).
  Then Phase 8 (tokenized MMF) per PRD.

## Base Sepolia (live)
- Deployed 2026-07-07, verified with a real settled payment.
  PaymentSettlement: 0x9d8b8b7c476ab02306046f3da719d380fa0456aa; first settled
  payment tx 0xdbf963150f5c1c90e3a007cc474c3fd42255fd3d019e3d71a6d821528fe258c5.
- Deployer/operator 0x5128889F20Ec13e0Be38b2BeBC568594159B652d (key in .env),
  ~0.078 ETH gas remaining — deploys cost ~0.002, settlements <0.0001, so no
  refill needed for many demos. Faucet lessons are in auto-memory
  (base-sepolia-faucet-lessons).
