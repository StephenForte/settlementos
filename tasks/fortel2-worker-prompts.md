# ForteL2 Wave 1 — worker prompts (copy-paste, one per agent)

Generated 2026-08-03 against `origin/main` = `0f1d0a4`. If main has moved when
you dispatch, the prompts still work — each tells the worker to branch from
current `origin/main` — but re-verify §0 of `tasks/fortel2-worker-plan.md`
first if more than a few days have passed.

Model assignment: T1 → strongest model. T2 → mid-tier. T3 → cheapest tier.

---

## Prompt 1 — T1: bridge-leg verification (strongest model)

```
You are a worker agent on the SettlementOS repo. Read CLAUDE.md and AGENTS.md
first — the invariants there are binding. Then read
tasks/prd-fortel2-integration.md (US-F008) and tasks/fortel2-worker-plan.md
(your task is T1). Read the current wave's decisions log at
tasks/fortel2-decisions-<date>.md before starting and append proposals there
per its rules if you hit anything outside your assignment.

TASK
The simulated-bridge code in lib/routing.ts and lib/executor.ts is believed
to be fully generic over sourceNetwork/destinationNetwork, meaning a bridge
leg where one side is fortel2-sepolia should already work with zero code
changes. Your job is to PROVE or DISPROVE that with hermetic tests, and to
write the manual QA runbook for the day a real ForteL2 RPC is reachable.
Treat "it's generic" as a claim to verify, not a fact.

1. Write tests/db/fortel2-bridge-route.test.ts: tests that never dial a
   chain, proving route quoting produces a correct BRIDGE_AND_SETTLE route
   for (a) base-sepolia -> fortel2-sepolia and (b) fortel2-sepolia ->
   base-sepolia, with correct bridge_fee_bps, destination asset resolution,
   and route descriptions naming the right networks. Known seam facts, which
   you should verify still hold: quoteRoutes(paymentId) reads the payment
   row via prisma (hence tests/db, which has the fixture DB), and
   liquidityCheck (lib/routing.ts:103) deliberately degrades to
   {ok:true, recallRequired:false} when the network's chain is unreadable —
   so with a payment row whose networks are fortel2 ids and no fortel2 chain
   running, quoting exercises the full FX/bridge-fee/asset-mapping math while
   liquidity reports ok. Assert the route shape and math; do NOT assert
   recall_required semantics here (they need a live treasury read — cover
   that gap explicitly in the runbook instead). Follow the DB-test patterns
   in tests/db/. If quoting turns out not to be exercisable this way without
   lib changes, that is a FINDING to report, not a license to edit lib code.
2. Read lib/executor.ts's bridge path (the treasuryTokenTransfer destination
   payout, destinationTxHash handling, and the compensate-vs-complete-forward
   decision) line by line against the AGENTS.md invariants "Never refund a
   released escrow; compensate it" and "Compensate only when the recipient
   was not paid". Report — do not fix — anything that would behave
   incorrectly when the destination network is a single-sequencer L2 with no
   replica (fortel2-sepolia has readRpcUrl optional and no explorer).
3. Write tasks/runbooks/fortel2-bridge-manual-qa.md (create the runbooks dir):
   a step-by-step manual verification script for a human with ForteL2 RPC
   access — preconditions (which .env vars, which networks deployed, funding
   state per tasks/fortel2-l2-prereqs.md), the exact API calls for a
   base-sepolia -> fortel2-sepolia bridged payment (mirror the flow in
   README "API"), what SETTLED evidence to capture (both tx hashes, audit
   events, INTACT chain), and the failure/repair paths to spot-check
   (stuckPayments view, compensation path).

CONSTRAINTS
- Allowed to create/edit ONLY: tests/db/fortel2-bridge-route.test.ts,
  tasks/runbooks/fortel2-bridge-manual-qa.md.
- lib/routing.ts, lib/executor.ts, lib/chain.ts are READ-ONLY for you. A bug
  found there goes in your handback as a proposed diff, not a commit.
- Never touch: README.md, DEMO.md, AGENTS.md, CLAUDE.md, PRD.md,
  tasks/prd-fortel2-integration.md, package.json, package-lock.json, any
  chain/deployments*.json, any .env, tests/global-setup.ts, tests/fixture.ts.
- Your tests must not contain a literal 9545 or 9546 — those ports belong to
  the ForteL2 sequencer; the test fixture deliberately moved to 19545/19546.
- No new npm dependencies.

COMMIT AND MERGE CONTRACT
- Branch fortel2/bridge-leg-verification from current origin/main. Never
  branch from another task's branch.
- Small scoped commits, style matching git log: test(fortel2): ...,
  docs(runbook): ...
- Before handback: npx tsc --noEmit && npm run lint && npm test all green.
- Open a PR; do not merge it. End your work by pasting this filled in:

  Task: T1 bridge-leg-verification
  Branch: fortel2/bridge-leg-verification
  Files touched: <list>
  Tests: <before> -> <after>, all green? <y/n>
  Deviations from assignment: <none or exact description>
  Findings outside my allowlist (not fixed, reporting only): <none or list>
  Proposed doc snippet for integrator: <exact text or none>
  New dependency requests: <none or list>
  Open questions for Stephen: <none or list>
  PR: <link>
```

