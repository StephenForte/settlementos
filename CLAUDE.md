@AGENTS.md

# SettlementOS — project status notes

Engineering guide (architecture, run/verify, invariants, gotchas) lives in
AGENTS.md above. README.md has full docs, DEMO.md the demo script, PRD.md the
product requirements + phase roadmap (canonical; updated 2026-07-08 with
implementation status and the JLTXX-inspired tokenized-MMF phase).

## State (2026-08-03)
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
- Phase 8 complete (2026-07-14, branch ralph/phase-8-tokenized-mmf — built
  autonomously by the Ralph loop in `scripts/ralph/`, 10/10 stories):
  JLTXX-inspired overnight liquidity parking per PRD §24. `TokenizedMMF.sol`
  (operator-permissioned subscribe/redeem, monotonic share index from 1e18),
  `TreasuryPosition` model + `mmfEligible`/`mmfOptIn` entity flags,
  `lib/treasury.ts` park/recall/accrueDaily (3.5% APY simulated, pure-bigint
  index math), 4 treasury API routes (opt-in guardrail → 403), route engine
  quotes against parked liquidity (`recall_required`) with executor
  auto-recall, Liquidity-page MMF card (park/recall/accrue, guardrail pills),
  segregation proven on-chain (escrow balance untouched through
  park→accrue→recall) with TREASURY_* events on the intact audit chain.
  Suite now 131 tests; full park→accrue→recall cycle also verified visually
  in the browser (+4.79 on 50k/day = 3.5%/365 exactly).
- Phase 7 deploy complete (2026-07-15): contracts live on Polygon Amoy —
  PaymentSettlement at the SAME address as Base Sepolia
  (0x9d8b8b7c476ab02306046f3da719d380fa0456aa, same deployer nonce sequence).
  First real bridged payment SETTLED: $25k USD→JPY, escrow+settle on Base
  Sepolia, mockJPY payout on Amoy (~7s). First attempt FAILED live on public
  RPC replica lag (settle + auto-refund both reverted "not initiated");
  fixed with `retryOnReplicaLag` in `operatorWrite` (lib/chain.ts, see AGENTS
  gotcha), stuck escrow recovered via manual failAndRefund + hash-correct
  audit events (chain INTACT). Suite now 135 tests. Deployer has ~0.33 POL
  left on Amoy (deploy cost ~0.23; faucet drips ~0.185/day if more needed —
  see auto-memory polygon-amoy-faucet-lessons).
- Phase 9 Track A complete (2026-07-16, branch ralph/phase-9-hardening — built
  autonomously by the Ralph loop in `scripts/ralph/`, 18/18 stories): production
  hardening per AUDIT.md. API-key identity + login cookie (US-001/2), authz +
  tenant scoping on every route (US-003/4), safe error vocabulary (US-005),
  compare-and-swap transitions + execution leases (US-006/7), idempotency keys
  (US-008), the compensation saga + operator repair view (US-009/10), bigint
  money/FX/liquidity math with canonical amount validation (US-011/12/13), exact
  per-payment allowances (US-014), the signer custody seam (US-015), atomic
  domain+audit writes (US-016), signed audit checkpoints (US-017), and baseline
  web hardening — CSP + security headers, 30 writes/min per principal, a 64KB
  body cap, cursor pagination, and a date-bounded CSV export (US-018). Suite now
  327 tests; lint, tsc, and build green.
