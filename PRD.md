# PRD: EVM-Based Stablecoin Settlement Infrastructure MVP

## Implementation Status (living section — updated 2026-08-03)

The MVP described in this PRD is **built and running**. Code: [github.com/StephenForte/settlementos](https://github.com/StephenForte/settlementos) (Next.js App Router + Prisma/SQLite + viem + Hardhat, Solidity 0.8.24). Engineering guide in `AGENTS.md`, demo run-of-show in `DEMO.md`.

| Phase | Scope | Status |
|---|---|---|
| 1 | Single-chain settlement (payment lifecycle, escrow contract, audit log, reconciliation) | ✅ Done |
| 2 | Multi-asset FX simulation, route engine, compliance workflow, liquidity reservations | ✅ Done |
| 3 | Multi-chain demo: two local chains + simulated bridge, per-network tx tracking | ✅ Done |
| 4 | **Real Base Sepolia deployment** with public Basescan links | ✅ Done 2026-07-07 |
| 5 | Test suite (71 tests: unit / DB / on-chain integration) + GitHub Actions CI | ✅ Done 2026-07-08 |
| 6 | Compliance provider sandbox (OpenSanctions + Chainalysis) | ✅ Done 2026-07-10 |
| 7 | Second real testnet (Polygon Amoy) — public cross-chain demo | ✅ Done 2026-07-15 |
| 8 | Tokenized MMF / overnight liquidity parking (JLTXX-inspired, see §24) | ✅ Done 2026-07-14 |
| 9 | Production hardening (AUDIT.md remediation) + regulatory & partner package | 🔨 Track A ✅ Done 2026-07-16 (327→341 tests, merged #8); Track B drafts in `docs/regulatory/` |
| ForteL2 | Home-rail integration (registry → deploy → settle → MMF → docs) | ✅ F1–F5 + F7 done — see [`tasks/prd-fortel2-integration.md`](tasks/prd-fortel2-integration.md); F4 live-MMF wiring PR #29 (2026-08-03); **live-sequencer park→accrue→recall verified 2026-08-07** (50k → 50004.79452, escrow untouched — [`tasks/runbooks/fortel2-live-session-2026-08-07.md`](tasks/runbooks/fortel2-live-session-2026-08-07.md)); F6 explorer address book done in [`settlementos-explorer`](https://github.com/StephenForte/settlementos-explorer) (PR #4 → `20f17ff`) |

Live on Base Sepolia (chainId 84532): `PaymentSettlement` at
[`0x9d8b8b7c476ab02306046f3da719d380fa0456aa`](https://sepolia.basescan.org/address/0x9d8b8b7c476ab02306046f3da719d380fa0456aa);
first real settled payment ($100k USD→JPY, 8.5s):
[`0xdbf963...258c5`](https://sepolia.basescan.org/tx/0xdbf963150f5c1c90e3a007cc474c3fd42255fd3d019e3d71a6d821528fe258c5).
Live on Polygon Amoy (chainId 80002): `PaymentSettlement` at
[the same address](https://amoy.polygonscan.com/address/0x9d8b8b7c476ab02306046f3da719d380fa0456aa)
(same deployer nonce sequence). First real cross-chain settled payment
($25k USD→JPY, Base Sepolia escrow → Polygon Amoy payout, ~7s):
escrow [`0x2857eb...15c8e`](https://sepolia.basescan.org/tx/0x2857eb40d9ec95e2672c36581ad578a29389fe1d8e98c50cf86074e483e15c8e),
payout [`0xc2d075...c0bd69`](https://amoy.polygonscan.com/tx/0xc2d0750d86926918b40f454d17fd2b46ba0ffbaf90185f57ca4fd466e8c0bd69).
Live on ForteL2 Sepolia (chainId 852): same `PaymentSettlement` address plus
`TokenizedMMF` at `0xaed29387417dad9ab1993332e2c2b99d35ffe7ff` — park→accrue→recall
and bridge legs verified 2026-08-07
([`tasks/runbooks/fortel2-live-session-2026-08-07.md`](tasks/runbooks/fortel2-live-session-2026-08-07.md)).
ForteL2 is a personal, best-effort L2 with **no uptime SLA** (operated on the
operator's Mac); Base Sepolia and Polygon Amoy are public testnets run by real
operators. A demo against 852 only works while that sequencer is up. An optional
Render read replica can back balance/display reads, but it is read-only, not a
substitute for the sequencer, and has OOM'd on catch-up on small instances (see
[`tasks/fortel2-l2-prereqs.md`](tasks/fortel2-l2-prereqs.md) § "Replica OOM on
catch-up"). Detailed phase notes in §29.

## 1. Product Name

Working name: **SettlementOS**

Alternative names:
- StableRoute
- RailLayer
- Atlas Settlement
- Corridor
- XBorderOS
- BaseRoute

## 2. Mission Statement

**Stablecoin settlement infrastructure for cross-border B2B payments, with compliant routing, liquidity management, and optional tokenized treasury products.**

## 3. Product Thesis

Cross-border B2B payments remain slow, expensive, opaque, and operationally painful. Stablecoins and EVM-compatible L2 networks create the possibility of fast, low-cost, programmable settlement, but enterprises and regulated financial institutions cannot directly use raw crypto rails without compliance, custody, liquidity, reporting, and operational controls.

The opportunity is to build an infrastructure layer that makes stablecoin settlement usable by businesses, fintechs, payment companies, and eventually regulated financial institutions.

The MVP should not create a new blockchain, issue a token, launch a consumer wallet, or become a full remittance company. It should demonstrate that cross-border value transfer can be orchestrated using EVM-based stablecoin rails with institutional-grade controls.

## 4. Strategic Framing

### What this is

SettlementOS is an **EVM-first stablecoin payment orchestration layer**.

It allows a business, fintech, payment company, or financial institution to initiate a cross-border payment, route it through stablecoin rails, simulate or execute FX/stablecoin conversion, track settlement, and produce a compliance and reconciliation record.

### What this is not

SettlementOS is not initially:

- A new L1 or L2 blockchain
- A new stablecoin issuer
- A consumer remittance app
- A DeFi yield product
- A crypto exchange
- A bank
- A Western Union clone
- A full replacement for SWIFT messaging
- A Solana-first neobank or wallet product

The long-term opportunity may touch parts of SWIFT, Western Union, MoneyGram, correspondent banking, and treasury management, but the MVP should stay narrower.

## 5. Core Product Principle

The product hierarchy is:

```text
Payments = Product
EVM L2s = Settlement rails
Stablecoins = Settlement assets
DeFi = Liquidity/routing utility
RWA = Treasury/idle-balance utility
Compliance = Trust layer
```

This keeps the product disciplined. The goal is not to build a crypto playground. The goal is to build a credible payment settlement system that happens to use stablecoins and L2 rails underneath.

## 6. Why EVM First

The MVP should be built on EVM-compatible infrastructure first.

### Rationale

EVM gives the project:

- Mature smart contract tooling
- Broad stablecoin support
- Strong developer ecosystem
- Easier Solidity hiring
- Existing L2 infrastructure
- Clear continuity with the Polygon/J.P. Morgan Project Guardian inspiration
- Easier integration with wallets, indexers, custody tools, analytics tools, and compliance vendors
- More obvious institutional familiarity than a brand-new chain

### Primary Network Inspiration: Base

Base should be the primary design inspiration for the MVP because it is:

- EVM-compatible
- L2-focused
- Stablecoin-friendly
- Developer-friendly
- Closely associated with Coinbase's regulated/on-ramp ecosystem
- Credible as a bridge between crypto-native infrastructure and mainstream financial use cases

The MVP does not need to be exclusively Base forever, but the first working prototype should be Base-inspired and EVM-native.

### Initial Network Strategy

Phase 1 should use:

```text
Primary testnet: Base Sepolia
Primary asset: mockUSDC
Architecture: EVM-only
```

Phase 2 may add:

```text
Secondary EVM testnet: Polygon Amoy or Arbitrum Sepolia
Secondary assets: mockJPY, mockSGD
```

Solana should be deferred until a later integration phase. Given the existing Squads relationship, Solana can become a partner/integration story, not the first technical surface.

## 7. Inspiration and Market Context

The key technical inspiration is the institutional DeFi / tokenized deposit model demonstrated by J.P. Morgan, DBS, SBI, and MAS Project Guardian. The relevant idea is not "crypto trading." The relevant idea is programmable, low-cost, near-instant institutional settlement using public blockchain infrastructure with identity, compliance, and controlled access layered on top.

SettlementOS should take inspiration from that model but simplify the first MVP:

- Use EVM testnet rails
- Use mock stablecoins
- Simulate FX
- Simulate payout
- Build compliance and auditability from day one
- Avoid live customer funds until after the POC and regulatory review

## 8. MVP Goal

The MVP should prove the following:

> A business can initiate a simulated cross-border B2B payment, route it through EVM-based stablecoin rails, optionally convert between currencies or stablecoins, settle near-instantly, and receive a clean compliance, liquidity, and reconciliation record.

The MVP can run entirely on testnet or sandbox infrastructure.

The goal is not to prove licensing readiness on day one. The goal is to prove that the technical, operational, and product architecture is credible enough to show to regulators, payment partners, fintechs, banks, and potential strategic partners.

## 9. Regulatory Strategy

### Updated Position

Regulation should not be ignored during the MVP, but formal regulatory engagement should begin **immediately after the MVP/POC is working**.

The sequence should be:

```text
MVP / POC
→ Internal legal/regulatory memo
→ Regulator-facing demo package
→ Informal regulator conversations
→ Partner/license strategy
→ Limited real-money pilot, if approved
```

### Important Distinction

"Regulation comes after MVP" means:

> Licensing, approvals, regulatory positioning, and formal go-to-market structure come after the technical POC.

It does **not** mean:

> Compliance architecture comes later.

Compliance architecture must be present from day one.

### Regulatory Design Principle

The MVP should look like something regulators can understand:

- No native token
- No consumer remittance
- No real customer funds
- No undisclosed yield
- No commingling of payment funds and treasury products
- No unpermissioned DeFi routing of customer funds
- Clear sender/recipient identity model
- Clear transaction monitoring hooks
- Clear audit trail
- Clear payment status lifecycle
- Clear failure/refund logic
- Clear distinction between payment settlement and treasury products

### Immediate Post-MVP Regulatory Deliverables

After the MVP/POC works, produce:

1. **Regulatory design memo**
   - What the product does
   - What it does not do
   - Who touches funds
   - Where funds are held
   - Which jurisdictions are in scope
   - Which licenses may be required
   - Which licensed partners may be used

2. **Regulator demo deck**
   - Simple payment lifecycle
   - Compliance gates
   - Audit trail
   - Risk controls
   - No-token/no-retail framing

3. **Legal classification memo**
   - Money transmission
   - Stablecoin usage
   - Custody
   - FX
   - Securities / investment product issues
   - AML/BSA/sanctions
   - Travel Rule
   - Data retention
   - Consumer vs B2B distinction

4. **Pilot structure memo**
   - Testnet-only POC
   - Sandbox pilot
   - Licensed-partner pilot
   - Limited real-money pilot
   - Jurisdiction-by-jurisdiction rollout path

## 10. Target Users

### Primary MVP User

**A fintech, payment company, neobank, or B2B platform that wants to move value cross-border using EVM-based stablecoin rails.**

Examples:

- Payment infrastructure company
- Neobank
- Card issuer
- B2B marketplace
- Import/export platform
- Payroll/payment company
- Crypto exchange or broker serving businesses
- Treasury team at a global startup

### Secondary Users

- Compliance officer
- Finance / treasury operator
- Payment operations analyst
- Regulator or policy stakeholder reviewing the demo
- Strategic partner evaluating integration

## 11. Initial Use Case

### Use Case: USD to Asia FX Settlement Demo

A U.S.-based business wants to send $100,000 equivalent to a recipient in Singapore or Japan.

In the MVP:

1. Sender initiates a payment in mockUSDC.
2. System screens sender, recipient, wallet, and corridor.
3. System selects an EVM route.
4. Payment settles on Base Sepolia.
5. Optional FX leg simulates conversion from USD stablecoin into SGD or JPY token equivalent.
6. Recipient receives stablecoin or simulated local fiat ledger credit.
7. Dashboard shows payment status, fees, route, compliance results, and reconciliation data.

## 12. MVP Scope

### In Scope

#### Payment Initiation

Users can create a payment with:

- Sender entity
- Recipient entity
- Source currency
- Destination currency
- Amount
- Preferred settlement asset
- Destination wallet or payout account
- Payment reason
- Reference ID / invoice ID
- Optional memo

#### EVM Stablecoin Settlement

MVP supports stablecoin transfer on EVM testnet infrastructure.

Initial supported network:

```text
Base Sepolia
```

Initial supported asset:

```text
mockUSDC
```

Potential Phase 2 networks:

```text
Polygon Amoy
Arbitrum Sepolia
Optimism Sepolia
```

Potential Phase 2 assets:

```text
mockSGD
mockJPY
mockEUR
mockUSDT
mockPYUSD
```

#### Corridor Simulation

Initial demo corridors:

- USD stablecoin → SGD token
- USD stablecoin → JPY token
- SGD token → JPY token
- JPY token → USD stablecoin

The MVP does not need real fiat payout. It should simulate payout rails with a ledger credit.

#### Routing Engine

The system calculates and displays route options based on:

- Network
- Estimated gas
- Estimated settlement time
- Liquidity availability
- Compliance status
- Counterparty rules
- Destination asset
- Slippage estimate
- Partner availability

Initial route example:

```text
mockUSDC on Base Sepolia
→ simulated FX conversion
→ mockJPY ledger credit
```

Phase 2 route example:

```text
mockUSDC on Base Sepolia
→ simulated bridge/swap
→ mockJPY on Polygon Amoy
→ recipient ledger credit
```

#### Compliance-Aware Payment Flow

The MVP should include compliance hooks from day one, even if operating only on testnet.

The product should support:

- KYB status for sender
- KYB/KYC status for recipient
- Sanctions screening placeholder
- Wallet risk score placeholder
- Transaction risk score
- Corridor risk flag
- Manual review state
- Approval/rejection state
- Audit trail

#### Dashboard

The MVP dashboard should include:

- Payment creation
- Payment status
- Payment detail page
- Route visualization
- Compliance status
- Settlement transaction hash
- Fee breakdown
- FX/slippage estimate
- Reconciliation export
- Entity management
- Wallet management
- Treasury balance view

#### API

The MVP should expose APIs for:

- Create payment
- Get payment status
- List payments
- Create recipient
- List recipients
- Get route quote
- Execute payment
- Cancel payment before execution
- Get balances
- Export reconciliation data

#### Treasury Module

The MVP should include a simple treasury balance module.

Initial functionality:

- Show balances by asset and network
- Show pending outgoing payments
- Show pending incoming payments
- Show simulated idle liquidity
- Show optional tokenized treasury product placeholder

The treasury module should not deploy user balances into DeFi yield in MVP.

#### RWA Placeholder

The MVP should include a placeholder for tokenized treasury products, but not build the full product.

Supported concept:

```text
Park idle stablecoin balances in approved tokenized T-bill or tokenized money-market products.
```

This should be visibly marked as future functionality and separated from payment balances.

## 13. Out of Scope for MVP

The MVP should not include:

- Real customer money
- Production fiat on/off ramps
- Real bank payouts
- Consumer wallet
- Retail remittance
- Native token
- New blockchain
- Real DeFi yield
- Unpermissioned liquidity pools
- Real-money FX execution
- Full licensing workflow
- Custody of real assets
- Mobile app
- Card issuance
- Payroll
- Merchant acquiring
- Real-world invoice financing
- Real estate tokenization
- Private credit tokenization
- Solana implementation

## 14. Product Principles

### Principle 1: EVM first

Build the MVP on EVM rails, starting with Base Sepolia.

### Principle 2: Existing rails, not new chain

Use existing L2 infrastructure and stablecoin standards. The product value is orchestration, compliance, liquidity, and settlement reliability.

### Principle 3: Payments first

DeFi and RWA are utilities. They should support settlement, routing, liquidity, and treasury. They should not become the main product.

### Principle 4: Compliance by design

Even in testnet, every payment should produce a compliance record. The MVP should be demo-friendly for regulators and bank partners.

### Principle 5: Regulation immediately post-POC

The MVP should be built to support immediate regulator and legal review once the technical POC is working.

### Principle 6: B2B before consumer

Consumer remittance introduces fraud, support, brand, licensing, and unit economic issues too early.

### Principle 7: Corridor discipline

The product should initially focus on a small number of corridors rather than "send anywhere to anyone."

### Principle 8: No token needed

The MVP should not require a native token. Token economics would distract from the institutional payment story.

## 15. User Stories

### Payment Operator

As a payment operator, I want to create a cross-border payment so that I can send value to a recipient in another country.

Acceptance criteria:

- User can select sender, recipient, amount, source asset, destination asset, and corridor.
- User receives a route quote before execution.
- User can submit the payment.
- Payment status updates as it moves through the workflow.

### Compliance Reviewer

As a compliance reviewer, I want to see risk flags before a payment executes so that I can approve, reject, or escalate the transaction.

Acceptance criteria:

- Payment detail page shows KYB/KYC state.
- Payment detail page shows wallet screening status.
- Payment detail page shows sanctions placeholder status.
- Payment can enter manual review.
- Reviewer can approve or reject payment.

### Treasury Manager

As a treasury manager, I want to view stablecoin balances across EVM networks so that I know what liquidity is available for settlement.

Acceptance criteria:

- Dashboard shows balances by asset and network.
- Dashboard shows committed liquidity.
- Dashboard shows pending payments.
- Dashboard shows liquidity shortfall if payment exceeds available balance.

### Developer

As a developer at a fintech partner, I want to initiate and track payments through an API so that I can embed settlement into my own application.

Acceptance criteria:

- API supports payment creation.
- API supports quote retrieval.
- API supports status polling.
- API returns transaction hash and route details.
- API returns reconciliation metadata.

### Regulator / Partner Viewer

As a regulator or partner, I want to see the full transaction lifecycle so that I can understand how stablecoin settlement can be controlled, monitored, and audited.

Acceptance criteria:

- Demo shows sender and recipient profile.
- Demo shows compliance gates.
- Demo shows EVM transaction.
- Demo shows route and fees.
- Demo shows final ledger credit.
- Demo shows audit export.

## 16. Payment Lifecycle

### State Machine

```text
DRAFT
→ QUOTED
→ COMPLIANCE_PENDING
→ APPROVED
→ LIQUIDITY_RESERVED
→ SUBMITTED_ONCHAIN
→ CONFIRMED_ONCHAIN
→ FX_OR_SWAP_COMPLETED
→ PAYOUT_PENDING
→ SETTLED
```

Exception states:

```text
REJECTED
FAILED
CANCELLED
MANUAL_REVIEW
REFUNDED
EXPIRED
```

### Payment Flow

1. Create payment.
2. Generate quote.
3. Run compliance checks.
4. Approve payment.
5. Reserve liquidity.
6. Submit EVM transaction.
7. Confirm transaction.
8. Execute or simulate FX/swap.
9. Mark payout as complete.
10. Generate reconciliation record.

## 17. Core Screens

### Dashboard Home

Shows:

- Total settlement volume
- Pending payments
- Failed payments
- Balances by asset
- Liquidity utilization
- Recent payments
- Compliance alerts

### Create Payment

Fields:

- Sender
- Recipient
- Amount
- Source asset
- Destination asset
- Source chain
- Destination chain
- Purpose
- Reference ID
- Memo

### Quote Screen

Shows:

- Route options
- Settlement asset
- Estimated gas
- Estimated network fee
- Estimated FX/slippage
- Estimated completion time
- Compliance status
- Liquidity availability

### Payment Detail

Shows:

- Payment ID
- Sender
- Recipient
- Amount
- Route
- Status
- Transaction hash
- Compliance checks
- Fee breakdown
- Audit log
- Reconciliation export

### Entity Management

Shows:

- Businesses
- Recipients
- KYB/KYC status
- Wallets
- Risk status
- Approved corridors

### Liquidity Dashboard

Shows:

- Balances by chain
- Balances by asset
- Reserved liquidity
- Available liquidity
- Shortfalls
- Simulated treasury allocation

## 18. API Requirements

### Create Payment

```http
POST /payments
```

Request:

```json
{
  "sender_id": "ent_sender_001",
  "recipient_id": "ent_recipient_001",
  "amount": "100000.00",
  "source_currency": "USD",
  "destination_currency": "JPY",
  "source_asset": "mockUSDC",
  "destination_asset": "mockJPY",
  "source_network": "base-sepolia",
  "destination_network": "base-sepolia",
  "purpose": "supplier_payment",
  "reference_id": "INV-2026-001"
}
```

Response:

```json
{
  "payment_id": "pay_001",
  "status": "DRAFT"
}
```

### Get Quote

```http
POST /payments/{payment_id}/quote
```

Response:

```json
{
  "payment_id": "pay_001",
  "status": "QUOTED",
  "routes": [
    {
      "route_id": "route_001",
      "source_network": "base-sepolia",
      "destination_network": "base-sepolia",
      "source_asset": "mockUSDC",
      "destination_asset": "mockJPY",
      "estimated_gas_usd": "0.10",
      "estimated_time_seconds": 15,
      "estimated_fx_rate": "157.20",
      "estimated_destination_amount": "15720000",
      "liquidity_available": true,
      "compliance_required": true
    }
  ]
}
```

### Execute Payment

```http
POST /payments/{payment_id}/execute
```

Response:

```json
{
  "payment_id": "pay_001",
  "status": "SUBMITTED_ONCHAIN",
  "transaction_hash": "0xabc123..."
}
```

### Get Payment

```http
GET /payments/{payment_id}
```

Response:

```json
{
  "payment_id": "pay_001",
  "status": "SETTLED",
  "sender_id": "ent_sender_001",
  "recipient_id": "ent_recipient_001",
  "amount": "100000.00",
  "source_asset": "mockUSDC",
  "destination_asset": "mockJPY",
  "transaction_hash": "0xabc123...",
  "audit_log": []
}
```

## 19. Smart Contract Requirements

### Contracts Needed

For MVP:

1. Mock ERC-20 stablecoin contracts
2. Payment escrow / settlement contract
3. Optional mock FX pool
4. Access control contract
5. Event emitter contract for indexing

For Phase 2:

1. Multi-chain route adapter
2. Mock bridge adapter
3. Cross-chain event reconciliation

### Payment Contract Capabilities

The payment contract should:

- Accept approved ERC-20 stablecoins
- Lock payment amount
- Emit payment initiated event
- Emit payment settled event
- Allow cancellation before execution
- Allow refund in failure state
- Restrict execution to approved operators
- Track payment ID
- Support idempotency

### Events

```solidity
event PaymentInitiated(
    bytes32 indexed paymentId,
    address indexed sender,
    address indexed recipient,
    address asset,
    uint256 amount,
    string sourceCurrency,
    string destinationCurrency
);

event PaymentSettled(
    bytes32 indexed paymentId,
    bytes32 routeId,
    uint256 settledAmount,
    string destinationAsset
);

event PaymentFailed(
    bytes32 indexed paymentId,
    string reason
);
```

## 20. Technical Architecture

### Frontend

Recommended:

- Next.js
- TypeScript
- Tailwind
- React Query
- Wallet integration optional for MVP

### Backend

Recommended:

- Node.js / TypeScript
- PostgreSQL
- Redis for job queue
- Prisma
- REST API first

Python / FastAPI is also acceptable, but TypeScript end-to-end may be faster for an EVM-first prototype.

### Blockchain Layer

Recommended:

- Solidity
- Base Sepolia
- viem or ethers.js
- Foundry or Hardhat
- Custom event indexer for MVP
- The Graph later if needed

### Chain Abstraction

Create adapter interfaces:

```text
ChainAdapter
- getBalance()
- estimateGas()
- submitTransaction()
- getTransactionStatus()
- listenForEvents()

AssetAdapter
- getDecimals()
- approve()
- transfer()
- balanceOf()

RouteAdapter
- quote()
- execute()
- status()
```

### Compliance Layer

Use mock providers for MVP:

```text
KYBProvider
SanctionsProvider
WalletRiskProvider
TransactionMonitoringProvider
```

Each provider returns:

```json
{
  "status": "pass | fail | review",
  "score": 0,
  "reason_codes": [],
  "provider": "mock_provider",
  "timestamp": "2026-07-06T00:00:00Z"
}
```

### Data Model

Core tables:

```text
entities
recipients
wallets
payments
payment_quotes
routes
compliance_checks
liquidity_balances
transactions
audit_events
treasury_positions
regulatory_review_items
```

## 21. Compliance Design

Even though MVP is testnet-only, the architecture should look regulator-ready.

### MVP Compliance Features

- Entity-level KYB status
- Recipient approval
- Wallet allowlist
- Sanctions screening placeholder
- Wallet risk placeholder
- Transaction risk score
- Corridor risk score
- Manual review queue
- Immutable audit log
- Exportable transaction report

### Compliance Decision States

```text
PASS
FAIL
MANUAL_REVIEW
EXEMPT_TESTNET
```

### Manual Review

A payment should require manual review if:

- Amount exceeds threshold
- Recipient is new
- Wallet is unverified
- Corridor is high risk
- Risk score exceeds threshold
- FX route involves unsupported asset

## 22. Regulatory Workstream

### During MVP

Regulatory design should be passive but intentional.

Tasks:

- Track product decisions that create regulatory implications.
- Maintain a regulatory issues log.
- Avoid product decisions that create unnecessary licensing burden.
- Keep payment funds separate from treasury/yield functionality.
- Ensure no native token is introduced.
- Ensure no retail/consumer flow is built.
- Ensure all payment flows have audit records.

### Immediately Post-MVP / POC

Regulatory engagement becomes an active workstream.

Tasks:

1. Prepare regulator-facing demo.
2. Prepare regulatory design memo.
3. Identify first jurisdiction.
4. Identify possible licensed partners.
5. Decide whether product will operate as:
   - Licensed payment company
   - Infrastructure provider to licensed entities
   - Technology vendor
   - Hybrid model
6. Begin informal conversations with regulators.
7. Structure a limited real-money pilot if appropriate.

### Regulatory Positioning

Preferred initial position:

> SettlementOS is a technology infrastructure provider that enables compliant stablecoin settlement workflows for businesses, fintechs, payment companies, and regulated partners.

Avoid initial positioning as:

- Consumer remittance company
- Bank replacement
- Deposit-taking institution
- Yield product
- Decentralized exchange
- New stablecoin issuer
- New blockchain network

## 23. Liquidity Management

### MVP Liquidity Functions

- Show available liquidity by asset/network
- Reserve liquidity for pending payments
- Release liquidity on failure
- Mark shortfalls
- Simulate rebalancing
- Simulate FX liquidity

### Example Liquidity Logic

```text
Payment amount: 100,000 mockUSDC
Available Base Sepolia mockUSDC: 250,000
Reserved: 50,000
Available after payment: 100,000
Liquidity status: sufficient
```

### Future Liquidity Features

- Real exchange integration
- OTC liquidity
- Automated rebalancing
- Stablecoin inventory management
- Treasury yield allocation
- Tokenized T-bill integration
- Multi-currency liquidity pools

## 24. RWA / Treasury Module

### MVP

Show a simulated treasury product:

```text
Product: Tokenized T-Bill Strategy
Status: Not enabled
Eligibility: Institutional only
Estimated yield: Simulated
Risk: Requires approval
```

### Future

Possible integrations:

- Tokenized U.S. Treasury products
- Tokenized money-market funds
- Bank-issued tokenized deposits
- Permissioned DeFi lending
- Internal liquidity pool

Important constraint:

Payment settlement balances and treasury/yield products must remain logically, legally, and operationally separate unless explicitly approved.

### Design Direction: Overnight Liquidity Parking, JLTXX-Inspired (added 2026-07-08)

**Market validation.** JPMorgan's JLTXX (OnChain Liquidity Token Money Market
Fund, launched May 2026) proves the model this section anticipated: a tokenized
MMF holding U.S. Treasuries and overnight Treasury repos, running on **public
Ethereum** via JPMorgan's Kinexys infrastructure, ~3.5% daily-accruing yield,
$1M minimum, qualified U.S. investors. AUM grew ~250% in its first weeks to
~$695M (July 2026), driven by institutions wanting compliant on-chain cash
management — and by GENIUS Act eligibility as stablecoin reserve backing.
Reference: cryptobriefing.com/jpmorgan-jltxx-tokenized-money-market-fund-surges-250-percent/

**Product concept for SettlementOS (Phase 8).** Institutions using SettlementOS
hold idle stablecoin between settlement windows. Today that balance earns
nothing and sits as raw treasury inventory. The feature:

- **Park**: sweep idle settlement-treasury or entity balances into a tokenized
  MMF position (mock "mockJLT" share token on testnet) — typically overnight,
  in anticipation of a corridor move the next day (e.g. park USD inventory
  Sunday night ahead of Monday's USD→JPY payout window).
- **Accrue**: daily yield accrual, simulated at a realistic T-bill/repo rate;
  position visible on the Liquidity & Treasury screen alongside per-network
  balances.
- **Recall**: T+0 redemption back to the settlement asset when a payment needs
  the liquidity — the route engine treats *parked* liquidity as
  "available-with-recall-delay" and can quote against it, auto-recalling on
  execution.
- **Guardrails** (the regulatory posture from §9 applies): institutional-only
  eligibility flag, explicit opt-in per entity, park/recall events on the
  hash-chained audit log, and **strict segregation** — parked funds live in a
  separate contract and are never commingled with in-flight payment escrow.

**MVP-safe implementation sketch.** A `TokenizedMMF` contract (permissioned
subscribe/redeem, daily index accrual, testnet-only) + a `TreasuryPosition`
table + park/recall API routes + liquidity-engine awareness. Entirely simulated
yield; no real securities. This keeps the demo honest while showing regulators
and partners exactly where a JLTXX-style integration (or the real JLTXX, via a
custody partner) would slot in.

**Why it matters commercially.** This turns SettlementOS from "payment rails"
into "payment rails + overnight cash management" — the JLTXX growth curve is
evidence institutions pay for exactly this combination, and it creates a
treasury-revenue-share pricing lever (§31 Commercial).

## 25. Partner Strategy

### Potential Partner Types

- Stablecoin issuers
- Crypto exchanges
- Payment infrastructure companies
- Neobanks
- Card issuers
- FX brokers
- OTC desks
- Regional payout providers
- Compliance vendors
- Chain analytics providers
- Custody providers

### Base / Coinbase Angle

Base provides a strong strategic inspiration because it sits near Coinbase's ecosystem, which is relevant for:

- Stablecoin access
- On/off-ramp logic
- Institutional familiarity
- Developer tooling
- Potential future custody and liquidity integrations

SettlementOS should not be dependent on Coinbase, but Base is a strong first network for a credible EVM-first prototype.

### Reap / Kraken Angle

Given the Reap acquisition by Kraken's parent, Reap/Kraken should be viewed as a potential partner or strategic reference point, not an immediate direct competitor.

Potential collaboration ideas:

- Use Kraken as exchange/liquidity provider
- Use Reap-like infrastructure for business onboarding and payout
- Build non-overlapping settlement orchestration layer
- Position as neutral infrastructure that can plug into Reap, Squads, Kraken, or similar partners

### Squads / Solana Angle

Given existing investor exposure to Squads, the MVP should avoid building a Solana neobank or treasury wallet that competes directly with Squads.

Instead:

- Integrate with Squads later for Solana-based business custody
- Use Squads as a possible treasury wallet layer
- Keep SettlementOS focused on routing, settlement, compliance, and payment orchestration
- Defer Solana implementation until EVM POC is validated

## 26. Success Metrics

### MVP Technical Metrics

- Payment created successfully
- Quote generated in less than 2 seconds
- Base Sepolia transaction submitted successfully
- Transaction confirmed
- Payment marked settled
- Audit log generated
- Reconciliation export generated
- Compliance checks completed
- Liquidity reserved and released correctly
- Payment state machine works end-to-end

### MVP Demo Metrics

- Can demo full payment lifecycle in under 5 minutes
- Can show before/after cost and time comparison
- Can show regulator-friendly compliance view
- Can show partner-friendly API
- Can show treasury/liquidity view
- Can explain why no token is needed
- Can explain why EVM/Base first is the right starting point

### Business Validation Metrics

- Number of partner conversations
- Number of signed LOIs
- Number of pilot design partners
- Number of corridors validated
- Number of regulators willing to review demo
- Number of payment companies interested in API integration

### Regulatory Validation Metrics

Post-MVP:

- Regulator demo completed
- Legal/regulatory memo completed
- First jurisdiction identified
- Licensed partner strategy identified
- Real-money pilot structure drafted
- Compliance provider shortlist created

## 27. Demo Script

### Demo Scenario

"ACME US wants to pay a Japanese supplier $100,000 equivalent using stablecoin settlement on EVM rails."

Steps:

1. Open dashboard.
2. Show ACME US as approved sender.
3. Show Japanese supplier as approved recipient.
4. Create payment.
5. Enter amount: $100,000.
6. Select source asset: mockUSDC.
7. Select destination asset: mockJPY.
8. Generate quote.
9. Show route:
   - Base Sepolia
   - Estimated gas: low
   - Estimated settlement time: seconds
10. Show compliance status:
   - KYB passed
   - Wallet screening passed
   - Corridor allowed
11. Execute payment.
12. Show EVM transaction hash.
13. Show settlement confirmation.
14. Show recipient ledger credit.
15. Export reconciliation report.
16. Show audit trail.
17. Show post-MVP regulator review checklist.

### Demo Narrative

"Today this payment would typically require bank rails, correspondent intermediaries, FX markup, operational reconciliation, and delayed settlement. SettlementOS shows how a regulated payment institution or enterprise could move value across borders using EVM-based stablecoin rails while preserving compliance controls, auditability, and liquidity management."

## 28. Key Risks

### Regulatory Risk

Even if the MVP is testnet-only, the real product will trigger money transmission, custody, AML, sanctions, stablecoin, securities, FX, and payments regulation.

Mitigation:

- Build compliance hooks from day one
- Avoid real money in MVP
- Avoid consumer remittance initially
- Avoid native token
- Avoid commingled yield
- Engage regulators immediately after MVP/POC
- Prefer licensed-partner model for early real-money pilot

### Partner Risk

Fiat payout and banking access may be hard.

Mitigation:

- MVP uses simulated payout
- Later integrate with licensed partners
- Focus on infrastructure, not direct consumer funds

### Liquidity Risk

Real payment settlement requires reliable liquidity.

Mitigation:

- Start with limited corridors
- Use pre-funded liquidity
- Integrate with exchanges/OTC desks later
- Build liquidity reservation system early

### Competitive Risk

Large players are moving into stablecoin payments.

Mitigation:

- Choose narrow corridor
- Be partner-friendly
- Avoid competing with every payment company
- Focus on orchestration layer and compliance UX

### Technical Risk

Cross-chain routing and bridging can introduce security risks.

Mitigation:

- Start single-chain on Base Sepolia
- Avoid real bridge risk in MVP
- Use adapter architecture
- Do not custody real funds initially
- Add multi-chain EVM support only after single-chain flow works

## 29. Build Phases & Status

> Renumbered 2026-07-08 to reflect the actual build. Phases 1–5 are complete;
> 6–9 are the forward roadmap. The original "Phase 0 design prototype" was
> folded into Phase 1 (the app itself became the prototype).

### Phase 1: Single-Chain Settlement — ✅ DONE

- Payment creation, quoting, execution against a local Base-simulating chain
- `PaymentSettlement` escrow contract + `MockERC20` assets (Solidity 0.8.24)
- 16-state payment lifecycle enforced by a state machine
- Hash-chained append-only audit log, reconciliation CSV export
- Dashboard, payment detail, entities, compliance queue screens

### Phase 2: Multi-Asset / FX / Compliance / Liquidity — ✅ DONE

- mockUSDC / mockJPY / mockSGD, currency↔asset mapping (JPY = 0 decimals)
- Simulated FX engine: static mids, spread, tiered slippage, platform fee
- Route engine: instant escrow vs. batched netting quotes
- Five mock compliance providers (KYB ×2, sanctions, wallet risk ×2, tx risk, corridor) with PASS / FAIL / MANUAL_REVIEW and a reviewer queue
- Treasury liquidity reservations with release-on-failure

### Phase 3: Multi-Chain EVM Demo — ✅ DONE

- Network-registry chain adapter (viem); two local Hardhat chains (31337/31338)
- Cross-chain routes via simulated bridge: escrow + FX on source, real ERC-20 treasury payout on destination — tx hashes on both networks
- Per-network wallets and account roles

### Phase 4: Real Base Sepolia — ✅ DONE 2026-07-07

- Deployed to public Base Sepolia (84532): contracts, funded role wallets, DB registration; deploy script is idempotent and reuses generated wallets
- Every transaction publicly verifiable — Basescan links throughout the UI
- Verified with a real settled payment: $100k USD→JPY in 8.5 seconds
- Key handling: funded deployer key in `.env` only; generated dust wallets in a gitignored deployments file; local chains and public testnet coexist

### Phase 5: Test Suite + CI — ✅ DONE 2026-07-08

- 71 vitest tests: unit (state machine, FX, base units), DB (compliance matrix, audit-chain tamper detection), integration (executor E2E on-chain, contract invariants, API validation)
- Fully self-contained fixture (own Hardhat nodes + throwaway DB); GitHub Actions CI on every push/PR

### Phase 6: Compliance Provider Sandbox — ✅ DONE 2026-07-10

Two mocks replaced with real vendor sandboxes behind the existing `ProviderResult` interface (`lib/providers/`):

- **Sanctions → OpenSanctions match API**: real consolidated OFAC/EU/UN screening of both parties' names (`match` → FAIL, near-threshold score → MANUAL_REVIEW)
- **Wallet risk → Chainalysis sanctions oracle**: real sanctioned-address detection via the free public smart contract (`isSanctioned(address)`, keyless — the free HTTP API's self-service signup no longer exists); platform policy (registration/allowlist) still gates before the oracle read
- Env-driven dispatch with mock fallback — each provider switches on independently via `OPENSANCTIONS_API_KEY` / `CHAINALYSIS_ORACLE_RPC_URL`; without them the deterministic mocks run, so the demo never breaks offline
- Fail-safe policy: provider error/timeout/malformed response → MANUAL_REVIEW, never fail-open
- Raw provider responses (and failure details) persisted on `ComplianceCheck.rawResponse` for audit evidence
- KYB stays mocked (sandbox onboarding cost exceeds demo value for now)
- 20 new tests (adapter mapping incl. on-chain ABI round-trip against a stubbed RPC, fail-safe, registry dispatch, raw-evidence persistence) — suite now 91; oracle verified live on Ethereum mainnet

### Phase 7: Second Real Testnet — Polygon Amoy — ✅ DONE 2026-07-15

- polygon-amoy (80002) in the network registry; `loadDeployments()` generalized
  to one `deployments.<id>.json` overlay per live network; parameterized
  `scripts/deploy-testnet.mjs` (replaces the Base Sepolia one-off) with
  per-network gas-dust targets — Amoy enforces a ~30 gwei floor, ~100× Base
  Sepolia (code 2026-07-13; deploy 2026-07-15 after faucet-funding the
  deployer ~0.185 POL/day)
- Cross-chain bridge demo now fully public: first real bridged payment
  ($25k USD→JPY) escrowed on Base Sepolia and paid out on Polygon Amoy, with
  Basescan + Amoy Polygonscan links on one payment (~7s end to end)
- Live-fire lesson: the first attempt failed when the load-balanced public RPC
  gas-estimated `settlePayment` against a replica that hadn't seen the escrow
  block ("not initiated") — added `retryOnReplicaLag` to `operatorWrite` for
  state-dependent calls (impossible to hit on single-node local chains); the
  stuck escrow was recovered on-chain via manual `failAndRefund` with the
  audit chain kept intact. Suite now 135 tests

### Phase 8: Tokenized MMF / Overnight Liquidity Parking — ✅ DONE 2026-07-14

Activated the §24 treasury placeholder as a working simulation — JLTXX-inspired
(see §24 for the full design). Built autonomously story-by-story by the Ralph
agent loop (`scripts/ralph/`), 10 user stories:

- `TokenizedMMF.sol`: operator-permissioned subscribe/redeem, daily accrual via
  a monotonic share index (starts 1e18); funds fully segregated from
  `PaymentSettlement` escrow (proven on-chain in tests)
- `TreasuryPosition` table + per-entity `mmfEligible` / `mmfOptIn` guardrail
  flags (institutional-only, explicit opt-in; API returns 403 otherwise)
- `lib/treasury.ts`: park (reserved liquidity can never be parked), T+0 recall,
  `accrueDaily` at a simulated 3.5% APY — pure-bigint index math, position
  value always derived from the live index, never stored
- Four thin API routes (`/api/treasury/park|recall|positions|accrue`), and
  `TREASURY_PARKED/ACCRUED/RECALLED` events on the hash-chained audit log
- Route engine treats parked liquidity as available-with-recall-delay
  (`recall_required` on quotes); the executor auto-recalls before escrow
- Liquidity-page MMF card: park/recall/accrue controls, live index and yield,
  "Institutional only" / "Simulated yield — testnet only" pills
- Suite grew 93 → 131 tests; park→accrue→recall verified in the browser
- **Live-network deploy (ForteL2 F4, 2026-08-03, PR #29):**
  `scripts/deploy-testnet.mjs` now provisions `TokenizedMMF` + yield buffer +
  treasury approval on every live network (base-sepolia / polygon-amoy /
  fortel2-sepolia). Older overlays without a fund still settle
  (`mmfAddress()` → `undefined`). Park→accrue→recall verified on a local
  chainId-852 node, then **live against the real 852 sequencer on 2026-08-07**
  (50k parked → 50004.79452 recalled, +4.794520 = 3.5%/365 exactly; escrow
  balance delta 0). Evidence: `tasks/runbooks/fortel2-live-session-2026-08-07.md`.
  Details in [`tasks/prd-fortel2-integration.md`](tasks/prd-fortel2-integration.md).
  Among those three live networks, ForteL2 is the personal, best-effort rail
  with **no uptime SLA** — a demo against 852 only works while the operator's
  sequencer is up (see README § ForteL2 / DEMO Part E).

### Phase 9: Production Hardening + Regulatory / Partner Package

**Track A — Production hardening.** Scope comes from the 2026-07-09 security,
accuracy, and maintainability audit (`AUDIT.md` in the repo — full findings,
refactor plan, and priorities). Remediation in the audit's recommended order:

1. Authentication, authorization, tenant isolation, and safe error handling
   (today every API route is open; the audit actor must come from an
   authenticated identity, not the request body)
2. Atomic, idempotent lifecycle execution — compare-and-swap status
   transitions, per-payment execution lease, liquidity reserved in the same
   transaction that claims the lease; concurrent-execution tests
3. Post-settlement compensation design — a settlement saga with a
   treasury-funded refund path for destination-leg failures that occur after
   source-chain settlement
4. Fixed-precision monetary model — strict amount validation (reject rather
   than truncate excess precision), no JS `Number` in quoting/liquidity/fee
   math, canonical decimal handling end to end
5. Key custody — managed signer/KMS for operator and treasury keys, no
   retained entity keys, exact short-lived approvals instead of unlimited
   allowances
6. Audit-chain anchoring (audit event written atomically with the domain
   change, signed checkpoints), security headers/rate limits/pagination,
   batched RPC reads

**Track B — Regulatory / partner package.** (Original "Phase 4" — unchanged.)

- Polished demo + this PRD
- Technical architecture deck
- Regulatory design memo, legal classification memo
- Partner integration memo, corridor strategy memo
- Real-money pilot options memo

The audit deliberately measures the gap between "credible demo" and
"operational system" — Track A closes that gap; Track B is the story told to
regulators and partners about how it gets closed.

## 30. Recommended MVP Cut

The smallest credible version is:

1. Base Sepolia only
2. mockUSDC only
3. Business sender
4. Business recipient
5. Compliance placeholders
6. Payment execution
7. Dashboard status
8. EVM transaction hash
9. Audit trail
10. Reconciliation export
11. Regulatory issues log

The more impressive demo version is:

1. Base Sepolia
2. mockUSDC + mockJPY + mockSGD
3. FX quote simulation
4. Route engine
5. Liquidity reservation
6. Compliance workflow
7. Recipient ledger credit
8. Audit/reconciliation export
9. Post-MVP regulator review package

Do not build Solana in the first MVP unless there is a strong Squads-specific reason. EVM-first will be faster and cleaner for the initial demo.

## 31. Open Questions

### Product

- Who is the first design partner?
- Is the first buyer a fintech, bank, payment company, exchange, or enterprise?
- Which corridor matters most?
- Is the core product API-first or dashboard-first?
- Is the first use case treasury movement, supplier payment, or payout?

### Technical

- Should Base Sepolia be the only Phase 1 network?
- Should FX be fully simulated or use testnet AMM contracts?
- Should custody be simulated, embedded, or wallet-connected?
- Should the recipient receive tokenized local currency or ledger credit?
- Should Phase 2 use Polygon Amoy or Arbitrum Sepolia?

### Regulatory

- Which jurisdiction should be the first regulatory conversation?
- Is this positioned as infrastructure for licensed partners or as a regulated payment company?
- Does the product ever touch customer funds directly?
- Is treasury yield offered by the platform, partner, or not at all?
- Which regulator gets the first post-MVP demo?

### Commercial

- Who pays?
- Pricing model: per transaction, basis points, SaaS fee, API fee, liquidity spread, treasury revenue share?
- Is this a standalone company, partner platform, or strategic wedge into existing portfolio companies?

## 32. Initial Recommendation

Start with a **Base Sepolia, EVM-first technical demo and partner validation MVP**.

Build the demo around this story:

> "We can move $100,000 equivalent from a U.S. business to an Asian business using EVM-based stablecoin settlement, with compliance gates, liquidity reservation, FX simulation, settlement tracking, and reconciliation."

The MVP should be designed so that immediately after the POC works, the team can show it to regulators, licensed payment partners, fintechs, and potential strategic partners.

Do not position this as a crypto app. Position it as a **payments infrastructure and settlement system**.

The right first milestone is not transaction volume. The right first milestone is getting three sophisticated parties to say:

1. "This solves a real payment problem."
2. "The compliance model is credible."
3. "We would pilot this if it worked with real rails."
