# ForteL2 hardening review — 2026-08-08 (T5)

**Baseline:** `origin/main` @ `312f096` (PR #40 live-session results).  
**Status:** Findings + residual rulings. No R4 “cleanup”; no automated action on
unknown destination evidence. No deploy-script code change in this review
commit (P1 treasury-key binding left OPEN for integrator ack).

Two complementary passes make up this document:

| Part | Surface | Primary files |
|---|---|---|
| **A** | T1–T4 money paths (executor / destination reconcile) | `lib/executor.ts`, `lib/chain.ts` |
| **B** | Deploy / registry / MMF composition | `scripts/deploy-testnet.mjs`, `lib/networks.ts`, `lib/treasury.ts` + `lib/routing.ts` (ForteL2/MMF only), T1–T4 tests |

**Method:** Static adversarial read against AGENTS.md invariants. No live
ForteL2 RPC on this host; `chain/deployments*.json` gitignored and **absent**
here (trusted via `tasks/runbooks/fortel2-live-session-2026-08-07.md`).

**Severity:** P0 = wrong money / irreversible stranding under normal ops;
P1 = wrong money or silent wrong mode under plausible failure/misconfig;
P2 = demo/ops footgun, stale docs, vacuous coverage, accepted residual;
OK = checked and sound.

**Counts (combined):** P0 **0** · P1 **3** · P2 **11** · R1–R4 ruled below.

---

# Part A — Money paths (T1–T4)

## A. Executive summary

T4 correctly inverted the T1-1 hazard for the *happy* receipt-loss window: a
mined destination payout whose receipt is lost completes forward; an
unreadable receipt stays `PAYOUT_PENDING` and does not compensate. Catch-path
ordering matches the AGENTS.md invariants for the branches the hermetic suite
exercises.

Residual risk is **composition**, not the confirmed/unknown happy paths:

1. The same submit-then-confirm shape T4 fixed on the bridge leg still exists
   on **compensation** (`runCompensationTransfer`) — a mined compensation whose
   receipt is lost leaves `COMPENSATION_PENDING` with no `compensationTxHash`,
   so `repairCompensation` can pay the sender a second time (**P1**).
2. If `destinationTxHash` **persist fails after** `writeContract` returns, catch
   still treats the recipient as unpaid and compensates (**P1**).
3. Unresolved `PAYOUT_PENDING` is visible when a hash exists, but has **no
   operator resolution API** (R1).
4. `transactionOutcome`'s `"absent"` arm must **not** be “fixed” to map missing
   receipts to absent (R4 trap).

## A. Coverage map

| Function | File:lines | Invariants checked |
|---|---|---|
| `resolveDestinationPayoutOutcome` | `lib/executor.ts:147-155` | Test-hook override vs live `transactionOutcome` |
| `reconcileDestinationPayout` | `lib/executor.ts:162-193` | confirmed→forward; unknown→non-terminal; absent/reverted→fall through |
| Bridge payout leg | `lib/executor.ts:445-486` | hash persist before `confirm()`; dual audit events |
| Catch path | `lib/executor.ts:513-588` | ledger → dest reconcile → escrow reconcile → refund/compensate/FAIL |
| `completeSettledPayout` | `lib/executor.ts:600-639` | forward-only; idempotent ledger; consume reservation |
| `compensateSender` / `runCompensationTransfer` | `lib/executor.ts:682-739` | post-release only; transfer failure stays `COMPENSATION_PENDING` |
| `stuckPayments` | `lib/executor.ts:764-812` | RPC null kept; `PAYOUT_PENDING`+hash kept |
| `repairCompensation` | `lib/executor.ts:823-873` | lease; dest confirmed/unknown refuse; escrow must be SETTLED |
| `transactionOutcome` | `lib/chain.ts:280-291` | missing receipt → unknown (via throw); `!receipt` → absent |
| `replicaLagRetries` / `operatorWrite` | `lib/chain.ts:294-354` | 0 on `fortel2-*`/local |
| `SubmittedTx` / `treasuryTokenTransfer` | `lib/chain.ts:250-254, 466-484` | hash first, `confirm()` separate |

## A. Invariant verdicts

### “Never refund a released escrow; compensate it” — OK

Catch reads escrow (or falls back to post-settlement DB status) before undo
(`lib/executor.ts:548-563`). `failAndRefund` only when escrow held (`565-575`).
Released → `compensateSender`.

### “Compensate only when the recipient was *not* paid; otherwise complete forward” — OK on destination path; gap on compensation path

Catch order (`513-537`): ledger → `destinationTxHash` reconcile
(confirmed/unknown/reverted) → escrow refund vs compensate.
`repairCompensation` refuses confirmed/unknown destination (`841-857`).
**Gap:** compensation transfer itself has no attempt-hash reconcile (P1).

### “Reconcile with the chain before undoing anything” — OK for destination + source escrow

Unknown destination does **not** undo.

### “A stranded payment must stay visible” — OK for T4 hash window; partial elsewhere

`PAYOUT_PENDING` **without** a hash is not a `stuckPayments` candidate (P2).

## A. Findings

### P1 — Compensation transfer still has the T1-1 receipt-loss double-pay window

**Where:** `lib/executor.ts:705-738` (`runCompensationTransfer`); repair
`823-872`.

**Failure scenario:** `COMPENSATION_PENDING` → `treasuryTokenTransfer`
broadcasts and mines → RPC drops before `confirm()` →
`compensationTxHash` still null → Repair re-sends → **sender paid twice**.

**Remediation:** Persist compensation attempt hash before `confirm()` (column
reuse or new — schema needs decisions-log), or scan before re-send; on repair
treat unknown compensation receipt like destination unknown. Regression hook
after compensation submit / before confirm.

**Not fixed here** — design choice required first (see decisions log T5-2).

### P1 — `destinationTxHash` persist failure after broadcast → catch compensates while recipient may be paid

**Where:** `lib/executor.ts:449-461` then catch `530-562`.

**Failure scenario:** Cross-chain payout broadcast returns `H`; DB update
throws; in-memory hash stays null; catch compensates; `H` mines → **treasury
double-pay**.

**Remediation:** On persist failure, keep `H` on the in-memory payment before
rethrow so catch reconciles; best-effort retry + audit. Process kill before
persist remains harder (pairs with stuck candidacy P2).

### P1 — Unresolved `PAYOUT_PENDING` has no resolution path (R1), stuck UI cannot act

**Where:** `lib/executor.ts:179-189, 764-812, 823-832`; UI
`app/payments/stuck/repair-list.tsx:27-35, 102-110`.

**Failure scenario:** Hash persisted, destination RPC unreadable → stays
`PAYOUT_PENDING`; execute cannot resume; repair rejects; stuck page lists but
Repair is `COMPENSATION_PENDING`-only → frozen until out-of-band tools.

**Ruling:** accept fail-closed for *automation*; escalate *operator UX* — need
“re-reconcile destination” (confirmed→forward, reverted→compensate,
unknown→409).

### P2 — R2: bridge hash write and `bridge.destination_payout_submitted` not one `$transaction`

**Where:** `lib/executor.ts:455-472` (confirmed event similarly separate).

**Failure scenario:** Hash commits; process dies before audit → money path
still safe via column; audit missing attempt event.

**Ruling:** accept with caveat — audit consistency gap, not demonstrated
double-pay.

### P2 — `PAYOUT_PENDING` without `destinationTxHash` omitted from `stuckPayments`

**Where:** `lib/executor.ts:767-771, 804-811`.

**Failure scenario:** Status `PAYOUT_PENDING`, killed before hash persist →
absent from stuck view, no execute/repair → stranded and invisible.

**Remediation:** Candidate all `PAYOUT_PENDING` (or reservation-backed).

### P2 — `repairCompensation` refuses confirmed destination but does not complete forward

**Where:** `lib/executor.ts:846-850`.

**Failure scenario:** Misclassified `COMPENSATION_PENDING` + confirmed dest →
409, never SETTLED. Remediation: complete forward on confirmed.

### P2 — Resilience tests: gaps

**Where:** `tests/integration/executor-rpc-resilience.test.ts`

| Test | Load-bearing? |
|---|---|
| receipt lost → SETTLED forward | **Yes** |
| never submitted → COMPENSATED | **Yes** |
| forced `reverted` → COMPENSATED | **Yes** (hooked outcome) |
| forced `unknown` → PAYOUT_PENDING + stuck | **Yes** for no-compensate |
| repair after SETTLED | **Weak** — status gate only |
| repair refuses confirmed | **Yes** |
| `replicaLagRetries` | **Yes but shallow** |

**Gaps:** repair-refuses-unknown; `transactionOutcome` NotFound→unknown unit
test; compensation receipt-loss; do **not** add production NotFound→absent.

## A. OK items

- Destination unknown does not auto-act (`179-189`, test `147-181`)
- `stuckPayments` keeps rows on escrow RPC null
- `repairCompensation` does not double-pay on confirmed/unknown **destination**
  evidence (compensation receipt-loss is the separate P1)
- `replicaLagRetries` / classifier sound for ForteL2 single-sequencer

---

# Part B — Deploy / registry / MMF surface

## B. Worker-plan §0 verification (current main + this disk)

| §0 claim (2026-08-03) | Verdict now | Evidence |
|---|---|---|
| F1 registry + "fail-closed on missing RPC" | **Partly false as worded** | Entries exist (`lib/networks.ts:69-86`). Missing `FORTEL2_SEPOLIA_RPC_URL` **defaults** to `http://127.0.0.1:9545` — not fail-closed. Fail-closed = unknown network id + deploy preflight when RPC unreachable. |
| F2 overlay exists with escrow+tokens | **True on ops host; false on this disk** | No `chain/` dir here. Live session confirms escrow `0x9d8b…56aa` survived. |
| F4 overlay has no TokenizedMMF; `mmfAddress` undefined | **Stale — superseded by live session** | Live fund `0xaed29387417dad9ab1993332e2c2b99d35ffe7ff` via `mmf_addon`, then `noop`. **This disk:** no overlay → `mmfAddress("fortel2-sepolia")` undefined / `loadDeployments` throws without local deployments. Hermetic wiring test remains the only CI proof. |
| F7 architecturally free, not demoed | **Stale — demoed live** | Live session bridged both ways (`base-local`↔`fortel2-sepolia`). T1 still proves quote math only in CI. |

## B. Findings

### P1 — Add-on path prefers `TREASURY_PRIVATE_KEY` without binding it to the overlay treasury address

**Where:** `scripts/deploy-testnet.mjs:447-454`, approve `:515-525`.

**Failure scenario:** Overlay treasury `{ address: A, privateKey: pkA }`;
`.env` has `TREASURY_PRIVATE_KEY=pkB`. Add-on checks allowance for **A**,
approves from **B**, merge succeeds → `noop`. Runtime park often self-heals
via `ensureTreasuryAllowance` when overlay has inline `pkA`; if overlay uses
`privateKeyEnv: "TREASURY_PRIVATE_KEY"` with address A while env holds pkB,
park/subscribe signs wrong → reverts until repaired.

**Remediation:** Require
`privateKeyToAccount(treasuryKey).address` matches overlay treasury address;
prefer overlay inline key when present. Unit-test a pure resolver helper.
Left OPEN (decisions T5-5) — small fix, deferred for integrator ack.

### P2 — R3: crash between fund deploy and overlay merge orphans TokenizedMMF (yield buffer unrecoverable)

**Where:** `scripts/deploy-testnet.mjs:464-530`; helpers `:304-315`;
`contracts/TokenizedMMF.sol` (no rescue); decisions T2-2; AGENTS.md
mode-level idempotency gotcha.

**Failure scenario:** `mmf_addon` deploys F1, mints 50k buffer, approves, dies
before `fs.writeFileSync`. Re-run → `mmf_addon` again → F2 + another 50k.
F1 orphaned. **No on-chain rescue** for the stranded buffer.
`mmfYieldBufferSatisfied` / `treasuryMmfApprovalSatisfied` read the **new**
address — always empty — and never prevent orphan redeploy.

**Ruling: ACCEPT** for mock-asset testnet (see R3). Do not market helpers as
per-step idempotency.

**Optional follow-up:** Persist `TokenizedMMF` immediately after deploy
receipt, then heal buffer/approve on `noop` when underfunded.

### P2 — `noop` does not heal underfunded buffer or missing treasury approval

**Where:** `scripts/deploy-testnet.mjs:386-388`; composition with
`lib/treasury.ts` redeem / `ensureTreasuryAllowance`.

**Failure scenario:** Overlay has fund (`noop`) but buffer drained by
accrue→redeem cycles. Re-deploy exits. Approval self-heals; **buffer does
not** → redeem/auto-recall can revert.

**Remediation:** On `noop`, warn or re-run mint/approve gates; document manual
buffer top-up in runbook.

### P2 — Quote RPC degrade + frozen `recall_required` skips auto-recall at execute

**Where:** `lib/routing.ts:108-127`; `lib/executor.ts:296-329`.

**Failure scenario:** Liquidity mostly parked; quote-time RPC flaps →
`{ok:true, recallRequired:false}` frozen into quote → execute skips
`recallForPayment` → fails free-liquidity check though parked would cover.
Fail-closed for money; wrong for ForteL2 demo UX.

**Remediation:** When free is short at execute, call `recallForPayment` (no-op
if free covers) instead of trusting the frozen flag alone. Needs regression
tests — OPEN as T5-6.

### P2 — Worker-plan §0 and MMF redeploy runbook stale post–live session

**Where:** `tasks/fortel2-worker-plan.md:9-22`;
`tasks/runbooks/fortel2-mmf-redeploy.md:32-80`.

**Failure scenario:** Operator following runbook §2 full-deploy narrative may
move overlay aside, orphaning live escrow + the 2026-08-07 fund.

**Remediation:** I6 — flip §0 F4/F7; rewrite runbook around `mmf_addon`/`noop`.

### P2 — `describePlannedActions` overclaims per-step idempotency on add-on

**Where:** `scripts/deploy-testnet.mjs:284-285` vs T2-2.

**Remediation:** Drop "if not already funded/approved" wording until a heal
path exists.

### P2 — Corrupt overlay JSON treated as "no overlay" → plans `full`

**Where:** `scripts/deploy-testnet.mjs:141-148`, `:160-161`.

**Failure scenario:** Truncated overlay → mode `full` in plan; `runFullDeploy`
usually throws on re-parse before overwrite — operator still steered wrong.

**Remediation:** `fail()` on unreadable JSON distinct from missing file.

### P2 — T3 treasury-audit tests partly vacuous

**Where:** `tests/unit/fortel2-treasury-audit.test.ts:114-127` (constant
equality); `:91-96` redundant with wiring test. Load-bearing: no-fund
`parkedBalance` (`:82-88`), yield floor math (`:99-111`).

### P2 — T1 bridge-route cannot see `recall_required` / real liquidity

**Where:** `tests/db/fortel2-bridge-route.test.ts` (explicit). Load-bearing for
pair-generic quote math; not MMF-liquidity coverage. Acceptable if not
overclaimed.

## B. OK — checked and sound

| Area | Notes |
|---|---|
| **OK** `decideDeployMode` full / mmf_addon / noop | Pure, unit-tested; live addon→noop proven |
| **OK** Treasury key validation hoisted before first addon tx | T2-1 present (`:440-453`) |
| **OK** Overlay merge last; escrow/tokens untouched on addon | |
| **OK** `mmfAddress` undefined → `parkedBalance` 0n / `NO_FUND` | `lib/chain.ts:190-196`, `lib/treasury.ts:440-441` |
| **OK** MMF ↔ escrow segregation | Contracts + live session escrow Δ0 |
| **OK** Read/write RPC split | `readRpcUrl` optional; writes stay on sequencer |
| **OK** Unknown network fail-closed | No fallback chain |
| **OK** Preflight helpers + `--preflight-only` | |

## B. Test load-bearing assessment (T1–T4)

| File | Verdict |
|---|---|
| `tests/db/fortel2-bridge-route.test.ts` | **Load-bearing** quote math; **vacuous** for liquidity/`recall_required` (by design) |
| `tests/unit/deploy-testnet-preflight.test.ts` | **Load-bearing** mode + preflight pure helpers; no addon I/O / R3 / key-binding |
| `tests/unit/fortel2-mmf-wiring.test.ts` | **Load-bearing** hermetic overlay→`mmfAddress` seam; not the real overlay |
| `tests/unit/fortel2-treasury-audit.test.ts` | **Mixed** (see P2) |
| `tests/integration/executor-rpc-resilience.test.ts` | Deploy skim: **load-bearing** `replicaLagRetries("fortel2-*")===0`; rest Part A |

## B. Composition gaps (T2 mode-awareness ↔ live treasury/MMF ops)

1. **Mode-level success ≠ fund health** — `noop` means address recorded, not buffer funded.
2. **Quote degrade ↔ execute recall** — frozen `recall_required: false` blocks T+0 recall.
3. **Overlay is sole `mmfAddress` source** — machine without gitignored overlay cannot see the live fund.
4. **Runbook lag** — live path was addon; runbook still centers full deploy.
5. **Self-heal asymmetry** — approval heals; buffer does not.

---

# Residual rulings (R1–R4) — combined

| Id | Ruling | One-line |
|---|---|---|
| **R1** | **accept (automation) / escalate (ops UX)** | Fail-closed non-action on unknown is correct; missing operator re-reconcile tool strands humans (stuck list watch-only for this state). |
| **R2** | **accept with caveat** | Hash/audit split is audit consistency, not demonstrated double-pay; money keys off the column. |
| **R3** | **ACCEPT (documented deploy residual)** | Mode-level-only addon idempotency confirmed in Part B; helpers unreachable on fresh fund; orphan can strand 50k mockUSDC with no contract rescue. Accept for testnet; optional early-overlay-write + heal. Do **not** claim per-step idempotency. |
| **R4** | **ACCEPT — do not “fix”** | Comment at `lib/chain.ts:265-278` accurate: viem throws → `"unknown"`. Mapping NotFound→`"absent"` reintroduces T1-1 double-pay. Dead `!receipt` arm stays for hooks/future provers only. |

---

# Direct answers

| Question | Answer |
|---|---|
| Does fortel2-sepolia overlay exist with TokenizedMMF **on this disk**? | **No** — `chain/` absent. Live session says yes (`0xaed293…`) on the ops host. |
| Would `mmfAddress("fortel2-sepolia")` resolve if overlay present? | **Yes** — wiring test + `lib/chain.ts:190-196`; live session exercised park/recall. |
| Are T1–T4 tests load-bearing or vacuous? | **Mixed** — see tables in A and B. |
| Can `repairCompensation` double-pay? | **Not** via confirmed/unknown destination. **Yes** via compensation receipt-loss + retry (Part A P1). |
| Can `stuckPayments` drop a stranded payment on RPC failure? | **No** for escrow-read null. **Yes** for hash-less `PAYOUT_PENDING`. |
| Destination hash set, receipt unknown — anything auto-act? | **No.** |

---

# Recommended next commits (priority)

1. **P1 (money)** Persist/reconcile compensation attempt like T4 bridge (T5-2).
2. **P1 (money)** In-memory/retry `destinationTxHash` if DB persist fails after broadcast (T5-3).
3. **P1 (deploy)** Bind addon treasury key to overlay address (T5-5).
4. **R1 ops** Operator re-reconcile destination API.
5. **P2** Widen `stuckPayments` to all `PAYOUT_PENDING`; execute-time recall when free short (T5-6).
6. **I6 docs** Refresh §0 + MMF redeploy runbook (T5-7).
7. **Tests** repair-refuses-unknown; `transactionOutcome` NotFound→unknown; trim vacuous T3 constant echoes.
