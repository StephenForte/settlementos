@AGENTS.md

# SettlementOS — project status notes

Engineering guide (architecture, run/verify, invariants, gotchas) lives in
AGENTS.md above. README.md has full docs, DEMO.md the demo script, PRD.md the
product requirements + phase roadmap (canonical; updated 2026-07-08 with
implementation status and the JLTXX-inspired tokenized-MMF phase).

## State (2026-07-08)
- Phases 1–4 complete: single-chain settlement; FX/routing/compliance/liquidity;
  multi-chain demo (base-local 31337 + polygon-local 31338, simulated bridge);
  real Base Sepolia (84532) with public Basescan links.
- Phase 5 complete: vitest suite (71 tests — unit/DB/on-chain integration, see
  AGENTS.md "Tests") + GitHub Actions CI. Lint, tsc, and tests all green.
- NEXT (agreed, 2026-07-09): compliance-provider sandbox — OpenSanctions for
  sanctions + Chainalysis free API for wallet screening, behind the existing
  ProviderResult interface, env-driven with mock fallback, fail-safe to
  MANUAL_REVIEW on provider errors, raw response persisted on ComplianceCheck.
  Stephen is opening the vendor accounts; keep KYB mocked.

## Base Sepolia (live)
- Deployed 2026-07-07, verified with a real settled payment.
  PaymentSettlement: 0x9d8b8b7c476ab02306046f3da719d380fa0456aa; first settled
  payment tx 0xdbf963150f5c1c90e3a007cc474c3fd42255fd3d019e3d71a6d821528fe258c5.
- Deployer/operator 0x5128889F20Ec13e0Be38b2BeBC568594159B652d (key in .env),
  ~0.078 ETH gas remaining — deploys cost ~0.002, settlements <0.0001, so no
  refill needed for many demos. Faucet lessons are in auto-memory
  (base-sepolia-faucet-lessons).
