# AGENTS.md — SettlementOS engineering guide

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## What this is

EVM stablecoin settlement MVP: payment orchestration for cross-border B2B
settlement over stablecoin rails — route quoting, compliance gate, on-chain
escrow, simulated FX/bridge/payout, hash-chained audit trail. Full docs in
[README.md](README.md), demo run-of-show in [DEMO.md](DEMO.md), product
requirements + roadmap in [PRD.md](PRD.md) (canonical — a copy may exist on
Stephen's Desktop; the repo version wins). Testnet demo only: mock assets,
simulated FX, no real funds.

## Run & verify

```bash
# Prerequisite: local Postgres 16 accepting connections on 127.0.0.1:5432
# (Homebrew `postgresql@16` or equivalent). Create an empty DB, then set
# DATABASE_URL in .env — see .env.example (?schema=settlementos).
npm run chain             # base-local    → :8545, chainId 31337
npm run chain:polygon     # polygon-local → :8546, chainId 31338
npm run setup             # deploy to both local chains + reset/seed DB (the reset button; localhost only)
npm run db:deploy         # prisma migrate deploy — the deployed/schema path (not setup)
npm run dev               # app on :3000
npm run deploy:base-sepolia   # real testnet deploy (needs funded DEPLOYER_PRIVATE_KEY in .env)
npm run deploy:polygon-amoy   # same, for Polygon Amoy (deployer needs POL there)
npm test                      # full suite — needs local Postgres; builds its own ephemeral DB + chains
npx tsc --noEmit && npm run lint
```

**Postgres version pin (16):** local Homebrew/`postgresql@16`, CI's
`postgres:16` service (`.github/workflows/ci.yml`), and the Render database
(`settlementos-db`, deliberately created at 16 — not Render's default 18) must
stay on the **same** major version. Migrations were authored and tested against
16; bumping one host alone reintroduces skew. Move all three together or none.
This is a pin rule, not an upgrade task.

**Tests**: `npm test` compiles contracts, boots two Hardhat nodes on test-only
ports (19545/19546), creates an **ephemeral Postgres database** (migrate deploy
into `?schema=settlementos`), seeds it, and drops the database on teardown. It
never touches the dev DB, `chain/deployments*.json`, or a remote host. Requires
Postgres on loopback (override the admin URL with `SETTLEMENTOS_TEST_PG_URL` —
CI sets this to the workflow's Postgres service). Layers: `tests/unit/` (state
machine, FX, base units, explorer URLs, provider adapters with stubbed fetch),
`tests/db/` (compliance matrix — mock and real-provider modes, audit-chain
tamper detection + concurrency), `tests/integration/` (executor E2E on-chain,
PaymentSettlement contract behavior, API route validation, MMF guardrails +
escrow segregation). CI runs typecheck + lint + tests on every push/PR
(`.github/workflows/ci.yml`, with a `postgres:16` service). **Add tests for new
lifecycle, compliance, or chain behavior** — and still smoke-test UI-visible
changes by hand via the flow in README "API". `npm run setup` resets DB + local
chains at any time (refuses non-localhost `DATABASE_URL`); it re-registers
real-testnet wallets and never touches the public testnet deployments. Local
dev schema sync uses `prisma db push` inside setup; the deployed path is
`npm run db:deploy` (`prisma migrate deploy`).

## Architecture map

| Module | Responsibility |
|---|---|
| [lib/networks.ts](lib/networks.ts) | Network registry (local sims + real base-sepolia, polygon-amoy, and fortel2-sepolia), explorer URL helpers. **Client-safe — no node imports, no secrets.** |
| [lib/chain.ts](lib/chain.ts) | viem chain adapter. Loads/merges `chain/deployments*.json`, per-network accounts via `accountsFor()`, contract ABIs (`SETTLEMENT_ABI`, `MMF_ABI`), `operatorWrite()` (escrow) / `mmfOperatorWrite()` (fund), `treasuryTokenTransfer()` (returns a `SubmittedTx` — hash first, `confirm()` separately, so callers can persist the attempt before awaiting the receipt), `transactionOutcome()` (destination-receipt ground truth; never returns "absent" from a live chain — see its comment), `replicaLagRetries()` (0 on single-sequencer rails), `priorityFeeFor()` (1 wei on `fortel2-*`, undefined elsewhere so viem keeps estimating), `ensureSenderAllowance()` (exact per-payment escrow approval) / `ensureTreasuryAllowance()`, `mmfAddress()` (undefined where no fund is deployed). Resolves no keys itself — `walletFor(networkId, signer)` takes a `Signer`. Write transports (`publicClientFor` / `walletFor`) attach Cloudflare Access service-token headers only for `fortel2-sepolia` and only when both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set; Base Sepolia / Amoy never receive them. `readClientFor` never does (replica is private-network, no Access). **`server-only`** |
| [lib/signers.ts](lib/signers.ts) | The custody seam: `Signer` (`address` + async `account()`), `signerFor(ref, role)` dispatching on the `AccountRef` (`kmsKeyId` → `KmsSigner`, else `LocalKeySigner`), `resolveKey()` (inline key or `privateKeyEnv` → .env), `AccountRef`. `KmsSigner` is the documented extension point and throws "not configured". **`server-only`** |
| [lib/state.ts](lib/state.ts) | Payment lifecycle state machine; `assertTransition()` enforces legal moves. Pure — no DB, no framework |
| [lib/transitions.ts](lib/transitions.ts) | The one way a payment's status changes: `transitionStatus(payment, to, {data, detail, auditData, action, actor})` asserts the move is legal, then compare-and-swaps on the observed status (`updateMany where {id, status: from}`). Zero rows → `StaleTransitionError` (an `ApiError` with code `conflict`, so `caughtErrorResponse` renders a 409 with no mapping). Audits only after a successful swap. `auditData` replaces `data` in the audit detail when a written column is too large/redundant to log (a quote's full `quoteJson`) |
| [lib/executor.ts](lib/executor.ts) | Orchestrates APPROVED → SETTLED: `withExecutionLease` (the one CAS-claim/finally-release the executor and the repair path share), auto-recall of parked MMF liquidity, liquidity reservation, escrow, FX, payout, and the failure exits — refund while the escrow is held, **compensation** once it is released (`compensateSender`), and `completeSettledPayout` when the recipient was provably paid (a ledger credit, or a destination receipt read back **confirmed** — a persisted `destinationTxHash` alone is an *attempt*, reconciled via `transactionOutcome()` before any undo; unknown outcome stays PAYOUT_PENDING for the operator). `ExecutionLeaseError` (an `ApiError` with code `conflict` → 409, like `StaleTransitionError`) is a second attempt losing the lease. Also the operator-repair half: `stuckPayments()` (payments still holding funds — candidacy off the reservation, not `onchainPaymentId` — each with its escrow state read live) and `repairCompensation()`. `executorTestHooks` are the test-only throw points for every failure exit |
| [lib/routing.ts](lib/routing.ts) | Route quotes (instant/batched/bridged), treasury liquidity checks. Parked MMF liquidity counts as available: free-short-but-parked-covers still quotes, flagged `recall_required`. `availableLiquidity()` is a display wrapper over `treasury.freeTreasuryBalance()` (bigint base units + formatted strings), and `liquidityCheck()`/`destinationUnits()` compare in **token base units** |
| [lib/fx.ts](lib/fx.ts) | Simulated FX, **all bigint**: static mid rates, spread + tiered slippage, platform fee. Amounts are currency **minor units**; rates are integers scaled by `10^RATE_DECIMALS` (18) — `midRate()` returns a scaled bigint, `formatRate()` renders it. `convert()` (minor units across currencies at a rate), `applyBps()` (worsen a rate), `usdEquivalent()` (→ USD minor units, for tiering/risk thresholds) |
| [lib/compliance.ts](lib/compliance.ts) | Compliance gate (KYB, sanctions, wallet/tx/corridor risk) → PASS/FAIL/MANUAL_REVIEW. Sanctions + wallet screening dispatch to real providers when env config is set (`OPENSANCTIONS_API_KEY`, `CHAINALYSIS_ORACLE_RPC_URL`), mocks otherwise |
| `lib/providers/` | Real vendor adapters: OpenSanctions (sanctions match API), Chainalysis sanctions oracle (keyless on-chain `isSanctioned()` read for wallet screening). **Fail-safe: any provider error/timeout → MANUAL_REVIEW, never fail-open.** Verbatim provider evidence persisted on `ComplianceCheck.rawResponse` |
| [lib/audit.ts](lib/audit.ts) | Append-only hash-chained audit log + chain verifier. `audit(action, detail, paymentId, actor, tx?)` — pass the caller's `Prisma.TransactionClient` to enlist the event in the transaction that writes the change it describes. Tip-read-plus-create is serialized with a transaction-scoped Postgres advisory lock (`lockAuditChain`). Also the anchoring half: `createCheckpoint()` (on demand; automatic every `AUDIT_CHECKPOINT_INTERVAL` events, default 100, signed with `AUDIT_ANCHOR_KEY`), `verifyAuditChain()` → `AuditIntegrity` (verdict + `mode`/`anchored`/`checkpoint`/`eventsVerified` coverage), `AuditAnchorError` |
| [lib/auth.ts](lib/auth.ts) | API-key identity: `authenticate(request)` (`x-api-key` header → `sos_key` cookie) → `Principal { keyId, role, entityId?, label }` or null. Roles OPERATOR/REVIEWER/ENTITY; only sha256 hashes are stored. `keyId` is the `ApiKey.id` — the stable per-caller identity anything keyed by principal uses. **Identity only — routes enforce authorization** |
| [lib/idempotency.ts](lib/idempotency.ts) | Idempotent-write records: `beginIdempotent()` (reserve the key or report replay/mismatch/in-flight), `completeIdempotent()` / `abandonIdempotent()`, `hashRequest()` (canonical, key-order-independent body fingerprint), `IDEMPOTENCY_TTL_MS` (24h, checked at read time — no cron). Framework-free; the response half is app/api/idempotency.ts |
| [lib/rate-limit.ts](lib/rate-limit.ts) | In-memory sliding-window limiter: `consumeRateLimit(key, {limit, windowMs, now})` → `RateLimitDecision`, `resetRateLimits()` (test-only). `now` is a **parameter**, so the window is testable without fake timers. Per-process by design — behind >1 instance it becomes a per-instance limit, and the fix is a shared store, not a cleverer Map |
| [lib/pagination.ts](lib/pagination.ts) | The bound on every list read: `parsePageRequest(searchParams)` → `{limit, cursor}` (default 50, max 200, canonical-integer grammar — `Number("1e3")` is 1000, so a regex decides), `toPage(rows, limit, idOf)` (fetch `limit + 1`, the extra row *is* the `has_more` evidence and is dropped), `PaginationError` → a route's 400 |
| [app/api/limits.ts](app/api/limits.ts) | The HTTP half of both: `beginWrite(req, principal)` → `{body}` **or** the 429/413 to return (same narrowing convention as guard.ts), `enforceWriteRateLimit()` for the bodyless writes, `rateLimitKey()` (principal → `key:<keyId>`, else `ip:<addr>` — the address read per `TRUSTED_PROXY_HOPS`, see gotcha), `WRITE_RATE_LIMIT` (30/min, `RATE_LIMIT_WRITES_PER_MINUTE` overrides), `MAX_BODY_BYTES` (64KB) |
| [lib/session.ts](lib/session.ts) | Next-only half of auth: `currentPrincipal()` resolves the `sos_key` cookie via `cookies()` for **server components** (which have no `Request`); `paymentScopeWhere(principal)` is the page-side tenant filter mirroring GET /api/payments; `sessionCookieOptions()` is the one place the cookie's flags are defined. Keep `next/headers` out of lib/auth.ts so route tests can pass a plain `Request`. Pages gate with these + `<AuthRequired>` (components/auth-required.tsx) |
| [lib/treasury.ts](lib/treasury.ts) | Tokenized-MMF treasury ops: `park()` (subscribe unreserved liquidity into the fund), `recall()` (T+0 redeem of a position, principal + accrued yield back to the treasury), `accrueDaily()` (advance the fund index by one day at `MMF_ANNUAL_RATE_BPS`, default 3.5% APY; `dailyIndex()`/`valueOfShares()` are the pure bigint math), `freeTreasuryBalance()` (bigint balance − RESERVED rows), `parkedBalance()` (derived value of ACTIVE positions; `0n`, never a throw, where no fund exists), `recallForPayment()` (FIFO auto-recall for the executor), `TreasuryError` (typed codes for route handlers), `TREASURY_*` audit actions |
| [lib/assets.ts](lib/assets.ts) | Asset metadata, currency↔token mapping, base-unit conversion |
| [lib/money.ts](lib/money.ts) | The amount gate at the API boundary: `parseAmount(amount, currency)` → bigint **minor units** (canonical grammar only — no exponent/sign/whitespace, at most the currency's decimals, ≤15 integer digits, > 0), `formatMinorUnits()` / `canonicalAmount()` for the stored string, `formatScaledUnits()` / `parseScaledUnits()` (the generic halves — any integer scaled by `10^n`, at any precision: FX rates, and reservation strings read back as token base units), `CURRENCY_DECIMALS` (USD/SGD 2, JPY 0), typed `MoneyError`. Framework-free; routes map it to a 400 |
| [scripts/setup.mjs](scripts/setup.mjs) | Local deploy (tokens, escrow, TokenizedMMF + its yield buffer and treasury approval) + DB seed (dev-mnemonic accounts, local only) |
| [scripts/deploy-testnet.mjs](scripts/deploy-testnet.mjs) | Real testnet deploy (base-sepolia / polygon-amoy / fortel2-sepolia via argv): env deployer key, tokens + escrow + TokenizedMMF (yield buffer + treasury approval), per-network gas-dust targets, generated dust wallets, DB registration |
| `app/api/*` | REST route handlers (thin; logic lives in lib/) |
| [app/api/guard.ts](app/api/guard.ts) | Authorization glue: `requirePrincipal(req)` / `requireRole(req, ...roles)` return a `Principal` **or** the `NextResponse` to return (`if (x instanceof NextResponse) return x`), plus `isPlatformRole()` for the OPERATOR/REVIEWER-see-everything check, `authorizePaymentWrite(principal, payment)` for the quote/execute/cancel rule (OPERATOR or the sender; returns the response to send or null), and `actorOf(principal)` for the audit actor. Also the error responses every handler returns: `errorResponse(code, msg?)` / `invalidRequest()` / `conflict()` / `unauthorized()` / `forbidden()` / `notFound()`, and `caughtErrorResponse(e, fallback, context)` for catch paths; `scrubFailureReason(principal, payment)` redacts the failure column and `scrubAuditDetail(principal, events)` the included audit-event detail for tenants. `isPlatformRole` is re-exported from lib/auth (pure, so pages can use it). HTTP concerns live here, not in lib/auth.ts |
| [lib/api-errors.ts](lib/api-errors.ts) | Framework-free error vocabulary: the `ApiErrorCode` union (unauthorized/forbidden/not_found/invalid_request/conflict/idempotency_conflict/execution_failed/internal), the code→status and code→canned-message tables, `ApiError` (throw when a lib wants to pick the client's message), `apiError()`, `fromThrown()` (logs the real error, returns a safe one), `SAFE_FAILURE_SUMMARY`. The NextResponse wrappers live in app/api/guard.ts |
| [app/api/idempotency.ts](app/api/idempotency.ts) | `beginIdempotency(req, principal, route, body)` → an `IdempotentScope` (`complete(res)` / `abandon()`) **or** the `NextResponse` to return (replay / 422 / 409), same narrowing convention as guard.ts. No `Idempotency-Key` header → a pass-through scope, so the wrapper is uniform and the browser demo is unaffected |
| `app/api/treasury/*` | MMF routes: `park`, `recall`, `positions` (GET, derived value per position, **paginated**), `accrue`. Writes are idempotency-wrapped like the payment writes. `errors.ts` holds the single `TreasuryErrorCode` → HTTP status table — add a code there when you add one to lib/treasury |
| `app/liquidity/` | Treasury dashboard. `page.tsx` is a server component (all chain/DB reads, per-network sections); `mmf-card.tsx` is the `"use client"` MMF card — park form, per-position Recall, Accrue demo control — which POSTs to the treasury routes and then `router.refresh()`es |
| `contracts/` | Solidity 0.8.24: `MockERC20` (permissionless mint, by design), `PaymentSettlement` escrow, `TokenizedMMF` (operator-gated share fund for parked treasury liquidity; monotonic index, no cross-calls with escrow) |
| `tests/` | Vitest suite: `unit/` (pure), `db/` (compliance, audit chain), `integration/` (executor E2E, contract, API). Fixture bootstrap in `global-setup.ts` + `helpers/` |
| [lib/mcp/](lib/mcp/) + [app/api/mcp/route.ts](app/api/mcp/route.ts) | Read-only MCP server. The route authenticates with `authenticate()` (`x-api-key`, then the `sos_key` cookie) and serves Streamable HTTP; `lib/mcp/` is the tool half (list/get payments, entities, networks, treasury positions, balances, audit-chain verify). Tenant scoping is a Prisma `where`, the same scrubbers as the REST routes, no write tools. **`server-only`** |

## Invariants — do not break these

- **State machine**: every payment status change must be a legal transition per
  `lib/state.ts`, and must go through `transitionStatus()` (lib/transitions.ts) —
  never a raw `prisma.payment.update({ data: { status } })`, which would clobber a
  concurrent writer. The status the caller passes in *is* the CAS's expected value,
  so a handler must transition from the row it actually read, and the executor's
  `payment = { ...payment, ...(await setStatus(...)) }` assignments are load-bearing:
  drop one and the next transition compares against a stale status and 409s itself.
  A lost race is normal (`StaleTransitionError` → 409), not a bug to retry blindly.
- **One execution attempt per payment**: `executePayment` claims `Payment.executionLeaseId`
  with a CAS (`where { id, status: "APPROVED", executionLeaseId: null }`) *before* it reads
  a chain or moves a token — a second concurrent execute throws `ExecutionLeaseError` having
  touched no chain state. The lease is re-asserted inside the `$transaction` that writes the
  `LiquidityReservation`, so a reservation can never exist without the lease that authorized
  it. `transitionStatus` releases the lease on any `LEASE_RELEASE_STATES` status (lib/state.ts:
  the terminal set + FAILED), and the executor's `finally` is the backstop for throws that never
  reach a transition — a stranded lease locks a payment out of every retry. The status check
  before the claim is *not* what decides the race; the claim is.
- **Audit only what happened, in the same transaction as what happened**: a status
  change is audited *after* its CAS reports a row was updated, and inside the same
  `prisma.$transaction` — a writer that lost the race must leave no event, and a
  domain write that rolls back must take its event with it. An append-only log
  recording a change that never landed is worse than no log at all. So any path
  that writes a domain row *and* an event passes its tx to `audit(..., tx)`
  (`transitionStatus`, treasury `park`/`recall`); only an event that describes no
  row (an export, a quote, the MMF accrual, whose index lives on chain) may take
  the no-tx form. The tip read and the create stay in one transaction, and that
  transaction holds a Postgres advisory lock (`lockAuditChain` /
  `pg_advisory_xact_lock` in lib/audit.ts) for the critical section — that is what
  serializes the chain under READ COMMITTED. SQLite's global write lock used to
  provide this for free; without the advisory lock, concurrent `audit()` calls
  fork on the same `prevHash` and `verifyAuditChain` reports BROKEN.
- **Audit everything**: any state change or fund movement gets an `audit(...)`
  event. The log is append-only — never update or delete `AuditEvent` rows; that
  breaks the hash chain (`GET /api/audit` verifies it, the UI shows INTACT/BROKEN).
- **The anchor is what the chain cannot do for itself**: the hash chain catches a
  naive *edit* (an event no longer hashes to its stored hash), but not an attacker
  with DB write access who re-hashes the log from the tampered event forward — that
  verifies clean. `AuditCheckpoint` signs the tip hash with `AUDIT_ANCHOR_KEY`
  (HMAC, key in the env and never in the DB), so a re-hashed history moves the tip
  to a value the attacker cannot sign. **Verification always re-hashes the whole
  chain from genesis** and the signature is a *second* check layered on top, not a
  shortcut: an edit before a checkpoint leaves the forward links and the signed tip
  untouched, so skipping pre-anchor events (an earlier "incremental" mode did
  exactly this) passed such an edit as INTACT — the one tamper the chain exists to
  catch. So verification is O(events) by necessity; there is no sound way to skip
  reading an event you might have to detect a change in. `verifyAuditChain` returns
  `mode: "full"` always; `anchored` says whether a key/checkpoint added the
  re-hash-attack layer. No key = no checkpoints and `anchored: false`: the demo
  still runs and says out loud that its INTACT is the weaker claim. Residual limit,
  deliberate: deleting the checkpoint rows drops back to chain-only, which a
  re-hash attack passes — closing that needs the anchor published where we do not
  control it.
- **Money types**: fiat amounts are decimal **strings** in the DB and API
  (`"100000.00"`); on-chain amounts are **bigint** base units via
  `toBaseUnits`/`fromBaseUnits`. mockJPY has **0 decimals**. Never put a JS float
  on-chain.
- **Amounts are validated at the boundary, and rejected — never repaired**: a
  client amount enters through `parseAmount` (lib/money.ts), which takes only
  `^[0-9]+(\.[0-9]+)?$` at no more than the *currency's* precision, so `"1e6"`,
  `"Infinity"`, `"+5"`, and `25000.001` JPY never become a `Payment` row. Excess
  precision is a 400, not a truncation: `toBaseUnits` truncates by design (it
  converts amounts already accepted), and silently doing that to a client's
  request would settle a sum nobody asked for. `Payment.amount` is stored in
  canonical form (`canonicalAmount()`: exactly the currency's decimals), so
  everything downstream may assume it. Never gate an amount with `Number(x)` —
  it accepts every one of those inputs. Reading a money string *back* (a
  reservation row, a quoted destination amount) goes through `parseScaledUnits`,
  not `toBaseUnits`: same reject-never-repair rule, at whatever scale the caller
  names. Truncating a reservation *down* under-counts what is already promised.
- **Quoting math is bigint, and it floors**: `lib/fx.ts` never puts a monetary value
  through a JS float — `157.2` is not representable, so `(amount - fee) * rate` drifts
  against the base units actually escrowed. Amounts are minor units, rates are scaled
  integers, and every monetary division **floors, in the platform's favour** (the
  effective rate and the destination amount both round down, so a quote never promises
  a recipient a minor unit the treasury must find). The one exception is the mid-rate
  table's derived inverses, which round to *nearest*: that is data being represented as
  accurately as the scale allows, not a fee — flooring there would bias every inverted
  corridor down (157,200 JPY would round-trip to $999.99). `Number()` in fx.ts is for
  bps constants only.
- **Per-network accounts**: operator/treasury/entity addresses differ per network.
  Always resolve via `accountsFor(networkId)` and look up entity wallets by
  `wallet.network` (with `wallets[0]` fallback) — never assume one shared address
  set. Signing keys resolve inline (generated dust wallets) or via `privateKeyEnv`
  → `.env` (funded keys). Funded keys must never be written anywhere but `.env`.
- **Key custody has one seam, and runtime is not deploy-time**: nothing at runtime
  reads a private key out of `process.env` or hands one to viem — a write resolves
  `signerFor(ref, role)` (lib/signers.ts) and passes the `Signer` to
  `walletFor(networkId, signer)`. Adding a `privateKeyToAccount` call anywhere else
  re-opens the seam this exists to close: swapping custody to a KMS/HSM must be one
  new `Signer` implementation (`KmsSigner` is the stub that marks the spot), not an
  audit of every call site. The **deploy** half is deliberately separate and stays
  that way: `scripts/*.mjs` read `DEPLOYER_PRIVATE_KEY` straight from the
  environment and cannot import this layer (they are `.mjs`, and it is
  `server-only`). Today a live network's operator ref still *points at*
  `DEPLOYER_PRIVATE_KEY` — the deployer is the on-chain operator those contracts
  were deployed with, so re-keying it needs an on-chain grant, not just a config
  edit. A production deployment gives the runtime operator its own key or a
  `kmsKeyId`; that ref is the only thing that changes.
- **Chain/key/money modules are `server-only`**: lib/chain.ts, lib/signers.ts,
  lib/treasury.ts, and lib/executor.ts import `server-only`, so a client component
  that reaches them fails `npm run build` rather than shipping deployment records
  and `.env` reads to a browser. lib/networks.ts is the client-safe half and must
  stay that way — anything a `"use client"` file needs about a network belongs
  there. (Tests alias the marker away; see the gotcha.)
- **Secrets**: `.env` and `chain/deployments*.json` are gitignored and must stay
  out of git. Never use the Hardhat dev-mnemonic keys on a public network; never
  put a mainnet key anywhere in this project.
- **Public RPC resilience**: anything that reads a real-network RPC must degrade
  gracefully (see balances route / liquidity page pattern) — one flaky endpoint
  must not 500 a whole page.
- **No API route is anonymous** except `/api/networks` (static registry) and
  `/api/auth/*` (the login exchange itself): every handler starts with a
  `requirePrincipal`/`requireRole` guard. Errors stay generic and leak nothing —
  anonymous and invalid keys get the same 401, and a tenant asking for another
  tenant's row gets a **404, never a 403**, so no response confirms an id exists.
- **A thrown error never reaches a client**: every API error body is
  `{ error_code, message }` where `error_code` is one of the stable codes in
  `lib/api-errors.ts`. A message is only shown if a route *chose* it
  (`invalidRequest("unsupported currency")`, `conflict(...)`, a `TreasuryError`);
  a **caught** error goes through `caughtErrorResponse(e, fallback, context)`,
  which `console.error`s the real thing server-side and answers with a canned
  message. Never `(e as Error).message` in a handler — executor/prisma/viem errors
  carry contract addresses, RPC URLs, and revert data.
- **`Payment.failureReason` is operator detail**: the row keeps the full reason, but
  reads scrub it to a fixed summary for ENTITY callers (`scrubFailureReason` in
  guard.ts, applied in both the list and detail routes). It names treasury balances
  and networks a tenant has no business seeing.
- **The audit actor comes from the key, never the body**: a route audits with
  `actorOf(principal)` (`"<label> (<ROLE>)"`) — a request field naming an actor would
  be a forgeable signature, so no handler accepts one. Events raised by the executor
  or lib/treasury on their own initiative stay `"system"`: that is the machine acting,
  not a caller.
- **Write authorization by role**: payments are driven by the OPERATOR or the *sender*
  (`authorizePaymentWrite`); REVIEWER decides manual reviews (`/review`) and never
  originates or executes; recipients may watch but not move a payment; treasury
  park/recall/accrue and entity onboarding are OPERATOR-only platform actions.
- **Tenant scoping is a query filter, not a post-filter**: an ENTITY principal's
  reads are narrowed in the `where` clause (`isPlatformRole(p) ? {} : { ... }`),
  so a row it may not see is never loaded and cannot leak through a count, an
  aggregate, or a forgotten field. Included relations count too: the payment-detail
  route redacts `auditEvents[].detail` for tenants (`scrubAuditDetail`), because the
  same operator diagnostics scrubbed from `failureReason` also ride inside the audit
  events transitionStatus merges the failed transition's columns into.
- **Server components gate themselves — the API filter does not cover them**: a
  page reads Prisma directly (no `Request`), so tenant isolation lives in the page,
  not a shared route guard. Every page resolves `currentPrincipal()` (lib/session)
  and either scopes its reads (`paymentScopeWhere`, or `id: principal.entityId` for
  entities) or gates to a platform role, rendering `<AuthRequired>` otherwise —
  dashboard/compliance/liquidity are platform-only; payments/entities scope per
  tenant. A page that reads a domain table without one of these renders every
  tenant's data to whoever asks (the `/payments/stuck` page was the original
  template for the check).
- **Compliance fail-safe**: a screening that cannot be performed (provider
  error, timeout, malformed response) resolves MANUAL_REVIEW — never PASS.
  Mocks stay the default when no provider env keys are set, so demos work
  offline; real-provider results must persist the verbatim vendor response on
  `ComplianceCheck.rawResponse` (audit evidence).
- **MMF segregation**: parked treasury funds live in `TokenizedMMF` and never pass
  through `PaymentSettlement` — the two contracts make no cross-calls and hold
  separate asset balances. The share index is monotonic (`accrue` reverts on any
  decrease), so a parked position can never lose value.
- **Idempotency is reserve-then-stamp, never check-then-write**: the first request
  *creates* the `IdempotencyRecord` — the unique index on `(principalId, key)` is what
  decides the race — then stamps its response onto the row it owns. A check-then-write
  would let two duplicates both pass the check. A duplicate therefore always finds a
  row: unstamped → 409 in-flight, stamped → replay, different body/route → 422. The
  scope wraps the **whole** handler, so a retry replays whatever the first call
  answered (including its errors); only a *throw* abandons the key, since an unknown
  outcome must stay retryable.

- **Every write is rate-limited and size-capped, after the auth check**: a write
  handler's second move (once it has a principal) is `beginWrite(req, principal)`
  — 30 writes/min per principal and a 64KB body, or the 429/413 it hands back.
  The order is load-bearing twice over: **after** auth, so the limiter counts
  against the `keyId` rather than an `x-forwarded-for` anyone can retype; and
  **before** the body is read or a row is touched, so a refused write reaches no
  DB and no chain. A refused hit is deliberately *not* recorded, or a caller
  hammering the limit would push its own window forward forever and never
  recover. The IP fallback exists for the one endpoint with no principal yet
  (`/api/auth/login`, where key-guessing would go) and is best-effort — that is
  why it is the fallback and not the key. Content-Length is a free first check
  but never the enforcement: the body stream is measured as it arrives and
  cancelled at the cap, because a client sets that header.
- **Every list read is bounded, and the cursor is tiebroken**: every collection
  route — `GET /api/payments`, `/api/audit`, `/api/entities`, `/api/treasury/positions`
  — pages through `parsePageRequest`/`toPage` (default 50, max 200); an unbounded
  `findMany` over a table that only grows is a denial of service a caller need not
  even intend. A limit past the cap is a **400, not a clamp**: clamping quietly
  answers a different question than the one asked. Ordering ends in `id`
  (`[{createdAt: "desc"}, {id: "desc"}]`), since `createdAt` is not unique and an
  unstable sort makes a walk skip or repeat rows. Two more traps the routes close:
  a cursor is validated (a non-numeric or out-of-Int-range `/api/audit` cursor is a
  400, not a Prisma 500), and a **tenant's** cursor must resolve inside its own
  scope first (`findFirst` with the tenant filter) — Prisma positions the cursor by
  id regardless of the `where`, so without that check a foreign id would page while
  a nonexistent one returned empty, an existence oracle the 404-not-403 rule exists
  to deny. Tenant scoping stays a `where` filter, so a page is never silently short.
- **Exports are bounded by a range, and audited once**: the reconciliation CSV
  takes `from`/`to` and defaults to the last 30 days. One
  `reconciliation.exported` event per export naming the range and the row count —
  never one per row, which would bury the chain in noise proportional to the
  table (AUDIT.md). A bare `YYYY-MM-DD` upper bound means the **whole day**: read
  as an instant it is that day's midnight, which silently drops everything
  exported-for made since.
- **API shape**: JSON request/response fields are `snake_case`; Prisma models are
  `camelCase`. Keep route handlers thin.
- **Reserved liquidity is untouchable, and "free" is defined once**: only the treasury
  balance minus RESERVED `LiquidityReservation` rows (`freeTreasuryBalance()`, lib/treasury)
  may be parked in the MMF — liquidity promised to an in-flight payment can never be swept
  into the fund. That function is the *only* implementation of that subtraction: routing's
  `availableLiquidity()` and the executor's reservation guard wrap it rather than sum the
  same rows again, because a second implementation is a second rounding rule, and a park and
  a payment must never both be told the same liquidity is theirs. Every comparison is bigint
  **token base units** — a currency's minor units are a different scale (USD counts cents,
  mockUSDC counts millionths), so cross the two only through a canonical string
  (`destinationUnits()`), never a bare number compare.
- **Positions are append-only history**: `recall()` flips a `TreasuryPosition` to
  RECALLED in place (status + `recalledAt` + `txHashRecall`); rows are never deleted,
  and a position's current value is always *derived* (`shares × live index`), never
  stored mutably on the row.
- **Never refund a released escrow; compensate it**: `settlePayment` moves the sender's
  money to the treasury, so a failure *after* it cannot call `failAndRefund` (the escrow
  row is SETTLED — the call reverts "not initiated"), and must not just mark the payment
  FAILED either, which would strand the sender's funds. It goes PAYOUT_PENDING →
  COMPENSATION_PENDING → treasury-funded transfer of the **source** asset back to the
  sender's wallet on the **source** network → COMPENSATED. A compensation transfer that
  itself fails leaves the payment in COMPENSATION_PENDING for an operator, never FAILED.
- **Compensate only when the recipient was *not* paid; otherwise complete forward**:
  once the destination payout has landed, the recipient has the money and
  compensating the sender would pay twice out of treasury. Cross-chain, the payout
  hash is persisted **on submit** (`destinationTxHash`, before the receipt is
  awaited — audit `bridge.destination_payout_submitted`), so the hash proves an
  *attempt*, not a payment. The executor's catch resolves it with
  `transactionOutcome()` on the destination chain *before* the escrow
  reconciliation below: **confirmed** → `completeSettledPayout` (create the ledger
  credit if missing, consume the reservation, mark SETTLED — never
  `compensateSender`); **reverted** → fall through to compensation; **unknown**
  (receipt unreadable — includes a tx still in the mempool; viem throws on a
  missing receipt, so "absent" is deliberately near-unreachable live, see the
  comment on `transactionOutcome`) → stay PAYOUT_PENDING, audit
  `payment.destination_payout_unresolved`, keep it in `stuckPayments()` — never
  auto-compensate and never auto-complete on unknown evidence. Same-chain routes
  never set `destinationTxHash`; the ledger credit alone is the proof there.
  `repairCompensation` re-checks the same outcome and refuses (409) on
  confirmed/unknown rather than double-paying.
- **Reconcile with the chain before undoing anything**: the executor's catch decides
  refund-vs-compensate from `onchainPaymentState()` (the escrow's own `getPayment`), not
  from the DB status — they disagree exactly when a step threw mid-flight, which is the
  only time this path runs. The DB says what the attempt *tried*; the chain says what
  landed. When the read itself fails, the DB status is the fallback — and a
  *post-settlement* status (FX_OR_SWAP_COMPLETED/PAYOUT_PENDING) is decisive on its
  own: those transitions only happen after `settlePayment` confirmed, so an
  unreadable escrow there means "released" → compensate, never FAILED (which would
  strand the sender, since compensation is unreachable from FAILED).
- **A stranded payment must stay visible**: `stuckPayments()` answers "who is still
  holding a sender's funds" from the DB *and* the chain — a FAILED payment is only
  really finished if its escrow refunded. Candidacy keys off having a
  `LiquidityReservation` (created immediately before `initiatePayment`), **not**
  `onchainPaymentId`: a receipt that times out leaves the escrow held with that
  column still null, and keying off it hid exactly that stranded payment. The
  escrow id is recomputed deterministically from `payment.id`, so the DB column is
  never the signal. An escrow read that fails degrades to `escrowState: null` and
  the payment is **kept**; only INITIATED/SETTLED/null keep it, while NONE (a
  reservation whose escrow tx reverted before mining) and REFUNDED are done —
  unknown is not the same as fine, and a flaky RPC must never make a stranded
  payment vanish from the one view that would surface it.
- **Repairing is not retrying**: `repairCompensation()` re-sends real money, so it
  claims the same execution lease (CAS on COMPENSATION_PENDING + `executionLeaseId`
  null), re-reads the escrow (only a *released* escrow may be repaid from treasury),
  and returns an already-COMPENSATED payment untouched rather than paying twice.
  Nothing retries a compensation automatically — that decision is an operator's.
- **No standing allowances**: an entity wallet grants the escrow *exactly* the amount
  of the payment in flight, immediately before `initiatePayment` (`ensureSenderAllowance`,
  lib/chain.ts), which then consumes it back to zero. Nothing pre-approves — not
  `scripts/setup.mjs`, not `scripts/deploy-testnet.mjs`, not the test fixture — because a
  MAX approval leaves a wallet's whole balance drainable by whatever the escrow address
  turns out to be, forever, while an exact one caps the loss at one payment. An allowance
  that already covers the amount short-circuits with no tx, so networks deployed before
  this (their wallets still hold the old MAX grants) keep settling untouched. The treasury's
  MMF approval is a different thing and stays MAX: the treasury is the platform's own account,
  not a customer's. Consequence: an entity wallet now signs a tx per payment, so it needs
  runtime gas (dust budget on a real testnet) and its **signing key must resolve** —
  `accountsFor(networkId).entityWallets[externalId]`, keyed by `Entity.externalId`.
- **Recall before reserve**: when a route carries `recall_required`, the executor
  redeems the parked positions *before* it reserves liquidity or escrows anything —
  otherwise it would reserve against a balance that is still sitting in the fund.
  A failed auto-recall fails the payment (APPROVED → FAILED) with nothing escrowed.

## Gotchas

- **Calling `audit()` without a `tx` from inside an open `prisma.$transaction` deadlocks.**
  It opens its own transaction on another connection, which under Postgres waits on
  the advisory lock (or on row locks) held by the outer transaction — the symptom is
  every test in the file timing out at ~5s, not an error naming a lock. Thread the tx
  through.

- `audit()` JSON-stringifies its detail, and `JSON.stringify` **throws on a bigint**.
  Convert base units to strings (`.toString()` / `fromBaseUnits`) before putting them
  in an audit detail.

- **Deleting a Payment silently breaks the audit chain.** `AuditEvent.payment` is an
  optional relation, so Prisma's default `SetNull` NULLs `paymentId` on the payment's
  events — and `paymentId` is inside the event hash, so every later event fails
  verification and the whole suite goes BROKEN. A test that cleans up payments it
  created must skip any that got audited (see `tests/integration/authz-writes.test.ts`);
  leaking a few rows is cheaper than a broken chain. Same reason the log is append-only
  in production.

- **Wiping `AuditEvent` without `AuditCheckpoint` leaves a dangling anchor**, and the
  chain then reads BROKEN (`checkpoint_anchor_missing`) forever after — an anchor
  pointing at an id that no longer exists is indistinguishable from deleted history,
  which is the whole point. Anything that clears the log clears both, in that order:
  `scripts/setup.mjs`'s reset (this bit the demo — the reset button handed the app a
  BROKEN chain), and the two test files that own the table (`tests/db/audit.test.ts`,
  `tests/db/audit-checkpoint.test.ts`). Note Postgres sequences (like SQLite's
  autoincrement) do **not** restart at 1 after a wipe — never infer a count from an
  id (that is why the checkpoint interval counts rows rather than subtracting ids).

- `recall_required` is a **quote-time snapshot** frozen into `Payment.quoteJson`. The
  world can move between quoting and execution, so nothing downstream may assume it is
  still accurate: `recallForPayment()` is a no-op when the free balance already covers
  the amount, and the executor's existing insufficient-liquidity check still runs after
  the recall. Import direction is routing → treasury (never the reverse) — treasury
  must not import routing or the module graph cycles.

- Advancing the MMF index does **not** add asset to the fund: simulated yield is
  paid out of a buffer that must be funded separately (mint mock asset to the MMF
  address). An underfunded buffer makes `redeem` revert rather than shortchange a
  redeemer — fund it wherever the MMF is deployed. `scripts/setup.mjs`,
  `scripts/deploy-testnet.mjs`, and the test fixture each mint a 50,000 mockUSDC
  buffer and have the **treasury approve the fund** (`subscribe` pulls via
  `transferFrom`); a new deploy target must do both or parking reverts.
- **Accrual is one-way.** `accrueDaily()` raises the share index, and the contract
  reverts on any decrease — there is no "un-accrue". So an accrued fund is accrued for
  good: after one, a park→recall round-trip returns *more* than the principal (assert
  `>=`, not `==`), floor division can shave a base unit of dust off a re-subscribed
  position, and tests sharing the fixture fund must assert index/share invariants rather
  than par. Vitest does not guarantee file order (it is sequential, not alphabetical), so
  *any* test file that accrues raises the index for every other file: derive expected
  amounts from the live index (`valueOfShares(shares, index)`), never from par.
- The MMF is deployed **per network**. Local chains always get one (`scripts/setup.mjs`);
  live networks get one from `scripts/deploy-testnet.mjs` (base-sepolia / polygon-amoy /
  fortel2-sepolia — F4). Resolve it with `mmfAddress(networkId)` from `lib/chain.ts`,
  which returns `undefined` (never throws) where no fund exists — overlays written
  before F4 still lack `TokenizedMMF`. Treat "no MMF here" as a normal state to
  degrade to, not an error.
- The `server-only` marker is enforced by the **bundler**, so two things follow.
  (1) `npm test` would die at import time without help — outside a React Server
  Components bundle the package resolves to a bare `throw` (its `react-server`
  export condition is what swaps in the empty module), so vitest.config.ts aliases
  it to `tests/stubs/server-only.ts`. (2) An **unused** import of a server-only
  module gets tree-shaken and the build stays green — a violation only surfaces
  once the imported symbol is actually referenced. So proving the guard works
  means calling the thing, not just importing it.
- Interactive pages keep chain/DB reads in the **server** component and pass plain
  serializable props to a `"use client"` child that owns the buttons (see
  `app/liquidity/`). The child POSTs to an API route, then calls `router.refresh()`,
  which re-renders the server parent and flows **new props** down — so never copy a
  server prop into `useState`, or the view goes stale after a mutation. (The payment
  pages predate this and fetch client-side instead; both patterns exist.)
- **`x-forwarded-for` is client-settable, and Next only fills it from the socket when
  it is absent** (`req.headers['x-forwarded-for'] ??= socket.remoteAddress`) — so the
  leftmost entry, the obvious one to read, is the one an attacker controls. The
  address-keyed limit on `POST /api/auth/login` (the only principal-less write) reads
  `TRUSTED_PROXY_HOPS` from the right of the list instead: with N proxies of ours, the
  Nth-from-right entry is the last one our own infrastructure wrote. Unset → the old
  best-effort leftmost read, which is what local demos want. Anything keyed on a
  principal is unaffected — a caller cannot rotate its API key.
- **A stored `Payment.amount` is not automatically canonical.** Rows written before
  the money gate passed only `Number(amount) > 0`, so a pre-gate DB can hold `"1e5"`
  or `"100.001"`; `lib/money` rejects all of them. Anything that acts on a payment
  must validate the amount *before* it moves the status — the execute route does, and
  the reason is that a `MoneyError` raised mid-gate strands the payment in
  COMPLIANCE_PENDING, which execute will not resume from (cancel is the only way out).
  Fail while the row is still QUOTED.
- Addresses read back from a contract are EIP-55 checksummed, but
  `chain/deployments*.json` stores them lowercase. Lowercase both sides before
  comparing, or the assertion fails on case alone.

- `npm run setup` **wipes the database** (payments, audit log, entities, parked MMF
  positions) and redeploys the local chains. Real-testnet contracts/wallets survive;
  their entity wallets are re-registered from `chain/deployments.<network>.json`.
- There is **no Prisma migrations directory** — the schema is applied with
  `prisma db push`, which `npm run setup` runs (alongside `prisma generate`) before
  seeding. After editing `prisma/schema.prisma`, `npm run setup` is what brings the
  dev DB and client in sync; the test fixture pushes the schema itself in
  `tests/global-setup.ts`. Seeded demo entities are defined **twice** — in
  `scripts/seed-entities.mjs` (imported by `scripts/setup.mjs` and
  `scripts/seed-demo.mjs`) and in `ENTITIES` in `tests/helpers/deploy.ts` —
  keep those two in sync when adding entity fields. Remote/non-destructive
  seed is `npm run seed:demo` (never `npm run setup` on Render). Overlay path
  resolution for the app and that seed is the single module
  `lib/overlay-paths.mjs`.
- **API keys are seeded, never stored raw.** `npm run setup` generates one OPERATOR,
  one REVIEWER, and one ENTITY key per entity, prints them once, and writes them to
  gitignored `chain/dev-api-keys.json` — the DB only ever holds sha256 hashes, so a
  lost key is regenerated by re-running setup, never recovered. `scripts/setup.mjs`
  is `.mjs` and **cannot import `lib/auth.ts`**, so it carries its own copy of the
  key format + `hashKey`; changing either in `lib/auth.ts` means changing it there
  too, or every seeded key silently stops resolving. Tests use fixed keys
  (`API_KEYS` in `tests/fixture.ts`, seeded by `tests/global-setup.ts`) the same way
  they use the dev mnemonic.
- **Signing in is how the browser demo gets an identity**: `/login` POSTs a raw key to
  `/api/auth/login`, which sets the httpOnly `sos_key` cookie that `authenticate()`
  already reads. Reseeding keys (`npm run setup`) invalidates live sessions — the old
  cookie resolves to null and the shell falls back to "not signed in", which is the
  intended fail-closed behaviour, not a bug. Because the root layout awaits
  `currentPrincipal()`, **every page is dynamically rendered**; anything added there
  must tolerate an anonymous principal, since `/login` itself renders in that shell.
- `chain/deployments.json` (local) and one `chain/deployments.<network>.json`
  overlay per live network (real testnets) are merged at read time by
  `loadDeployments()`. The app only offers networks present in the merged result
  (`/api/networks`).
- Local chains mine instantly; Base Sepolia and Polygon Amoy have ~2s blocks.
  Execution is synchronous by design (a settled payment ≈ 8–10s on a real testnet).
- **Public RPCs are load-balanced replicas**: a write that depends on state from a
  just-confirmed tx can be gas-estimated against a node that hasn't seen that block
  yet and revert (seen live: `settlePayment` → "not initiated" seconds after the
  escrow confirmed, and the auto-refund failed the same way). `operatorWrite` wraps
  state-dependent calls in `retryOnReplicaLag` (lib/chain.ts); use it for any new
  call that reads state written by a previous tx. The retry budget is
  network-aware (`replicaLagRetries`): 4×2s on load-balanced public testnets,
  **0 on `fortel2-*` and local chains** — a single-sequencer rail has no replicas,
  so "not initiated" there is a real failure that should surface immediately, not
  after ~8s of retries. Local single-node chains can never reproduce the lag —
  it only shows up live.
- Re-running a `deploy:*` script is **mode-aware** (auto-detected from the
  network's overlay): no overlay → full deploy; overlay with escrow + tokens but
  no `TokenizedMMF` → **MMF add-on** (fund + yield buffer + treasury approval
  merged into the existing overlay, escrow/tokens untouched); overlay already
  carrying a fund → **no-op**. So a full redeploy of fresh contracts now requires
  moving the overlay aside first (wallets in it are reused wherever possible).
  `--preflight-only` prints the detected mode and planned actions without sending
  a transaction — run it before any live deploy. Add-on idempotency is
  **mode-level only**: a run that dies between the fund deploy and the overlay
  merge leaves an orphaned fund a re-run won't reuse (decisions log T2-2).
- **`--adopt` is the escape hatch when the overlay is gone but the contracts and
  `DEPLOYER_PRIVATE_KEY` survived.** Auto-detect would choose `full` and
  redeploy — never run a bare `deploy:*` against a network whose escrow is
  already live at the documented address. Adopt is explicit
  (`node --env-file=.env scripts/deploy-testnet.mjs <network> --adopt`): it
  bytecode-verifies every address in `ADOPTABLE_NETWORKS`, generates **new**
  treasury/entity wallets, mints demo balances, runs the MMF add-on when the
  registry has no fund, and writes a fresh overlay. See
  [tasks/runbooks/adopt-base-sepolia.md](tasks/runbooks/adopt-base-sepolia.md).

### Where addresses come from, and when they change

| Kind | Source | Changes when |
|---|---|---|
| `PaymentSettlement`, mockUSDC / mockJPY / mockSGD | Deployed once per network by `deploy-testnet.mjs` (full mode). Same deployer nonce sequence → **same addresses across Base Sepolia / Amoy / ForteL2** — a documented property, not a coincidence. | A **full redeploy** (new deployer nonce history, or a different key) invalidates them and orphans every cited tx hash / explorer link. |
| Operator | `DEPLOYER_PRIVATE_KEY` in `.env` — the EOA that deployed the contracts is the on-chain operator. | Re-keying needs an **on-chain grant**, not a config edit. Adopt keeps this address. |
| Treasury + entity wallets | `generatePrivateKey()` at deploy/adopt time; private keys live only in the gitignored `chain/deployments.<network>.json` overlay (or `TREASURY_PRIVATE_KEY` in `.env`). | Losing the overlay loses **only these keys**. Contracts and the operator key are unaffected. `--adopt` generates replacements; do not reuse or sweep the old addresses. |
| `TokenizedMMF` | Per-network; added by full deploy or MMF add-on / adopt when missing (Base Sepolia's 2026-07-07 deploy predates F4). | A new fund address on add-on/adopt; escrow/tokens stay put. |
| ForteL2 Phase 7/8 **re-genesis** | Wipes the L2 state. Every ForteL2 contract address above expires, including the backed-up overlay's contract entries. The settlementos-explorer repo's address book (**11 ForteL2 rows**) becomes wrong on a public site and must be republished. After re-genesis: deploy or `--adopt` with a new `ADOPTABLE_NETWORKS` entry, then update the explorer book. Generated wallet keys in any old ForteL2 overlay backup are then worthless for signing on the new chain even if the files survive. |
- A test that drives `initiatePayment` **directly** (rather than through the executor)
  must approve the sender's tokens itself — no fixture wallet carries a standing
  allowance any more. See `approveAmount()` in tests/integration/contract.test.ts.
- **ForteL2's 1-wei tip is pinned because the node suggested our own tip back
  to us.** Measured on `pay_4bf481cdc9ea` (2026-08-13), with no fee configured
  by SettlementOS: `eth_maxPriorityFeePerGas` returned 1,000,000 wei (op-geth
  GPO default; no `--gpo.*` flags), `eth_gasPrice` 1,000,251 wei, L2
  `baseFeePerGas` 251 wei, sequencer `--miner.gasprice` 1 (1 wei is the
  accepted floor), and `effectiveGasPrice` on our settlements was exactly
  1,000,251. viem asked the node and used the answer. `priorityFeeFor()`
  therefore returns `1n` on `fortel2-*` rather than `0n` (zero risks rejection
  at the sequencer floor) or leaving that 1,000,000-wei estimate in place.
  ForteL2 has not changed the GPO default (deliberate, while they size the
  spam question for future clients).
- Polygon Amoy enforces a ~30 gwei minimum gas price (Base Sepolia is sub-gwei),
  so Amoy gas-dust targets in the deploy script are ~100× higher.
  `priorityFeeFor` is undefined on Amoy (and Base Sepolia) for the same reason:
  a ForteL2-style 1-wei tip there would sit unmined rather than error.
- **The rate limiter is per-process, and the whole test suite shares one.** At the
  real 30/min the operator key would 429 whichever file happened to run after the
  busy ones — a failure that looks like a bug in the test that lost. `FIXTURE_ENV`
  pins `RATE_LIMIT_WRITES_PER_MINUTE` effectively off; a test that wants the limit
  lowers it *and* calls `resetRateLimits()`, then restores both
  (`withWriteLimit()` in tests/integration/limits.test.ts). Same trap for anything
  else built on module-level state.
- **Security headers come from `next.config.ts`'s `headers()`**, so they are on
  pages *and* API routes but only from a **running server** — a route handler
  called directly in vitest returns a bare NextResponse with none of them. Verify
  headers with curl against `npm run dev`, not with a route test. The CSP still
  carries `script-src 'unsafe-inline'` because the App Router bootstraps hydration
  with inline scripts; removing it needs a per-request nonce threaded from
  middleware, and `'unsafe-eval'` is dev-only (react-refresh).
- A **stale `.next/` cache** can make every API route 404 while pages still render
  (seen live after a branch's worth of route changes: `/api/networks` 404'd too).
  `rm -rf .next` and restart before believing a 404 you cannot explain — the routes
  were fine.
- Two Hardhat configs: `hardhat.config.cjs` (+ `.polygon.cjs` for chainId 31338).
  Artifacts land in `chain/artifacts/` (gitignored); `npm run compile` before
  anything that reads them.
- The cross-chain "bridge" is simulated: escrow + FX on the source chain, then a
  treasury-funded ERC-20 payout on the destination chain. Not lock-and-mint.
- **MCP is not a second identity path.** `POST /api/mcp` calls `authenticate()`
  like every other route — `x-api-key` then the `sos_key` cookie. There is no
  `MCP_API_KEY`, and `Authorization: Bearer` is ignored. Clients that can only
  send a Bearer token (Claude/ChatGPT connectors) will 401 until an OAuth
  follow-up; Cursor and other clients that set custom headers work today. The
  transport is `WebStandardStreamableHTTPServerTransport` (JSON, stateless): the
  Node `StreamableHTTPServerTransport` wrapper pulls in Hono's
  `getRequestListener`, which overwrites global `Response` and breaks every
  other App Router route. Streamable HTTP also requires
  `Accept: application/json, text/event-stream` on POST.
- **A recorded overlay is not proof the contracts are still there, or still
  those contracts.** `decideDeployMode()` is pure — it only reads the overlay
  slice — so a post-re-genesis overlay still resolves `noop`/`mmf_addon` while
  every recorded address is empty or, worse, a *different* token (same CREATE
  slot, later deployer nonce → non-empty bytecode of the wrong type). Non-adopt
  paths therefore bytecode-verify every recorded address and check each token's
  on-chain `decimals()` against the overlay *before* `--preflight-only` returns.
  Empty or wrong-identity → abort (do not auto-escalate to `full`); the remedy
  is moving `chain/deployments.<network>.json` aside. `--force-full-deploy` does
  not bypass this gate. `--adopt` already had the presence half; it does not
  check decimals.

## Cursor Cloud specific instructions

The startup update script runs `npm install`, ensures a gitignored `.env` exists
with a local Postgres `DATABASE_URL` (`?schema=settlementos` — see `.env.example`),
and runs `npx prisma generate`. Everything below is per-session service startup the
agent does by hand — do not add it to the update script.

- **Postgres is required.** Install/start Postgres **16** on loopback before `npm run
 setup` or `npm test` (same major as CI and Render — see the pin rule under Run &
 verify). Create an empty database (e.g. `settlementos_dev`) and set
 `DATABASE_URL="postgresql://USER@127.0.0.1:5432/settlementos_dev?schema=settlementos"`.
- **`.env` is required and gitignored** (never committed), so it does not persist in
  the repo across fresh VMs — the update script recreates it. The app, `npm run
  setup`, and `npm run dev` all fail without `DATABASE_URL`. `npm test` builds its
  own ephemeral database (admin URL `SETTLEMENTOS_TEST_PG_URL`, defaulting to
  `postgresql://127.0.0.1:5432/postgres`) and never uses the dev DB. No other secrets
  are needed for the local demo (real testnets and real compliance providers are
  optional — see README).
- **To run the app end-to-end**, both local Hardhat chains must be running *before*
  `npm run setup` (see README "Quick start" / AGENTS "Run & verify"): start `npm run
  chain` (:8545) and `npm run chain:polygon` (:8546) as long-lived processes (use
  tmux), then `npm run setup` (compile + `prisma db push` + deploy + seed; refuses
  non-localhost URLs), then `npm run dev` (:3000). Deployed environments use
  `npm run db:deploy` instead of setup's `db push`. `npm run setup` prints seeded API
  keys and also writes them to gitignored `chain/dev-api-keys.json` — sign in at
  `/login` with the OPERATOR key, or pass it as the `x-api-key` header to the API.
- **Hello-world smoke test** (verified working): create → quote → execute a payment
  (ACME US Inc → Tokyo Trading KK, `100000.00` USD→JPY, both networks `base-local`)
  reaches `SETTLED` with real on-chain escrow/settlement tx hashes; `GET /api/audit`
  reports the chain INTACT.
- `npm test` needs local Postgres but neither the dev chains nor `npm run setup` —
  see AGENTS "Tests".
