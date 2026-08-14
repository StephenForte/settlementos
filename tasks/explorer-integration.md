# Explorer ↔ SettlementOS — cross-repo state reconciliation (X1–X7)

Prepared 2026-08-14. Companion to [`tasks/fortel2-worker-plan.md`](fortel2-worker-plan.md)
(F-series) and [`tasks/hosting-worker-plan.md`](hosting-worker-plan.md) (J-series).
Structure mirrors both deliberately — verified state, task tree with model/order,
file ownership, commit contract — so an agent moving between them relearns nothing.

**Scope: documentation only.** This workstream changes no behaviour, adds no
dependency, and ships no feature. It exists because SettlementOS's prose about the
[`settlementos-explorer`](https://github.com/StephenForte/settlementos-explorer)
repo has drifted badly enough to mislead, and because nothing today says which repo
owns which fact — so the drift will recur unless the rule is written down.

**Explicitly out of scope**, each considered and deferred on 2026-08-14:

- Setting `explorerUrl` for `fortel2-sepolia` so SettlementOS deep-links into the
  explorer's tx/block pages. Real, specified (see **§0 finding 10**), and *not this
  workstream*. It is a code change with a live-reachability problem attached.
- Publishing a machine-readable address book from SettlementOS. Explorer **D31**
  decided against fetched-JSON/env config for those rows; reopening it needs an
  argument, not a task.
- Re-genesis re-key coordination between the two repos. Tracked at J4 and in the
  explorer's [`docs/FORTEL2-REKEY.md`](https://github.com/StephenForte/settlementos-explorer/blob/main/docs/FORTEL2-REKEY.md).

---

## 0. Verified state (read this before assigning anything)

Checked **2026-08-14** against both repos' live `origin/main` and, where noted, over
the network. Where a claim was verified, the method is named. Claims taken from the
other repo's own documents are attributed as such rather than presented as measured
here — that distinction is the whole subject of this workstream.

| Item | State | Evidence |
|---|---|---|
| SettlementOS `origin/main` | `f4b3402` | `git log` — "feat(mcp): read-only MCP server reusing API-key identity (J8) (#70)" |
| SettlementOS open PRs / issues | **0 / 0** | `gh pr list` / `gh issue list`, both empty |
| Explorer `main` | `d590d8d` (2026-08-14T22:02:59Z) | `gh api .../commits/main` — merge of PR #56 |
| Explorer open PRs / issues | **0 / 0** | `gh pr list` / `gh issue list --repo StephenForte/settlementos-explorer`, both empty |
| Explorer task series | **F6a → F6x complete**; next free `F6y` | explorer [`docs/PLAN.md`](https://github.com/StephenForte/settlementos-explorer/blob/main/docs/PLAN.md) §1, read at `d590d8d` |
| Explorer next free decision id | **`D38`** (`D37` retired unused with F6x) | explorer `docs/DECISIONS.md`, last heading `### D37` |
| Explorer test suite | **221 tests / 32 files** | **Their** reviewer's measurement on `c7c67dd`, per their PLAN §0. Not re-measured here — see **XD2**, this is exactly the kind of number this repo must not copy |
| Explorer live site | **up** | `curl` 2026-08-14: `/` → 200, `/fortel2-sepolia` → 200, `/api/health` → `{"ok":true,"service":"settlementos-explorer","mcpConfigured":true,"etherscanKeyConfigured":true}` |
| J8 (SettlementOS MCP server) | **merged** | `f4b3402`, PR [#70](https://github.com/StephenForte/settlementos/pull/70) |

### The drift inventory

Ten findings. Nine are stale claims in this repo; one is a gap; one (11) is the
mirror image in the other repo. Every line number is against `f4b3402`.

| # | Where | Claim | Reality |
|---|---|---|---|
| 1 | [`tasks/fortel2-worker-plan.md:15`](fortel2-worker-plan.md) | verified "against explorer `main` @ `f669cbe` for F6" | `main` is `d590d8d`; `f669cbe` is ~20 merges stale |
| 2 | `tasks/fortel2-worker-plan.md:24` | F6 row: "`main` @ `f669cbe` … **F6a–F6q** series complete" | Series runs to **F6x** — adds tx detail pages, block detail pages, and two MCP tools |
| 3 | `tasks/fortel2-worker-plan.md:113` | "complete on `main` @ `f669cbe` (F6a–F6q)" | Same as 1 + 2 |
| 4 | [`tasks/prd-fortel2-integration.md:168`](prd-fortel2-integration.md) | "F6a–F6q complete on `main` @ `f669cbe`" | Same as 2 |
| 5 | [`tasks/prd-settlementos-explorer.md`](prd-settlementos-explorer.md) `:3–14`, `:39`, `:41`, `:65` | Status note and three acceptance criteria cite clone `f669cbe`; six criteria left unticked pending a browser look | The whole document is a duplicate acceptance list for a repo that keeps its own. US-010's live-URL criterion is now partly answerable (site 200 + health ok). See **XD1** |
| 6 | [`CLAUDE.md:220`](../CLAUDE.md) | "NEXT: **optional F6 explorer address book** — build it so the ForteL2 rows can be re-keyed after the re-genesis" | F6 is not pending work. The address book shipped in explorer PR #4 and the series ran 23 more tasks past it; the re-key path is written up in the explorer's `docs/FORTEL2-REKEY.md` (structure decided in **D31**) |
| 7 | `CLAUDE.md:226` | "Optional **J8 MCP server** — nothing waits on it" | J8 merged as `f4b3402` (PR #70) |
| 8 | [`tasks/hosting-worker-plan.md:41`, `:55`](hosting-worker-plan.md) | J8 "**Open** … Not started here" | Merged (7). Separately, **J9 does not appear in that doc at all** despite shipping in PR #67 — boundary item, see **X6** |
| 9 | [`PRD.md:18`](../PRD.md) | "F6 explorer address book done … (PR #4 → `20f17ff`)" | True but frozen at the first sub-task; reads as if the explorer is an address book |
| 10 | **Gap, not drift** — [`lib/networks.ts:64`](../lib/networks.ts) | "No block explorer yet, so tx links stay null" | Still true of *public block explorers*. But the explorer now publishes a **URL contract addressed to SettlementOS** — canonical `/{networkId}/tx/{txHash}` and `/{networkId}/block/{numberOrHash}`, aliases `/tx/{hash}?chainId=852` and a bare `/tx/{hash}` defaulting to `fortel2-sepolia` (**D33**), hashes matched case-insensitively, deep links surviving a hard refresh. Their PRD §4 calls it "an integration contract, not an internal route". This repo records it nowhere |
| 11 | **Reciprocal** — explorer `docs/PLAN.md:3–5` | says this repo's `tasks/fortel2-worker-plan.md` §0 tracks F6 as *"Partially done, out of repo"* | §0 line 24 says **"Done (out of repo)"**. Drift runs both ways |

**What is *not* wrong, and must survive every edit.** The address-book provenance
paragraphs (`prd-fortel2-integration.md:175`, `fortel2-worker-plan.md:24`) are
correct and hard-won: the ForteL2 rows were confirmed by F6c chain-852 liveness and
F6f against gitignored `chain/deployments.fortel2-sepolia.json`, **not** by the
explorer's `EXPECTED` unit test, which compares two constants in the same commit and
is a tautology (their PLAN §6 trap 2). Any task that touches those lines preserves
the distinction verbatim. Likewise [`AGENTS.md:554`](../AGENTS.md)'s re-genesis row is
accurate; it only wants a pointer added.

---

## 1. Task tree

```
X1  retire tasks/prd-settlementos-explorer.md to a pointer stub   [XD1]
X2  tasks/fortel2-worker-plan.md — F6 rows become pointers
X3  tasks/prd-fortel2-integration.md — US-F007 F6 line becomes a pointer
X4  CLAUDE.md NEXT block + PRD.md roadmap row
X5  AGENTS.md — record the URL contract; correct the lib/networks.ts comment  [XD3]
X6  tasks/hosting-worker-plan.md — J8 status + missing J9      [boundary, see §4]
X7  explorer-side reciprocal fix (finding 11)                  [planner only — not dispatchable]
```

X1–X6 own disjoint files and **may all run in parallel**. There is no dependency
between them; the only shared artifact is this plan, which workers never edit.

| ID | Status | Model / order | Owns | Notes |
|---|---|---|---|---|
| **X1** | Open | strong · parallel | `tasks/prd-settlementos-explorer.md` | Judgment task despite being one file. **XD1** pre-assigned |
| **X2** | Open | cheap · parallel | `tasks/fortel2-worker-plan.md` | Findings 1–3. Preserve the provenance paragraph verbatim |
| **X3** | Open | cheap · parallel | `tasks/prd-fortel2-integration.md` | Finding 4. Do **not** re-tick or un-tick any US-F007 checkbox — that inconsistency is Stephen's open call, unrelated to this workstream |
| **X4** | Open | strong · parallel | `CLAUDE.md`, `PRD.md` | Findings 6, 7, 9. `CLAUDE.md`'s NEXT block is the most-read text in the repo; getting it wrong is what caused this workstream |
| **X5** | Open | strong · parallel | `AGENTS.md`, `lib/networks.ts` (comment only) | Finding 10 + the `AGENTS.md:554` pointer. **XD3** optional. Hard guard: **must not set `explorerUrl`** |
| **X6** | Open | cheap · parallel | `tasks/hosting-worker-plan.md` | Finding 8. J-series boundary — see §4 before dispatching |
| **X7** | Open | planner | explorer `docs/PLAN.md` | Finding 11. Their §2 makes `docs/PLAN.md` **planner-only**; a worker may not touch it. Planner-authored PR to the other repo |

---

## 2. File ownership

| File | Owner | Notes |
|---|---|---|
| `tasks/prd-settlementos-explorer.md` | X1 | Whole file; X1 may delete content wholesale if XD1 goes that way |
| `tasks/fortel2-worker-plan.md` | X2 | Lines 15, 24, 113 only. Leave the F1–F8 rows alone |
| `tasks/prd-fortel2-integration.md` | X3 | Line 166–168 prose only. **Checkboxes are frozen** |
| `CLAUDE.md`, `PRD.md` | X4 | |
| `AGENTS.md` | X5 | Not X4 — the split exists so the two can run at once |
| `lib/networks.ts` | X5 | **Comment text only.** Any change to a value, a key, or an export is out of scope and fails review |
| `tasks/hosting-worker-plan.md` | X6 | |
| `tasks/explorer-integration.md` (this file) | **planner only** | Workers never edit it |
| explorer `docs/PLAN.md`, `docs/DECISIONS.md` | **their planner only** | Their §2. X7 is authored, not dispatched |

**No append-only shared file in this workstream**, so the usual end-of-file conflict
does not apply — the decisions for X1–X6 live in §6 of this planner-owned file, and
workers cite them rather than appending to them. That is a deliberate departure from
the F-series `DECISIONS.md` pattern, justified by size: six docs tasks do not earn a
second file.

**The one likely collision anyway:** `main` moves under a task. Six PRs against six
docs will land over a short window and every one of them rebases cleanly *except*
when two workers were told to add the same pointer sentence. §5 fixes the pointer
wording once so they are byte-identical if they do collide.

---

## 3. Commit and merge contract

*Include verbatim in every worker prompt.*

- **Branch:** `docs/<task-slug>`, created from `origin/main` **at the moment you
  start**. Never branch from another task's branch.
- **Allowed to touch:** exactly the files in your assignment's ownership row. If you
  believe you need another file, stop and say so in the handback instead of editing it.
- **Never touch:** `tasks/explorer-integration.md`, any file owned by another X task,
  `.env`, `chain/*`, `package-lock.json`.
- **This workstream changes no behaviour.** If your diff touches a `.ts`/`.tsx`/`.sol`
  file in any way other than a comment, you have left scope.
- **Commit convention:** `docs: <what>` — mirror existing `git log` style.
- **Gate — all three must pass locally before handback:**
  ```
  npx tsc --noEmit && npm run lint && npm test
  ```
  A docs-only diff cannot break these, which is the point: a green gate proves the
  diff really was docs-only.
- **Never push to `main`.** Always a PR, even a one-line change.
- **You open the PR; you do not merge it.**

### Handback report

```
TASK:        <id> — <title>
BRANCH / PR: <branch> / <url>
GATE:        tsc / lint / tests <before> -> <after>
FILES TOUCHED: <exact list — must equal the ownership row>
CLAIMS REMOVED: <each stale claim you deleted, quoted, with the line it was on>
CLAIMS ADDED:   <each new claim, and how you verified it — a link is not verification>
DEVIATIONS FROM THE SPEC, AND WHY: <none, or numbered list>
RISKS AND FOLLOW-UPS: <the most useful field — write it honestly>
```

---

## 4. Integration order and boundaries

```
X1 ─┐
X2 ─┤
X3 ─┼─ all parallel, no ordering constraint
X4 ─┤
X5 ─┘
X6 ─── dispatch only after reading the boundary note below
X7 ─── planner, other repo, any time
```

**X6 is a boundary task and could be someone else's.** Findings 8's two halves are
J-series facts (J8's status, J9's absence) that happen to sit next to an explorer
pointer. The J-series plan's status column is known to go stale independently of this
workstream, and a previous session mis-attributed unnumbered chores to the deliberately
unallocated J5–J7. So X6 is scoped **narrowly**: correct J8's status, add a J9 row,
and touch nothing else in that table. Do **not** refresh J3-deploy or J4 as a
side-quest, and do **not** assign scope to J5–J7 — the plan says outright not to
invent work to fill those numbers.

**X7 crosses a repo boundary** and lands in a document their ownership table marks
planner-only. It does not go to a worker. It is one sentence, and the value is
symmetry: the rule in **XD2** binds both repos or it binds neither.

---

## 5. The pointer wording (use this, verbatim)

Every task that removes a stale claim replaces it with a pointer. Fixing the wording
here means six PRs produce the same sentence, so a collision resolves in seconds and
a future reader sees one idiom rather than six.

> Explorer work is tracked in that repo's
> [`docs/PLAN.md`](https://github.com/StephenForte/settlementos-explorer/blob/main/docs/PLAN.md)
> §0, which is authoritative — read it rather than any status copied here.

Where a specific closed item still needs naming (US-F007's acceptance criterion, the
address-book provenance), name the **PR number and its merge SHA in that repo**, which
are immutable, and never the branch tip or a task range.

---

## 6. Decisions

Append-only. Never renumber; supersede in place with a date and a reason.
Pre-assigned: **XD1** → X1, **XD3** → X5 (optional, retire it unused if X5 hits no
fork). **XD2** is the planner's, written below, and is the deliverable this whole
workstream exists to produce.

### XD1 — `tasks/prd-settlementos-explorer.md` is retired to a pointer stub

*Pre-assigned to X1. Recommendation, with the fork stated so the worker can dissent.*

The file is a 200-line acceptance-criteria list for a product that lives in another
repo and maintains its own, more rigorous, list. Every one of its `[x]` marks is a
claim about code this repo cannot see, and finding 5 shows what that costs: three
criteria cite a clone SHA that is 20 merges stale, and six sit unticked pending a
browser session nobody in this repo will run.

**Recommendation: reduce it to a stub** — the introduction (which is good product
writing and explains *why* the explorer exists), the Non-Goals section (a boundary
that is genuinely ours to state), and a pointer per §5. Delete the user stories, the
acceptance criteria, the functional requirements, and the open questions; the explorer
repo has all four in better shape.

**The dissent worth hearing:** the FR list and Open Questions record what *SettlementOS*
wanted, and deleting them loses the original intent behind a product now documented
only by its implementer. If the worker takes that view, the alternative is to keep
FR-1…FR-11 and Open Questions, marked as the **founding brief, frozen 2026-08-09**,
and delete only the user stories and their checkboxes. Either is defensible. Deleting
the checkboxes is not optional in either branch — a stale tick is the failure mode.

### XD2 — which repo owns which fact, and what may cross the boundary

*Planner's decision, 2026-08-14. This is the rule the workstream exists to install.*

**Each repo owns the facts it can verify in its own CI.** Everything else it may
*link to* and must not *copy*.

| Fact | Owner | The other repo may |
|---|---|---|
| Explorer task status, SHAs, test counts, decisions, live URL | explorer `docs/PLAN.md` §0 + `docs/DECISIONS.md` | link only |
| SettlementOS contracts, overlays, deploy modes, chain invariants | this repo's `CLAUDE.md` + `AGENTS.md` + `tasks/*` | link only |
| The ForteL2 address values themselves | **copied by design** into the explorer's `src/config/address-book.ts` (**D31**), with out-of-band provenance | — |
| The tx/block URL contract | explorer `docs/TX-VIEWER-PRD.md` §4 | quote the *shape*, cite the source |

**Four things may never be written about the other repo**, because each goes stale by
construction and neither CI checks prose:

1. **A branch-tip SHA.** `main` moves; a merge SHA does not. Cite PR + merge SHA.
2. **A task-range claim** ("F6a–F6q complete"). It is false the moment F6r merges,
   and it is false *silently* — nothing errors.
3. **A test count.**
4. **A status verb about their in-flight work** ("not started", "blocked", "optional").
   Status is theirs to declare; ours to link to.

**Why prose and not a lint rule:** a link-checker catches dead URLs, not a live URL
under a stale sentence — every claim in the inventory above sits beside a working
link. Automation would have caught none of them. The rule that actually works is
*don't write the copy in the first place.* An optional CI job that flags a 7-or-40-hex
string near "settlementos-explorer" is recorded as a **follow-up, not a task** — it is
worth doing only if this drifts a second time after the rule exists.

### XD3 — *(pre-assigned, optional)* where the URL contract is recorded

*For X5. Retire unused if the worker hits no fork.*

Finding 10 has a fork: record the contract in `AGENTS.md` (where an engineer looks
before touching a network) or in `lib/networks.ts` beside the `explorerUrl` comment
(where they look while touching one). Recommendation is **AGENTS.md, with a one-line
correction to the code comment** pointing at it — the contract is several lines and a
registry file should not grow prose. If the worker finds a third option or disagrees,
write the entry; if the recommendation just works, retire XD3 and say so.

---

## 7. Standing traps

1. **The claim you are fixing may be right.** Three of the eleven findings sit inside
   paragraphs that are correct and were expensive to establish — the address-book
   provenance and the `EXPECTED`-is-a-tautology point. Removing them while removing a
   stale SHA on the same line would destroy the more valuable text.
2. **`main` moves during a task** — six of these can be in flight at once. Re-check
   `origin/main` immediately before merging.
3. **A live link is not a verified claim.** Every stale sentence in §0 sits next to a
   URL that resolves. Verifying a pointer means reading what it points *at*.
4. **This repo's own notes are claims too.** `CLAUDE.md`'s state block and the J-series
   status column have both been wrong while reading as authoritative. A worker who
   "confirms" a fact by finding it in `CLAUDE.md` has confirmed nothing.
5. **`npm test` needs local Postgres 16.** A docs worker who cannot run the gate must
   say so in the handback rather than reporting a gate it did not run.
