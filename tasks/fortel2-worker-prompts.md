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

---

# T5 — hardening review (final worker task, added 2026-08-07)

Dispatch after PR #40 (live-session results + doc flips) is on main. Model:
strongest available, high reasoning effort. This is a **review-first** task
over money paths; see the calibration note in the prompt.

## Prompt 5 — T5: ForteL2 hardening review (strongest model, high effort)

```
You are the final worker on the SettlementOS ForteL2 integration: an
adversarial hardening review of everything the integration added. You are the
last gate before this surface is called done.

READ FIRST, IN THIS ORDER
1. CLAUDE.md and AGENTS.md — the invariants there are binding. Pay closest
   attention to: "Never refund a released escrow; compensate it", "Compensate
   only when the recipient was *not* paid; otherwise complete forward",
   "Reconcile with the chain before undoing anything", "A stranded payment
   must stay visible", "Audit only what happened, in the same transaction as
   what happened", and "MMF segregation".
2. AUDIT.md — the methodology to imitate: severity-tagged findings, each with
   the relevant code and a concrete remediation.
3. tasks/fortel2-worker-plan.md (you are T5) and
   tasks/fortel2-decisions-2026-08-03.md (entries T1-1 through T4-3).
4. tasks/runbooks/fortel2-live-session-2026-08-07.md — what was proven live
   on the real 852 chain, and what was NOT.

**Read current main before trusting any status claim above, including mine.**
Every "done" in this prompt is a claim to verify, not a fact. The plan document
itself was written by checking claims against the repo and finding one that was
overstated; do the same to it.

WHY THIS EXISTS
T1–T4 shipped in two waves (PRs #33, #34, #35, #37) and were reviewed
individually as they landed, but nobody has looked at the resulting surface as
a whole. Individually-correct changes compose into gaps. Two of them touched
money paths directly:
- T4 (PR #37) changed when a destination payout is believed: the payout hash is
  now persisted BEFORE the receipt is awaited, and the executor's catch
  reconciles it with transactionOutcome() before compensating or completing
  forward. That is the difference between a treasury double-pay and a correct
  undo.
- T2 (PR #34) made scripts/deploy-testnet.mjs mode-aware (full / MMF add-on /
  no-op). It moves real testnet funds and deploys contracts.
The 2026-08-07 live session exercised the happy paths on the real ForteL2
sequencer (MMF park->accrue->recall, cross-chain settles both directions, both
bridge audit events in order). It did NOT exercise any failure path live.

SCOPE OF THE REVIEW
The ForteL2-specific surface and what T1–T4 changed — NOT a re-audit of the
whole payments product (Phase 9 Track A covered that):
- lib/chain.ts — transactionOutcome, replicaLagRetries, SubmittedTx /
  treasuryTokenTransfer, mmfAddress, operatorWrite's retry classifier
- lib/executor.ts — reconcileDestinationPayout, the catch-path ordering,
  completeSettledPayout, stuckPayments, repairCompensation, the bridge payout leg
- lib/networks.ts — the fortel2-sepolia / fortel2-local entries, the read/write
  RPC split
- scripts/deploy-testnet.mjs — mode detection, the add-on path, preflight helpers
- lib/treasury.ts and lib/routing.ts ONLY where ForteL2/MMF behaviour is
  involved (both are network-generic; do not re-review them wholesale)
- the tests T1–T4 added: are they load-bearing, or do they pass vacuously?

FOUR KNOWN RESIDUALS — rule on each explicitly, by id, in your report
R1. An unresolved PAYOUT_PENDING payment (destination receipt unreadable) has
    NO automated resolution path: executePayment's lease CAS requires status
    APPROVED so execute cannot resume it, and repairCompensation only accepts
    COMPENSATION_PENDING. It sits in stuckPayments() until a human acts.
    Is that acceptable-and-documented, or a gap that strands funds in practice?
R2. In the cross-chain payout leg, the destinationTxHash write and its
    bridge.destination_payout_submitted audit event are separate operations,
    not one prisma.$transaction — arguably outside "audit in the same
    transaction as the domain write". Rule on BOTH bridge events together.
    Note this matches the file's pre-existing pattern, so "it was already like
    that" is not by itself an answer.
R3. deploy-testnet.mjs idempotency is mode-level ONLY: a run that dies between
    the fund deploy and the overlay merge leaves an orphaned TokenizedMMF that
    a re-run will not reuse (it re-detects mmf_addon and deploys another). The
    mmfYieldBufferSatisfied / treasuryMmfApprovalSatisfied helpers do not
    protect against this — they are unreachable on a freshly deployed fund.
    Accept with a documented caveat, or fix?
R4. transactionOutcome's "absent" branch is unreachable from a live chain
    (viem throws TransactionReceiptNotFoundError rather than returning null),
    so every no-receipt case maps to "unknown". Confirm the code comment
    explaining this is accurate and sufficient. SEE THE TRAP.

THE TRAP — the highest-value paragraph here; read it twice
The most likely way this task does damage is a confident "cleanup" of R4.
Making a missing receipt return "absent" instead of "unknown" looks like
finishing an unfinished branch. It would reintroduce the exact double-pay T4
was written to prevent: the executor's catch compensates the sender on
"absent", and a transaction sitting in the mempool is indistinguishable from
one that will never mine — so the treasury would repay the sender while the
recipient's payout lands moments later. One receipt read cannot tell those
apart. The same hazard has a second face: "fixing" R1 with an automatic retry
that resolves an unknown outcome by guessing. Any change that lets the system
act on unknown evidence is wrong, however tidy it looks. If you believe R4's
branch should change, that is a decisions-log proposal, not a commit.

WHAT MUST NOT CHANGE
- The state machine (lib/state.ts) and the transition contract
  (lib/transitions.ts). A new payment status is a decisions-log proposal;
  expect no.
- prisma/schema.prisma — decisions-log proposal required first.
- The fail-closed rules: compliance provider errors resolve MANUAL_REVIEW
  (never PASS); a missing ForteL2 RPC fails closed and never falls back to
  another chain.
- Tenant scoping as a WHERE filter, the 404-not-403 rule, and the
  audit-actor-from-the-key rule.
- **Do not weaken existing tests.** If a test must change because it encoded
  the behaviour you are fixing, that is legitimate — declare it in the
  handoff with your reasoning. Silently rewritten assertions are how
  invariants die.

WHAT TO PRODUCE
1. `tasks/fortel2-hardening-review-2026-08.md` — findings in AUDIT.md's style,
   severity-tagged (P0/P1/P2), each with: the relevant file:line, a concrete
   failure scenario (inputs/state -> wrong outcome), and a remediation. An
   explicit ruling on R1–R4 by id. If you find nothing at a severity, say so
   and say what you looked for — a review that reports "all clear" without
   naming its coverage is indistinguishable from one that didn't run.
2. Fixes ONLY for findings that are clearly in scope and low-risk, each with a
   regression test. Anything larger is a finding, not a commit. No refactors,
   no renames, no "while I was in there".
3. Decisions-log entries under the existing `## T5` heading in
   tasks/fortel2-decisions-2026-08-03.md, numbered **T5-1, T5-2, T5-3, …** in
   the order you raise them. These ids are pre-assigned: use them, and do NOT
   scan the file for the highest existing number. If you believe you need a
   different id, stop and ask.

