# SettlementOS — Regulatory Design Memo

> **STATUS: FROZEN TEMPLATE (2026-08-10).**  
> This memo is an **unreviewed draft**, frozen on this date. It is **illustrative
> scaffolding** for a bank or licensed partner evaluating SettlementOS — not legal,
> regulatory, or compliance advice, and not authoritative for any jurisdiction.  
> An adopter is expected to **replace** this document with their own. Substitution
> points use `[[ADOPTER: …]]` (see [README.md](README.md)).
>
> **Amendment 2026-08-13.** §10 added: ForteL2's confirmed L1-calldata
> data-availability fact, framed as a question for counsel. The 2026-08-10
> freeze, the not-advice framing, the `[[ADOPTER: …]]` convention, and the
> instruction to replace this document are unchanged. This memo still draws no
> legal conclusions.

**Audience:** internal strategy, prospective regulated partners, and (in
redacted form) informal regulator conversations.
**Purpose:** describe, in regulator-legible terms, what SettlementOS does and does
not do, who touches funds, where funds are held, which jurisdictions are in scope,
and the licensing paths available — so that formal legal and regulatory engagement
can begin from an accurate picture.
**Lead jurisdiction:** [[ADOPTER: lead jurisdiction — draft used United States]],
with [[ADOPTER: secondary corridor jurisdictions — draft used Singapore and Japan]]
as the live cross-border corridors (see [corridor strategy](05-corridor-strategy.md)).
**Status:** the product is a testnet proof of concept. This memo describes the
architecture's *intended* operating posture; where a capability is simulated or
absent today, it says so. This memo is not legal advice; see the
[legal classification memo](03-legal-classification.md).

---

## 1. One-paragraph description

SettlementOS is a **technology infrastructure provider** that enables compliant
stablecoin settlement workflows for businesses, fintechs, payment companies, and
regulated partners. It orchestrates cross-border B2B payments over EVM stablecoin
rails — route quoting, a compliance gate, on-chain escrow, FX, payout, and a
tamper-evident audit trail — as software. In the operating model it is designed
for, the **licensed partner**
([[ADOPTER: partner licence category — e.g. money transmitter, bank, e-money/PSP]]),
not SettlementOS, is the entity that touches customer funds and holds the
regulatory permissions.

## 2. What the product does

- Onboards business **entities** (sender/recipient) with KYB status, wallets,
  allowlist flags, and approved corridors.
- Quotes a **route** for a payment (source/destination network, asset, FX, fees,
  liquidity, estimated settlement time).
- Runs a **compliance gate** on every execution: KYB, sanctions, wallet risk,
  transaction risk, corridor eligibility → PASS / MANUAL_REVIEW / FAIL.
- **Escrows** the source asset on-chain, records an FX conversion, and **pays out**
  the destination asset (on-chain payout on a cross-chain route; a local-currency
  ledger credit as the fiat-rail stand-in).
- Maintains an append-only, hash-chained, periodically-signed **audit trail** and a
  bounded **reconciliation export**.
- Provides **failure handling**: on-chain refund before settlement, treasury-funded
  compensation after settlement, and an operator repair path for partial failures.

## 3. What the product does not do

- **No native token.** There is no SettlementOS token.
- **No consumer remittance.** B2B only; senders and recipients are onboarded
  businesses.
- **No real customer funds today.** Testnet, mock assets, simulated FX/payout.
- **No custody of customer funds in the target model.** The licensed partner holds
  funds; SettlementOS is the software layer (see §4).
- **No undisclosed yield.** The optional tokenized-MMF treasury feature is
  operator-only, explicitly opt-in, strictly segregated from payment escrow, and
  simulated.
- **No unpermissioned DeFi routing of customer funds.** Settlement is through a
  permissioned, operator-gated contract; there is no routing through third-party
  DeFi protocols.
- **No commingling** of payment-settlement funds and treasury products — enforced
  by separate contracts with no cross-calls, not merely by policy.

## 4. Who touches funds

| Function | POC (testnet) | Target operating model |
|---|---|---|
| Holds/moves customer fiat | n/a (simulated) | **Licensed partner** (MT/bank/PSP) |
| Holds/moves on-chain assets | operator-controlled test wallets | Licensed partner or its qualified custodian |
| Runs compliance screening | SettlementOS + vendor sandboxes | SettlementOS software + partner's program of record |
| Orchestrates the workflow | SettlementOS | SettlementOS (software only) |
| Signs settlement transactions | operator key (env, POC) | KMS/HSM under the fund-holding entity's control |

