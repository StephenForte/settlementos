# SettlementOS — Technical Architecture

> **STATUS: FROZEN TEMPLATE (2026-08-10).**  
> This memo is an **unreviewed draft**, frozen on this date. It is **illustrative
> scaffolding** for a bank or licensed partner evaluating SettlementOS — not legal,
> regulatory, or compliance advice, and not authoritative for any jurisdiction.  
> An adopter is expected to **replace** this document with their own. Substitution
> points use `[[ADOPTER: …]]` (see [README.md](README.md)).
>
> **Amendment 2026-08-14.** §10 extended with an independent verification of
> the calldata claim — the Sepolia batch-inbox and batcher addresses, the
> transaction type actually observed, and what the property does and does not
> let a reader do. Nothing else in this memo changes.
>
> **Amendment 2026-08-13.** §10 added. ForteL2 confirmed (2026-08-13) that it
> posts L2 batches to Ethereum L1 as calldata, not blobs, so ForteL2 history is
> permanently re-derivable from L1. The 2026-08-10 freeze, the not-advice
> framing, the `[[ADOPTER: …]]` convention, and the instruction to replace this
> document are unchanged.

**Audience:** technical reviewers at prospective payment partners, banks, and
fintechs; the technical annex to the regulator demo deck.
**Status of the system:** testnet-only proof of concept. Mock assets, simulated
FX and payout, no real customer funds. Every claim below is grounded in the
running code ([AGENTS.md](../../AGENTS.md) is the engineering guide).
**Adopter context:** [[ADOPTER: deploying legal entity / programme name]];
networks and environments in your pack —
[[ADOPTER: production / pilot network set (replace Base Sepolia, Polygon Amoy, locals)]].

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
  development plus real public testnets
  ([[ADOPTER: live testnet / mainnet targets — draft cites Base Sepolia, Polygon Amoy]]).
  Contract addresses and account roles are loaded per network.

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

## 10. ForteL2 data availability (rail property)

On 2026-08-13 ForteL2 confirmed they post L2 batch data to Ethereum L1 as
**calldata**, not as EIP-4844 blob data. Blob data is pruned from L1 after
roughly 18 days; calldata is not. ForteL2 history is therefore **permanently
re-derivable from L1**: a counterparty can independently reconstruct that rail's
settlement history from first principles at any future date.

This is a property of ForteL2's L1 data-availability path. It is not a claim
about Base Sepolia, about SettlementOS's Postgres database, or about the
hash-chained audit log in this repository.

### Verified independently (2026-08-14)

The calldata property above was ForteL2's statement. It was checked against
Sepolia rather than accepted on report.

**Method.** `batcherHash()` and `batchInbox()` were read from the ForteL2
`SystemConfigProxy` on Sepolia (`0x8416cd475d75b558899d83f4cf0ffeb85d7bc361`),
and the batcher's recent transactions were then listed.

>
> **Addendum, 2026-08-22.** ForteL2 performed a planned coordinated re-genesis of
> chain 852 on this date. The verification recorded in this section stands as an
> accurate record of what was observed on 2026-08-14, but it is **no longer
> independently reproducible as written**: the `SystemConfigProxy` cited above was
> replaced, and its successor is `0x7c799f23a427328831be0a8206a525a9bc886bde`.
> The batcher EOA and the batch inbox below are unchanged — both survive a
> re-genesis — so the batcher nonce remains a monotonic and still-valid figure.
> A reader re-performing this check should read the current address from ForteL2's
> `deployments/rail-interface.json` (v7 or later).

- **Batch inbox:** `0x007238ac625E3e5369739fA5b9CDbf61320B237c`
- **Batcher EOA:** `0x3d54fd6353cd66d143fb94d178c9eeb1ae98a31d` — nonce **6,671**
  when checked, i.e. that many batch transactions posted to L1 to date.

The four most recent batches, all sent to the batch inbox:

| L1 block | Timestamp (UTC) | Tx type | Calldata |
|---|---|---|---|
| 11490445 | 2026-08-14 23:40:00 | 2 | 623 bytes |
| 11490419 | 2026-08-14 23:34:00 | 2 | 103 bytes |
| 11490393 | 2026-08-14 23:28:48 | 2 | 115 bytes |
| 11490368 | 2026-08-14 23:23:36 | 2 | 111 bytes |

**Type 2 is EIP-1559 — plain calldata.** A blob-carrying batch would be type 3
(EIP-4844) and would fall under the ~18-day pruning window. None of these do.
Cadence was roughly one batch every five to six minutes, and the calldata sizes
are span-batch compression at work: a whole five-minute window of L2 activity in
a few hundred bytes.

**What this establishes, and what it does not.** It establishes that batches are
posted as calldata and therefore persist in L1 history for as long as Ethereum
does. It does **not** make an individual L2 transaction hash findable on L1: a
batch is compressed and holds every L2 transaction in its window, so a given
settlement is present as bytes, not as a searchable hash. Recovering one means
deriving the L2 chain from the posted batches. The property is archival, not a
lookup path — day-to-day verification reads the L2 directly.

**Operational dependency.** Batch posting costs the batcher L1 gas. Its balance
was ~0.90 ETH when checked; if it empties, batch posting stops and L1 receives
no further history, though everything already posted remains re-derivable. That
is a ForteL2 operational concern rather than a SettlementOS one, but it bounds
the durability claim above.
