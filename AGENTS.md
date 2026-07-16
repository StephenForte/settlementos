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
npm run chain             # base-local    → :8545, chainId 31337
npm run chain:polygon     # polygon-local → :8546, chainId 31338
npm run setup             # deploy to both local chains + reset/seed DB (the reset button)
npm run dev               # app on :3000
npm run deploy:base-sepolia   # real testnet deploy (needs funded DEPLOYER_PRIVATE_KEY in .env)
npm run deploy:polygon-amoy   # same, for Polygon Amoy (deployer needs POL there)
npm test                      # full suite — no chains/DB needed, builds its own fixture
npx tsc --noEmit && npm run lint
```

**Tests**: `npm test` is fully self-contained — it compiles contracts, boots two
Hardhat nodes on test-only ports (9545/9546), deploys to them, and builds a fresh
SQLite DB under `tests/.tmp/` (never touching dev chains, `chain/deployments*.json`,
or the dev DB). Layers: `tests/unit/` (state machine, FX, base units, explorer
URLs, provider adapters with stubbed fetch), `tests/db/` (compliance matrix —
mock and real-provider modes, audit-chain tamper detection),
`tests/integration/` (executor E2E on-chain, PaymentSettlement contract behavior,
API route validation, MMF guardrails + escrow segregation). CI runs typecheck + lint + tests on every push/PR
(`.github/workflows/ci.yml`). **Add tests for new lifecycle, compliance, or
chain behavior** — and still smoke-test UI-visible changes by hand via the flow
in README "API". `npm run setup` resets DB + local chains at any time; it
re-registers real-testnet wallets and never touches the public testnet deployments.

## Architecture map

| Module | Responsibility |
|---|---|
| [lib/networks.ts](lib/networks.ts) | Network registry (local sims + real base-sepolia and polygon-amoy), explorer URL helpers. **Client-safe — no node imports, no secrets.** |
| [lib/chain.ts](lib/chain.ts) | viem chain adapter. Loads/merges `chain/deployments*.json`, per-network accounts via `accountsFor()`, contract ABIs (`SETTLEMENT_ABI`, `MMF_ABI`), `operatorWrite()` (escrow) / `mmfOperatorWrite()` (fund), `treasuryTokenTransfer()`, `ensureTreasuryAllowance()`, `mmfAddress()` (undefined where no fund is deployed) |
| [lib/state.ts](lib/state.ts) | Payment lifecycle state machine; `assertTransition()` enforces legal moves |
| [lib/executor.ts](lib/executor.ts) | Orchestrates APPROVED → SETTLED: auto-recall of parked MMF liquidity, liquidity reservation, escrow, FX, payout, refund-on-failure |
| [lib/routing.ts](lib/routing.ts) | Route quotes (instant/batched/bridged), treasury liquidity checks. Parked MMF liquidity counts as available: free-short-but-parked-covers still quotes, flagged `recall_required` |
| [lib/fx.ts](lib/fx.ts) | Simulated FX: static mid rates, spread + tiered slippage, platform fee |
| [lib/compliance.ts](lib/compliance.ts) | Compliance gate (KYB, sanctions, wallet/tx/corridor risk) → PASS/FAIL/MANUAL_REVIEW. Sanctions + wallet screening dispatch to real providers when env config is set (`OPENSANCTIONS_API_KEY`, `CHAINALYSIS_ORACLE_RPC_URL`), mocks otherwise |
| `lib/providers/` | Real vendor adapters: OpenSanctions (sanctions match API), Chainalysis sanctions oracle (keyless on-chain `isSanctioned()` read for wallet screening). **Fail-safe: any provider error/timeout → MANUAL_REVIEW, never fail-open.** Verbatim provider evidence persisted on `ComplianceCheck.rawResponse` |
| [lib/audit.ts](lib/audit.ts) | Append-only hash-chained audit log + chain verifier |
| [lib/auth.ts](lib/auth.ts) | API-key identity: `authenticate(request)` (`x-api-key` header → `sos_key` cookie) → `Principal { role, entityId?, label }` or null. Roles OPERATOR/REVIEWER/ENTITY; only sha256 hashes are stored. **Identity only — routes enforce authorization** |
| [lib/session.ts](lib/session.ts) | Next-only half of auth: `currentPrincipal()` resolves the `sos_key` cookie via `cookies()` for **server components** (which have no `Request`); `sessionCookieOptions()` is the one place the cookie's flags are defined. Keep `next/headers` out of lib/auth.ts so route tests can pass a plain `Request` |
| [lib/treasury.ts](lib/treasury.ts) | Tokenized-MMF treasury ops: `park()` (subscribe unreserved liquidity into the fund), `recall()` (T+0 redeem of a position, principal + accrued yield back to the treasury), `accrueDaily()` (advance the fund index by one day at `MMF_ANNUAL_RATE_BPS`, default 3.5% APY; `dailyIndex()`/`valueOfShares()` are the pure bigint math), `freeTreasuryBalance()` (bigint balance − RESERVED rows), `parkedBalance()` (derived value of ACTIVE positions; `0n`, never a throw, where no fund exists), `recallForPayment()` (FIFO auto-recall for the executor), `TreasuryError` (typed codes for route handlers), `TREASURY_*` audit actions |
| [lib/assets.ts](lib/assets.ts) | Asset metadata, currency↔token mapping, base-unit conversion |
| [scripts/setup.mjs](scripts/setup.mjs) | Local deploy (tokens, escrow, TokenizedMMF + its yield buffer and treasury approval) + DB seed (dev-mnemonic accounts, local only) |
| [scripts/deploy-testnet.mjs](scripts/deploy-testnet.mjs) | Real testnet deploy (base-sepolia / polygon-amoy via argv): env deployer key, per-network gas-dust targets, generated dust wallets, DB registration |
| `app/api/*` | REST route handlers (thin; logic lives in lib/) |
| [app/api/guard.ts](app/api/guard.ts) | Authorization glue: `requirePrincipal(req)` / `requireRole(req, ...roles)` return a `Principal` **or** the `NextResponse` to return (`if (x instanceof NextResponse) return x`), plus `isPlatformRole()` for the OPERATOR/REVIEWER-see-everything check, `authorizePaymentWrite(principal, payment)` for the quote/execute/cancel rule (OPERATOR or the sender; returns the response to send or null), and `actorOf(principal)` for the audit actor. Also the error responses every handler returns: `errorResponse(code, msg?)` / `invalidRequest()` / `conflict()` / `unauthorized()` / `forbidden()` / `notFound()`, and `caughtErrorResponse(e, fallback, context)` for catch paths; `scrubFailureReason(principal, payment)` redacts operator detail for tenants. HTTP concerns live here, not in lib/auth.ts |
| [lib/api-errors.ts](lib/api-errors.ts) | Framework-free error vocabulary: the `ApiErrorCode` union (unauthorized/forbidden/not_found/invalid_request/conflict/execution_failed/internal), the code→status and code→canned-message tables, `ApiError` (throw when a lib wants to pick the client's message), `apiError()`, `fromThrown()` (logs the real error, returns a safe one), `SAFE_FAILURE_SUMMARY`. The NextResponse wrappers live in app/api/guard.ts |
| `app/api/treasury/*` | MMF routes: `park`, `recall`, `positions` (GET, derived value per position), `accrue`. `errors.ts` holds the single `TreasuryErrorCode` → HTTP status table — add a code there when you add one to lib/treasury |
| `app/liquidity/` | Treasury dashboard. `page.tsx` is a server component (all chain/DB reads, per-network sections); `mmf-card.tsx` is the `"use client"` MMF card — park form, per-position Recall, Accrue demo control — which POSTs to the treasury routes and then `router.refresh()`es |
| `contracts/` | Solidity 0.8.24: `MockERC20` (permissionless mint, by design), `PaymentSettlement` escrow, `TokenizedMMF` (operator-gated share fund for parked treasury liquidity; monotonic index, no cross-calls with escrow) |
| `tests/` | Vitest suite: `unit/` (pure), `db/` (compliance, audit chain), `integration/` (executor E2E, contract, API). Fixture bootstrap in `global-setup.ts` + `helpers/` |

## Invariants — do not break these

- **State machine**: every payment status change must be a legal transition per
  `lib/state.ts`. Go through the executor's `setStatus()` (which calls
  `assertTransition` + audits) rather than raw `prisma.payment.update`.
- **Audit everything**: any state change or fund movement gets an `audit(...)`
  event. The log is append-only — never update or delete `AuditEvent` rows; that
  breaks the hash chain (`GET /api/audit` verifies it, the UI shows INTACT/BROKEN).
- **Money types**: fiat amounts are decimal **strings** in the DB and API
  (`"100000.00"`); on-chain amounts are **bigint** base units via
  `toBaseUnits`/`fromBaseUnits`. mockJPY has **0 decimals**. Never put a JS float
  on-chain.
- **Per-network accounts**: operator/treasury/entity addresses differ per network.
  Always resolve via `accountsFor(networkId)` and look up entity wallets by
  `wallet.network` (with `wallets[0]` fallback) — never assume one shared address
  set. Signing keys resolve inline (generated dust wallets) or via `privateKeyEnv`
  → `.env` (funded keys). Funded keys must never be written anywhere but `.env`.
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
  aggregate, or a forgotten field.
- **Compliance fail-safe**: a screening that cannot be performed (provider
  error, timeout, malformed response) resolves MANUAL_REVIEW — never PASS.
  Mocks stay the default when no provider env keys are set, so demos work
  offline; real-provider results must persist the verbatim vendor response on
  `ComplianceCheck.rawResponse` (audit evidence).
- **MMF segregation**: parked treasury funds live in `TokenizedMMF` and never pass
  through `PaymentSettlement` — the two contracts make no cross-calls and hold
  separate asset balances. The share index is monotonic (`accrue` reverts on any
  decrease), so a parked position can never lose value.
- **API shape**: JSON request/response fields are `snake_case`; Prisma models are
  `camelCase`. Keep route handlers thin.
- **Reserved liquidity is untouchable**: only the treasury balance minus RESERVED
  `LiquidityReservation` rows (`freeTreasuryBalance()`) may be parked in the MMF —
  liquidity promised to an in-flight payment can never be swept into the fund.
- **Positions are append-only history**: `recall()` flips a `TreasuryPosition` to
  RECALLED in place (status + `recalledAt` + `txHashRecall`); rows are never deleted,
  and a position's current value is always *derived* (`shares × live index`), never
  stored mutably on the row.
- **Recall before reserve**: when a route carries `recall_required`, the executor
  redeems the parked positions *before* it reserves liquidity or escrows anything —
  otherwise it would reserve against a balance that is still sitting in the fund.
  A failed auto-recall fails the payment (APPROVED → FAILED) with nothing escrowed.

## Gotchas

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

- `recall_required` is a **quote-time snapshot** frozen into `Payment.quoteJson`. The
  world can move between quoting and execution, so nothing downstream may assume it is
  still accurate: `recallForPayment()` is a no-op when the free balance already covers
  the amount, and the executor's existing insufficient-liquidity check still runs after
  the recall. Import direction is routing → treasury (never the reverse) — treasury
  must not import routing or the module graph cycles.

- Advancing the MMF index does **not** add asset to the fund: simulated yield is
  paid out of a buffer that must be funded separately (mint mock asset to the MMF
  address). An underfunded buffer makes `redeem` revert rather than shortchange a
  redeemer — fund it wherever the MMF is deployed. `scripts/setup.mjs` and the test
  fixture each mint a 50,000 mockUSDC buffer and have the **treasury approve the fund**
  (`subscribe` pulls via `transferFrom`); a new deploy target must do both or parking
  reverts.
- **Accrual is one-way.** `accrueDaily()` raises the share index, and the contract
  reverts on any decrease — there is no "un-accrue". So an accrued fund is accrued for
  good: after one, a park→recall round-trip returns *more* than the principal (assert
  `>=`, not `==`), floor division can shave a base unit of dust off a re-subscribed
  position, and tests sharing the fixture fund must assert index/share invariants rather
  than par. Vitest does not guarantee file order (it is sequential, not alphabetical), so
  *any* test file that accrues raises the index for every other file: derive expected
  amounts from the live index (`valueOfShares(shares, index)`), never from par.
- The MMF is deployed **per network** and only on the local chains today. Resolve it
  with `mmfAddress(networkId)` from `lib/chain.ts`, which returns `undefined` (never
  throws) where no fund exists — real testnets included. Treat "no MMF here" as a
  normal state to degrade to, not an error.
- Interactive pages keep chain/DB reads in the **server** component and pass plain
  serializable props to a `"use client"` child that owns the buttons (see
  `app/liquidity/`). The child POSTs to an API route, then calls `router.refresh()`,
  which re-renders the server parent and flows **new props** down — so never copy a
  server prop into `useState`, or the view goes stale after a mutation. (The payment
  pages predate this and fetch client-side instead; both patterns exist.)
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
  `scripts/setup.mjs` and in `ENTITIES` in `tests/helpers/deploy.ts` — keep the two
  in sync when adding entity fields.
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
  call that reads state written by a previous tx. Local single-node chains can
  never reproduce this — it only shows up live.
- Re-running `deploy:base-sepolia` / `deploy:polygon-amoy` deploys **fresh
  contracts** but reuses the generated treasury/entity wallets (and their gas dust).
- Polygon Amoy enforces a ~30 gwei minimum gas price (Base Sepolia is sub-gwei),
  so Amoy gas-dust targets in the deploy script are ~100× higher.
- Two Hardhat configs: `hardhat.config.cjs` (+ `.polygon.cjs` for chainId 31338).
  Artifacts land in `chain/artifacts/` (gitignored); `npm run compile` before
  anything that reads them.
- The cross-chain "bridge" is simulated: escrow + FX on the source chain, then a
  treasury-funded ERC-20 payout on the destination chain. Not lock-and-mint.
