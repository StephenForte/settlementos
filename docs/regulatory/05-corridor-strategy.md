# SettlementOS — Corridor Strategy Memo

> **STATUS: FROZEN TEMPLATE (2026-08-10).**  
> This memo is an **unreviewed draft**, frozen on this date. It is **illustrative
> scaffolding** for a bank or licensed partner evaluating SettlementOS — not legal,
> regulatory, or compliance advice, and not authoritative for any jurisdiction.  
> An adopter is expected to **replace** this document with their own. Substitution
> points use `[[ADOPTER: …]]` (see [README.md](README.md)).

**Audience:** internal strategy, prospective partners.
**Purpose:** explain the live corridors, why they were chosen, the per-corridor
operational considerations, and the expansion path.
**Status:** corridors are live on the testnet POC with simulated FX and payout.
Rates below are the POC's static demo rates, not market rates.
**Programme corridors:** [[ADOPTER: production corridor set (replace the illustrative USD/JPY/SGD table below)]].

---

## 1. Live corridors

| Corridor | Assets (source → dest) | POC demo mid-rate |
|---|---|---|
| **[[ADOPTER: corridor 1 — draft USD → JPY]]** | mockUSDC → mockJPY | 157.20 |
| **[[ADOPTER: corridor 2 — draft USD → SGD]]** | mockUSDC → mockSGD | 1.35 |
| **[[ADOPTER: corridor 3 — draft SGD → JPY]]** | mockSGD → mockJPY | 116.44 |

Inverse corridors (JPY→USD, SGD→USD, JPY→SGD) are supported via nearest-rounded
inverse rates. Same-currency settlement (e.g. USD→USD) is a legal corridor and
settles at parity. Corridor eligibility is enforced per entity at onboarding
(each entity carries an approved-corridors list) and re-checked in the compliance
gate.

## 2. Why these corridors

- **[[ADOPTER: anchor currency — draft used USD]] is the anchor.** Every corridor
  either starts or ends in that currency in the draft set, matching where
  regulated stablecoins and liquidity are deepest and where the
  [[ADOPTER: lead-jurisdiction-first regulatory posture — draft used US-first]]
  applies.
- **[[ADOPTER: secondary corridor markets — draft used Japan and Singapore]]** are
  high-value B2B trade corridors with sophisticated counterparties, real
  cross-border settlement pain (speed, cost, cut-off times), and mature regulators
  ([[ADOPTER: secondary regulators — draft cited MAS, JFSA]]) whose frameworks make
  a compliant infrastructure story legible.
- **[[ADOPTER: precision-exercising currency pair — draft used JPY (0 decimals) and SGD (2 decimals)]]**
  exercise the money model's precision handling end to end — a deliberate proof
  that the base-unit discipline holds across currencies with different minor units.

## 3. Per-corridor considerations

For each live corridor, the operating questions are the same and are owned jointly
with the licensed partner:

- **Liquidity** — the treasury must hold destination-asset inventory (or park/
  recall it via the MMF feature) sufficient for in-flight payments; reservations
  make promised liquidity untouchable. Real corridors need real, funded inventory
  from the partner.
- **FX** — the POC simulates rates; production needs a regulated FX source and rate/
  markup disclosure (see [legal classification §4](03-legal-classification.md)).
- **Compliance** — sanctions and corridor eligibility are screened today; real KYB
  and jurisdiction-specific AML/Travel-Rule handling are the partner's program.
- **Settlement asset** — a regulated stablecoin acceptable in both endpoints.

## 4. Expansion path

1. **Deepen the anchor corridors**
   ([[ADOPTER: anchor corridor set — draft used USD↔JPY, USD↔SGD, SGD↔JPY]]) with a
   licensed partner and real liquidity before adding breadth.
2. **Add [[ADOPTER: next corridor tranche — draft suggested USD↔EUR / USD↔GBP]]**
   once a [[ADOPTER: regional licensed partner for that tranche]] and matching
   stablecoin liquidity are available — large, well-understood corridors.
3. **Add [[ADOPTER: opportunistic corridor tranche — draft suggested intra-Asia e.g. SGD↔HKD, JPY↔KRW]]**
   where a partner already operates.
4. **Generalize**: adding a corridor is configuration (network registry, asset
   mapping, FX source, entity approvals) plus liquidity and a compliant partner —
   not new settlement code. The architecture is corridor-agnostic; the constraints
   are liquidity, licensing, and FX, not engineering.

## 5. Sequencing principle

Corridors go live **one licensed partner and one funded corridor at a time**, gated
by the [pilot options memo](06-pilot-options.md): sandbox → licensed-partner pilot →
limited real-money → scale. Breadth without a licensed, funded partner behind a
corridor is not a real corridor.
