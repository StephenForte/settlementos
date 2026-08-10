# SettlementOS — Legal Classification Memo

> **STATUS: FROZEN TEMPLATE (2026-08-10).**  
> This memo is an **unreviewed draft**, frozen on this date. It is **illustrative
> scaffolding** for a bank or licensed partner evaluating SettlementOS — not legal,
> regulatory, or compliance advice, and not authoritative for any jurisdiction.  
> An adopter is expected to **replace** this document with their own. Substitution
> points use `[[ADOPTER: …]]` (see [README.md](README.md)).  
> **Do not resolve the open questions below in this repository** — answers belong
> to qualified counsel, not to a software project.

> **This is not legal advice.** It draws no legal conclusions. It is a structured
> set of **issues and questions for qualified counsel and regulators**, grounded in
> what the system does (see [technical architecture](01-technical-architecture.md)
> and [regulatory design](02-regulatory-design.md)). Every item below should be
> confirmed, corrected, or ruled out by licensed counsel in the relevant
> jurisdiction before any real-money operation.

**Lead jurisdiction:** [[ADOPTER: lead jurisdiction — draft used United States]].
Secondary: [[ADOPTER: secondary jurisdictions — draft used Singapore, Japan]]
(live corridors).
**Counsel:** [[ADOPTER: lead counsel / firm for classification analysis]].
**Framing assumption to test first:** SettlementOS operates as **technology
infrastructure** to a licensed, fund-holding partner, and does not itself touch
customer funds. Much of the analysis below turns on whether that assumption holds
in fact and in law.

---

## How to read this memo

Each section states (a) what the system does today, (b) the classification
question, and (c) the specific questions for counsel. Answers should feed the
regulatory design memo and the pilot go/no-go gates.

## 1. Money transmission (US)

- **What the system does:** orchestrates the movement of value between businesses;
  in the target model the licensed partner moves the funds, SettlementOS provides
  software.
- **Question:** does SettlementOS's role constitute "money transmission" or
  "receiving money for transmission" under
  [[ADOPTER: lead-jurisdiction money-transmission / BSA (or equivalent) rules — draft cited FinCEN BSA + state MTL statutes]],
  or does the not-touching-funds / infrastructure posture
  place it outside the definition (e.g. a payment-processor or agent-of-the-payee
  analysis)?
- **For counsel:**
  - Does escrow via an operator-controlled smart contract count as SettlementOS
    "controlling" or "holding" funds, even on testnet-derived architecture?
  - [[ADOPTER: federal / national registration question — draft cited FinCEN MSB]]:
    required, or avoided under the infrastructure model?
  - [[ADOPTER: sub-national licence footprint — draft cited US state MTLs]]:
    which territories, and does an agent/partner model cover them?
  - Does the treasury account that receives released escrow change the analysis?

## 2. Stablecoin usage

- **What the system does:** settles in mock ERC-20 stand-ins for
  [[ADOPTER: corridor currencies — draft used USD/JPY/SGD]]
  stablecoins; production would use real regulated stablecoins.
- **Question:** classification and permissibility of the specific settlement
  stablecoins, and any issuer-imposed or regulatory constraints on using them for
  B2B settlement.
- **For counsel:** which stablecoins are acceptable settlement assets in each
  jurisdiction; issuer terms; any pending US federal stablecoin legislation that
  changes the analysis; reserve/redemption assurances required.

## 3. Custody

- **What the system does:** the escrow contract and treasury hold on-chain assets;
  signing is behind a custody seam with a KMS/HSM extension point; entity wallets
  grant exact per-payment allowances.
- **Question:** does any part of this constitute custody of customer assets by
  SettlementOS, triggering custody rules or a qualified-custodian requirement?
- **For counsel:** where must a qualified custodian sit; does operator control of
  the settlement contract equal custody; does the exact-allowance / no-standing-
  approval design help; what key-management standards must the fund-holding entity
  meet.

## 4. Foreign exchange

- **What the system does:** applies a **simulated** FX conversion (static mid rate,
  spread, tiered slippage, platform fee) during settlement.
- **Question:** does providing FX quotes/conversion implicate FX dealer/broker
  regulation, and how must the rate and fee be disclosed?