The architecture already isolates signing behind a custody seam with a documented
KMS/HSM extension point, and uses exact per-payment allowances rather than standing
approvals — so "who can move funds, and how much" is bounded by design.

## 5. Where funds are held

- **On-chain:** in the `PaymentSettlement` escrow contract during a payment, then
  released to a treasury account; parked treasury liquidity sits in a separate
  `TokenizedMMF` contract. Balances are segregated by contract.
- **Off-chain / fiat:** not handled in the POC. In the operating model, fiat is
  held by the licensed partner or its bank, never by SettlementOS.

## 6. Jurisdictions in scope

Lead: **[[ADOPTER: lead jurisdiction — draft used United States]].** Live corridors
also touch **[[ADOPTER: secondary jurisdictions — draft used Singapore and Japan]]**.
The go-to-market assumption is that SettlementOS operates as infrastructure to a
licensed entity in each jurisdiction rather than seeking to be the licensed entity
itself at the outset. Jurisdiction-by-jurisdiction rollout is covered in the
[pilot options memo](06-pilot-options.md).

## 7. Licenses that may be required (to be confirmed with counsel)

Depending on the operating model chosen, one or more of the following may be
implicated — **for the fund-holding entity**, which in the target model is the
partner, not SettlementOS:

- [[ADOPTER: lead-jurisdiction money-transmission / MSB / MTL (or equivalent) licence categories — draft cited US FinCEN MSB + state MTLs]],
  or reliance on a licensed partner / agent model.
- **Bank/trust or special-purpose** charters where custody or settlement finality
  is involved.
- [[ADOPTER: secondary-jurisdiction payment / DPT licence categories — draft cited Singapore Payment Services Act (MAS)]].
- [[ADOPTER: secondary-jurisdiction funds-transfer / crypto-asset registration — draft cited Japan JFSA]].

Which of these attach — and whether SettlementOS-as-software avoids them by not
touching funds — is the core question for the [legal classification
memo](03-legal-classification.md).

## 8. Licensed partners that may be used

- [[ADOPTER: named or candidate domestic fund-moving licensed partner (MT/MSB/bank)]].
- [[ADOPTER: bank or e-money/PSP partner for fiat on/off ramps and settlement accounts]].
- A qualified **custodian** for on-chain assets — [[ADOPTER: custodian counterparty]].
- Regulated **stablecoin issuers** for the settlement asset —
  [[ADOPTER: acceptable settlement stablecoin issuer(s)]].
- Established **compliance vendors** for KYB, sanctions, wallet, and transaction
  screening (the POC already integrates sanctions and wallet-screening sandboxes) —
  [[ADOPTER: programme-of-record screening vendors]].

## 9. Regulatory design principles — and how each is enforced

The PRD's regulatory design principles are structural properties of the code, not
aspirations (see [technical architecture §7](01-technical-architecture.md)):
no native token, no retail, no real funds yet, no undisclosed yield, no
commingling, no unpermissioned DeFi routing, a clear identity model, transaction-
monitoring hooks, a complete audit trail, an explicit lifecycle, and clear
failure/refund logic. Each maps to an enforced mechanism, which is what makes the
architecture "something a regulator can understand."

## 10. ForteL2 data availability — question for counsel

**Fact (ForteL2, 2026-08-13):** ForteL2 posts L2 batches to Ethereum L1 as
calldata, not blobs. Blob data is pruned from L1 after roughly 18 days;
calldata is not. ForteL2 history is permanently re-derivable from L1. This is a
property of that rail's data-availability path. It says nothing about Base
Sepolia, about SettlementOS's Postgres database, or about the hash-chained
audit log described in §2 and §9.

**Question for counsel:** for a programme that settles on ForteL2, does a rail
whose history is permanently re-derivable from L1 calldata change the analysis
of record-retention, independent reconstruction, or audit-evidence obligations
— and if so, what belongs in the programme of record versus what SettlementOS
stores off-chain? See the [legal classification memo](03-legal-classification.md)
§8 (data retention & privacy). This memo does not answer that question.

## 11. Immediate next steps

1. Confirm the **operating model** (SettlementOS-as-infrastructure to a licensed
   partner) with counsel ([[ADOPTER: counsel of record]]).
2. Commission the [legal classification](03-legal-classification.md) analysis,
   [[ADOPTER: lead jurisdiction — draft used US]]-first.
3. Identify a lead licensed partner
   ([[ADOPTER: lead licensed partner]]) per the [partner integration
   memo](04-partner-integration.md).
4. Scope a sandbox / licensed-partner pilot per the [pilot options
   memo](06-pilot-options.md).
