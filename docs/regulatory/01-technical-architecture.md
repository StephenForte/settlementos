# SettlementOS — Technical Architecture

**Audience:** technical reviewers at prospective payment partners, banks, and
fintechs; the technical annex to the regulator demo deck.
**Status of the system:** testnet-only proof of concept. Mock assets, simulated
FX and payout, no real customer funds. Every claim below is grounded in the
running code ([AGENTS.md](../../AGENTS.md) is the engineering guide).

---

## 1. What SettlementOS is

An infrastructure layer that makes cross-border B2B settlement over EVM stablecoin
rails usable by businesses and regulated partners: route quoting, a compliance
gate, on-chain escrow, simulated FX/bridge/payout, and a hash-chained audit trail —
wrapped in the operational controls (identity, authorization, atomic execution,
compensation, key custody, audit anchoring) that separate a demo from an
operable system.

It is **not** a token, a consumer remittance app, a custodian of customer funds,
a DeFi yield product, or a real-money system today. Those exclusions are
deliberate and are enforced by the architecture, not just policy (see §7).

## 2. System shape

Three tiers, each with a hard boundary:

- **Application / API** — a Next.js (App Router) service exposing a REST API and
  an operator/partner UI. Route handlers are thin; all logic lives in `lib/`.
- **Domain / ledger** — a relational store (SQLite in the POC; the schema is
  portable to Postgres for operation) holding payments, entities, wallets,
  compliance checks, liquidity reservations, treasury positions, and the
  append-only audit log.
- **Chain adapter** — a viem-based adapter to EVM networks: two local chains for
  development plus real public testnets (Base Sepolia, Polygon Amoy). Contract
  addresses and account roles are loaded per network.

Chain, key-custody, treasury, and executor modules are marked `server-only`: a
client bundle that reaches them fails the build, so deployment records and key
material can never ship to a browser.

## 3. Payment lifecycle

A payment moves through an explicit state machine; every transition is legal-by-
construction and recorded. The happy path:

```
DRAFT → QUOTED → COMPLIANCE_PENDING → APPROVED → LIQUIDITY_RESERVED
      → SUBMITTED_ONCHAIN → CONFIRMED_ONCHAIN → FX_OR_SWAP_COMPLETED
      → PAYOUT_PENDING → SETTLED
```

Branches: `MANUAL_REVIEW` (a compliance flag parks the payment for a reviewer),
`REJECTED` (compliance fail), `CANCELLED` (before execution), `FAILED` → `REFUNDED`
(escrow held, refunded on-chain), and the post-settlement saga
`COMPENSATION_PENDING` → `COMPENSATED` (see §5).

**Invariant:** no status changes except through a single compare-and-swap
transition (`updateMany where {id, status: from}`). A concurrent writer that loses
the race changes nothing and is told so — the lifecycle cannot be corrupted by two
requests racing.

## 4. On-chain vs. off-chain, and the trust model

- **On-chain (real transactions, even in the POC):** source-asset escrow and
  release via a `PaymentSettlement` contract; on a cross-chain route, a
  treasury-funded ERC-20 payout on the destination network. Each leg produces a
  public explorer link.
- **Simulated:** FX rates (a static mid-rate table with spread, tiered slippage,
  and a platform fee), the cross-chain "bridge" (escrow + FX on the source chain,
  then a treasury-funded payout on the destination chain — not lock-and-mint), and
  the recipient's local-currency ledger credit (a stand-in for a fiat rail).
- **Operator-controlled:** the `PaymentSettlement` contract is admin/operator
  gated. That is a deliberate product choice for a permissioned settlement system,
  and it is what makes the compliance gate and monitoring meaningful — but it means
  operational controls, monitoring, and key-management policy are load-bearing
  (§6), not optional.

**Money-type discipline:** fiat amounts are canonical decimal strings; on-chain
amounts are bigint base units; quoting/fee/liquidity arithmetic is bigint end to
end and floors in the platform's favour. No JavaScript float ever touches a
monetary value. Client amounts are validated at the API boundary against a strict
canonical grammar and **rejected, never truncated** — excess precision is a 400,
so a sum nobody asked for can never be settled.

## 5. Failure handling — refund and compensation

Failures are reconciled against on-chain fact, not the database's intent, because
the two disagree exactly when a step threw mid-flight:

