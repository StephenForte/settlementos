# SettlementOS

**EVM stablecoin settlement infrastructure — testnet MVP demo.**

SettlementOS is a payment orchestration layer for cross-border B2B settlement over
EVM stablecoin rails. A business initiates a payment, the system quotes routes,
runs a compliance gate, escrows stablecoin on a settlement contract, simulates the
FX leg, credits the recipient's local-currency ledger, and produces a hash-chained
audit trail plus a reconciliation export.

> Testnet demo only. Mock assets, simulated FX, simulated payout. No real funds,
> no native token, no consumer flows.

## Architecture

| Layer | Implementation |
|---|---|
| Frontend + API | Next.js (App Router) + Tailwind, REST route handlers |
| Database | SQLite via Prisma (entities, payments, compliance checks, audit log, liquidity reservations, ledger credits) |
| Chain | Local Hardhat node (Anvil-compatible, chainId 31337); config included for Base Sepolia |
| Contracts | Solidity 0.8.24 — `MockERC20` (mockUSDC/mockJPY/mockSGD) + `PaymentSettlement` escrow |
| Chain client | viem |
| Compliance | Mock providers (KYB, sanctions, wallet risk, transaction risk, corridor risk) with PASS / FAIL / MANUAL_REVIEW outcomes |

### Payment lifecycle

```
DRAFT → QUOTED → COMPLIANCE_PENDING → APPROVED → LIQUIDITY_RESERVED
      → SUBMITTED_ONCHAIN → CONFIRMED_ONCHAIN → FX_OR_SWAP_COMPLETED
      → PAYOUT_PENDING → SETTLED
```

Exception states: `MANUAL_REVIEW`, `REJECTED`, `FAILED`, `CANCELLED`, `REFUNDED`, `EXPIRED`.
Transitions are enforced by a state machine ([lib/state.ts](lib/state.ts)).

## Quick start

```bash
npm install

# 1. Local EVM chain (keep running)
npm run chain

# 2. Deploy contracts + seed demo entities (rerun any time to reset)
npm run setup

# 3. App
npm run dev
```

Open http://localhost:3000.

## Demo script (~5 minutes)

1. **Dashboard** — settled volume, in-flight payments, compliance alerts.
2. **New Payment** — ACME US Inc → Tokyo Trading KK, `100000.00` USD → JPY,
   reference `INV-2026-001`. Create draft.
3. **Get Route Quote** — two route options (instant escrow vs. batched netting)
   with FX rate vs. mid-market, fees, gas, time, and liquidity availability.
4. **Run Compliance & Execute** — 7 checks pass (KYB, sanctions, wallet risk ×2,
   transaction risk, corridor); payment escrows mockUSDC on-chain, settles, and
   credits ¥ to the recipient ledger. Every state transition is audit-logged with
   real transaction hashes.
5. **Manual review path** — send `300000.00` USD to *Osaka Parts Co* (KYB pending,
   wallet not allowlisted, amount above the $250k threshold). The payment parks in
   the **Compliance Queue**; approve it as a reviewer, then execute.
6. **Liquidity & Treasury** — live on-chain treasury balances, reservations, and
   the tokenized T-bill placeholder (disabled, institutional-only, per PRD).
7. **Export reconciliation CSV** from the dashboard; show the audit chain
   "INTACT" badge on the Compliance page (hash-chained, tamper-evident).

Demo entities seeded by `npm run setup`:

| Entity | Country | KYB | Purpose |
|---|---|---|---|
| ACME US Inc | US | PASSED | Sender with 1,000,000 mockUSDC |
| Tokyo Trading KK | JP | PASSED | Happy-path recipient |
| Singapore Imports Pte Ltd | SG | PASSED | USD→SGD / SGD→JPY corridors |
| Osaka Parts Co | JP | PENDING | Triggers the manual-review path |

## API

```
POST /api/payments                    create payment (DRAFT)
GET  /api/payments                    list payments
GET  /api/payments/{id}               payment detail + checks + audit log
POST /api/payments/{id}/quote         generate route quote
POST /api/payments/{id}/execute       compliance gate + on-chain settlement
POST /api/payments/{id}/review        reviewer approve/reject (MANUAL_REVIEW)
POST /api/payments/{id}/cancel        cancel before execution
GET  /api/entities                    list entities
POST /api/entities                    create entity (starts KYB PENDING)
GET  /api/balances                    on-chain balances + reservations + ledgers
GET  /api/reconciliation              CSV export
GET  /api/audit                       audit log + chain integrity check
```

Example:

```bash
curl -X POST http://localhost:3000/api/payments \
  -H 'Content-Type: application/json' \
  -d '{
    "sender_id": "ent_acme_us",
    "recipient_id": "ent_tokyo_supplier",
    "amount": "100000.00",
    "source_currency": "USD",
    "destination_currency": "JPY",
    "purpose": "supplier_payment",
    "reference_id": "INV-2026-001"
  }'
```

## Compliance model

Every execution runs the full provider set and persists results:

- **KYB/KYC** — entity onboarding status
- **Sanctions** — screening placeholder
- **Wallet risk** — allowlist + risk score (>40 review, >70 fail)
- **Transaction risk** — USD-equivalent >$250k manual review, >$1M fail
- **Corridor risk** — corridor must be pre-approved for both entities

Any FAIL → `REJECTED`. Any MANUAL_REVIEW → parked for a reviewer decision.
The audit log is append-only and hash-chained; `GET /api/audit` verifies the chain.

## Base Sepolia

The MVP runs on a local chain with identical contracts. `hardhat.config.cjs`
includes a `baseSepolia` network — set `BASE_SEPOLIA_RPC_URL` and
`DEPLOYER_PRIVATE_KEY`, then deploy with
`npx hardhat run --network baseSepolia` and point `CHAIN_RPC_URL` at the RPC.
(The setup script's dev accounts are local-only; a testnet deploy needs its own
funded keys and a rework of the account roles.)

## Out of scope (by design, per PRD)

Real funds, fiat on/off ramps, custody, native token, consumer remittance, DeFi
yield, bridges, Solana. Compliance providers are mocks; FX and payout are
simulated.
