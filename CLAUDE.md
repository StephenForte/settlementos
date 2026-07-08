@AGENTS.md

# SettlementOS — project status notes

Engineering guide (architecture, run/verify, invariants, gotchas) lives in
AGENTS.md above. README.md has full docs, DEMO.md the demo script. The PRD is at
~/Downloads/settlementos_evm_stablecoin_settlement_prd.md.

## State (2026-07-08)
- Phases 1–4 complete: single-chain settlement; FX/routing/compliance/liquidity;
  multi-chain demo (base-local 31337 + polygon-local 31338, simulated bridge);
  real Base Sepolia (84532) with public Basescan links.
- Tests: none yet — a likely next phase. Candidates discussed with Stephen:
  second real testnet (Polygon Amoy 80002 — per-network plumbing already
  supports it), real compliance-provider sandbox, test suite.

## Base Sepolia (live)
- Deployed 2026-07-07, verified with a real settled payment.
  PaymentSettlement: 0x9d8b8b7c476ab02306046f3da719d380fa0456aa; first settled
  payment tx 0xdbf963150f5c1c90e3a007cc474c3fd42255fd3d019e3d71a6d821528fe258c5.
- Deployer/operator 0x5128889F20Ec13e0Be38b2BeBC568594159B652d (key in .env),
  ~0.078 ETH gas remaining — deploys cost ~0.002, settlements <0.0001, so no
  refill needed for many demos. Faucet lessons are in auto-memory
  (base-sepolia-faucet-lessons).
