# SettlementOS — Real-Money Pilot Options Memo

> **STATUS: FROZEN TEMPLATE (2026-08-10).**  
> This memo is an **unreviewed draft**, frozen on this date. It is **illustrative
> scaffolding** for a bank or licensed partner evaluating SettlementOS — not legal,
> regulatory, or compliance advice, and not authoritative for any jurisdiction.  
> An adopter is expected to **replace** this document with their own. Substitution
> points use `[[ADOPTER: …]]` (see [README.md](README.md)).

**Audience:** internal strategy, prospective licensed partners, and (informally)
regulators.
**Purpose:** lay out the staged path from the testnet POC to a limited real-money
pilot, with an explicit risk gate at each step tied to what the POC does and does
not yet do.
**Status:** the system is a testnet proof of concept. No stage below involves real
customer funds until its gate is cleared.
**Not legal advice** — see the [legal classification memo](03-legal-classification.md).
**Pilot owner:** [[ADOPTER: programme / partner owning the pilot]].
**Target pilot window:** [[ADOPTER: pilot start/end dates or milestone calendar]].

---

## 1. Principle

Real money is introduced **last, in the smallest credible increment, behind a
licensed partner**, and only after the specific limitation that made a stage risky
has been closed. Each stage has a go/no-go gate; a stage does not begin until the
prior gate is cleared.

## 2. Stages

### Stage 0 — Testnet POC *(current)*

- **What runs:** full lifecycle on public testnets
  ([[ADOPTER: demo networks — draft cited Base Sepolia, Polygon Amoy]]);
  mock assets; simulated FX, bridge, and payout; sanctions + wallet screening
  against real vendor sandboxes; complete audit + reconciliation.
- **Funds at risk:** none.
- **Purpose:** prove the technical, operational, and product architecture is
  credible enough to show regulators and partners.
- **Exit gate → Stage 1:** legal classification
  ([[ADOPTER: lead jurisdiction — draft used US]]) complete enough to confirm the
  infrastructure-not-money-transmitter operating model; a lead licensed partner
  identified — [[ADOPTER: named lead licensed partner]].

### Stage 1 — Regulator/partner sandbox

- **What changes:** the same POC, walked through with a regulator and/or a licensed
  partner; possibly the partner's real KYB and compliance program wired into the
  gate; still no real customer funds.
- **Funds at risk:** none (or partner's own test funds).
- **Exit gate → Stage 2:** partner's AML program of record in place; custody/KMS
  wired; FX source and disclosure model agreed; Travel-Rule approach chosen;
  treasury/MMF feature deferred or cleared.

### Stage 2 — Licensed-partner pilot (real assets, closed set)

- **What changes:** real regulated stablecoin as the settlement asset, moved by the
  **licensed partner** on a small, closed set of vetted business counterparties
  ([[ADOPTER: closed counterparty set]]) on
  **one** corridor ([[ADOPTER: first real-money corridor]]); SettlementOS remains
  software-only; qualified custody in place ([[ADOPTER: custodian]]).
- **Funds at risk:** real, but small, closed, and behind the partner's license and
  custody — [[ADOPTER: pilot notional / per-payment / aggregate caps]].
- **Exit gate → Stage 3:** clean reconciliation and audit across the pilot; no
  compliance escapes; operational runbook (incident, repair, key rotation) proven;
  the POC-grade infrastructure limitations (§4) closed for production scale.

### Stage 3 — Limited real-money pilot (scoped)

- **What changes:** wider but still bounded set of business customers on the initial
  corridor(s); real fiat on/off ramps via the partner; monitoring and limits live.
- **Funds at risk:** real, scoped by caps and corridor.
- **Exit gate → Stage 4:** sustained clean operation; regulator awareness/comfort;
  economics validated.

### Stage 4 — Jurisdiction-by-jurisdiction rollout

- **What changes:** additional corridors/jurisdictions, each with its own licensed
  partner and local counsel sign-off
  ([[ADOPTER: rollout jurisdiction / regulator pairs — draft cited Singapore/MAS, Japan/JFSA]],
  then breadth per the [corridor strategy](05-corridor-strategy.md)).
- **Funds at risk:** managed per jurisdiction, one partner and one funded corridor
  at a time.

## 3. Gate summary

| Gate | Blocks until |
|---|---|
| 0 → 1 | [[ADOPTER: lead jurisdiction]] operating-model classification confirmed; lead partner identified |
| 1 → 2 | Real KYB/AML program, custody/KMS, FX source, Travel Rule, MMF decision |
| 2 → 3 | Clean pilot reconciliation + audit; runbook; production-grade infra |
| 3 → 4 | Sustained clean operation; regulator comfort; economics |

## 4. POC limitations each real-money stage must close

These are the honest edges of the POC (from the [technical
architecture](01-technical-architecture.md)); a real-money stage cannot open over
an unclosed one:

- **Simulated FX / bridge / payout** → real regulated FX source; real settlement
  asset; real fiat rails (partner).
- **Mocked KYB** → the partner's real KYB/AML program of record.
- **POC datastore & rate limiter** (SQLite, per-process) → Postgres + shared limiter
  store for a multi-instance deployment (both documented).
- **Operator-controlled settlement contract** → production key-management policy,
  KMS/HSM custody, monitoring, and separation of deploy vs. runtime keys (the
  custody seam exists for exactly this).
- **Audit anchor signed but not externally published** → publish the anchor to a
  counterparty or public chain so deletion of the anchor itself is detectable.
- **Treasury/MMF feature** → deferred until its securities analysis (legal §5)
  clears, or kept off for the pilot.

## 5. Recommendation

Proceed Stage 0 → 1 now: the architecture is ready to *show*. Do not open any
real-money stage until (a)
[[ADOPTER: lead jurisdiction — draft used US]] legal classification confirms the
operating model and (b) a licensed partner owns funds, custody, and the AML program
of record. The engineering to close §4 is understood and mostly
configuration/deployment, not new design — the gating path is legal and partner,
not technical.
