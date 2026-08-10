# Track B — Regulatory / Partner Package (frozen templates)

**Status: FROZEN TEMPLATES — 2026-08-10.**

This directory is a **reference scaffolding pack**, not a finished compliance
file for any bank, partner, or jurisdiction. The six memos were drafted
2026-07-16 / 2026-07-24, never counsel-reviewed, and are now **frozen** so an
adopter can swap them for their own documents without mistaking the drafts for
authoritative advice.

**Grounding rule (unchanged):** claims about SettlementOS are grounded in what
the code actually does (see [AGENTS.md](../../AGENTS.md), [PRD.md](../../PRD.md),
[AUDIT.md](../../AUDIT.md)). Simulated, stubbed, and planned capabilities are
labelled as such. **Nothing here is legal advice.** The legal and regulatory
memos frame **questions for counsel and regulators**, not conclusions — freeze
preserves that framing; do not "improve" a question into an answer.

## What this pack is

| # | Document | Role in the pack |
|---|---|---|
| 01 | [Technical architecture](01-technical-architecture.md) | What the system does, structurally |
| 02 | [Regulatory design memo](02-regulatory-design.md) | Intended operating posture (infrastructure to a licensed partner) |
| 03 | [Legal classification memo](03-legal-classification.md) | **Questions for counsel** — deliberately no conclusions |
| 04 | [Partner integration memo](04-partner-integration.md) | How a partner integrates; responsibility split |
| 05 | [Corridor strategy memo](05-corridor-strategy.md) | Illustrative corridor set and expansion path |
| 06 | [Real-money pilot options memo](06-pilot-options.md) | Staged path and go/no-go gates |
| — | Regulator demo deck | Optional — buildable from 01 + 02 if a live pitch needs it |

## Placeholder convention

Adopter-owned facts use a single greppable form:

```text
[[ADOPTER: short description of what to substitute]]
```

Examples of what belongs in a placeholder (not an exhaustive list):

- Legal entity / product operating name for the deploying party
- Lead and secondary **jurisdictions**
- **Licence categories** and named statutes/regulators
- **Corridor** currencies, rates policy, and expansion targets
- Named **counterparties** (licensed partner, custodian, FX source, counsel)
- Pilot **dates**, caps, and closed counterparty sets

Search the tree with:

```bash
rg '\[\[ADOPTER:' docs/regulatory/
```

Product engineering names that describe *this* codebase (e.g. contract names,
API shapes, SettlementOS as the software under discussion) are left unmarked.
Replace the **memo**, not the architecture vocabulary, when you adopt.

## How to swap in your own documents

1. **Copy this directory** (or start a parallel pack owned by your compliance /
   legal workstream). Do not edit the frozen originals in place if you need a
   paper trail of the template.
2. **Replace each memo** with your institution's equivalent: same topic coverage
   is useful; the words and conclusions must be yours (and counsel's).
3. **Resolve every `[[ADOPTER: …]]`** — grep until there are zero matches, or
   delete the placeholder convention entirely once your pack no longer needs it.
4. **Send 03 (legal classification) to qualified counsel** before any real-money
   stage. Keep it as questions until counsel answers; do not let an engineer
   close the open items.
5. **Re-ground technical claims** against the code you will actually run (fork /
   version / configuration), using AGENTS.md / PRD.md / AUDIT.md as the pattern,
   not as your production evidence.
6. **Drop or rewrite** any US-first / USD–JPY–SGD framing that does not match
   your programme — those choices were illustrative for the original draft.

## Review notes (historical)

Original decisions (2026-07-16): markdown memos; US-first jurisdiction lead
(SG/JP as live corridors and parallel workstreams); legal memo framed as
questions for counsel. Those decisions remain visible in the frozen text as
`[[ADOPTER: …]]` substitution points. Stephen's review and counsel engagement
were never completed before freeze — treat the pack accordingly.