- **Before the escrow is released** → on-chain refund (`FAILED` → `REFUNDED`).
- **After the escrow is released to the treasury** → the escrow cannot be
  refunded, so the sender is made whole by a treasury-funded transfer of the
  source asset back to their wallet on the source network (`COMPENSATION_PENDING`
  → `COMPENSATED`). A compensation that itself fails stays pending for an operator,
  never silently FAILED.
- **After the recipient was already paid** (cross-chain payout landed) → the
  payment completes forward to `SETTLED`; compensating here would pay twice.

An operator "needs attention" view surfaces any payment still holding funds — read
live from the chain, so a flaky RPC cannot make a stranded payment disappear — and
a repair action re-runs a failed compensation idempotently.

## 6. Operational controls (Track A / AUDIT.md remediation)

The controls a regulator or partner would expect of an operable system:

- **Identity & authorization** — every API caller presents an API key resolving to
  a role (operator, compliance reviewer, entity/tenant); only key hashes are
  stored. Every route authorizes by role, and tenant reads are scoped by query
  filter so one party can never see another's data. Cross-tenant probes get a 404,
  never a signal that an id exists.
- **The audit actor is the authenticated identity**, never a request field — an
  actor cannot be forged.
- **Atomic, idempotent execution** — a per-payment execution lease (claimed with
  the liquidity reservation in one transaction) makes double-execution impossible;
  idempotency keys make a retried write safe.
- **Key custody seam** — nothing at runtime reads a private key from the
  environment directly; a signer abstraction resolves keys, with a documented KMS/
  HSM extension point. Entity wallets grant the escrow an **exact per-payment
  allowance**, not a standing unlimited approval.
- **Tamper-evident audit** — every domain change and its audit event commit in the
  same transaction; the log is hash-chained and periodically signed with an anchor
  key held outside the database, so a re-hashed history cannot verify clean.
- **Safe errors** — clients receive stable error codes with no internal detail
  (contract addresses, RPC URLs, revert data stay in server logs); operator failure
  detail is redacted for tenant callers.
- **Web hardening** — security headers, per-principal write rate limits, a request
  body cap, pagination on every list read, and a date-bounded reconciliation export
  audited once per export.

## 7. How the architecture enforces the regulatory posture

The regulatory design principles (PRD §9) are enforced structurally, not just
stated:

- **No commingling of payment funds and treasury products** — parked treasury
  liquidity lives in a separate `TokenizedMMF` contract that makes no cross-calls
  with the escrow contract and holds separate balances; only unreserved treasury
  balance can be parked, so liquidity promised to an in-flight payment is never
  swept into the fund.
- **Clear sender/recipient identity model** — every payment references onboarded
  entities with KYB status, wallets, allowlist flags, and approved corridors.
- **Compliance gate on every execution** — KYB, sanctions, wallet risk,
  transaction risk, corridor risk. Sanctions and wallet screening call real vendor
  sandboxes (OpenSanctions, a Chainalysis sanctions oracle) when configured; any
  provider error resolves to MANUAL_REVIEW, never a silent PASS. Verbatim vendor
  evidence is persisted.
- **Complete audit trail & reconciliation** — every state change and fund movement
  is audited; a bounded CSV reconciliation export is available to platform roles.
- **No native token, no retail, no undisclosed yield, no unpermissioned DeFi
  routing** — none of these exist in the codebase.

## 8. What a partner integrates against

A REST API with `snake_case` JSON: create a payment, quote it, execute it (runs the
compliance gate then settles), review a manual-review case, cancel, read status and
the audit trail, list entities, read balances, export reconciliation. Writes accept
an idempotency key. The UI is a reference operator/partner console over the same
API.

## 9. Deliberate limitations (stated plainly)

- Testnet only; mock assets; simulated FX, bridge, and payout.
- SQLite and a per-process rate limiter in the POC — both have documented
  operational replacements (Postgres, a shared limiter store) for a multi-instance
  deployment.
- KYB is mocked; only sanctions/wallet screening reach real sandboxes.
- The audit anchor is signed but not yet published to an external party or public
  chain — the residual step to make deletion of the anchor itself detectable.
- The settlement contract is operator-controlled; production use requires the
  key-management policy and monitoring that control implies.

These are the honest edges of the POC. Track A made the *architecture* operable;
closing these is the work between POC and a licensed, real-money pilot (see the
pilot options memo).
