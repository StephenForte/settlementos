# PRD: SettlementOS → ForteL2 Integration

## Introduction

Land SettlementOS on [ForteL2](https://github.com/StephenForte/ForteL2), the OP Stack L2 intended as the long-term **home settlement rail**. This PRD is the handoff for the SettlementOS repo only.

ForteL2 does **not** reimplement payments, compliance, escrow, or the JLTXX-style MMF. Those already exist here. SettlementOS adds ForteL2 as another network in the registry, deploys the **same** contracts, and demos settlement with L2 tx hashes — the same pattern used for Base Sepolia and Polygon Amoy.

**Do not use the ForteL2 money-rail PRD as your only brief.** That doc is for the L2 operator (sequencer, bridge, fees). **This file is what SettlementOS implements.** Shared ownership rules live in ForteL2 `tasks/coordination-settlementos.md` (copy or submodule link as needed).

## Who does what (RACI)

| Work item | SettlementOS | ForteL2 | You ship when… |
|---|---|---|---|
| Payment lifecycle, quotes, FX, compliance, API/UI | **R/A** | — | Already done — do not rebuild on L2 |
| `PaymentSettlement`, `MockERC20`, `TokenizedMMF` | **R/A** (deploy to ForteL2) | Hosts chain | Same bytecode/ABI as other networks |
| `fortel2` / `fortel2-sepolia` network registry entries | **R/A** | Publishes RPC + chain ID | Adapter works like `base-sepolia` |
| Deploy script overlay `deployments.fortel2*.json` | **R/A** | Provides funded deployer / RPC | `npm run deploy:fortel2…` succeeds |
| Demo path: single-chain settle on ForteL2 | **R/A** | Rail up | Payment detail shows ForteL2 explorer/RPC links |
| Cross-chain Base↔ForteL2 via **simulated** bridge | **R/A** (optional) | I | Only after single-chain works |
| Park / recall MMF on ForteL2 | **R/A** | I | Existing treasury flows against ForteL2 RPC |
| Explorer address book entries for ForteL2 | **R/A** (explorer repo) | Publishes addresses | After first deploy |
| OP Stack / bridge / fee market / paymaster | I / C | **R/A** | Blocked on ForteL2 MR stories |
| Canonical USDC cutover (leave mocks) | **R** adapter | **A** path choice | Joint decision; SOS flips asset mapping |
| Rebuild escrow/MMF as L2 “primitives” | **Forbidden** | **Forbidden** | — |

R = Responsible, A = Accountable, C = Consulted, I = Informed

## Goals

- Treat ForteL2 as a first-class network beside `base-local`, `polygon-local`, `base-sepolia`, `polygon-amoy`.
- Prove the README thesis: SettlementOS application layer on ForteL2 settlement infrastructure.
- Change **adapters and deploy/config**, not payment product semantics.
- Keep testnet/mock posture (no real customer funds).

## Non-goals

- Implementing sequencer, batcher, proposer, or L1 contracts
- Forking or rewriting `PaymentSettlement` / `TokenizedMMF` for “L2 native” behavior
- Moving compliance, audit DB, or FX engine on-chain
- Replacing the simulated Base↔Polygon bridge with a production bridge in this PRD
- Mainnet or real USDC (tracked as a later cutover story only)

## When SOS may come on ForteL2 (lifecycle gate)

ForteL2 learning Phases **0–3 are done** (Sepolia L2 chain **852** + Render replica).

| Gate | SOS action |
|---|---|
| **NOW (recommended)** | Start **F1–F5 against `fortel2-sepolia` (852)** using ForteL2 `deployments/rail-interface.json` |
| Optional | `fortel2-local` (901) for offline-only experiments (resets freely) |
| Reads | Prefer Render **replica** RPC when reachable; **writes** use Mac sequencer `L2_RPC_URL` |
| Do **not** wait for | Phase 3b friends, Phase 4–6 client rebuilds, paymaster, real USDC |
| Redeploy SOS contracts | Required at ForteL2 **Phase 7** network wipe (coordinated with replica pack/publish) |

## Dependencies (blocking inputs from ForteL2)

| Input | Status |
|---|---|
| Chain IDs 901 (local) / **852** (Sepolia L2) | ✅ in `rail-interface.json` |
| L2 RPC (Mac sequencer loopback) | ✅ `http://127.0.0.1:9545` when stack up |
| Bridge proxies + deposit funding mode | ✅ Sepolia Standard Bridge; deposit to fund L2 |
| Reset policy | ✅ Sepolia pinned through Phase 6; wipe at Phase 7 |
| Replica for reads | ✅ Phase 3 done — URL operator-configured (private Render) |

Canonical file: ForteL2 `deployments/rail-interface.json` + `tasks/prd-money-rail.md`.

## Phase roadmap (SettlementOS)

| Phase | Scope | Status |
|---|---|---|
| **F1** | Network registry + chain adapter for **`fortel2-sepolia` (852)** (and optional local 901) | ✅ Done (PR #21) |
| **F2** | Deploy existing contracts + seed wallets on ForteL2 852 | ✅ Done (PR #24) — deployed 2026-07-24 |
| **F3** | Single-chain payment demo (ACME → Tokyo) on ForteL2 | ✅ Done — first settle 2026-07-24 (`pay_8c318fcae804`) |
| **F4** | Treasury MMF park/recall against ForteL2 balances | ✅ **Done live (2026-08-07)** — `TokenizedMMF` deployed to the real 852 sequencer via the add-on path (`0xaed29387…e7ff`); park→accrue→recall returned 50004.79452 on 50k (+4.794520 = 3.5%/365 exactly) with the escrow balance unmoved. Evidence: [`tasks/runbooks/fortel2-live-session-2026-08-07.md`](runbooks/fortel2-live-session-2026-08-07.md) |
| **F5** | Docs/demo/README: ForteL2 as destination rail | ✅ Done (with F3) |
| **F6** | Explorer address book + optional replica read URL | After F3 |
| **F7** | Optional: simulated bridge legs involving ForteL2 | ✅ **Done live (2026-08-07)** — both directions settled with dual hashes (`base-local`→`fortel2-sepolia` in ~4.5s, `fortel2-sepolia`→`base-local` in ~12.5s). Second leg is a local chain, not Base Sepolia — see US-F008 |
| **F8** | Later: canonical USDC adapter cutover | Joint with ForteL2 MR-4 |

## User stories — SettlementOS

### US-F001: Add ForteL2 to the network registry
**Description:** As an operator, I want to select ForteL2 as source/destination network in the UI and API.

**Acceptance Criteria:**
- [x] Primary entry `fortel2-sepolia`: chainId **852**, RPC from env (e.g. `FORTEL2_SEPOLIA_RPC_URL`, defaulting to Mac sequencer URL from rail-interface)
- [x] Optional entry `fortel2-local`: chainId **901** for offline experiments
- [x] Optional `FORTEL2_SEPOLIA_READ_RPC_URL` (replica) used for balance/read paths when set; writes still use sequencer RPC
- [x] `networkInfo`, explorer helpers, and route engine accept the new ids without special-case payment logic
- [x] Missing RPC fails closed with a clear error (do not silently fall back to another chain)
- [x] Unit/registry tests updated; README notes env vars and that the chain is operated outside this repo

### US-F002: Parameterize deploy for ForteL2
**Description:** As an operator, I want `deploy-testnet`-style scripting to deploy mocks + `PaymentSettlement` + `TokenizedMMF` to ForteL2.

**Acceptance Criteria:**
- [x] Deploy path reuses existing contracts; no ForteL2-only Solidity in this phase
- [x] Writes `chain/deployments.fortel2-sepolia.json` (gitignored if it contains keys; public addresses documentable)
- [x] Operator / treasury / entity dust funding follows existing testnet patterns; L2 ETH via ForteL2 deposit bridge (not genesis)
- [x] Idempotent re-run behavior matches Base Sepolia / Amoy scripts where practical
- [x] Documented npm script (e.g. `deploy:fortel2-sepolia`)
- [x] `TokenizedMMF` deployed on live networks (F4 / US-F005, PR #29) — same
  script path as escrow + mocks; yield buffer + treasury approval included.
  Older overlays without a fund keep settling (`mmfAddress()` → `undefined`).

### US-F003: Wire DB registration after deploy
**Description:** As the demo, I need entities and wallets registered for ForteL2 so execute/compliance paths work.

**Acceptance Criteria:**
- [x] Setup/deploy registration creates per-network wallets for ForteL2 like other live networks
- [x] `npm run setup` (or documented variant) can re-bind ForteL2 addresses after DB reset without breaking local Hardhat networks
- [x] Balances API shows ForteL2 treasury/entity balances when that network is deployed

### US-F004: Single-chain settle on ForteL2
**Description:** As a demo operator, I want the ACME → Tokyo $100k USD→JPY path to escrow and settle on ForteL2.

**Acceptance Criteria:**
- [x] Create payment with `source_network` = `destination_network` = ForteL2 id
- [x] Quote → compliance → execute completes to `SETTLED` (or existing success terminal state)
- [x] Payment detail shows ForteL2 tx hash(es); link via explorer helper if an explorer URL exists, else raw hash + RPC note
- [x] Audit log entries reference those hashes
- [x] No changes to compliance provider semantics

### US-F005: MMF park/recall on ForteL2
**Description:** As a treasury operator, I want overnight parking to work against ForteL2 liquidity.

**Acceptance Criteria:**
- [x] Park/recall/accrue APIs succeed when treasury inventory lives on ForteL2 — **verified against the live 852 sequencer on 2026-08-07**. `TokenizedMMF` (`0xaed29387…e7ff`) was deployed by the add-on path with its 50k mockUSDC yield buffer and treasury MAX approval; a park→accrue→recall of 50,000 returned **50004.79452** (+4.794520 = 3.5%/365 to the base unit, matching an independent recompute of the index). Tx hashes in [`tasks/runbooks/fortel2-live-session-2026-08-07.md`](runbooks/fortel2-live-session-2026-08-07.md).
- [x] Segregation invariant preserved (MMF funds not commingled with escrow) — proven **on the live chain**: through park→accrue→recall the treasury moved +4.794520, the fund −4.794520, and the escrow contract's balance delta was **exactly 0.000000**. It stayed 0 through a subsequent real settlement on the same network. Hermetic overlay wiring coverage in `tests/unit/fortel2-mmf-wiring.test.ts`.
- [x] Route engine `recall_required` behavior unchanged — no routing changes; suite green.

### US-F006: Documentation and demo run-of-show
**Description:** As a partner viewer, I want README/DEMO to show ForteL2 as the destination rail without implying SOS runs the sequencer.

**Acceptance Criteria:**
- [x] README “long-term destination ForteL2” section updated with concrete local integrate steps
- [x] DEMO.md (or equivalent) has a ForteL2 single-chain beat
- [x] Explicit statement: payments product = SettlementOS; rail = ForteL2; no duplicate primitives
- [x] Link to ForteL2 coordination + money-rail docs for infra questions
- [x] F4 treasury beat documented: README + DEMO cover TokenizedMMF deploy on
  live networks and the ForteL2 park→accrue→recall path (live-sequencer run
  still pending a reachable RPC)

### US-F007: Sepolia-backed ForteL2 overlay (optional, later)
**Description:** As a public demo, I want `fortel2-sepolia` analogous to `base-sepolia`.

**Acceptance Criteria:**
- [ ] Second network entry once ForteL2 publishes Sepolia-backed RPC + chain ID
- [ ] `deployments.fortel2-sepolia.json` overlay pattern
- [ ] settlementos-explorer address book updated (separate repo story)
- [ ] Best-effort uptime called out (personal L2, not SLA)

### US-F008: Simulated bridge involving ForteL2 (optional)
**Description:** As a demo, I may show Base Sepolia ↔ ForteL2 using the **existing simulated bridge** (escrow on A, treasury payout on B).

**Acceptance Criteria:**
- [x] Only after US-F004 is green — US-F004 settled 2026-07-24, re-confirmed live 2026-08-07
- [x] No new bridge protocol — reuse current adapter behavior. No bridge code was written for this: `quoteRoutes`/`lib/executor` were already network-pair generic (proven hermetically by T1, `tests/db/fortel2-bridge-route.test.ts`), and the live run confirmed it
- [x] Dual tx hashes on payment detail — **both directions, live 2026-08-07**. `base-local`→`fortel2-sepolia` (`pay_6f678a415d2b`): source escrow+settle on base-local, destination payout on ForteL2 at block 732,051; recipient's ForteL2 mockJPY moved +3,915,077, exactly the quoted amount. Reverse (`pay_302fbe6a0541`): escrow+settle **on ForteL2**, payout on base-local
- [x] Documented as simulation, same honesty as Base↔Amoy — treasury-funded ERC-20 payout on the destination chain, not lock-and-mint

**Deviation from the description, deliberate:** the second leg was `base-local`,
not Base Sepolia. This machine's `deployments.base-sepolia.json` is absent and
was never committed (it holds generated wallet keys), so Base Sepolia's
treasury/entity **signing keys are unrecoverable** — its contracts are live but
unusable from here. The mechanism under test (network-pair-generic quoting,
cross-chain escrow, treasury payout on the destination, dual hashes) is
identical; only the counterpart chain differs. A Base Sepolia leg needs a fresh
deploy with new addresses — a deliberate decision, tracked in the session notes.

## Out of scope for SettlementOS in this PRD (ForteL2 owns)

Escalate to ForteL2 / money-rail PRD — do not implement here:

- Sequencer, batcher, proposer, derivation, fault proofs  
- L1 contract deployment / rollup genesis  
- Changing L2 block time or fee parameters  
- Paymaster / EIP-4337 infrastructure (consume later if they publish an address)  
- CCTP / canonical USDC issuance  
- Genesis predeploy of SOS contracts (joint later; SOS still owns bytecode)

## Success metrics

- One green demo: quote → comply → settle on ForteL2 with audit + reconciliation export  
- ForteL2 is selectable in create-payment without code forks per corridor  
- No second escrow/MMF contract family introduced  
- CI still green on existing local + Sepolia/Amoy paths

## Open questions (SOS-facing)

- Exact network `id` strings (`fortel2-local` vs `forte-l2`) — match ForteL2 rail interface naming  
- Explorer URL: none / Otterscan / custom — until decided, show hash only  
- Whether entity dust wallets need L2 gas from genesis allocation or operator sponsorship only (SOS already operator-writes; may need zero entity gas on ForteL2)

## Recommendation

Implement **F1→F5** against local ForteL2 as soon as the rail interface exists. Treat ForteL2 like “another Hardhat/Base Sepolia”: registry, deploy, demo. Do not wait for paymaster or canonical USDC.