---

## Prompt 2 — T2: deploy/registry hardening (mid-tier model)

```
You are a worker agent on the SettlementOS repo. Read CLAUDE.md and AGENTS.md
first — the invariants there are binding. Then read
tasks/prd-fortel2-integration.md, tasks/f2-prep-notes.md,
tasks/fortel2-l2-prereqs.md, and tasks/fortel2-worker-plan.md (your task is
T2). Read the current wave's decisions log at
tasks/fortel2-decisions-<date>.md before starting and append proposals there
per its rules if you hit anything outside your assignment.

CONTEXT YOU MUST VERIFY, NOT ASSUME
The live chain/deployments.fortel2-sepolia.json overlay (gitignored, exists
locally, dated 2026-07-24) was deployed BEFORE TokenizedMMF support landed in
scripts/deploy-testnet.mjs, so it has no TokenizedMMF field and
mmfAddress("fortel2-sepolia") returns undefined. Re-running the full deploy
script would deploy fresh contracts and orphan the existing escrow/tokens.
Read the script end to end before changing anything.

TASK
1. Add an "MMF add-on" mode to scripts/deploy-testnet.mjs: when the overlay
   for the target network already exists and has PaymentSettlement + tokens
   but no TokenizedMMF, support deploying ONLY the fund (plus its 50k
   mockUSDC yield buffer mint and the treasury MAX approval — mirror what the
   full path and scripts/setup.mjs already do), then merge TokenizedMMF into
   the existing overlay without disturbing the escrow/token/account entries.
   Decide the CLI shape (flag or auto-detect) yourself and state the choice
   in your handback. Idempotency is the hard requirement: a re-run against an
   overlay that already has a fund must be a no-op — it must not deploy a
   second fund, re-mint a second buffer, or stack approvals. Note the
   AGENTS.md gotcha: the treasury MMF approval is deliberately MAX (platform
   account) while entity allowances are exact — do not "fix" that.
2. The preflight ALREADY EXISTS inline (scripts/deploy-testnet.mjs ~lines
   164-174: RPC reachability, chain-id match, deployer balance vs
   minDeployerBalance, all fail-closed). Do not re-add it. The actual work:
   (a) factor those checks plus your new overlay-state detection from item 1
   into small pure/mockable helpers so they are unit-testable without a live
   RPC, and (b) add a --preflight-only (or equivalent) mode that runs the
   checks and the mode decision, prints what a real run WOULD do, and exits
   before any tx — so an operator on the ForteL2 machine can validate the
   environment safely before spending gas.
3. Check whether scripts/setup.mjs's live-network wallet re-registration is
   already generic over LIVE_NETWORK_IDS (it should include fortel2-sepolia
   automatically). If it is, say so in your handback and change nothing. Only
   edit it if you find a real gap.
4. Write tests/unit/deploy-testnet-preflight.test.ts covering the extracted
   preflight checks and the add-on/idempotency decision logic (which mode a
   given overlay state selects), all with mocked RPC/fs — no chain dialed.
   If the script's structure makes the logic untestable without a large
   refactor, extract the minimal pure helpers needed and no more.

CONSTRAINTS
- Allowed to edit: scripts/deploy-testnet.mjs, scripts/setup.mjs (only per
  item 3), tests/unit/deploy-testnet-preflight.test.ts (new).
- Never touch: lib/networks.ts (report gaps, don't edit), any
  chain/deployments*.json (generated artifacts — your script writes them at
  runtime, you never hand-edit or commit one), README.md, DEMO.md, AGENTS.md,
  CLAUDE.md, PRD.md, tasks/prd-fortel2-integration.md, package.json,
  package-lock.json, any .env.
- Do NOT run the script against any real network. Mocked tests only.
- No new npm dependencies.

COMMIT AND MERGE CONTRACT
- Branch fortel2/deploy-hardening from current origin/main. Never branch from
  another task's branch.
- Small scoped commits, style matching git log: feat(deploy): ...,
  test(deploy): ...
- Before handback: npx tsc --noEmit && npm run lint && npm test all green.
- Open a PR; do not merge it. End your work by pasting this filled in:

  Task: T2 deploy-hardening
  Branch: fortel2/deploy-hardening
  Files touched: <list>
  Tests: <before> -> <after>, all green? <y/n>
  Deviations from assignment: <none or exact description>
  Findings outside my allowlist (not fixed, reporting only): <none or list>
  Proposed doc snippet for integrator: <exact text or none>
  New dependency requests: <none or list>
  Open questions for Stephen: <none or list>
  PR: <link>
```

