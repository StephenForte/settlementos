# Track B — Regulatory / Partner Package

The story told to regulators, payment partners, fintechs, banks, and strategic
partners about the system built in Tracks 1–9A. Track A (production hardening per
`AUDIT.md`) closed the gap between "credible demo" and "operational architecture";
Track B documents how that architecture is meant to be operated, licensed, and
partnered.

**Grounding rule for every document here:** claims are grounded in what the code
actually does (see [AGENTS.md](../../AGENTS.md), [PRD.md](../../PRD.md),
[AUDIT.md](../../AUDIT.md)). Simulated, stubbed, and planned capabilities are
labelled as such — a regulator-facing package that overstates what exists is worse
than one that is modest and exact. Nothing here is legal advice; the legal and
regulatory memos frame **questions for counsel and regulators**, not conclusions.

## Deliverables (PRD §9)

Decisions taken (2026-07-16): **markdown memos**; **US-first** jurisdiction lead
(SG/JP as live corridors and parallel workstreams); the legal memo is framed as
**questions for counsel**, drawing no legal conclusions.

| # | Document | Status |
|---|---|---|
| 01 | [Technical architecture](01-technical-architecture.md) | ✅ Draft |
| 02 | [Regulatory design memo](02-regulatory-design.md) | ✅ Draft |
| 03 | [Legal classification memo](03-legal-classification.md) | ✅ Draft (questions for counsel) |
| 04 | [Partner integration memo](04-partner-integration.md) | ✅ Draft |
| 05 | [Corridor strategy memo](05-corridor-strategy.md) | ✅ Draft |
| 06 | [Real-money pilot options memo](06-pilot-options.md) | ✅ Draft |
| — | Regulator demo deck | ⏳ Optional — buildable from 01 + 02 if a live pitch needs it |

## Review notes

These are **drafts for Stephen's review**, not finished external documents. Before
anything leaves the building: Stephen's pass on positioning and tone; the legal
classification memo goes to actual counsel (it is structured for that); and the
US-first framing gets confirmed against the intended domicile / partner. The
regulator demo deck is deliberately left as an optional build from the technical
architecture + regulatory design memos, since it only matters for a live pitch.
