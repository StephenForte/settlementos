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

### T5-5: Addon TREASURY_PRIVATE_KEY not bound to overlay treasury address (P1)
- Status: OPEN
- Type: finding
- Detail: `runMmfAddon` prefers `process.env.TREASURY_PRIVATE_KEY` without checking it derives `overlay.accounts.treasury.address`. Can approve from the wrong wallet while merge succeeds → noop. park() often self-heals when overlay has an inline key; `privateKeyEnv` mismatch breaks park. Proposed: fail closed on address mismatch; prefer overlay inline key when present. Small + unit-testable.
- Resolution: (integrator) approve fix-on-branch or defer.

### T5-6: Execute must not trust frozen recall_required alone when free is short (P2)
- Status: OPEN
- Type: finding
- Detail: `liquidityCheck` RPC degrade → `recall_required: false`; executor skips `recallForPayment` then fails free-liquidity check even if parked covers. Fail-closed for money, wrong for flaky ForteL2 RPC demo UX. Proposed: call `recallForPayment` (no-op when free covers) whenever free is short at execute. Needs regression tests.
- Resolution: (integrator) schedule follow-up or reject.

### T5-7: §0 / MMF redeploy runbook stale after 2026-08-07 live session (P2)
- Status: OPEN
- Type: scope-question
- Detail: worker-plan §0 still says F4 overlay has no TokenizedMMF; `fortel2-mmf-redeploy.md` §2 still centers full deploy / "addon not landed". Live session + PR #40 closed F4 via mmf_addon. Doc-freeze blocks editing AGENTS/README/plan body from T5; hand to I6. Also: §0 "fail-closed on missing RPC" overstates F1 — missing env defaults to loopback, not fail-closed.
- Resolution: (I6) refresh §0 F4/F7/F1 wording and rewrite runbook §2 around addon/noop.

### T5-8: R3 deepened — ACCEPT; helpers unreachable; buffer unrecoverable on orphan
- Status: APPROVED (reviewer ruling)
- Type: residual-ruling
- Detail: Supersedes the shallow "out of money-path scope" half of T5-1's R3 note with a full deploy-surface read. Confirmed: crash between fund deploy and overlay merge re-detects mmf_addon and deploys a second fund; `mmfYieldBufferSatisfied`/`treasuryMmfApprovalSatisfied` never help (fresh address is empty); TokenizedMMF has no rescue so a minted 50k buffer on the orphan is stranded. Accept for mock-asset testnet; optional follow-up early overlay write + noop heal. Documented in Part B of `tasks/fortel2-hardening-review-2026-08.md`.
- Resolution: ACCEPT; no code change in T5.

### T5-9: Fix T5-3 — in-memory destinationTxHash before DB persist
- Status: APPROVED
- Type: design-choice
- Detail: SUPERSEDES T5-3. Low-risk same-process fix: set `payment.destinationTxHash` from `bridgeTx.hash` before the Prisma update so a persist throw still lets catch reconcile. Added test-only `beforeDestinationTxHashPersist` hook + regression proving SETTLED (not COMPENSATED) when persist fails after broadcast. No schema change.
- Resolution: landed on T5 branch with regression test.

### T5-10: Fix T5-4 — stuckPayments candidates all PAYOUT_PENDING
- Status: APPROVED
- Type: design-choice
- Detail: SUPERSEDES T5-4. Widen candidacy/filter from `PAYOUT_PENDING`+hash to every `PAYOUT_PENDING` so a process death between status write and hash persist cannot hide a released escrow. Visibility only — still no automated resolution (R1). Regression plants a hash-less row and asserts listing.
- Resolution: landed on T5 branch with regression test.

### T5-11: Fix T5-5 — resolveAddonTreasuryKey binds key to overlay address
- Status: APPROVED
- Type: design-choice
- Detail: SUPERSEDES T5-5. Extracted pure `resolveAddonTreasuryKey` in `scripts/deploy-testnet.mjs`: prefer overlay inline privateKey, else env/`privateKeyEnv`; fail closed when derived address ≠ overlay treasury address. `runMmfAddon` uses it before any tx. Unit tests cover prefer-inline, env fallback, mismatch, missing key. Also dropped "if not already funded/approved" from `describePlannedActions` mmf_addon wording (R3 honesty).
- Resolution: landed on T5 branch with unit tests.

### T5-12: R4 regression — missing receipt maps to unknown
- Status: APPROVED
- Type: design-choice
- Detail: Hermetic test calls `transactionOutcome` with a nonexistent hash on the fixture chain; expects `"unknown"` (viem throw path), not `"absent"`. Documents the trap: do not "fix" NotFound→absent. No production code change.
- Resolution: landed in `tests/integration/executor-rpc-resilience.test.ts`.

## T6 — compensation attempt reconciliation + operator re-reconcile

### T6-1: compensationTxHash is the attempt hash (no schema change)
- Status: APPROVED (implicit — implementing T5-2 per T4-1 mirror)
- Type: design-choice
- Detail: Reuse nullable `compensationTxHash` for the submitted attempt hash (persisted before `confirm()`), mirroring T4-1's `destinationTxHash`. The column remains nullable; COMPENSATED status (backed by a confirmed receipt read) is the only claim the sender was repaid. A non-null hash alone must never mark COMPENSATED — a reverted attempt would strand the sender silently.
- Resolution: implemented on branch fortel2/compensation-reconcile.

### T6-2: compensation reconcile outcomes match destination leg
- Status: APPROVED (implicit — implementing T5-2 per T4-1 mirror)
- Type: design-choice
- Detail: Before any re-transfer, `runCompensationTransfer` calls `transactionOutcome` on the source network. confirmed → COMPENSATED with no re-send (`payment.compensation_recovered`); unknown → refuse (409 from repair, stay COMPENSATION_PENDING, audit `payment.compensation_unresolved`, stay in stuckPayments); reverted/absent → fresh transfer is correct. Distinct audit events: `payment.compensation_submitted` (attempt) and `payment.compensation_transfer` (confirm path).
- Resolution: implemented on branch fortel2/compensation-reconcile.

### T6-3: executorTestHooks for compensation receipt-loss
- Status: APPROVED (implicit)
- Type: design-choice
- Detail: Added `afterCompensationSubmitted`, `beforeCompensationTxHashPersist`, and `compensationPayoutOutcome` mirrors of the destination-leg hooks. First commit landed the seam + a failing balance-delta test proving the double-pay; fix followed.
- Resolution: implemented on branch fortel2/compensation-reconcile.

### T6-4: R1 operator reconcile never broadcasts
- Status: APPROVED (implicit — implementing R1 per T5 review)
- Type: design-choice
- Detail: `POST /api/payments/[id]/reconcile` + `reconcileUnresolvedPayment` re-read chain evidence under the execution lease. PAYOUT_PENDING+confirmed → complete forward; +reverted/absent → COMPENSATION_PENDING only (no treasury transfer — `/repair` sends); +unknown → unchanged. COMPENSATION_PENDING+confirmed → COMPENSATED; +reverted → unchanged (eligible for repair); +unknown → unchanged. No state-machine edits required (existing edges suffice). No schema change.
- Resolution: implemented on branch fortel2/compensation-reconcile.

## T6 — compensation attempt reconciliation + operator re-reconcile (post-wave)

(entries here — ids T6-1, T6-2, … pre-assigned; do not scan for the highest)
