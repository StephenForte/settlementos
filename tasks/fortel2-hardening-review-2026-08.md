# ForteL2 hardening review — T1–T4 money paths (T5)

**Date:** 2026-08-08  
**Scope:** Adversarial review of ForteL2 integration money paths changed by T1–T4.  
**Primary files:** `lib/executor.ts`, `lib/chain.ts`.  
**Tests reviewed:** `tests/integration/executor-rpc-resilience.test.ts` (plus adjacent compensation/repair coverage).  
**Status:** Findings + residual rulings. No R4 “cleanup”; no automated action on unknown destination evidence.

## Executive summary

T4 correctly inverted the T1-1 hazard for the *happy* receipt-loss window: a mined destination payout whose receipt is lost completes forward; an unreadable receipt stays `PAYOUT_PENDING` and does not compensate. Catch-path ordering matches the AGENTS.md invariants for the branches the hermetic suite exercises.

The residual risk is **composition**, not the confirmed/unknown happy paths:

1. The same submit-then-confirm shape T4 fixed on the bridge leg still exists on **compensation** (`runCompensationTransfer`) — a mined compensation whose receipt is lost leaves `COMPENSATION_PENDING` with no `compensationTxHash`, so `repairCompensation` can pay the sender a second time (**P1**).
2. If `destinationTxHash` **persist fails after** `writeContract` returns, catch still treats the recipient as unpaid and compensates (**P1**).
3. Unresolved `PAYOUT_PENDING` is visible when a hash exists, but has **no operator resolution API** (R1) — the stuck UI lists it with a compensation-oriented diagnosis and no action button.
4. `transactionOutcome`'s `"absent"` arm must **not** be “fixed” to map missing receipts to absent (R4 trap) — that reintroduces double-pay.

**P0 count: 0** (no path found that double-pays on the T4 destination happy path under the intended unknown/confirmed rules).

---

## Coverage map (what was read)

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
| `replicaLagRetries` / `operatorWrite` | `lib/chain.ts:294-354` | 0 on `fortel2-*`/local; classifier strings |
| `SubmittedTx` / `treasuryTokenTransfer` | `lib/chain.ts:250-254, 466-484` | hash first, `confirm()` separate |
| `mmfAddress` | `lib/chain.ts:190-196` | undefined where undeployed (non-money-path for T4) |

---

## Invariant verdicts

### “Never refund a released escrow; compensate it” — OK

Catch reads escrow (or falls back to post-settlement DB status) before undo (`lib/executor.ts:548-563`). `failAndRefund` only runs when escrow is held (`565-575`). Released escrow → `compensateSender`. Matches AGENTS.md.

### “Compensate only when the recipient was *not* paid; otherwise complete forward” — OK on destination path; gap on compensation path

Catch order (`513-537`):

1. Ledger credit → `completeSettledPayout` (never compensate).
2. `destinationTxHash` → `reconcileDestinationPayout`:
   - `confirmed` → complete forward
   - `unknown` → return same row (`PAYOUT_PENDING`), **no** compensate / **no** SETTLED
   - `reverted` / `absent` → `null` → fall through to source-side compensate
3. Only then escrow-based refund vs compensate.

`repairCompensation` refuses when destination outcome is `confirmed` or `unknown` (`841-857`).

**Gap:** compensation transfer itself has no attempt-hash / receipt reconcile (see P1 below) — T4’s lesson was not applied to the saga’s other treasury leg.

### “Reconcile with the chain before undoing anything” — OK for destination + source escrow

Destination receipt before compensate/complete; source `onchainPaymentState` before refund vs compensate. Unknown destination does **not** undo.

### “A stranded payment must stay visible” — OK for T4 hash window; partial elsewhere