---

## Prompt 3 — T3: MMF live-readiness runbook + coverage (cheapest model)

```
You are a worker agent on the SettlementOS repo. Read CLAUDE.md and AGENTS.md
first — the invariants there are binding. Then read
tasks/prd-fortel2-integration.md (US-F005), tasks/f2-prep-notes.md, and
tasks/fortel2-worker-plan.md (your task is T3). Read the current wave's
decisions log at tasks/fortel2-decisions-<date>.md before starting and append
proposals there per its rules if you hit anything outside your assignment.

TASK — additive only. You create two new files and edit nothing that exists.

1. Write tasks/runbooks/fortel2-mmf-redeploy.md (create the runbooks dir if
   T1 hasn't already; if both tasks create it, git merges directories
   trivially): the operator runbook for bringing TokenizedMMF live on
   fortel2-sepolia once a reachable RPC exists. Cover: preconditions
   (deployer L2 balance, sequencer up, which .env vars), the deploy step
   (reference the deploy script's MMF path — note a parallel task T2 is
   adding an add-on mode; write the runbook against the script's CURRENT
   behavior and add a clearly-marked "once T2's add-on mode lands" variant),
   the yield-buffer funding and treasury-approval steps and WHY they matter
   (AGENTS.md gotcha: an underfunded buffer makes redeem revert; accrual is
   one-way), the verification sequence (park -> accrue -> recall via the
   treasury API, expected +3.5%/365 yield math, escrow balance untouched
   through the cycle = the segregation invariant), and the audit-trail checks
   (TREASURY_* events present, chain INTACT).
2. Write tests/unit/fortel2-treasury-audit.test.ts: hermetic tests (follow
   tests/unit/fortel2-mmf-wiring.test.ts's temp-overlay pattern) proving
   treasury-layer behavior is network-generic for fortel2-sepolia where that
   can be shown without a chain: parkedBalance() returns 0n (never throws)
   when the overlay has no fund; mmfAddress() resolves when it does; and
   whatever pure lib/treasury math (dailyIndex/valueOfShares) is exercisable
   hermetically. Do not duplicate cases fortel2-mmf-wiring.test.ts already
   covers — read it first and complement it.

CONSTRAINTS
- Allowed to create ONLY: tasks/runbooks/fortel2-mmf-redeploy.md,
  tests/unit/fortel2-treasury-audit.test.ts. Zero edits to existing files.
  Your final git diff --stat against main must show only new files.
- If you find a real bug in lib/treasury.ts or anywhere else, report it in
  your handback — do not fix it.
- Your tests must not contain a literal 9545 or 9546 (ForteL2 sequencer
  ports; the test fixture uses 19545/19546).
- Never touch: README.md, DEMO.md, AGENTS.md, CLAUDE.md, PRD.md,
  tasks/prd-fortel2-integration.md, package.json, package-lock.json, any
  chain/deployments*.json, any .env.
- No new npm dependencies. No chain dialed in tests.

COMMIT AND MERGE CONTRACT
- Branch fortel2/mmf-runbook from current origin/main. Never branch from
  another task's branch.
- Small scoped commits, style matching git log: docs(runbook): ...,
  test(fortel2): ...
- Before handback: npx tsc --noEmit && npm run lint && npm test all green.
- Open a PR; do not merge it. End your work by pasting this filled in:

  Task: T3 mmf-runbook
  Branch: fortel2/mmf-runbook
  Files touched: <list — new files only>
  Tests: <before> -> <after>, all green? <y/n>
  Deviations from assignment: <none or exact description>
  Findings outside my allowlist (not fixed, reporting only): <none or list>
  Proposed doc snippet for integrator: <exact text or none>
  New dependency requests: <none or list>
  Open questions for Stephen: <none or list>
  PR: <link>
```

