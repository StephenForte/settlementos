# SettlementOS — Regulatory Design Memo

**Audience:** internal strategy, prospective regulated partners, and (in
redacted form) informal regulator conversations.
**Purpose:** describe, in regulator-legible terms, what SettlementOS does and does
not do, who touches funds, where funds are held, which jurisdictions are in scope,
and the licensing paths available — so that formal legal and regulatory engagement
can begin from an accurate picture.
**Lead jurisdiction:** United States, with Singapore and Japan as the live
cross-border corridors (see [corridor strategy](05-corridor-strategy.md)).
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
for, the **licensed partner** (a money transmitter, bank, or e-money/PSP licensee),
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

Lead: **United States.** Live corridors also touch **Singapore** and **Japan**.
The go-to-market assumption is that SettlementOS operates as infrastructure to a
licensed entity in each jurisdiction rather than seeking to be the licensed entity
itself at the outset. Jurisdiction-by-jurisdiction rollout is covered in the
[pilot options memo](06-pilot-options.md).

## 7. Licenses that may be required (to be confirmed with counsel)

Depending on the operating model chosen, one or more of the following may be
implicated — **for the fund-holding entity**, which in the target model is the
partner, not SettlementOS:

- US **money transmission** — federal FinCEN MSB registration and state money
  transmitter licenses (MTLs), or reliance on a licensed partner / agent model.
- **Bank/trust or special-purpose** charters where custody or settlement finality
  is involved.
- Singapore **Payment Services Act** (MAS) licensing for cross-border money
  transfer / digital payment token services.
- Japan **Funds Transfer / crypto-asset** registration (JFSA).

Which of these attach — and whether SettlementOS-as-software avoids them by not
touching funds — is the core question for the [legal classification
memo](03-legal-classification.md).

## 8. Licensed partners that may be used

- A US money transmitter / MSB to be the fund-moving entity domestically.
- A bank or e-money/PSP partner for fiat on/off ramps and settlement accounts.
- A qualified **custodian** for on-chain assets.
- Regulated **stablecoin issuers** for the settlement asset.
- Established **compliance vendors** for KYB, sanctions, wallet, and transaction
  screening (the POC already integrates sanctions and wallet-screening sandboxes).

## 9. Regulatory design principles — and how each is enforced

The PRD's regulatory design principles are structural properties of the code, not
aspirations (see [technical architecture §7](01-technical-architecture.md)):
no native token, no retail, no real funds yet, no undisclosed yield, no
commingling, no unpermissioned DeFi routing, a clear identity model, transaction-
monitoring hooks, a complete audit trail, an explicit lifecycle, and clear
failure/refund logic. Each maps to an enforced mechanism, which is what makes the
architecture "something a regulator can understand."

## 10. Immediate next steps

1. Confirm the **operating model** (SettlementOS-as-infrastructure to a licensed
   partner) with counsel.
2. Commission the [legal classification](03-legal-classification.md) analysis,
   US-first.
3. Identify a lead licensed partner per the [partner integration
   memo](04-partner-integration.md).
4. Scope a sandbox / licensed-partner pilot per the [pilot options
   memo](06-pilot-options.md).
