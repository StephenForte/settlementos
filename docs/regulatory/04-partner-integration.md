# SettlementOS — Partner Integration Memo

**Audience:** prospective partners — money transmitters, banks, PSPs/e-money
licensees, custodians, stablecoin issuers, and compliance vendors.
**Purpose:** describe how a partner integrates with SettlementOS, what each side
owns, and the commercial models available.
**Status:** testnet POC. Integration surfaces described here exist and run; fiat
rails, real assets, and real licensing are the partner's contribution.

---

## 1. Positioning

SettlementOS is the **software and orchestration layer**; the partner brings the
**license, the funds, and the rails**. The clean division of responsibility is the
product: SettlementOS makes stablecoin settlement operable and auditable, and the
licensed partner makes it lawful and funded.

## 2. Integration models

| Model | SettlementOS role | Partner role | When it fits |
|---|---|---|---|
| **Infrastructure to a licensed entity** *(primary)* | Software: orchestration, compliance gate, audit, reconciliation | Holds funds, holds licenses, is the entity of record | A licensed MT/bank/PSP wants stablecoin settlement without building it |
| **Embedded / white-label** | Same, delivered under the partner's brand | Customer-facing, licensed, funded | A platform embeds settlement for its own business customers |
| **Compliance-vendor integration** | Consumes the vendor's screening via the provider seam | Provides KYB/sanctions/wallet/tx screening | Already live for sanctions + wallet screening |
| **Custody integration** | Signs via the custody seam (KMS/HSM/qualified custodian) | Holds keys / assets | Where a qualified custodian is required |
| **Stablecoin issuer** | Uses the issuer's token as the settlement asset | Issues/redeems the regulated stablecoin | Production settlement asset |

The primary model is **infrastructure to a licensed entity**, consistent with the
[regulatory design memo](02-regulatory-design.md): the partner touches funds and
holds permissions; SettlementOS does not.

## 3. What a partner integrates against

A REST API (JSON, `snake_case`), the same surface the reference operator console
uses:

- **Onboarding** — create/read entities (KYB status, wallets, allowlist, approved
  corridors).
- **Payments** — create → quote → execute (runs the compliance gate, then settles)
  → read status, compliance results, and the audit trail; cancel; reviewer
  approve/reject for manual-review cases.
- **Treasury** (optional, operator-only) — park/recall/accrue for the segregated
  MMF feature; positions.
- **Operations** — balances, bounded reconciliation CSV export, audit log with a
  live integrity verdict.

Operational properties a partner can rely on: API-key identity with roles
(operator / reviewer / entity), tenant-scoped reads, per-principal write rate
limits, **idempotency keys** on writes (safe retries), stable error codes with no
internal leakage, pagination on every list, and a hash-chained, signed audit trail.

## 4. Responsibility split

| Concern | SettlementOS | Partner |
|---|---|---|
| Payment orchestration & lifecycle | ✅ | |
| Compliance **gate** (workflow, evidence, reviewer queue) | ✅ | |
| Compliance **program of record** (KYB, SAR/CTR, OFAC ownership) | | ✅ |
| On-chain escrow, FX record, payout mechanics | ✅ | |
| Fiat on/off ramp & settlement accounts | | ✅ |
| Custody of funds/keys | seam only | ✅ |
| Licensing & regulatory status | | ✅ |
| Audit trail & reconciliation | ✅ | shared review |
| Liquidity for corridors | treasury mechanics | ✅ funds |

## 5. What a partner brings

- A **license** in the relevant jurisdiction (or an agent relationship that covers
  it).
- **Funds and liquidity** for the corridors they want live (see [corridor
  strategy](05-corridor-strategy.md)).
- **Fiat rails** (bank accounts, on/off ramps).
- Optionally: **custody**, a **compliance program**, or a **stablecoin**.

## 6. Integration path

1. **Sandbox** against the testnet POC — exercise the full create→quote→execute→
   settle→reconcile flow with mock assets.
2. **Compliance wiring** — connect the partner's screening (or use the built-in
   sandboxes) via the provider seam; confirm evidence capture.
3. **Custody wiring** — implement a `Signer` for the partner's KMS/HSM/custodian.
4. **Corridor enablement** — configure networks, assets, and treasury liquidity.
5. **Pilot** — per the [pilot options memo](06-pilot-options.md), starting sandbox/
   limited before any real-money flow.

## 7. What is not ready (so partners plan around it)

- Fiat rails and real assets are the partner's to provide; the POC simulates them.
- KYB is mocked in the POC; the partner's real KYB program plugs into the gate.
- The datastore and rate limiter are POC-grade (SQLite, per-process); a multi-
  instance deployment uses Postgres and a shared limiter store (documented).
- The audit anchor is signed but not yet externally published — a hardening step
  for a production integration.
