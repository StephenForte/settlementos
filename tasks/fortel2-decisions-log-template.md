# ForteL2 wave decisions log — <DATE>

Copy this file to `tasks/fortel2-decisions-<date>.md` at the start of each
wave. Every worker reads the whole file before starting and appends **only
under its own task heading** (concurrent appends then land in different line
ranges and merge cleanly). Stephen (or the integrator) resolves items marked
OPEN; workers must not act on an OPEN item.

Rules of the log:
- A worker writes here INSTEAD of touching a file outside its allowlist,
  adding a dependency, or deviating from its assignment. Proposal first,
  code only after the entry is marked APPROVED.
- Entries are append-only. To change a decision, add a new entry that
  supersedes the old one; never rewrite history.
- Keep entries to the format below. No essays.

Entry format:

```
### <task>-<n>: <one-line title>
- Status: OPEN | APPROVED | REJECTED | SUPERSEDED by <id>
- Type: file-outside-allowlist | new-dependency | design-choice | bug-found-elsewhere | scope-question
- Detail: <2-5 lines: what, why, and the smallest viable alternative if rejected>
- Resolution: <filled by integrator>
```

## Wave-level standing decisions (integrator fills before kickoff)

- Base commit for this wave: `<sha of origin/main at kickoff>`
- Doc-freeze in effect: workers do not edit README/DEMO/AGENTS/CLAUDE/PRD/
  prd-fortel2-integration.md; doc snippets go in handback reports.
- Dependency freeze in effect: no package.json/package-lock.json changes
  without an APPROVED entry here.

---

## T1 — bridge-leg verification

(entries here)

## T2 — deploy/registry hardening

(entries here)

## T3 — MMF runbook + coverage

(entries here)

## T4 — executor RPC resilience (wave 2)

(entries here)

## T5 — hardening review (wave 2)

(entries here)
