# ForteL2 wave decisions log — 2026-08-03 (Wave 1: T1, T2, T3)

Instance of `tasks/fortel2-decisions-log-template.md`. Every worker reads this
whole file before starting and appends **only under its own task heading**.
Stephen resolves items marked OPEN; workers must not act on an OPEN item.

Rules of the log:
- A worker writes here INSTEAD of touching a file outside its allowlist,
  adding a dependency, or deviating from its assignment. Proposal first,
  code only after the entry is marked APPROVED.
- Entries are append-only. To change a decision, add a new entry that
  supersedes the old one; never rewrite history.

Entry format:

```
### <task>-<n>: <one-line title>
- Status: OPEN | APPROVED | REJECTED | SUPERSEDED by <id>
- Type: file-outside-allowlist | new-dependency | design-choice | bug-found-elsewhere | scope-question
- Detail: <2-5 lines: what, why, and the smallest viable alternative if rejected>
- Resolution: <filled by integrator>
```

## Wave-level standing decisions

- Base commit for this wave: `0f1d0a4` (origin/main, 2026-08-03)
- Doc-freeze in effect: workers do not edit README/DEMO/AGENTS/CLAUDE/PRD/
  prd-fortel2-integration.md; doc snippets go in handback reports.
- Dependency freeze in effect: no package.json/package-lock.json changes
  without an APPROVED entry here.
- Both `tasks/runbooks/` creators (T1, T3) may create the directory; git
  merges new files in a new directory without conflict.
- US-F007's checkbox state is known-inconsistent with the F1 phase table;
  no worker acts on US-F007 this wave (Stephen to resolve).
