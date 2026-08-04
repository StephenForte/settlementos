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

(entries here)

## T2 — deploy/registry hardening

(entries here)

## T3 — MMF runbook + coverage

(entries here)