- **For counsel:** FX licensing/registration for the fund-holding entity; rate and
  markup disclosure requirements; whether a third-party regulated FX provider is
  required in production.

## 5. Securities / investment product (the treasury feature)

- **What the system does:** an **optional, operator-only, opt-in, simulated**
  tokenized money-market-fund feature parks idle treasury liquidity for overnight
  yield; it is strictly segregated from payment escrow and never involves customer
  funds.
- **Question:** would a productionized version be an investment company / security
  / regulated fund product, and does keeping it operator-only and segregated from
  customer funds keep it out of scope?
- **For counsel:** securities/'40-Act analysis of the MMF feature; whether it can
  exist at all in a settlement product without separate licensing; disclosure and
  segregation requirements; whether to defer the feature entirely for the pilot.

## 6. AML / BSA / sanctions

- **What the system does:** a compliance gate on every execution — KYB, sanctions
  (real OpenSanctions sandbox), wallet screening (real Chainalysis sanctions-oracle
  sandbox), transaction risk, corridor eligibility; any provider error resolves to
  MANUAL_REVIEW (never a silent pass); verbatim vendor evidence is persisted; a
  reviewer queue exists. KYB is mocked in the POC.
- **Question:** does the program meet BSA/AML program expectations and OFAC
  screening obligations for the fund-holding entity, and what is missing?
- **For counsel / compliance:** required elements of the AML program of record
  (currently KYB is a mock); SAR/CTR obligations; OFAC screening scope (parties +
  wallets) and recordkeeping; who owns the program — SettlementOS or the partner.

## 7. Travel Rule

- **What the system does:** records originator/beneficiary entity identity, wallets,
  amounts, and a full audit trail per payment.
- **Question:** which transfers trigger the Travel Rule, and can the captured data
  satisfy originator/beneficiary information-sharing requirements?
- **For counsel:** thresholds and applicability to on-chain B2B settlement; required
  data fields vs. what is captured; a Travel Rule messaging solution/provider; how
  the requirement is met across the
  [[ADOPTER: corridor jurisdiction set — draft used US/SG/JP]] corridors.

## 8. Data retention & privacy

- **What the system does:** persists entities, payments, compliance results
  (including verbatim vendor responses), and an append-only audit log. Public-chain
  activity (addresses, amounts, timing) is inherently public; the design keeps PII,
  invoice references, and internal identifiers **off-chain / out of calldata**.
- **Question:** retention periods, data-subject rights, cross-border data transfer,
  and the treatment of on-chain data that cannot be deleted.
- **For counsel:** applicable privacy regimes across corridors; retention schedule
  for compliance evidence; the "public chain = public data" disclosure and consent
  posture; immutability vs. erasure-rights tension.

## 9. Consumer vs. B2B distinction

- **What the system does:** B2B only; onboarded business entities on both sides; no
  consumer flows.
- **Question:** does the B2B-only scope reliably keep the product out of consumer-
  protection and consumer money-transmission regimes, and how is "business" enforced
  at onboarding?
- **For counsel:** definitional lines for "business" vs "consumer" per jurisdiction;
  onboarding controls needed to keep consumers out; disclosures if any consumer-
  adjacent use is possible.

## 10. Cross-corridor ([[ADOPTER: secondary jurisdictions — draft used Singapore, Japan]]) — flag for local counsel

The same questions recur under
[[ADOPTER: secondary regulator / statute set — draft cited MAS (Singapore Payment Services Act — cross-border money transfer / DPT) and JFSA (Japan — funds-transfer and crypto-asset registration)]].
Each corridor needs local counsel; this memo leads with
[[ADOPTER: lead jurisdiction — draft used US]] and flags
[[ADOPTER: secondary workstreams — draft used SG/JP]] as parallel workstreams once
the lead position is set.

## 11. Priority questions (the ones that gate a real-money pilot)

1. Does the infrastructure-not-money-transmitter framing hold in the US? (§1)
2. Is any part of the flow "custody" by SettlementOS? (§3)
3. Is the treasury/MMF feature a securities problem, and should it be deferred? (§5)
4. Whose AML program of record governs, and what must be added (real KYB)? (§6)
5. How is the Travel Rule satisfied on-chain across corridors? (§7)

These five determine whether the pilot can be structured as designed or needs a
different operating model.
