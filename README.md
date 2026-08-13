# SettlementOS

An experiment in stablecoin settlement for cross-border payments — testing whether a chain-agnostic settlement layer can move value from country A to country B fast and cheap, without carrying the rest of crypto along for the ride.

Most general-purpose chains optimize for everything: NFTs, meme coins, web3 social, DeFi composability. SettlementOS starts from the opposite premise — **what does the stack look like if transfers and payments are the *only* workload?** Strip the use case down to settlement and a lot of complexity (and cost) falls away.

## Current state

This is the experimentation phase. The system is deployed to **Base Sepolia**, **Polygon Amoy**, and [ForteL2](https://github.com/StephenForte/ForteL2) Sepolia — deliberately multi-chain, to prove the settlement layer can connect to several rails rather than marrying one. A purpose-built [independent explorer](https://github.com/StephenForte/settlementos-explorer) shows only what a payments system needs: transfers, settlement state, and nothing Etherscan-shaped.

ForteL2 is the long-term home rail: SettlementOS as the application layer, ForteL2 as the settlement infrastructure underneath it. Together they're a full-stack test of the payments-only thesis.

## Roadmap (directional)

1. **Now:** multi-chain deployment and settlement mechanics on testnets (Base Sepolia, Polygon Amoy, and [ForteL2](https://github.com/StephenForte/ForteL2) Sepolia — first settle 2026-07-24; TokenizedMMF park/recall wiring shipped 2026-08-03)
2. **Next:** explorer/replica polish as the rail hardens toward public operation (live ForteL2 sequencer park→accrue→recall and cross-chain bridge legs both landed 2026-08-07)
3. **Eventually:** a true settlement platform for cross-border transactions — acknowledged to be far away; everything before that point is learning in public

## Why

Cross-border settlement through correspondent banking is slow and expensive by construction. Stablecoins on general-purpose chains fix the speed but inherit congestion, fee volatility, and complexity from workloads payments never asked for. The open question this project pokes at: is a purpose-narrowed stack meaningfully better, or does generality win anyway? Building it is the only honest way to find out.

---

# The system

SettlementOS is a payment orchestration layer for cross-border B2B settlement over
EVM stablecoin rails. A business initiates a payment, the system quotes routes,
runs a compliance gate, escrows stablecoin on a settlement contract, simulates the
FX leg, credits the recipient's local-currency ledger, and produces a hash-chained
audit trail plus a reconciliation export. Idle treasury liquidity can be parked
overnight in a tokenized money-market fund and recalled T+0 when a payment needs it.

> Testnet demo only. Mock assets, simulated FX, simulated payout. No real funds,
> no native token, no consumer flows.

## Architecture

| Layer | Implementation |
|---|---|
| Frontend + API | Next.js (App Router) + Tailwind, REST route handlers |
| Database | SQLite via Prisma (entities, payments, compliance checks, audit log + signed checkpoints, liquidity reservations, treasury positions, ledger credits, API keys, idempotency records) |
| Chains | Two local Hardhat nodes: `base-local` (31337, simulates Base Sepolia) and `polygon-local` (31338, simulates Polygon Amoy), plus real `base-sepolia` (84532), `polygon-amoy` (80002), and `fortel2-sepolia` (852) — see [Real public testnets](#real-public-testnets-base-sepolia--polygon-amoy) and [ForteL2](#fortel2) |
| Contracts | Solidity 0.8.24 — `MockERC20` (mockUSDC/mockJPY/mockSGD), `PaymentSettlement` escrow, `TokenizedMMF` (operator-gated share fund for parked treasury liquidity) |
| Chain client | viem, via a network-registry chain adapter ([lib/chain.ts](lib/chain.ts), [lib/networks.ts](lib/networks.ts)) with a pluggable signer/custody seam ([lib/signers.ts](lib/signers.ts)) |
| Bridge | Simulated: source-chain escrow + FX, then treasury pays out destination-asset tokens to the recipient wallet on the destination chain (real ERC-20 tx on chain 2) |
| Compliance | KYB, sanctions, wallet risk, transaction risk, corridor risk with PASS / FAIL / MANUAL_REVIEW outcomes. Sanctions + wallet screening run against real vendor sandboxes (OpenSanctions, Chainalysis) when env keys are set; mocks otherwise |
| Hardening | API-key auth with role-based authorization and tenant scoping, compare-and-swap state transitions + execution leases, idempotency keys, a compensation saga with an operator repair view, bigint money math validated at the boundary, rate limits + body caps + cursor pagination, CSP/security headers |

### Payment lifecycle

```
DRAFT → QUOTED → COMPLIANCE_PENDING → APPROVED → LIQUIDITY_RESERVED
      → SUBMITTED_ONCHAIN → CONFIRMED_ONCHAIN → FX_OR_SWAP_COMPLETED
      → PAYOUT_PENDING → SETTLED
```

Exception states: `MANUAL_REVIEW`, `REJECTED`, `FAILED`, `CANCELLED`, `REFUNDED`,
`EXPIRED`, and the compensation path `COMPENSATION_PENDING → COMPENSATED` (a
failure after the escrow is released repays the sender from treasury rather than
refunding a contract that no longer holds the funds).
Transitions are enforced by a state machine ([lib/state.ts](lib/state.ts)) and
applied with compare-and-swap so concurrent writers can't clobber each other.

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

Open http://localhost:3000 and sign in at `/login` with the OPERATOR key that
`npm run setup` printed (also written to gitignored `chain/dev-api-keys.json`).

```bash
npm test   # self-contained: builds its own chains + DB under tests/.tmp
```

## Authentication

Every API route (except `/api/networks` and the login exchange) requires an API
key — the `x-api-key` header, or the httpOnly cookie set by signing in at
`/login`. `npm run setup` seeds one OPERATOR key, one REVIEWER key, and one
ENTITY key per demo entity; only sha256 hashes are stored, so a lost key is
regenerated by re-running setup. Roles gate what a caller can do: OPERATOR
drives payments and treasury, REVIEWER decides manual reviews, ENTITY callers
see and act only on their own payments (tenant-scoped queries, scrubbed failure
detail, 404 — never 403 — for rows outside their scope).

Writes accept an optional `Idempotency-Key` header: a retry with the same key
and body replays the original response instead of double-executing.

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
   reservations, and the tokenized MMF card: park unreserved liquidity into the
   fund, accrue a day of simulated yield (3.5% APY), recall T+0 with the yield.
   Routes quoted against parked liquidity are flagged `recall_required` and the
   executor auto-recalls before escrowing.
8. **Export reconciliation CSV** from the dashboard (includes per-network tx
   hashes); show the audit chain badge on the Compliance page (hash-chained,
   tamper-evident). Out of the box it reads **INTACT (unanchored)** — the chain
   is self-consistent but nothing signs its tip. Set `AUDIT_ANCHOR_KEY` in
   `.env` and create a checkpoint (`POST /api/audit/checkpoint`, or wait for
   the automatic one every 100 events) to upgrade it to a signed **INTACT**.

Demo entities seeded by `npm run setup`:

| Entity | Country | KYB | Purpose |
|---|---|---|---|
| ACME US Inc | US | PASSED | Sender with 1,000,000 mockUSDC |
| Tokyo Trading KK | JP | PASSED | Happy-path recipient |
| Singapore Imports Pte Ltd | SG | PASSED | USD→SGD / SGD→JPY corridors |
| Osaka Parts Co | JP | PENDING | Triggers the manual-review path |

## API

```
POST /api/auth/login                  exchange an API key for a session cookie
POST /api/auth/logout                 clear the session cookie
POST /api/payments                    create payment (DRAFT)
GET  /api/payments                    list payments (cursor-paginated)
GET  /api/payments/{id}               payment detail + checks + audit log
POST /api/payments/{id}/quote         generate route quote
POST /api/payments/{id}/execute       compliance gate + on-chain settlement
POST /api/payments/{id}/review        reviewer approve/reject (MANUAL_REVIEW)
POST /api/payments/{id}/cancel        cancel before execution
POST /api/payments/{id}/repair        operator retry of a stuck compensation
GET  /api/entities                    list entities (cursor-paginated)
POST /api/entities                    create entity (starts KYB PENDING)
GET  /api/balances                    on-chain balances + reservations + ledgers
POST /api/treasury/park               park unreserved liquidity into the MMF
POST /api/treasury/recall             redeem a parked position (T+0)
GET  /api/treasury/positions          parked positions + derived value (paginated)
POST /api/treasury/accrue             advance the fund index one day (demo)
GET  /api/reconciliation              CSV export (date-bounded, default last 30 days)
GET  /api/audit                       audit log + chain integrity check (paginated)
POST /api/audit/checkpoint            sign an audit checkpoint on demand
GET  /api/networks                    network registry (anonymous)
```

Example:

```bash
curl -X POST http://localhost:3000/api/payments \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <OPERATOR key from npm run setup>' \
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
The audit log is append-only and hash-chained; `GET /api/audit` verifies the
chain from genesis, and signed checkpoints (`AUDIT_ANCHOR_KEY`) anchor the tip
so a re-hashed history can't pass as intact.

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
   `PaymentSettlement` + `TokenizedMMF` (yield buffer + treasury approval),
   generates local treasury/entity wallets (funding each with dust gas —
   entities approve the exact payment amount at execute time), mints demo
   balances, registers the wallets in the DB, and writes
   `chain/deployments.<network>.json` (gitignored — it holds the generated
   dust-wallet keys; the funded deployer key stays in `.env` only). Overlays
   from before F4 omit the fund; re-run the deploy to provision it.
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

## ForteL2

[ForteL2](https://github.com/StephenForte/ForteL2) — the OP Stack L2 that is the
long-term home settlement rail — is in the network registry as `fortel2-sepolia`
(chain ID 852, Sepolia-backed), plus an optional offline `fortel2-local` (901).
The chain is operated **outside this repo** on the operator's Mac — a personal,
best-effort L2 with **no uptime SLA**. Base Sepolia and Polygon Amoy are public
testnets run by real operators; ForteL2 is one person's stack. A demo against
852 only works while that sequencer is up. On Render Oregon, an optional read
replica at `http://fortel2-replica:10000` (Private Service `fortel2-replica`,
same private network as this app) backs balance/display reads only — it is
read-only (~3 min lag vs the sequencer from L1 batching; settle-and-confirm
against the replica looks like failed txs), not a substitute for the sequencer,
and has OOM'd on catch-up on small instances (see
[`tasks/fortel2-l2-prereqs.md`](tasks/fortel2-l2-prereqs.md) §5). There is no
public read URL yet; `rail-interface.json` `replica.readRpcUrl` stays null.
Canonical chain facts (chain IDs, RPCs, bridge addresses, reset policy) live in
ForteL2's `deployments/rail-interface.json`.

```bash
# Write RPC. Local default: Mac sequencer loopback. On Render: Cloudflare
# Access hostname. Never VITE_*; never commit the service token.
FORTEL2_SEPOLIA_RPC_URL=https://fortel2-write.ente.ltd
# Access service token for the write hostname (Render only). Both required
# to attach CF-Access-Client-Id / CF-Access-Client-Secret on write clients;
# either missing → no headers (local loopback still works).
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=
# Optional read-only replica (Render Oregon private network only). Balance/
# display reads only — writes and confirm() always use the write RPC above.
# Never point this at ente.ltd (the replica has no Access). ~3 min lag;
# unset locally unless you tunnel to the replica.
FORTEL2_SEPOLIA_READ_RPC_URL=http://fortel2-replica:10000
# Optional offline ForteL2 devnet (resets freely; experiments only)
FORTEL2_LOCAL_RPC_URL=http://127.0.0.1:9545
```

**Live as a settlement + treasury rail** (phases F1–F5 of
[tasks/prd-fortel2-integration.md](tasks/prd-fortel2-integration.md)):
SettlementOS contracts — `MockERC20`s, `PaymentSettlement`, and
`TokenizedMMF` — deploy onto chain 852 the same way they do onto Base Sepolia
/ Amoy. The ACME → Tokyo USD→JPY demo settled there end to end (2026-07-24),
and F4 (2026-08-03) wired overnight liquidity parking: `deploy-testnet.mjs`
provisions the fund + 50k mockUSDC yield buffer + treasury approval, and
`lib/treasury` resolves it via `mmfAddress()` like any other network. A
park→accrue→recall cycle was verified against a local chainId-852 node;
and a live park→accrue→recall ran against the real 852 sequencer on
2026-08-07 (50,000 mockUSDC out, 50004.79452 back, escrow untouched — see
`tasks/runbooks/fortel2-live-session-2026-08-07.md`). Cross-chain legs with
ForteL2 on either side also settle live with dual tx hashes. The division of
labor is deliberate: **SettlementOS is the payments product; ForteL2 is the
rail.** No ForteL2-side primitives are duplicated here, and nothing in this
repo runs the chain (sequencer, batcher, bridge, and L1 contracts are
ForteL2's; see ForteL2's `tasks/coordination-settlementos.md` and
`tasks/prd-money-rail.md` for infra questions).

To integrate locally (on the machine where the ForteL2 sequencer runs):

```bash
# 1. Preflight — expect chain id 852 and an advancing block number
cast chain-id --rpc-url http://127.0.0.1:9545
# 2. Fund the deployer on L2 (no faucet): send ETH on Sepolia L1 to the
#    OptimismPortalProxy (address in ForteL2 deployments/rail-interface.json);
#    the same amount mints to the deployer on 852. ~0.05 ETH is ample.
# 3. Deploy contracts (escrow + tokens + TokenizedMMF) + dust-fund wallets,
#    then register entities
npm run deploy:fortel2-sepolia
npm run setup
```

The deploy writes `chain/deployments.fortel2-sepolia.json` (gitignored — holds
generated dust-wallet keys) and re-runs are mode-aware, auto-detected from that
overlay: a pre-MMF overlay (escrow + tokens, no fund) gets an **MMF add-on**
run — `TokenizedMMF` + its 50k mockUSDC yield buffer + the treasury approval
merged in without redeploying escrow or tokens — and an overlay that already
carries the fund makes the re-run a no-op. Dry-run any live deploy first with
`node --env-file=.env scripts/deploy-testnet.mjs fortel2-sepolia
--preflight-only`, which validates the RPC, chain id, and deployer balance and
prints the detected mode without sending a transaction. Older overlays that
predate the MMF still settle — `mmfAddress()` returns `undefined` and the
Liquidity page degrades to "no fund". ForteL2 has no block explorer yet, so payments there
show raw tx hashes without links; verify with
`cast receipt <hash> --rpc-url http://127.0.0.1:9545`. The Sepolia deployment
is pinned through ForteL2's learning Phase 6 — a Phase 7 re-genesis requires a
coordinated redeploy of the SettlementOS contracts.

## Documentation

- [AGENTS.md](AGENTS.md) — engineering guide: architecture map, invariants, gotchas
- [DEMO.md](DEMO.md) — demo run-of-show
- [PRD.md](PRD.md) — product requirements + phase roadmap (canonical)
- [docs/regulatory/](docs/regulatory/) — regulatory design, legal classification,
  partner integration, corridor strategy, and pilot memos (frozen templates).
  Signed-in readers can browse them in-app at `/docs/regulatory`
- [settlementos-explorer](https://github.com/StephenForte/settlementos-explorer) —
  the purpose-built payments explorer
- [ForteL2](https://github.com/StephenForte/ForteL2) — the OP Stack L2 this
  system will eventually settle on

## Out of scope (by design, per PRD)

Real funds, fiat on/off ramps, custody, native token, consumer remittance, DeFi
yield, real bridges, Solana. KYB, transaction-risk, and corridor compliance
providers are mocks (sanctions and wallet screening can use real vendor
sandboxes — see "Real provider sandboxes"); FX, payout, and the cross-chain
bridge are simulated (the bridge leg is a treasury-funded payout on the
destination chain, not a lock-and-mint bridge). The tokenized MMF pays simulated
yield from a pre-funded buffer, not a real T-bill fund.
