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
| Chains | Two local Hardhat nodes: `base-local` (31337, simulates Base Sepolia) and `polygon-local` (31338, simulates Polygon Amoy), plus real `base-sepolia` (84532) and `polygon-amoy` (80002) with public explorer links — see [Real public testnets](#real-public-testnets-base-sepolia--polygon-amoy) |
| Contracts | Solidity 0.8.24 — `MockERC20` (mockUSDC/mockJPY/mockSGD) + `PaymentSettlement` escrow, deployed to both networks |
| Chain client | viem, via a network-registry chain adapter ([lib/chain.ts](lib/chain.ts), [lib/networks.ts](lib/networks.ts)) |
| Bridge | Simulated: source-chain escrow + FX, then treasury pays out destination-asset tokens to the recipient wallet on the destination chain (real ERC-20 tx on chain 2) |
| Compliance | KYB, sanctions, wallet risk, transaction risk, corridor risk with PASS / FAIL / MANUAL_REVIEW outcomes. Sanctions + wallet screening run against real vendor sandboxes (OpenSanctions, Chainalysis) when env keys are set; mocks otherwise |

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

# 1. Local EVM chains (keep both running)
npm run chain            # base-local    → 127.0.0.1:8545, chainId 31337
npm run chain:polygon    # polygon-local → 127.0.0.1:8546, chainId 31338

# 2. Deploy contracts to both chains + seed demo entities (rerun any time to reset)
npm run setup

# 3. App
npm run dev
```

Open http://localhost:3000.

```bash
npm test   # self-contained: builds its own chains + DB under tests/.tmp
```

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
5. **Cross-chain route** — create a payment with source chain *Base (local)* and
   destination chain *Polygon Amoy (local)*. The recommended **BRIDGE_AND_SETTLE**
   route escrows mockUSDC on Base, runs the simulated bridge, and pays out mockJPY
   to the recipient's wallet **on the Polygon chain** — the payment detail page
   shows transaction hashes on both networks, plus a single-chain fallback route.
6. **Manual review path** — send `300000.00` USD to *Osaka Parts Co* (KYB pending,
   wallet not allowlisted, amount above the $250k threshold). The payment parks in
   the **Compliance Queue**; approve it as a reviewer, then execute.
7. **Liquidity & Treasury** — live on-chain treasury balances per network,
   reservations, and the tokenized T-bill placeholder (disabled, per PRD).
8. **Export reconciliation CSV** from the dashboard (now includes per-network tx
   hashes); show the audit chain "INTACT" badge on the Compliance page
   (hash-chained, tamper-evident).

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
    "source_network": "base-local",
    "destination_network": "polygon-local",
    "purpose": "supplier_payment",
    "reference_id": "INV-2026-001"
  }'
```

### Deploying behind a proxy

Writes are rate-limited per API key. The one endpoint with no key to count yet is
`POST /api/auth/login`, which falls back to the caller's address — and the only
source for that is `x-forwarded-for`, a header the client sets. Next fills it in
from the socket *only when it is absent*, so a caller that sends its own wins and
can rotate fake values to dodge the limit.

If anything fronts the app, tell it how many of those hops are yours:

```bash
# Number of proxies you run in front of this app (load balancer, ingress, CDN…).
# The address that many hops from the right of x-forwarded-for is the one your
# outermost proxy actually observed; everything left of it is unverifiable.
TRUSTED_PROXY_HOPS=1

# optional: writes per key per minute (default 30)
RATE_LIMIT_WRITES_PER_MINUTE=30
```

Unset (the default, and what local demos want) the leftmost entry is used as
before — best-effort, and only sound behind a proxy that overwrites the header.

## Compliance model

Every execution runs the full provider set and persists results:

- **KYB/KYC** — entity onboarding status (mock)
- **Sanctions** — real OpenSanctions screening when configured, mock otherwise (see below)
- **Wallet risk** — allowlist policy, then real Chainalysis sanctions-oracle screening when configured, risk-score mock otherwise
- **Transaction risk** — USD-equivalent >$250k manual review, >$1M fail (mock)
- **Corridor risk** — corridor must be pre-approved for both entities (mock)

Any FAIL → `REJECTED`. Any MANUAL_REVIEW → parked for a reviewer decision.
The audit log is append-only and hash-chained; `GET /api/audit` verifies the chain.

### Real provider sandboxes (optional)

Two checks can run against real vendor services instead of mocks. Each switches
on independently via `.env` — with nothing set the deterministic mocks run, so
the demo never breaks offline:

```bash
# SANCTIONS → OpenSanctions match API (consolidated OFAC/EU/UN).
# Self-service key: https://www.opensanctions.org/account/
OPENSANCTIONS_API_KEY=...

# WALLET_RISK → Chainalysis sanctions oracle: a free public smart contract
# (isSanctioned(address)), read over any mainnet RPC — no API key or Chainalysis
# account needed. Any public Ethereum RPC works, e.g.:
CHAINALYSIS_ORACLE_RPC_URL=https://ethereum-rpc.publicnode.com

# optional overrides
OPENSANCTIONS_API_URL=https://api.opensanctions.org
# Oracle contract. Default 0x40C57923924B5c5c5455c48D93317139ADDaC8fb covers
# Ethereum/Polygon/BNB/Avalanche/Optimism/Arbitrum/Fantom/Celo/Blast; if you
# point the RPC at Base mainnet instead, set:
# CHAINALYSIS_ORACLE_ADDRESS=0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B
COMPLIANCE_PROVIDER_TIMEOUT_MS=5000
```

Sanctions designations are per address, not per chain, so the oracle chain is
independent of the payment's network — screening a Base Sepolia wallet against
the Ethereum-mainnet oracle is correct.

Behavior with real providers (`lib/providers/`):

- **Fail-safe** — provider error, timeout, or malformed response → `MANUAL_REVIEW`
  with `provider_error` reason codes. Screening never fails open.
- **Audit evidence** — the verbatim vendor response (or the failure detail) is
  persisted on each `ComplianceCheck` row as `rawResponse`.
- **Platform policy still applies** — unregistered / non-allowlisted wallets go
  to manual review before any vendor is called.

## Real public testnets (Base Sepolia + Polygon Amoy)

The same contracts deploy to real Base Sepolia (chainId 84532) and real Polygon
Amoy (chainId 80002); the UI links every transaction to
[Basescan](https://sepolia.basescan.org) / [Amoy Polygonscan](https://amoy.polygonscan.com).
Setup (per network):

1. **Deployer key** — generate a fresh key (never reuse a mainnet key) and put it
   in `.env` as `DEPLOYER_PRIVATE_KEY`. This key is the settlement **operator**
   and works on both networks.
2. **Gas** — fund the deployer address with the network's native gas token. Only
   gas is needed — the settlement assets are self-deployed mock tokens.
   - Base Sepolia: ≥0.005 ETH (0.01+ is comfortable) from the
     [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet) (free) or
     [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia).
   - Polygon Amoy: ≥0.4 POL from the
     [official Polygon faucet](https://faucet.polygon.technology) or
     [Alchemy faucet](https://www.alchemy.com/faucets/polygon-amoy). Amoy
     enforces a ~30 gwei gas floor, so everything costs ~100× more gas-wise
     than Base Sepolia — the deploy script's dust targets account for this.
3. **Deploy** — `npm run deploy:base-sepolia` or `npm run deploy:polygon-amoy`
   (both call `scripts/deploy-testnet.mjs`). The script deploys the tokens +
   `PaymentSettlement`, generates local treasury/entity wallets (funding each with
   dust gas for approvals), mints demo balances, registers the wallets in the DB,
   and writes `chain/deployments.<network>.json` (gitignored — it holds the
   generated dust-wallet keys; the funded deployer key stays in `.env` only).
   Re-runs reuse the generated wallets.

Then `npm run dev` and pick **Base Sepolia** or **Polygon Amoy** as source and/or
destination chain — the payment detail page shows public explorer links for the
escrow and settlement transactions. With both deployed, a bridged
Base Sepolia → Polygon Amoy payment gets public explorer links on *two* chains
for one payment. Optional env: `BASE_SEPOLIA_RPC_URL` / `POLYGON_AMOY_RPC_URL`
(default to the public RPCs) and `TREASURY_PRIVATE_KEY` (defaults to a generated
wallet). Local chains and the real testnets coexist: `npm run setup` re-registers
the testnet entity wallets after every DB reset, and cross-chain routes can
bridge between any pair (simulated bridge, real transactions on both networks).

## Out of scope (by design, per PRD)

Real funds, fiat on/off ramps, custody, native token, consumer remittance, DeFi
yield, real bridges, Solana. KYB, transaction-risk, and corridor compliance
providers are mocks (sanctions and wallet screening can use real vendor
sandboxes — see "Real provider sandboxes"); FX, payout, and the cross-chain
bridge are simulated (the bridge leg is a treasury-funded payout on the
destination chain, not a lock-and-mint bridge).
