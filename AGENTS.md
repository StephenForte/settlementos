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
npm test                      # full suite — no chains/DB needed, builds its own fixture
npx tsc --noEmit && npm run lint
```

**Tests**: `npm test` is fully self-contained — it compiles contracts, boots two
Hardhat nodes on test-only ports (9545/9546), deploys to them, and builds a fresh
SQLite DB under `tests/.tmp/` (never touching dev chains, `chain/deployments*.json`,
or the dev DB). Layers: `tests/unit/` (state machine, FX, base units, explorer
URLs), `tests/db/` (compliance matrix, audit-chain tamper detection),
`tests/integration/` (executor E2E on-chain, PaymentSettlement contract behavior,
API route validation). CI runs typecheck + lint + tests on every push/PR
(`.github/workflows/ci.yml`). **Add tests for new lifecycle, compliance, or
chain behavior** — and still smoke-test UI-visible changes by hand via the flow
in README "API". `npm run setup` resets DB + local chains at any time; it
re-registers Base Sepolia wallets and never touches the public testnet deployment.

## Architecture map

| Module | Responsibility |
|---|---|
| [lib/networks.ts](lib/networks.ts) | Network registry (local sims + real base-sepolia), explorer URL helpers. **Client-safe — no node imports, no secrets.** |
| [lib/chain.ts](lib/chain.ts) | viem chain adapter. Loads/merges `chain/deployments*.json`, per-network accounts via `accountsFor()`, contract ABIs, `operatorWrite()`, `treasuryTokenTransfer()` |
| [lib/state.ts](lib/state.ts) | Payment lifecycle state machine; `assertTransition()` enforces legal moves |
| [lib/executor.ts](lib/executor.ts) | Orchestrates APPROVED → SETTLED: liquidity reservation, escrow, FX, payout, refund-on-failure |
| [lib/routing.ts](lib/routing.ts) | Route quotes (instant/batched/bridged), treasury liquidity checks |
| [lib/fx.ts](lib/fx.ts) | Simulated FX: static mid rates, spread + tiered slippage, platform fee |
| [lib/compliance.ts](lib/compliance.ts) | Mock providers (KYB, sanctions, wallet/tx/corridor risk) → PASS/FAIL/MANUAL_REVIEW |
| [lib/audit.ts](lib/audit.ts) | Append-only hash-chained audit log + chain verifier |
| [lib/assets.ts](lib/assets.ts) | Asset metadata, currency↔token mapping, base-unit conversion |
| [scripts/setup.mjs](scripts/setup.mjs) | Local deploy + DB seed (dev-mnemonic accounts, local only) |
| [scripts/deploy-base-sepolia.mjs](scripts/deploy-base-sepolia.mjs) | Real testnet deploy: env deployer key, generated dust wallets, DB registration |
| `app/api/*` | REST route handlers (thin; logic lives in lib/) |
| `contracts/` | Solidity 0.8.24: `MockERC20` (permissionless mint, by design), `PaymentSettlement` escrow |
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
- **API shape**: JSON request/response fields are `snake_case`; Prisma models are
  `camelCase`. Keep route handlers thin.

## Gotchas

- `npm run setup` **wipes the database** (payments, audit log, entities) and
  redeploys the local chains. Base Sepolia contracts/wallets survive; its entity
  wallets are re-registered from `chain/deployments.base-sepolia.json`.
- `chain/deployments.json` (local) and `chain/deployments.base-sepolia.json`
  (real testnet) are merged at read time by `loadDeployments()`. The app only
  offers networks present in the merged result (`/api/networks`).
- Local chains mine instantly; Base Sepolia has ~2s blocks. Execution is
  synchronous by design (a settled payment ≈ 8–10s on the real testnet).
- Re-running `deploy:base-sepolia` deploys **fresh contracts** but reuses the
  generated treasury/entity wallets (and their gas dust).
- Two Hardhat configs: `hardhat.config.cjs` (+ `.polygon.cjs` for chainId 31338).
  Artifacts land in `chain/artifacts/` (gitignored); `npm run compile` before
  anything that reads them.
- The cross-chain "bridge" is simulated: escrow + FX on the source chain, then a
  treasury-funded ERC-20 payout on the destination chain. Not lock-and-mint.
