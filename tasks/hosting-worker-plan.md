# Hosting / public demo — worker-ready plan (J1–J8)

Prepared 2026-08-10. Companion to the Render runbook
[`tasks/runbooks/render-deploy.md`](runbooks/render-deploy.md) and the Base
Sepolia adopt runbook [`tasks/runbooks/adopt-base-sepolia.md`](runbooks/adopt-base-sepolia.md).
Structure mirrors [`tasks/fortel2-worker-plan.md`](fortel2-worker-plan.md):
verified state, task tree with model/order, irreversible facts.

Facts below were checked against this repo on **2026-08-10** (`origin/main` @
`8ab02c2` + PR #59 on `feat/render-deploy`). Where conversation memory disagreed
with the repo, the repo won.

## 0. Verified state

| Claim | Verified | Evidence |
|---|---|---|
| Base Sepolia escrow still at same address | **True** | `PaymentSettlement` `0x9d8b8b7c476ab02306046f3da719d380fa0456aa` in live overlay + CLAUDE.md |
| `--adopt` exists and is network-generic | **True** | `scripts/deploy-testnet.mjs` (`ADOPTABLE_NETWORKS`, PRs #55–#57) |
| Postgres on `settlementos` schema | **True** | PR #58 `8ab02c2`; `prisma/schema.prisma` `provider = "postgresql"`; URL `?schema=settlementos` |
| Audit chain advisory lock | **True** | `lockAuditChain` / `pg_advisory_xact_lock` in `lib/audit.ts` |
| Render blueprint in repo | **True (unverified live)** | `render.yaml` on PR #59; **no live Render service has been confirmed from this workstream** |
| Non-destructive remote seed | **True (hermetic)** | `npm run seed:demo` / `scripts/seed-demo.mjs`; create-only entities by default |
| ForteL2 re-genesis pending | **Open / external** | CLAUDE.md + ForteL2 plan: Phase 7/8 re-genesis invalidates ForteL2 contract addresses |

## 1. Task tree

```
Wave 0 (done)
├─ J1  Base Sepolia adopt (no redeploy)     [Opus · serial]
└─ J2  SQLite → Postgres (schema settlementos) [Opus · after J1]

Wave 1 (this PR / operator)
├─ J3-repo   Render readiness in git (blueprint, overlay path, seed, runbook)
└─ J3-deploy Operator Dashboard + Shell steps (NOT run yet)

Later (not started)
├─ J4  ForteL2 public-RPC coordination memo   [blocked on re-genesis]
├─ J5  unallocated
├─ J6  unallocated
├─ J7  unallocated
├─ J8  MCP server                             [prior art: settlementos-explorer]
└─ F8  canonical USDC                         [noted, not plannable]
```

| ID | Status | Model / order | Notes |
|---|---|---|---|
| **J1** | **DONE** | Opus · wave 0 | PRs [#55](https://github.com/StephenForte/settlementos/pull/55)–[#57](https://github.com/StephenForte/settlementos/pull/57) (2026-08-10). Contracts **adopted, not redeployed**; `PaymentSettlement 0x9d8b8b7c476ab02306046f3da719d380fa0456aa` preserved. `--adopt` in `scripts/deploy-testnet.mjs` is network-generic. Live proof: payment `pay_29683b98af96` SETTLED. Runbook: [`adopt-base-sepolia.md`](runbooks/adopt-base-sepolia.md). |
| **J2** | **DONE** | Opus · after J1 | PR [#58](https://github.com/StephenForte/settlementos/pull/58) (`8ab02c2`). SQLite → Postgres on schema `settlementos` so a shared instance can keep another app (chainbank) in `public.*`. Audit tip-write serialized by transaction-scoped `lockAuditChain` — SQLite's global write lock had provided that implicitly; without the advisory lock, concurrent `audit()` forks on `prevHash`. |
| **J3-repo** | **In PR #59** | Opus · wave 1, no parallel | `render.yaml`, Secret File overlay resolution (`lib/overlay-paths.mjs`), `npm run seed:demo`, runbook. Gate green in-repo; **not** proof of a live Render deploy. |
| **J3-deploy** | **NOT RUN** | Operator · after J3-repo merges | Manual steps in [`render-deploy.md`](runbooks/render-deploy.md). Nothing in this workstream is verified against a live Render service yet. |
| **J4** | **Open** | — | ForteL2 public-RPC coordination memo. **Blocked** on a pending ForteL2 Phase 7/8 **re-genesis**, which invalidates every ForteL2 contract address — including the settlementos-explorer's 11-row ForteL2 address book on a public site, and the contract entries in any backed-up ForteL2 overlay. |
| **J5** | **Unallocated** | — | No scope assigned. Do not invent work to fill the number. |
| **J6** | **Unallocated** | — | No scope assigned. |
| **J7** | **Unallocated** | — | No scope assigned. |
| **J8** | **Open** | — | MCP server. Strong prior art in the settlementos-explorer repo's `server/mcp/`. Not started here. |
| **F8** | **Noted** | — | Canonical USDC. Explicitly not plannable yet (same posture as the ForteL2 plan). |

## 2. Irreversible facts

- `chain/deployments.fortel2-sepolia.json` and `chain/deployments.base-sepolia.json`
  are each the **only** copy of that network's generated treasury + entity
  private keys. Both are gitignored. The operator backs them up offline.
- Losing an overlay costs the **generated wallets**, not the on-chain contracts
  and not `DEPLOYER_PRIVATE_KEY` (the operator key in `.env`).
- Adopt / redeploy semantics: `--adopt` regenerates treasury/entity wallets and
  re-homes the overlay without redeploying escrow/tokens when those contracts
  are already live.
- **`deployments.base-sepolia.json` stores `treasury` as an inline `privateKey`.**
  Only `operator` uses `privateKeyEnv: DEPLOYER_PRIVATE_KEY`. That is why
  `TREASURY_PRIVATE_KEY` is **not** in the Render env inventory — the Secret
  File carries treasury key material.
- Schema isolation (`settlementos.*` vs `public.*`) is **not** credential
  isolation. A peer app with the same DB role can still read our schema.
- `lib/rate-limit.ts` is per-process; keep Render at `numInstances: 1`
  (accepted — do not add Redis for J3).

## 3. Commit / merge contract (same spirit as ForteL2)

1. Branch from current `origin/main` (or push fixes onto the open J3 PR branch).
2. Do not open a second PR for J3 fixes — update #59 in place.
3. Never commit `.env`, overlays, or raw API keys.
4. `npm run setup` stays localhost-only and destructive; remote seed is only
   `npm run seed:demo`.
