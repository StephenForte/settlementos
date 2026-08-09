# ForteL2 integration — worker-ready plan

Prepared 2026-08-03. Companion to `tasks/prd-fortel2-integration.md` (the brief)
and `tasks/coordination-settlementos.md` (ownership rules). This file is the
dispatch plan for parallel coding agents: task tree, ownership, model tiers,
the commit/merge contract every task follows, review checklists, and the
first three ready-to-paste prompts.

## 0. Verified state (read this before assigning anything)

Checked against the repo on **2026-08-09** (origin/main @ `4513d96`), re-verified
against [`tasks/runbooks/fortel2-live-session-2026-08-07.md`](runbooks/fortel2-live-session-2026-08-07.md)
for every live ForteL2 claim and against
[`settlementos-explorer`](https://github.com/StephenForte/settlementos-explorer)
`main` @ `f669cbe` for F6 — not just the PRD's checkboxes:

| Claim | Verified | Evidence |
|---|---|---|
| F1 network registry | **True** | `lib/networks.ts` has `fortel2-sepolia` (852) and `fortel2-local` (901); RPC from env with loopback default to the operator Mac; `tests/unit/networks.test.ts` covers it. F1 landed PR #21 |
| F2 deploy script | **True** | `scripts/deploy-testnet.mjs` has a `fortel2-sepolia` `NETWORK_CONFIGS` entry; overlay at `chain/deployments.fortel2-sepolia.json` (gitignored, dated 2026-07-24) with `PaymentSettlement` + tokens + operator/treasury/entity wallets. F2 landed PR #24 |
| F3 single-chain settle | **True (live-verified 2026-08-07)** | First settle `pay_8c318fcae804` (2026-07-24, PR #26) re-confirmed **SETTLED** in the DB during the live session — [`tasks/runbooks/fortel2-live-session-2026-08-07.md`](runbooks/fortel2-live-session-2026-08-07.md) § "Earlier ForteL2 history". Same session also settled a fresh $25k payment on 852 |
| F4 MMF on ForteL2 | **True live (2026-08-07)** | Add-on deploy wrote `TokenizedMMF` **`0xaed29387417dad9ab1993332e2c2b99d35ffe7ff`** into the overlay; park→accrue→recall on 50k returned 50004.79452 with escrow untouched. Evidence: live-session runbook § F4. Hermetic wiring: `tests/unit/fortel2-mmf-wiring.test.ts` |
| F5 docs | **True** | README/DEMO/AGENTS/PRD synced; ForteL2 uptime disclosure in README § ForteL2 (2026-08-08), mirrored into DEMO Part E + PRD (2026-08-09) |)
| F6 explorer address book | **Done (out of repo)** | [`settlementos-explorer`](https://github.com/StephenForte/settlementos-explorer) `main` @ `f669cbe`. Address book + `mmf-contract` role: PR [#4](https://github.com/StephenForte/settlementos-explorer/pull/4) → `20f17ff` (11 ForteL2 rows). Design system: PR [#6](https://github.com/StephenForte/settlementos-explorer/pull/6) → `223d452`. F6a–F6q series complete; tracking doc is that repo's [`docs/PLAN.md`](https://github.com/StephenForte/settlementos-explorer/blob/main/docs/PLAN.md) §0. Address provenance is out-of-band (F6c chain-852 liveness + F6f against `chain/deployments.fortel2-sepolia.json`) — the explorer's `EXPECTED` unit test is a tautology (PLAN §6 trap 2), not the verification |
| F7 bridge leg via ForteL2 | **True live (2026-08-07)** | Both directions settled with dual hashes: `base-local`→`fortel2-sepolia` (`pay_6f678a415d2b`, ~4.5s) and `fortel2-sepolia`→`base-local` (`pay_302fbe6a0541`, ~12.5s). Evidence: live-session runbook § F7. Hermetic quote math: `tests/db/fortel2-bridge-route.test.ts` (T1) |
| US-F007 (Sepolia-backed overlay) | **Resolved (2026-08-09)** | All four criteria ticked in [`tasks/prd-fortel2-integration.md`](prd-fortel2-integration.md) § US-F007 — including explorer address book (F6a PR #4 → `20f17ff`) |

Two hard blockers that shaped this plan — **corrected 2026-08-08**:

1. **~~No reachable ForteL2 RPC from this machine.~~ Cleared on the operator's Mac.**
   The ForteL2 stack runs locally (`http://127.0.0.1:9545`); the 2026-08-07 live
   session verified F4 and F7 against it. **Still true for CI and remote workers:**
   GitHub Actions and sandbox VMs cannot dial that loopback — ForteL2-touching
   tasks remain scoped to code + hermetic tests + runbooks unless run on the Mac.
2. **`fortel2-local` (901) is still operated outside this repo** (Anvil devnet ForteL2
   runs, not our Hardhat nodes) — unlike `base-local`/`polygon-local`, there is
   no way to spin up a throwaway ForteL2 chain in CI or a worker's sandbox.

Consequence for planning: hermetic tests and runbooks are the default for workers;
**live 852 verification is ops work on the ForteL2 Mac** — done for F3/F4/F7 on
2026-08-07 ([`tasks/runbooks/fortel2-live-session-2026-08-07.md`](runbooks/fortel2-live-session-2026-08-07.md)).
F6 address-book confirmation (F6c/F6f) is also done in the explorer repo; future
live checks (F8 cutover, buffer top-ups) follow the same pattern.

## 1. Branching scheme: what you described is the wrong shape

"Agents start from main or a shared branch" is two different failure modes
depending on which one happens:

- **Shared branch**: every agent's diff lands on top of every other agent's
  in-progress diff. This is the worst option — it turns three independent
  tasks into one long serial dependency chain with unreviewed intermediate
  states, and nobody can `git bisect` or roll back one task without touching
  the others. Stop using this.
- **All from main, independently**: fine in principle, but the pain you're
  describing (three agents finish, you lose real time to conflicts) means the
  *files* aren't actually partitioned — they're colliding on the same lines,
  usually in shared prose docs and lockfiles, not in the "real" code.

Looking at the actual git history here, every past ForteL2 PR touched
`README.md`, `DEMO.md`, `AGENTS.md`, `CLAUDE.md`, and often `PRD.md` *together*
with its code change (e.g. PR #29, PR #31). That's your conflict source: N
parallel agents each rewriting the same "State" section of the same files.

**Recommended shape — trunk-based, strict path ownership, docs deferred:**

1. Every task branches from **current `origin/main`** at kickoff, never from
   another task's branch. Branch name: `fortel2/<task-slug>`.
2. Each task gets a **disjoint file allowlist** (below). A task that discovers
   it needs to touch a file outside its allowlist stops and reports it as a
   decision, rather than editing it.
3. **Workers never edit shared prose/status files** — `README.md`, `DEMO.md`,
   `AGENTS.md`, `CLAUDE.md`, `PRD.md`, `tasks/prd-fortel2-integration.md`.
   These are the files that were colliding. Instead, each task's handback
   report includes the *proposed* doc snippet (a few sentences / a checklist
   flip), and you (or one "integrator" pass) apply all of them in a single
   commit after each wave merges. This is the single highest-leverage change
   from what you're doing today.
4. **No new npm dependencies without a decision-log entry first** (§4). A
   lockfile diff from two branches merged out of order is exactly the kind of
   conflict that eats your afternoon.
5. Merge **one task at a time, in the integration order below**, straight to
   `main` (squash merge). Because file allowlists are disjoint, most merges
   should be fast-forward-clean with no rebase needed. Only tasks that share
   files (named in §5) need to branch *after* the task they depend on has
   merged.
6. Keep tasks short-lived (aim: mergeable same day). The longer a branch
   lives, the more its assumptions about `main` drift.

This gets you most of what a shared branch was trying to buy (agents building
on each other's work) without its cost (serialized, unreviewable diffs) — by
making the dependency explicit in the *order* you kick tasks off, not in a
shared ref.

## 2. Task tree

```
Wave 1 (parallel, kick off now, all branch from current main)
├─ T1  F7 hermetic bridge-leg verification + manual QA runbook
├─ T2  ForteL2 deploy/registry hardening (preflight, idempotent MMF add-on)
└─ T3  MMF live-readiness runbook + audit/test coverage (additive only)

Wave 2 (sequenced — branch only after named Wave 1 task merges)
├─ T4  Executor resilience for a best-effort/flaky L2 RPC   [after T1 merges]
└─ T5  Hardening review pass over the full ForteL2 surface  [after T1–T4 merged]

Integration-only (not a parallel-agent task — you or one reviewer, not delegated)
└─ I6  Consolidate docs: CLAUDE.md/README/AGENTS/PRD state + checkbox updates
```

F6 (explorer) is out of this repo's tree entirely and **complete** on
[`settlementos-explorer`](https://github.com/StephenForte/settlementos-explorer)
`main` @ `f669cbe` (F6a–F6q). Further explorer work is tracked in that repo's
[`docs/PLAN.md`](https://github.com/StephenForte/settlementos-explorer/blob/main/docs/PLAN.md),
not here. F8 (canonical USDC) is explicitly a joint-later decision per the PRD —
not plannable yet.

### Task detail

#### T1 — F7 hermetic bridge-leg verification + runbook (US-F008)

**Goal:** Prove the existing bridge code has no hardcoded network-pair
assumption that would break when one leg is `fortel2-sepolia`/`fortel2-local`,
and hand you a manual QA script for the day a real ForteL2 RPC is reachable.
Do **not** attempt to build new bridge logic — `lib/routing.ts` already
quotes `BRIDGE_AND_SETTLE` off `sourceNetwork`/`destinationNetwork` generically
(see `lib/routing.ts:137-238`), and `lib/executor.ts` already runs the
simulated bridge payout off the same generic `destNet` (see
`lib/executor.ts:223`, `:385-407`). This task is verification, not invention.

**Owns (may edit):**
- `tests/db/fortel2-bridge-route.test.ts` (new file — `quoteRoutes` reads the
  payment row via Prisma, so this is a DB test, not a pure unit test;
  `liquidityCheck` degrades to ok-true when the network's chain is
  unreachable, which is exactly what makes hermetic quoting possible)
- `tasks/runbooks/fortel2-bridge-manual-qa.md` (new file, new dir)

**Forbidden:**
- `lib/routing.ts`, `lib/executor.ts`, `lib/chain.ts` — read-only. If a real
  bug is found, report it in the handback as a proposed fix with a diff, do
  not commit it in this branch — that's a decision for the integrator to
  route (possibly into T4).
- Any file in the "workers never edit" doc list (§1.3)
- `scripts/deploy-testnet.mjs`, `scripts/setup.mjs` (T2's territory)

**Model:** strongest available. Small diff, but it requires correctly
understanding compensation/bridge semantics (AGENTS.md invariants: "Never
refund a released escrow; compensate it," "Compensate only when the recipient
was *not* paid") well enough to write a test that actually exercises the
right path, not a shallow one.

#### T2 — ForteL2 deploy/registry hardening

**Goal:** Close the gap that let F4 read as "done" when the live overlay has
no fund. Make the deploy script able to **add** `TokenizedMMF` to an existing
`fortel2-sepolia` overlay that was deployed before F4 shipped (idempotent
"upgrade" re-run). The preflight itself (RPC reachability, chain-id match,
deployer balance, all fail-closed) **already exists inline** at
`scripts/deploy-testnet.mjs:164-174` — verified, don't re-add it. The real
work there is factoring it into unit-testable helpers and adding a
`--preflight-only` mode that validates and prints the planned actions
without spending gas.

**Owns (may edit):**
- `scripts/deploy-testnet.mjs`
- `scripts/setup.mjs` (only the `LIVE_NETWORK_IDS` re-registration path, if a
  real gap is found — check first, it may already be generic)
- `tests/unit/deploy-testnet-preflight.test.ts` (new file, testing the
  extracted validation helpers with a mocked RPC client)

**Forbidden:**
- `lib/networks.ts` — F1's fail-closed validation already exists per the
  verified state above; if this task finds a real gap in it, report it, don't
  edit it (that's registry-layer, not deploy-layer, and touches the same file
  T4 might need)
- `chain/deployments.*.json` — these are generated artifacts and gitignored;
  never hand-edit or commit one
- Doc list (§1.3)

**Model:** mid-tier is fine. This is pattern-following work — Base Sepolia and
Polygon Amoy already establish the shape for everything except the
"add MMF to an existing overlay" idempotency, which is the one part that
needs real care (must not silently re-mint a second buffer or double-approve
in a way that breaks the "exact allowance" invariant).

#### T3 — MMF live-readiness runbook + audit/test coverage

**Goal:** Purely additive. Write the runbook for redeploying
`fortel2-sepolia` with the fund once T2 ships and a real RPC is reachable
(fund the yield buffer, treasury-approve, verify segregation — mirror the
`scripts/setup.mjs` local pattern per the AGENTS.md gotcha on funding the
buffer). Add confirmatory tests that treasury/audit behavior is already
network-generic for any `fortel2-*` id (it should be — `lib/treasury.ts` is
described as network-generic in AGENTS.md — this task proves it, doesn't
change it).

**Owns (may edit):**
- `tasks/runbooks/fortel2-mmf-redeploy.md` (new file)
- `tests/unit/fortel2-treasury-audit.test.ts` (new file)

**Forbidden:**
- Every existing `lib/` file — this task adds files, it does not edit any
  existing source. If it finds a real bug, report it, don't fix it here.
- Doc list (§1.3)

**Model:** cheapest tier that can write correct Vitest tests and clear
prose. Zero blast radius by construction (new files only).

#### T4 — Executor resilience for a best-effort/flaky L2 RPC [Wave 2]

**Prerequisite:** branch only after T1 has merged to `main` (shares
`lib/executor.ts`/`lib/chain.ts` with T1's read-only findings; starting after
avoids a rebase surprise if T1 surfaced a real fix).

**Goal:** ForteL2 is explicitly "best-effort uptime... personal L2, not SLA"
(US-F007). `operatorWrite` already wraps state-dependent calls in
`retryOnReplicaLag` for public-RPC replica lag (Base Sepolia/Amoy). Evaluate
whether that's sufficient for a single-sequencer, no-replica, possibly-down
L2, or whether execution needs a bounded timeout + clear
`ExecutionLeaseError`-style failure rather than hanging — and whether a
mid-flight RPC outage during a ForteL2 leg is correctly reconciled by the
existing "read the chain before undoing anything" logic
(`onchainPaymentState()` path) or needs a network-specific timeout budget.

**Owns (may edit):**
- `lib/chain.ts` (retry/timeout logic only)
- `lib/executor.ts` (only the reconciliation path, if a real gap is found)
- `tests/integration/executor-rpc-resilience.test.ts` (new file)

**Forbidden:** doc list (§1.3); no changes to the state machine
(`lib/state.ts`) or transition contract (`lib/transitions.ts`).

**Model:** strongest available, high effort. This touches the
compensation/refund correctness invariants directly — the highest-blast-radius
task in the tree.

#### T5 — Hardening review pass [Wave 2, final gate]

**Prerequisite:** branch after T1–T4 are all merged.

**Goal:** A read-heavy adversarial review of everything the ForteL2
integration added or changed across F1–F5 plus T1–T4, modeled on the existing
`AUDIT.md` methodology (severity-tagged findings with relevant code and
remediation) and the Phase 9 Track A multi-angle review referenced in
`CLAUDE.md`. Scope: the ForteL2-specific surface only (network registry entries,
deploy script, MMF wiring, bridge-leg code, the new resilience logic from T4)
— not a re-audit of the whole payments product, which Phase 9 already covered.
Fix only what's clearly in-scope and low-risk; anything bigger gets reported
as a finding, not silently patched.

**Owns:** whatever files its own confirmed findings require — narrow, targeted
fixes only, each with a regression test. No refactors.

**Model:** strongest available. This is the gate before you call the
hardening phase complete.

#### I6 — Doc consolidation [integration-only, not delegated]

After T1–T5 land, apply the accumulated doc-diff proposals from every
handback report to `CLAUDE.md`, `README.md`, `AGENTS.md`, `DEMO.md`, and flip
the checkboxes in `tasks/prd-fortel2-integration.md` in one pass. Do this
yourself or with a single reviewing agent — never split across workers.

## 3. Model assignment summary

| Task | Model tier | Why |
|---|---|---|
| T1 | Strongest | Small diff, but wrong understanding of compensation semantics produces a test that proves nothing |
| T2 | Mid | Pattern-following against two existing examples; one idempotency subtlety to get right |
| T3 | Cheapest | Additive only, zero existing-file edits, easy to verify |
| T4 | Strongest, high effort | Directly touches refund/compensation correctness — highest blast radius in the tree |
| T5 | Strongest | Adversarial review quality scales with model strength |

## 4. Shared decisions doc

Use `tasks/fortel2-decisions-log-template.md` as the template. At the start of
each wave, copy it to a dated instance (e.g. `tasks/fortel2-decisions-2026-08-03.md`)
that every worker in that wave reads before starting and appends to under
**their own task's heading only** (so concurrent appends land in different
line ranges and merge cleanly). Anything that would otherwise cause a worker
to touch a forbidden file, add a dependency, or deviate from its allowlist
goes here first, as a proposal, not as code.

## 5. Review checklist (apply to every task's output before merging)

**Universal, every task:**
- [ ] Branch is `fortel2/<task-slug>` off a commit that was `origin/main` HEAD
      at kickoff (not another task's branch)
- [ ] Diff touches only files in that task's allowlist — grep the diff for any
      of: `README.md`, `DEMO.md`, `AGENTS.md`, `CLAUDE.md`, `PRD.md`,
      `tasks/prd-fortel2-integration.md`, `package-lock.json`. Any hit is an
      automatic bounce back to the worker unless it was pre-approved in the
      decisions log.
- [ ] `npx tsc --noEmit && npm run lint && npm test` all green, and the
      handback report states the before/after test count
- [ ] No new npm dependency unless logged and approved beforehand
- [ ] Commit messages follow the repo's existing scoped style
      (`feat(fortel2): ...`, `test: ...`, `fix(...): ...` — see `git log`)
- [ ] Handback report is complete (§6 template) — incomplete reports bounce

**Task-specific, apply the matching AGENTS.md invariant:**
- [ ] T1/T4: "Never refund a released escrow; compensate it" and "Reconcile
      with the chain before undoing anything" — re-read the actual diff/test
      against these two invariants line by line, not just "tests pass"
- [ ] T2: "No standing allowances" and the MMF buffer-funding gotcha
      ("Advancing the MMF index does not add asset to the fund") — confirm the
      idempotent redeploy path doesn't double-fund or double-approve
- [ ] T3: confirm it truly added zero edits to existing `lib/` files (a `git
      diff --stat` against `main` should show only new files)
- [ ] T5: confirm every fix it made has a regression test and is narrowly
      scoped to the finding — reject anything that reads like a refactor

## 6. Commit and merge contract (every task follows this — include verbatim in every worker prompt)

- **Branch:** `fortel2/<task-slug>`, created from `origin/main` at the moment
  you start. Do not branch from another task's branch.
- **Allowed to touch:** exactly the file allowlist given in your task
  assignment. If you believe you need to touch anything else, stop and record
  it as a proposal in the shared decisions log instead of editing it.
- **Never touch:** `README.md`, `DEMO.md`, `AGENTS.md`, `CLAUDE.md`, `PRD.md`,
  `tasks/prd-fortel2-integration.md`, `package-lock.json` (unless a
  dependency addition was pre-approved in the decisions log), any
  `chain/deployments*.json`, any `.env`.
- **Commit convention:** small, scoped commits; message prefix matches the
  area, e.g. `test(fortel2): ...`, `feat(fortel2): ...`,
  `fix(deploy): ...`, `docs(runbook): ...`. Mirror `git log` style already in
  this repo.
- **Before handback:** `npx tsc --noEmit && npm run lint && npm test` must all
  pass locally. If your task is UI-visible, browser-verify per AGENTS.md.
- **Handback report (paste this back, filled in):**
  ```
  Task: <slug>
  Branch: fortel2/<slug>
  Files touched: <list — must match allowlist exactly>
  Tests: <before count> -> <after count>, all green? <y/n>
  Deviations from assignment: <none, or exact description + why>
  Findings outside my allowlist (not fixed, reporting only): <none, or list>
  Proposed doc snippet for integrator (if any): <exact text, or none>
  New dependency requests (not yet added): <none, or list + why>
  Open questions for Stephen: <none, or list>
  PR: <link>
  ```
- **Merge:** you open the PR; you do not merge it yourself. Squash merge only,
  after the review checklist (§5) passes.

## 7. Integration order

```
T2 ──┐
T3 ──┼── any order, merge whenever ready (zero mutual file overlap)
T1 ──┘
        │
        ▼ (T4 branches only after T1 is on main)
       T4
        │
        ▼ (T5 branches only after T1+T2+T3+T4 are all on main)
       T5
        │
        ▼
       I6  (you, doc consolidation — not a worker task)
```

T1, T2, T3 can genuinely run in parallel right now — their allowlists don't
intersect. T4 is the one true sequencing dependency: it shares
`lib/chain.ts`/`lib/executor.ts` with T1, so kicking it off before T1 merges
risks exactly the rebase pain you're trying to avoid.

## 8. Conflict hot zones (despite the ownership split)

- **`README.md` / `DEMO.md` / `AGENTS.md` / `CLAUDE.md` / `PRD.md`** — solved
  by the "workers never edit these" rule (§1.3). This was the actual source
  of your past conflicts; every prior ForteL2 PR touched these together.
- **`package-lock.json`** — solved by "no new deps without a logged decision."
  A lockfile diff from two out-of-order merges is a real conflict even with
  disjoint source files.
- **`lib/chain.ts` / `lib/executor.ts`** — T1 (read-only) and T4 (editing)
  both touch these conceptually. Solved by sequencing, not by ownership —
  T4 simply doesn't start until T1 is merged.
- **`scripts/deploy-testnet.mjs`** — only T2 owns it, but it's the single
  highest-risk file in the whole tree because it moves real (testnet) funds.
  If a second task later needs to touch it, that task must branch after T2
  merges, not in parallel.
- **`tests/global-setup.ts` / `tests/fixture.ts`** — none of T1–T3 should need
  these (each adds a self-contained new test file), but if a worker finds it
  needs a new shared fixture helper, that's a stop-and-report case, not an
  edit — a second task touching test infra at the same time is exactly the
  kind of collision the allowlists are meant to prevent.
- **Test-fixture ports (9545/9546 vs ForteL2's 9545)**: the test fixture was
  deliberately moved to 19545/19546 (PR #23) specifically to stay clear of
  ForteL2's local sequencer port. Any new test file must not reintroduce a
  literal `9545`/`9546` — flagged explicitly in the T1 prompt below since it's
  the task most likely to write ForteL2-adjacent test fixtures.

## 9. Explicitly blocked / not worker tasks

- **Live-redeploying `fortel2-sepolia` with the MMF fund** and **live-running
  a bridge settle through ForteL2** — **done 2026-08-07** on the operator's Mac
  ([`tasks/runbooks/fortel2-live-session-2026-08-07.md`](runbooks/fortel2-live-session-2026-08-07.md)).
  Still not a worker task: requires ForteL2 machine access. Future live ops
  (buffer top-ups, F8 cutover) follow the same pattern. F6 address-book
  verification is done in the explorer repo (see §0 F6 row).
- ~~**US-F007's ambiguity** (§0)~~ — **resolved 2026-08-09** (docs truth-up):
  F1/F2 delivered the overlay; explorer address book closed by F6a
  (PR #4 → `20f17ff`). See [`tasks/prd-fortel2-integration.md`](prd-fortel2-integration.md) § US-F007.