`stuckPayments` keeps `COMPENSATION_PENDING`, `PAYOUT_PENDING` **with** `destinationTxHash`, and FAILED+reservation when escrow is `INITIATED`/`SETTLED`/**`null`** (RPC failure does **not** drop).  

`PAYOUT_PENDING` **without** a hash (process death after status flip / before persist) is **not** a candidate — visibility hole (P1/P2 below).

---

## Findings

### P1 — Compensation transfer still has the T1-1 receipt-loss double-pay window

**File:lines:** `lib/executor.ts:705-738` (`runCompensationTransfer`); repair entry `823-872`.

**Failure scenario:**

1. Payment in `COMPENSATION_PENDING` (catch already decided sender is owed).
2. `treasuryTokenTransfer` broadcasts; tx mines; RPC drops before `confirm()` returns (or confirm throws after mine).
3. Catch audits `payment.compensation_failed`, returns still `COMPENSATION_PENDING`, **`compensationTxHash` still null** (hash only written after confirm at 722-724).
4. Operator clicks Repair → `repairCompensation` → second `treasuryTokenTransfer` → **sender paid twice out of treasury**.

**Why this is a T1–T4 composition bug:** T4 introduced `SubmittedTx` and persist-before-confirm *for the bridge leg* because this exact window double-pays. The compensation leg uses the same `treasuryTokenTransfer` API but still confirm-then-record, and `repairCompensation` has no compensation-attempt reconcile.

**Remediation:**

1. Persist a compensation attempt hash before `confirm()` (reuse column or add one — schema change needs a decisions-log proposal), **or** before re-sending, scan source-chain for an existing treasury→sender transfer of `amountUnits` / refuse if `compensationTxHash` already set on a prior partial write.
2. On repair, treat unknown compensation receipt like destination unknown: refuse until readable.
3. Regression: hook throw after compensation submit / before confirm; assert repair does not move a second balance delta.

**Not fixed in this review** — needs a small design choice (column vs reuse) before code.

---

### P1 — `destinationTxHash` persist failure after broadcast → catch compensates while recipient may be paid

**File:lines:** `lib/executor.ts:449-461` then catch `530-562`.

**Failure scenario:**

1. Cross-chain: escrow settled, status `PAYOUT_PENDING`.
2. `treasuryTokenTransfer` returns hash `H` (tx broadcast / mining).
3. `prisma.payment.update({ destinationTxHash: H })` throws (DB busy, disk, etc.).
4. In-memory `payment.destinationTxHash` remains null (assignment never completes).
5. Catch: no ledger, `reconcileDestinationPayout` no-ops on null hash → escrow SETTLED → `compensateSender`.
6. `H` mines → recipient holds destination tokens **and** sender is compensated → **treasury double-pay**.

T4 narrowed the window (no longer waiting on receipt before persist) but left persist itself fallible without a fallback. Same-process fix is low-risk: on persist failure, keep `H` on the in-memory row (and ideally write it in a retry) so catch reconciles; process kill before persist remains a harder residual (see below).

**Remediation:**

1. After `writeContract`, if DB persist throws, set `payment = { ...payment, destinationTxHash: H }` before rethrow so catch calls `transactionOutcome`.
2. Best-effort: retry persist; audit `bridge.destination_payout_persist_failed` with `H`.
3. Longer-term: pre-intent row before broadcast, or balance/tx scan before compensating a hash-less `PAYOUT_PENDING`.

---

### P1 — Unresolved `PAYOUT_PENDING` has no resolution path (R1), and stuck UI cannot act

**File:lines:** `lib/executor.ts:179-189, 764-812, 823-832`; UI `app/payments/stuck/repair-list.tsx:27-35, 102-110`.

**Failure scenario:**

1. Hash persisted; destination RPC unreadable → catch returns `PAYOUT_PENDING`, audits `payment.destination_payout_unresolved`, reservation stays `RESERVED`.
2. `executePayment` cannot resume (lease CAS requires `APPROVED`).
3. `repairCompensation` rejects non-`COMPENSATION_PENDING`.
4. Stuck page lists the payment (hash present) but diagnosis is escrow-centric (“released… never settled”) and **Repair is only shown for `COMPENSATION_PENDING`**.
5. Funds: sender short (escrow released), recipient maybe paid — **frozen until a human uses out-of-band tools** (manual DB/chain).

**Ruling:** **accept as fail-closed design** for *automation* (must not guess on unknown). **Escalate product gap** for *operator tools*: need an explicit “re-reconcile destination” action that only completes forward on `confirmed`, compensates only on `reverted`, and refuses on `unknown` — never auto.

---

### P2 — R2: bridge hash write and `bridge.destination_payout_submitted` audit are not one `$transaction`

**File:lines:** `lib/executor.ts:455-472` (and confirmed event `475-485` similarly separate from confirm).

**Failure scenario:**

1. `destinationTxHash` row write commits.
2. Process dies before `audit("bridge.destination_payout_submitted")`.
3. Money path still safe if catch runs later (hash present → reconcile). Audit chain **missing the attempt event** while status/hash imply an attempt — violates the spirit of “audit in the same transaction as the domain write” (AGENTS.md), even though this matches older executor patterns for chain-adjacent events.

**Ruling:** **accept with caveat** for T5 — money invariants do not depend on that event; tighten when/if payout bookkeeping is transactionalized. Do not pretend “pre-existing” absolves it; call it an accepted consistency gap.

---

### P2 — `PAYOUT_PENDING` without `destinationTxHash` omitted from `stuckPayments`

**File:lines:** `lib/executor.ts:767-771, 804-811`.

**Failure scenario:**

1. Status reaches `PAYOUT_PENDING` (escrow already SETTLED).
2. Process killed before hash persist (or before catch runs).
3. Lease cleared by `withExecutionLease` `finally`.
4. Candidate query requires `destinationTxHash: { not: null }` → **payment absent from stuck view**.
5. No execute retry, no repair → stranded and invisible.

**Remediation:** Candidate all `PAYOUT_PENDING` (or those with RESERVED reservation / settled escrow). Accept brief listing during in-flight execute. Pair with R1 operator re-reconcile tool.

---

### P2 — `repairCompensation` refuses confirmed destination but does not complete forward

**File:lines:** `lib/executor.ts:846-850`.

**Failure scenario:** Synthetic/misclassified `COMPENSATION_PENDING` + confirmed destination hash → 409, status unchanged. No double-pay (good) but **no path to SETTLED**. Hermetic test at `executor-rpc-resilience.test.ts:208-239` pins refuse-not-pay; natural occurrence is rare if catch ordering holds.

**Remediation:** On confirmed destination during repair, call `completeSettledPayout` (or a dedicated operator complete-forward) instead of only refusing.

---

### P2 — Resilience tests: one case is weak; `absent` and compensation receipt-loss uncovered

**File:** `tests/integration/executor-rpc-resilience.test.ts`

| Test | Load-bearing? |
|---|---|
| receipt lost → SETTLED forward (`51-87`) | **Yes** — real chain mine + live `transactionOutcome`, asserts no compensation, reservation CONSUMED |
| never submitted → COMPENSATED (`89-118`) | **Yes** — `beforeDestinationPayout` |
| forced `reverted` → COMPENSATED (`120-145`) | **Yes** for catch fall-through (outcome hooked; does not prove viem reverted mapping) |
| forced `unknown` → PAYOUT_PENDING + stuck (`147-181`) | **Yes** for no-compensate / no-SETTLED; does **not** assert recipient balance (tx may still have mined) |
| repair after SETTLED (`183-206`) | **Weak** — only hits status gate (`cannot be repaired from status SETTLED`), **not** the destination-outcome refuse branch |
| repair refuses confirmed on misclassified row (`208-239`) | **Yes** for repair’s dest check |
| `replicaLagRetries` (`242-253`) | **Yes but shallow** — pure function only; does not exercise `operatorWrite` / classifier |

**Gaps:** no test that repair refuses on `unknown`; no test pinning `absent`→compensate (document-only via hook); no compensation receipt-loss test; no unit test that `transactionOutcome` maps thrown NotFound → `unknown` (not `absent`).

---

### OK — Destination unknown does not auto-act

**File:lines:** `lib/executor.ts:179-189, 532-537`; test `147-181`.

Inputs: hash set, `destinationPayoutOutcome = "unknown"`. Outcome: status stays `PAYOUT_PENDING`, reservation `RESERVED`, no `payment.compensation_transfer`, listed in `stuckPayments`. Nothing polls or auto-repairs. **Correct.**

---

### OK — `stuckPayments` does not drop stranded rows on RPC failure

**File:lines:** `lib/executor.ts:789-811`.

`escrowState: null` is kept. `PAYOUT_PENDING`+hash kept regardless of escrow. Adjacent `repair.test.ts` covers escrow-read-fail keep for FAILED/compensation candidates.

---

### OK — `repairCompensation` does not double-pay on confirmed/unknown destination (bridge evidence)

**File:lines:** `lib/executor.ts:841-857`.

Confirmed/unknown → 409, no transfer. (Compensation **receipt-loss** double-pay is a separate P1 above.)

---

### OK — `replicaLagRetries` / `operatorWrite` classifier (T1-2 / T4-2)

**File:lines:** `lib/chain.ts:294-351`.

`fortel2-*` and non-live → 0 retries; other live → 4. Classifier: escrow-dependent fns retry on `"not initiated"`; `initiatePayment` on `"insufficient allowance"`. Latency-only on single-sequencer rails; no correctness break of compensate/refund rules.

---

### OK — `mmfAddress` degrade

**File:lines:** `lib/chain.ts:190-196`. Returns `undefined` when undeployed; not on the T4 payout reconcile path.

---

## Residual rulings (R1–R4)

| Id | Ruling | One-line |
|---|---|---|
| **R1** | **accept (automation) / escalate (ops UX)** | Fail-closed non-action on unknown is correct; missing operator re-reconcile tool strands humans in practice (stuck list is watch-only for this state). |
| **R2** | **accept with caveat** | Hash/audit split is an audit consistency gap, not a demonstrated double-pay; money path keys off the column. Tighten with transactional bookkeeping later. |
| **R3** | **accept (out of money-path primary scope)** | deploy-testnet mode-level orphan MMF is a deploy ops residual; not an executor/chain settle invariant. Documented caveat sufficient for T5 money review. |
| **R4** | **accept — do not “fix”** | Comment at `lib/chain.ts:265-278` is accurate: viem throws on missing receipt → `catch` → `"unknown"`. Mapping NotFound→`"absent"` would make catch compensate while a mempool tx can still mine — **reintroduces T1-1**. The `if (!receipt) return "absent"` arm (`286`) is dead against current viem; leave it for hooks/future provers only. |

---

## Direct answers

| Question | Answer |
|---|---|
| Can `repairCompensation` double-pay? | **Not** via confirmed/unknown destination evidence. **Yes** via compensation-transfer receipt loss + retry (P1). |
| Can `stuckPayments` drop a stranded payment on RPC failure? | **No** for escrow-read failure (`null` kept). **Yes** for `PAYOUT_PENDING` without hash (not RPC — candidacy gap). |
| `destinationTxHash` set, receipt unknown — anything auto-act? | **No.** Stays `PAYOUT_PENDING`; audit only; stuck list only. |

---

## Recommended next commits (priority)

1. **P1** Apply T4 persist/reconcile pattern to `runCompensationTransfer` + repair (decisions-log design choice if schema needed).
2. **P1** In-memory / retry persist of `destinationTxHash` if DB write fails after broadcast; regression hook.
3. **R1 ops** Operator “re-reconcile destination” API (confirmed→forward, reverted→compensate, unknown→409).
4. **P2** Widen `stuckPayments` to all `PAYOUT_PENDING`; fix stuck-UI diagnosis for unresolved dest.
5. **Tests** repair-refuses-unknown; `transactionOutcome` NotFound→unknown unit test; do **not** add production NotFound→absent.