FILE SCOPE
- Owned (may change freely): tasks/fortel2-hardening-review-2026-08.md (new),
  plus new test files you add under tests/.
- Narrow, fix-only (touch ONLY to fix a finding you documented first, minimal
  diff): lib/chain.ts, lib/executor.ts, lib/networks.ts,
  scripts/deploy-testnet.mjs, lib/treasury.ts, lib/routing.ts, and existing
  test files.
- Shared, additive only: tasks/fortel2-decisions-2026-08-03.md — append under
  `## T5` only, never edit another task's entries (they are append-only
  history).
- Off-limits: README.md, DEMO.md, AGENTS.md, CLAUDE.md, PRD.md,
  tasks/prd-fortel2-integration.md (a doc-freeze is in effect so parallel
  workers stop colliding in prose — hand doc changes back as snippets);
  package.json / package-lock.json (dependency freeze — a lockfile merged out
  of order is a real conflict); any chain/deployments*.json (generated, holds
  private keys, gitignored); any .env; lib/state.ts; lib/transitions.ts;
  prisma/schema.prisma.
**If you find yourself needing to change something off-limits, stop and report
rather than widening scope.**

OUT OF SCOPE, AND WHY
- Re-auditing auth, tenant scoping, rate limits, pagination, idempotency, or
  the audit chain in general — Phase 9 Track A did that (see CLAUDE.md); only
  flag one if a ForteL2/T1–T4 change specifically broke it.
