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

---

## T1 — bridge-leg verification

### T1-1: destination-payout receipt loss can compensate after tokens moved
- Status: OPEN
- Type: bug-found-elsewhere
- Detail: In `lib/chain.ts` `treasuryTokenTransfer`, `writeContract` returns a hash then `confirm()` awaits the receipt. If the RPC drops after the dest transfer mines but before the receipt returns, `lib/executor.ts` never writes `destinationTxHash` and the catch path treats the recipient as unpaid → `compensateSender` on source while dest tokens already sit on the recipient wallet (treasury double-pay). Pre-existing for all bridges; more likely on a best-effort single-sequencer ForteL2 than on Base/Amoy public RPCs. Proposed direction for T4: persist the hash as soon as `writeContract` returns (before receipt), or reconcile dest balance before compensating. No lib edit in T1.
- Resolution:

### T1-2: operatorWrite replica-lag retries on a single-sequencer L2
- Status: OPEN
- Type: bug-found-elsewhere
- Detail: `operatorWrite`'s `retryOnReplicaLag` classifies `"not initiated"` / `"insufficient allowance"` as transient. On fortel2-sepolia (no replica; `readRpcUrl` optional) those strings are usually real failures, so a ForteL2 *source* leg can burn ~4×2s before failing closed. Not a correctness break of the compensate/refund invariants. T4 may want a network-aware retry policy or shorter budget for single-node rails.
- Resolution:

### T1-3: quoting claim VERIFIED for ForteL2 network ids
- Status: APPROVED
- Type: design-choice
- Detail: Hermetic `tests/db/fortel2-bridge-route.test.ts` proves `quoteRoutes` emits correct `BRIDGE_AND_SETTLE` for base-sepolia↔fortel2-sepolia both ways (fee, assets, labels, FX math = Base↔Polygon control). `liquidityCheck` degrades as documented when fortel2 is absent from fixture deployments. Executor bridge path is network-generic by inspection; live settle still needs the manual runbook.
- Resolution: landed in T1 PR; no lib change required for quoting.


## T2 — deploy/registry hardening

(entries here)

## T3 — MMF runbook + coverage

(entries here)