- Branch naming: `cursor/<slug>-<hash>` is an accepted standing exception to
  the `fortel2/<slug>` convention where a worker's PR tooling requires the
  prefix (first used by T2 / PR #34). Content and commit rules unchanged.
- 2026-08-03 (evening): the ForteL2 stack moves onto THIS machine tomorrow
  (2026-08-04) — the 852 sequencer becomes reachable at the default loopback
  RPC. The §9 "externally blocked" ops items (live MMF redeploy, bridge
  manual QA, F4 live verification) become executable. Worker tests still
  stay hermetic — CI must never depend on the ForteL2 stack being up.

---

## T1 — bridge-leg verification

### T1-1: destination-payout receipt loss can compensate after tokens moved
- Status: APPROVED
- Type: bug-found-elsewhere
- Detail: In `lib/chain.ts` `treasuryTokenTransfer`, `writeContract` returns a hash then `confirm()` awaits the receipt. If the RPC drops after the dest transfer mines but before the receipt returns, `lib/executor.ts` never writes `destinationTxHash` and the catch path treats the recipient as unpaid → `compensateSender` on source while dest tokens already sit on the recipient wallet (treasury double-pay). Pre-existing for all bridges; more likely on a best-effort single-sequencer ForteL2 than on Base/Amoy public RPCs. Proposed direction for T4: persist the hash as soon as `writeContract` returns (before receipt), or reconcile dest balance before compensating. No lib edit in T1.
- Resolution: APPROVED as T4's primary brief (verified against lib/chain.ts:431-437 + the executor catch path by the integrator). CAUTION baked into the T4 prompt: naive persist-early inverts the bug — a hash written pre-receipt is evidence of an ATTEMPT, not of payment; the catch path currently treats destinationTxHash as proof the recipient was paid, so persist-early without reconciliation would mark SETTLED payments whose payout tx reverted/never mined. The fix must extend "reconcile with the chain before undoing anything" to the destination leg.

### T1-2: operatorWrite replica-lag retries on a single-sequencer L2
- Status: APPROVED
- Type: bug-found-elsewhere
- Detail: `operatorWrite`'s `retryOnReplicaLag` classifies `"not initiated"` / `"insufficient allowance"` as transient. On fortel2-sepolia (no replica; `readRpcUrl` optional) those strings are usually real failures, so a ForteL2 *source* leg can burn ~4×2s before failing closed. Not a correctness break of the compensate/refund invariants. T4 may want a network-aware retry policy or shorter budget for single-node rails.
- Resolution: APPROVED as T4 secondary scope (lower priority than T1-1; latency-only, no correctness break).

### T1-3: quoting claim VERIFIED for ForteL2 network ids
- Status: APPROVED
- Type: design-choice
- Detail: Hermetic `tests/db/fortel2-bridge-route.test.ts` proves `quoteRoutes` emits correct `BRIDGE_AND_SETTLE` for base-sepolia↔fortel2-sepolia both ways (fee, assets, labels, FX math = Base↔Polygon control). `liquidityCheck` degrades as documented when fortel2 is absent from fixture deployments. Executor bridge path is network-generic by inspection; live settle still needs the manual runbook.
- Resolution: landed in T1 PR; no lib change required for quoting.


## T2 — deploy/registry hardening

### T2-1 (integrator, post-review): treasury signer validated before first tx
- Status: APPROVED
- Type: bug-found-elsewhere
- Detail: PR #34's MMF add-on resolved the treasury key AFTER deploying the
  fund; since the overlay merge is the last step, aborting there would leave
  the overlay fund-less and a re-run would deploy a second, orphaned fund.
  Fixed by the integrator on the branch (b46c011) before merge: validation
  hoisted above the first transaction.
- Resolution: merged in PR #34.

### T2-2 (integrator, post-review): idempotency is mode-level only
- Status: APPROVED
- Type: design-choice
- Detail: `mmfYieldBufferSatisfied` / `treasuryMmfApprovalSatisfied` are
  unreachable on every normal path — an add-on run always deploys a fresh
  fund whose balance/allowance are zero. The protection that matters is
  mode-level (`noop` when the overlay carries a fund). Recorded so nobody
  credits the script with per-step idempotency it doesn't have; a tx
  revert/RPC drop mid-add-on can still orphan a fund (acceptable, testnet
  mock assets, `--preflight-only` first shrinks the window).
- Resolution: no change; known residual.

## T3 — MMF runbook + coverage

### T3-1 (integrator, post-review): runbook's "current behavior" predates #34
- Status: APPROVED
- Type: design-choice
- Detail: `tasks/runbooks/fortel2-mmf-redeploy.md` §2 describes the pre-#34
  full-deploy behavior; since #34 merged, `npm run deploy:fortel2-sepolia`
  auto-selects the MMF add-on against the existing overlay — the runbook's
  fenced "once T2 lands" variant is now the actual path. Fold into I6's doc
  pass; the fenced note already steers the operator right.
- Resolution: note for I6; no runbook change needed pre-ops-run.

## T4 — executor RPC resilience (wave 2)

### T4-1: destination payout attempt vs confirmation without schema change
- Status: APPROVED (implicit — implemented per T1-1 resolution)
- Type: design-choice
- Detail: Reuse `destinationTxHash` for the submitted attempt hash (persisted before receipt await). Catch path no longer treats hash alone as proof of payment — calls `transactionOutcome()` on the destination chain. Confirmed → `completeSettledPayout`; reverted/absent → fall through to source-side compensate; unknown → stay `PAYOUT_PENDING`, audit `payment.destination_payout_unresolved`, visible in `stuckPayments`. Separate audit events: `bridge.destination_payout_submitted` (attempt) and `bridge.destination_payout` (receipt confirmed). No Prisma/state-machine changes.
- Resolution: implemented on branch fortel2/executor-rpc-resilience.

### T4-2: network-aware replica-lag retry budget via network id prefix
- Status: APPROVED (implicit — implemented per T1-2 resolution)
- Type: design-choice
- Detail: `replicaLagRetries(networkId)` returns 0 for `fortel2-*` and local chains, 4 for other live networks (base-sepolia, polygon-amoy). Avoids editing `lib/networks.ts`; ForteL2 ids are the stable signal for single-sequencer rails. No new config machinery.
- Resolution: implemented on branch fortel2/executor-rpc-resilience.

### T4-3: executorTestHooks extensions for hermetic receipt-loss tests
- Status: APPROVED (implicit)
- Type: design-choice
- Detail: Added `afterDestinationPayoutSubmitted` (throw between hash persist and confirm) and `destinationPayoutOutcome` (force reconciliation outcome without a live ForteL2 RPC). Keeps CI hermetic on fixture chains 19545/19546.
- Resolution: implemented on branch fortel2/executor-rpc-resilience.

## T5 — hardening review (wave 2)

### T5-1: residual rulings R1–R4 (money-path review)
- Status: APPROVED (reviewer ruling)
- Type: residual-ruling
- Detail: Full write-up in `tasks/fortel2-hardening-review-2026-08.md`. R1 accept-automation / escalate-ops-UX (no auto-act on unknown; need operator re-reconcile tool). R2 accept-with-caveat (hash vs audit not one $transaction — audit consistency, not demonstrated double-pay). R3 accept for this money-path review (deploy orphan MMF is ops/deploy residual). R4 accept — do NOT map missing receipt → "absent"; that reintroduces T1-1 double-pay. Dead `!receipt` arm stays for hooks/future provers only.
- Resolution: rulings recorded; no R4 code "cleanup".

### T5-2: compensation transfer still has T1-1 receipt-loss double-pay (P1)
- Status: OPEN
- Type: finding
- Detail: `runCompensationTransfer` awaits `confirm()` before writing `compensationTxHash`. A mined compensation whose receipt is lost leaves `COMPENSATION_PENDING` with null hash; `repairCompensation` re-sends → sender paid twice. T4 fixed this shape on the bridge leg only.
- Resolution: needs design choice (persist attempt hash before confirm — possibly schema — vs on-chain scan before repair). Not fixed in the review commit.

### T5-3: destinationTxHash persist failure after broadcast (P1)
- Status: OPEN
- Type: finding
- Detail: If `prisma.payment.update({ destinationTxHash })` throws after `treasuryTokenTransfer` returns a hash, catch sees null hash and compensates while the dest tx may mine. Same-process mitigation: keep hash on the in-memory payment before rethrow so `reconcileDestinationPayout` runs.
- Resolution: deferred as a small follow-up fix+test; documented in the review.

### T5-4: PAYOUT_PENDING without hash invisible to stuckPayments (P2)
- Status: OPEN
- Type: finding
- Detail: T4 added `PAYOUT_PENDING`+`destinationTxHash` candidacy; process death after `PAYOUT_PENDING` and before persist leaves a settled escrow with no stuck-list entry and no repair API.
- Resolution: widen candidacy to all `PAYOUT_PENDING` (or reservation-backed) in a follow-up; pairs with R1 operator tool.