- The three T4 live checks that did not run (receipt-loss-completes-forward,
  unresolved-stays-stuck, repair-refuses-on-confirmed). They need failure
  injected between a tx mining and its receipt returning, which requires the
  test-only executorTestHooks. The hermetic tests cover them. Do not build a
  live harness.
- Base Sepolia / Polygon Amoy restoration — their overlays and signing keys
  are gone from the dev machine; restoring one is a deliberate decision with
  documented-address consequences, not a cleanup task.
- F6 (explorer, separate repo) and F8 (canonical USDC, joint-later).

THE GATE — run at handoff time, after rebasing onto current origin/main
```bash
git fetch origin && git rebase origin/main
npx tsc --noEmit
npm run lint
npm test
```
`npm test` is self-contained (it boots its own chains on 19545/19546 and builds
a fresh DB under tests/.tmp) — no dev chains, no DATABASE_URL, no ForteL2 stack.
CI must never depend on the ForteL2 sequencer being up; if you add a test that
dials 9545/9546, that is a bug in the test.
**Baseline is 438 passing.** Report the exact count. Unexplained movement in
either direction is itself a finding — including tests that vanish.
Green against a stale base tells you nothing; rebase first.

THE TESTS THAT MATTER
Ask of each regression test: what property does this pin, and would it fail if
the bug came back in a slightly different shape? State the property, not the
file. Specifically, if you touch the reconciliation path, there must be a test
asserting that **an unknown destination outcome moves no money in either
direction** — neither compensating the sender nor completing forward. That is
the property the whole T4 design exists to protect.
If you find a bug you cannot cover with the existing harness, say so, say what
you hand-verified instead, and do NOT build new harness infrastructure for it.

IF YOU THINK THIS IS WRONG
If you believe the review scope is wrong, a residual is misdiagnosed, or one of
my assertions above is simply incorrect, say so and argue it with evidence
rather than implementing it half-heartedly. You are the last gate; a
well-argued disagreement is worth more than a compliant review. I have been
wrong at least once per wave so far.

COMMIT AND MERGE CONTRACT
- Branch `fortel2/hardening-review` from current origin/main. Never branch from
  another task's branch. (`cursor/<slug>-<hash>` is an accepted alternative if
  your PR tooling requires that prefix.)
- Small scoped commits: `docs(review): …`, `fix(chain): …`, `fix(executor): …`,
  `test(executor): …`.
- Open a PR; do NOT merge it.
- Hand back EXACTLY this block, filled in:

TASK:        T5 — ForteL2 hardening review
BRANCH:      fortel2/hardening-review
PR:          <url>
STATUS:      complete | complete-with-caveats | blocked

GATE:        lint ✅  typecheck ✅
             tests <N> passed  (baseline 438; explain any delta)
MIGRATION:   none  (this repo has no migrations dir — schema is db push)

FINDINGS:    P0 <n>, P1 <n>, P2 <n>  — full detail in
             tasks/fortel2-hardening-review-2026-08.md
RULINGS:     R1 <accept|fix|escalate> — <one line>
             R2 <…>   R3 <…>   R4 <…>

SHARED FILES TOUCHED:
  <path> — what changed, why it is additive
  (or: none)

DECISION-LOG ENTRIES ADDED:
  T5-1 <title> … (or: none)

EXISTING TESTS MODIFIED:
  <path> — <old assertion> → <new assertion>; why this is a strengthening,
  not a weakening
  (or: none)

DECISIONS NEEDED FROM STEPHEN:
  none | <the question, and what you did in the meantime>

RISKS AND FOLLOW-UPS:
  What this review does NOT cover. What was hand-verified vs automated.
  Residual risk stated plainly rather than implied. Anything you chose not to
  fix, and why.
```