---

# ForteL2 Wave 2 — T4 prompt (added 2026-08-03, after T1/PR #33 merged)

Dispatch only after PR #33 is on main (it is, as of `0dcac71`). Model:
strongest available, high reasoning effort — this task touches the
compensate/complete-forward correctness invariants directly.

## Prompt 4 — T4: executor resilience for a flaky single-sequencer L2 (strongest model)

```
You are a worker agent on the SettlementOS repo. Read CLAUDE.md and AGENTS.md
first — the invariants there are binding, especially "Never refund a released
escrow; compensate it", "Compensate only when the recipient was NOT paid;
otherwise complete forward", and "Reconcile with the chain before undoing
anything". Then read tasks/fortel2-worker-plan.md (your task is T4) and
tasks/fortel2-decisions-2026-08-03.md — entries T1-1 and T1-2 are APPROVED
and are your brief. Append your own proposals under the T4 heading per the
log's rules.

CONTEXT (verified by the integrator, but re-verify before coding)
ForteL2 (fortel2-sepolia, 852) is a single-sequencer personal L2: no replica
fleet, no SLA, and its RPC can drop mid-settlement. Two confirmed weaknesses:

T1-1 (PRIMARY — real double-pay window): treasuryTokenTransfer
(lib/chain.ts ~431-437) submits the destination payout via writeContract,
then confirm() awaits the receipt before returning; lib/executor.ts writes
destinationTxHash only after that returns (~line 393). If the RPC drops
after the transfer MINES but before the receipt arrives, the throw reaches
the executor catch with destinationTxHash still null -> the reconciliation
treats the recipient as unpaid -> compensateSender pays the sender back on
source while the recipient already holds the destination tokens. Treasury
pays twice.

T1-2 (SECONDARY — latency only): operatorWrite's retryOnReplicaLag
(lib/chain.ts ~264-308) classifies "not initiated"/"insufficient allowance"
errors as transient replica lag and retries 4x2s. On a single-node chain
those are usually real failures; a ForteL2 source leg burns ~8s before
failing closed. No correctness break.

THE TRAP — read this twice
The naive T1-1 fix (persist the hash the moment writeContract returns)
INVERTS the bug: the catch path currently treats a non-null
destinationTxHash as proof the recipient was paid (it runs
completeSettledPayout, which marks SETTLED). A hash written before the
receipt is evidence of an ATTEMPT, not of payment — the tx can revert or
never mine. Persist-early without changing the reconciliation would mark
payments SETTLED whose recipient got nothing. Your design must distinguish
"payout attempted (hash known, outcome unknown)" from "payout confirmed",
and the catch path must resolve "attempted" by READING THE DESTINATION
CHAIN (receipt lookup for the known hash): confirmed -> complete forward;
definitively absent/reverted -> compensate; unreadable -> leave the payment
in a non-terminal state for the operator repair view (stuckPayments), never
auto-compensate and never auto-complete on unknown evidence. That is the
existing source-side "reconcile before undoing" invariant, extended to the
destination leg.

TASK
1. Fix T1-1 along the lines above. Design choices are yours (e.g.
   treasuryTokenTransfer returning {hash, wait()} so the executor can
   persist the attempt before awaiting confirmation; how to represent
   attempted-vs-confirmed — an audit event alongside the column, a second
   column via decisions-log proposal, or deriving it from status). Keep the
   blast radius small: do not touch lib/state.ts or lib/transitions.ts —
   if you believe a new payment status is unavoidable, STOP and propose it
   in the decisions log first (expect pushback; PAYOUT_PENDING +
   COMPENSATION_PENDING + the stuck view likely already cover the
   operator-facing states you need).
2. Make stuckPayments()/repairCompensation() aware of the new
   attempted-unknown case if they are not already: a payment whose payout
   attempt has an unknown outcome must stay visible in the stuck view, and
   repairCompensation must not compensate one whose destination receipt now
   reads confirmed (it should complete forward instead, or at minimum
   refuse and say why).
3. Fix T1-2 with the smallest change that works: make the transient
   classifier or retry budget network-aware (a single-sequencer chain gets
   fewer/no replica-lag retries). Do not invent per-network config
   machinery if a simple property on the existing NETWORK/deployment shape
   or a parameter threaded from the caller suffices. Justify the shape you
   pick in your handback.
4. Tests in tests/integration/executor-rpc-resilience.test.ts (new file),
   driven through executorTestHooks (lib/executor.ts ~52-108) on the local
   fixture chains — CI must never depend on a ForteL2 stack being up. You
   may ADD hooks to ExecutorTestHooks if the existing seams cannot express
   receipt-loss-after-mine (likely: a hook between tx submission and
   receipt await inside the payout leg). Cover at minimum:
   a. receipt lost AFTER the payout mined -> reconciliation completes
      forward, recipient NOT double-paid, sender NOT compensated;
   b. payout tx never mined / reverted -> compensateSender runs exactly
      once, ledger + audit consistent;
   c. destination chain unreadable during reconciliation -> payment stays
      non-terminal, appears in stuckPayments, no money moves;
   d. repairCompensation on case (a)'s payment refuses to double-pay;
   e. T1-2: the retry classifier change (unit-style is fine for this one).
   Every test asserts the audit trail matches what actually happened
   (events only for landed writes, chain INTACT).

CONSTRAINTS
- Allowed to edit: lib/chain.ts, lib/executor.ts,
  tests/integration/executor-rpc-resilience.test.ts (new).
- prisma/schema.prisma, lib/state.ts, lib/transitions.ts: decisions-log
  proposal required BEFORE touching (expect no for the latter two).
- Never touch: README.md, DEMO.md, AGENTS.md, CLAUDE.md, PRD.md,
  tasks/prd-fortel2-integration.md, package.json, package-lock.json, any
  chain/deployments*.json, any .env, scripts/*.
- No literal 9545/9546 in tests (ForteL2 sequencer ports; fixture uses
  19545/19546).
- No new npm dependencies.
- Audit invariants apply in full: events in the same transaction as what
  they describe, no bigint in audit detail JSON, actor "system" for
  executor-initiated events.

COMMIT AND MERGE CONTRACT
- Branch fortel2/executor-rpc-resilience from current origin/main. Never
  branch from another task's branch.
- Small scoped commits: fix(executor): ..., fix(chain): ...,
  test(executor): ...
- Before handback: npx tsc --noEmit && npm run lint && npm test all green.
- Open a PR; do not merge it. End your work by pasting this filled in:

  Task: T4 executor-rpc-resilience
  Branch: fortel2/executor-rpc-resilience
  Files touched: <list>
  Tests: <before> -> <after>, all green? <y/n>
  Deviations from assignment: <none or exact description>
  Findings outside my allowlist (not fixed, reporting only): <none or list>
  Proposed doc snippet for integrator: <exact text or none>
  New dependency requests: <none or list>
  Open questions for Stephen: <none or list>
  What to verify LIVE once the ForteL2 stack is up on this machine
  (2026-08-04+): <specific manual checks your hermetic tests could not
  cover>
  PR: <link>
```