- Phase 9 Track A hardened + merged (2026-07-16, PR #8 → main `e328ca2`): an
  8-angle multi-agent review found 16 confirmed issues; the 12 critical/high
  (double-payout, FAILED-strands-compensation, stuck-view visibility, quote-route
  CAS bypass, route-select race, create+audit atomicity, audit incremental→full
  verification, tenant page scoping, tenant audit-detail scrub, cookie 500,
  liquidity fallthrough, treasury idempotency) + 4 mediums (cursor oracle,
  unbounded lists, audit cursor overflow, 29→30-day reconciliation) + cleanups
  (withExecutionLease, fx parseScaledUnits) all fixed with regression tests.
  Suite 327 → 341. 2 PLAUSIBLE findings deferred to a background task (legacy
  amount rows, login x-forwarded-for spoof).
- Phase 9 Track B drafts written (2026-07-16, branch track-b-regulatory):
  `docs/regulatory/` — technical architecture + regulatory design, legal
  classification (framed as questions for counsel), partner integration, corridor
  strategy, and pilot options memos. Decisions: markdown memos, US-first, no legal
  conclusions. DRAFTS for Stephen's review; the legal memo is for actual counsel.
- ForteL2 integration F1–F5 (see `tasks/prd-fortel2-integration.md`):
  - F1 registry (`fortel2-sepolia` 852 + optional local 901) — PR #21.
  - F2 deploy to 852 — PR #24 (2026-07-24).
  - F3 first single-chain settle on the home rail — 2026-07-24
    (`pay_8c318fcae804`); F5 docs/demo beat landed with it (PR #26).
  - F4 TokenizedMMF on live networks — PR #29 (2026-08-03):
    `deploy-testnet.mjs` provisions `TokenizedMMF` + 50k mockUSDC yield
    buffer + treasury approval on every live network (base-sepolia /
    polygon-amoy / fortel2-sepolia); hermetic overlay wiring test added;
    park→accrue→recall verified on a local chainId-852 node. Live-sequencer
    run pending a reachable ForteL2 RPC. Suite 398 tests.
- ForteL2 parallel-worker waves 1+2 (2026-08-03, PRs #32–#37, dispatched per
  `tasks/fortel2-worker-plan.md` with `tasks/fortel2-decisions-2026-08-03.md`
  as the wave decisions log):
  - T1 (PR #33): hermetic BRIDGE_AND_SETTLE quoting proof for
    base-sepolia↔fortel2-sepolia (`tests/db/fortel2-bridge-route.test.ts`) +
    bridge manual-QA runbook. Surfaced T1-1 (receipt-loss double-pay window)
    and T1-2 (replica-lag retries wasted on a single-sequencer rail).
  - T2 (PR #34): deploy script mode-aware — auto-detected full / MMF add-on
    (fund + buffer + approval merged into an existing overlay) / no-op, plus
    `--preflight-only`; preflight extracted into unit-tested helpers.
  - T3 (PR #35): MMF live-redeploy runbook
    (`tasks/runbooks/fortel2-mmf-redeploy.md`) + treasury-seam tests.
  - T4 (PR #37): executor RPC resilience — `destinationTxHash` persisted on
    submit as an *attempt*, catch path reconciles the destination receipt
    (`transactionOutcome`) before compensating or completing forward, unknown
    outcome stays PAYOUT_PENDING in the stuck view, `repairCompensation`
    refuses on confirmed/unknown, `replicaLagRetries` 0 on fortel2-*/local.
  - Suite 398 → 438. T5 (hardening review) HELD until after the live 852
    session; its brief is queued in the decisions log.
- NEXT: live ForteL2 session on this machine (852 sequencer now local):
  MMF add-on deploy + park→accrue→recall (runbook), bridge QA (runbook),
  T4's four live checks — then dispatch T5, then the I6 checkbox/doc flips
  those runs justify. Also: optional F6 explorer address book; Stephen's
  review of the Track B regulatory drafts; US-F007 checkbox inconsistency
  in the PRD still needs Stephen's call.

## Base Sepolia (live)
- Deployed 2026-07-07, verified with a real settled payment.
  PaymentSettlement: 0x9d8b8b7c476ab02306046f3da719d380fa0456aa; first settled
  payment tx 0xdbf963150f5c1c90e3a007cc474c3fd42255fd3d019e3d71a6d821528fe258c5.
- Deployer/operator 0x5128889F20Ec13e0Be38b2BeBC568594159B652d (key in .env),
  ~0.078 ETH gas remaining — deploys cost ~0.002, settlements <0.0001, so no
  refill needed for many demos. Faucet lessons are in auto-memory
  (base-sepolia-faucet-lessons).
