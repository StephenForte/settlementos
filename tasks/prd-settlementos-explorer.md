# PRD: SettlementOS Explorer

> **Status note (2026-08-09):** This PRD lived in SettlementOS while the explorer
> was planned. Implementation and F6a–F6q closed out in the separate repo
> [`StephenForte/settlementos-explorer`](https://github.com/StephenForte/settlementos-explorer)
> (`main` @ `f669cbe`). **Authoritative tracking is that repo's
> [`docs/PLAN.md` §0](https://github.com/StephenForte/settlementos-explorer/blob/main/docs/PLAN.md)** —
> re-read it rather than trusting checkboxes here. Criteria below were
> re-verified against a fresh clone of that `main` on 2026-08-09; browser-only
> and live-data criteria left unticked on purpose (a blank prompts a look; a
> guessed tick does not). Address provenance for ForteL2 rows is out-of-band
> (F6c chain-852 liveness + F6f against SettlementOS
> `chain/deployments.fortel2-sepolia.json`) — never "verified by tests" (the
> explorer `EXPECTED` map is a tautology; PLAN §6 trap 2).

## Introduction

A small, standalone web application that visualizes the on-chain footprint of SettlementOS: the escrow and token contracts, the operator, the treasuries, and the entity wallets (ACME US, Tokyo Trading KK, Singapore Imports, Osaka Parts) on the two live testnets — Base Sepolia (84532) and Polygon Amoy (80002).

Block explorers like Basescan show raw addresses with no context; the SettlementOS app shows business records but assumes you trust its database. The explorer sits between them: it reads **only public chain data** through public RPCs and explorer APIs, labels every address from a bundled address book, and shows who moved what to whom — an independent, third-party view of the system that works even if SettlementOS itself is down. It is a demo and verification tool: "here is the settlement system's activity, verifiable on-chain, with the actors named."

It lives in its **own repository** and deploys as a static site. It has no backend, no database, no API keys to SettlementOS, and no private keys of any kind.

## Goals

- Show every known SettlementOS address on both testnets with its role, label, balances, and recent activity.
- Let a viewer click any address and see its detail: balances per token, transfer history, and counterparties — every item deep-linked to Basescan/Polygonscan for independent verification.
- Render the relationships between addresses as an interactive graph: nodes are addresses, edges are aggregated token flows (e.g. ACME US → escrow → treasury; treasury → Tokyo Trading KK).
- Link the two networks: one entity = one card, with its per-network wallets side by side, so the cross-chain USD→JPY story is visible (escrow on Base Sepolia, payout on Amoy).
- Degrade gracefully when a public RPC or explorer API is flaky — one dead endpoint must never blank the whole app.
- Deployable by anyone from a fresh clone: `npm install && npm run dev`, and a one-command static deploy.

## User Stories

### US-001: Scaffold the repository
**Description:** As a developer, I need a new repo with a working build so every later story has a home.

**Acceptance Criteria:**
- [x] New repository `settlementos-explorer` with Vite + React + TypeScript — verified: `gh api repos/StephenForte/settlementos-explorer` + clone `package.json` / `vite.config.ts` / `src/*.tsx` on `main` @ `f669cbe`
- [x] `npm run dev` serves a placeholder page; `npm run build` produces a static bundle — verified: `package.json` scripts (`dev`/`build`); CI runs `npm run build`; live SPA at `https://settlementos-explorer-ihgo.onrender.com` returns HTTP 200
- [x] oxlint + `tsc --noEmit` wired into `npm run lint` / `npm run typecheck`, both green — verified: clone @ `f669cbe` `package.json` scripts (`lint` → oxlint, `typecheck` → `tsc -b --noEmit`); both green on that clone
- [x] README states what the app is, that it holds **no secrets**, and how to run it — verified: explorer `README.md` "What this repo does **not** contain" + Quick start
- [x] `.gitignore` covers `node_modules/`, `dist/`, `.env*` — verified: explorer `.gitignore`

### US-002: Address book and network registry
**Description:** As a developer, I need a typed, bundled config of every known address so the whole app labels chain data consistently.

**Acceptance Criteria:**
- [x] `src/config/networks.ts`: Base Sepolia (84532, `https://sepolia.base.org`, basescan) and Polygon Amoy (80002, public RPC, amoy.polygonscan) with explorer URL helpers for address/tx — verified: file on `main` (Amoy RPC is now `polygon-amoy.drpc.org` per F6i; also carries `fortel2-sepolia` 852)
- [x] `src/config/address-book.ts`: every known address with `{ address, role, label, networkId }` — roles: `escrow-contract`, `token-contract`, `operator`, `treasury`, `entity` (+ `mmf-contract` for ForteL2 TokenizedMMF) — verified: file on `main`
- [x] Entries cover: PaymentSettlement (`0x9d8b8b7c476ab02306046f3da719d380fa0456aa`, same on both networks), the three tokens (mockUSDC/mockJPY/mockSGD, same addresses on both networks, with decimals 6/0/6), the operator (`0x5128889F20Ec13e0Be38b2BeBC568594159B652d`, shared), and the per-network treasury + four entity wallets (public addresses only, never keys) — verified: `address-book.ts` on `main`; ForteL2's 11 rows added in explorer PR #4 → `20f17ff`. **Provenance (not tests):** F6c chain-852 liveness 2026-08-08 + F6f against SettlementOS `chain/deployments.fortel2-sepolia.json` (explorer `docs/PLAN.md` §0)
- [x] Entities carry a stable `entityId` (`ent_acme_us`, `ent_tokyo_supplier`, `ent_sg_supplier`, `ent_osaka_parts`) and display name (ACME US Inc, Tokyo Trading KK, Singapore Imports Pte Ltd, Osaka Parts Co) so the same entity is linkable across networks — verified: `ENTITIES` + entity rows in `address-book.ts`
- [x] `lookupAddress(networkId, address)` resolves case-insensitively (chain reads return EIP-55 checksummed, config may be lowercase) and returns `undefined` for unknown addresses — verified: implementation + `src/config/address-book.test.ts`
- [x] Unit tests for lookup (case-insensitivity, unknown address) pass — verified: `npm test` in throwaway clone → 137 passed (includes `address-book.test.ts`)

### US-003: Chain read layer — balances
**Description:** As a developer, I need a data layer that reads live balances so pages have something true to show.

**Acceptance Criteria:**
- [x] viem clients per network using the public RPCs from the network registry — verified: `src/lib/clients.ts` + `src/chain/balances.ts`
- [x] `getBalances(networkId, address)` returns native gas balance plus each mock token's `balanceOf`, formatted with the token's decimals (bigint math; no JS floats on raw units) — verified: `balances.ts` + `lib/format.ts` (`formatUnits` from viem)
- [x] Reads are batched (multicall or `Promise.allSettled`) — one call per address, not per token serially — verified: `Promise.all` over native + per-token promises with per-promise error→`unavailable` handlers in `fetchBalances` (allSettled semantics)
- [x] A failed RPC read returns a typed `unavailable` result for that field, never throws to the UI — verified: `BalanceStatus = 'ok' | 'unavailable'`
- [x] Responses cached in-memory for ~30s so navigating between pages doesn't re-hammer public RPCs — verified: `src/lib/cache.ts` `DEFAULT_TTL_MS = 30_000`; `getBalances` wraps `cached()`
- [x] Typecheck/lint passes — verified: `npm run typecheck && npm run lint` green on clone @ `f669cbe`

### US-004: Chain read layer — transfer history
**Description:** As a developer, I need each address's token-transfer history so activity and relationships can be shown.

**Acceptance Criteria:**
- [x] `getTransfers(networkId, address)` returns ERC-20 `Transfer` events (from/to/token/amount/txHash/blockNumber/timestamp) where the address is sender or receiver, newest first — verified: `src/chain/transfers.ts`
- [x] Primary source: Etherscan V2 multi-chain API (`tokentx` action, chainid param) — one optional API key via `VITE_ETHERSCAN_API_KEY`; app must also work keyless on the free no-key tier at reduced rate — verified: `ETHERSCAN_V2` + `.env.example` / README
- [x] Fallback when the explorer API fails: `eth_getLogs` over a bounded recent block window against the public RPC, clearly labeled as "recent activity only" — verified: `transfers.ts` fallback path + AddressDetailPage "Recent activity only" banner
- [x] Escrow lifecycle events (PaymentSettlement's initiate/settle/refund event signatures) decoded and merged into the same timeline where the API returns them — verified: `fetchEscrowEvents` / `kind: 'escrow'` in `transfers.ts`
- [x] Every transfer carries resolved labels for both counterparties via the address book (unknown addresses show truncated hex) — verified: `lookupAddress` / `labelForAddress` usage + transfers tests
- [x] Unit tests with stubbed fetch cover: happy path, API error → fallback, unknown counterparty labeling — verified: `src/chain/transfers.test.ts` (`parses explorer API happy path…`, `falls back to RPC logs when explorer API errors`, `labels known counterparties and truncates unknowns`); suite green
- [x] Typecheck/lint passes — verified with US-003 gate on same clone

### US-005: Overview page with address directory
**Description:** As a viewer, I want a landing page listing every known address by role and network so I can see the whole cast at a glance.

**Acceptance Criteria:**
- [x] Network switcher (Base Sepolia / Polygon Amoy) that every view respects; selection persists in the URL — verified: `AppShell` + `useNetworkParam` (also includes ForteL2 Sepolia); routes `/:networkId`
- [x] Addresses grouped by role (Contracts / Platform / Entities) with label, truncated address, copy button, and live token balances — verified: `OverviewPage` + `ROLE_GROUP_ORDER` + `CopyButton` + `BalanceChips`
- [x] Each row links to the address detail page (US-006) and has an external link to Basescan/Polygonscan — verified: `OverviewPage` detail `Link` + `ExplorerLink` (omitted only when `explorerUrl` is null, e.g. ForteL2)
- [x] Balance load failures show an inline "unavailable" state per row, not a broken page — verified: `BalanceChips` `chip-warn` / `unavailable` copy
- [x] Typecheck/lint passes — verified with US-003 gate
- [ ] Verify in browser using dev-browser skill — **left unticked:** no browser session in this docs task (component tests exist under `src/pages/OverviewPage.test.tsx` but are not the criterion)

### US-006: Address detail page
**Description:** As a viewer, I want to click an address and see everything about it so I can drill into any actor's activity.

**Acceptance Criteria:**
- [x] Route `/:networkId/address/:address` shows: label + role badge, full address with copy, explorer link, native + token balances — verified: `AddressDetailPage.tsx` + `App.tsx` route
- [x] Transfer history table: direction (in/out), counterparty (labeled, linking to its own detail page), token, amount, time, and tx hash linking to the explorer — verified: `TransferTable.tsx`
- [x] Counterparty summary: distinct counterparties with aggregate in/out totals per token — verified: `CounterpartySummary.tsx` + `counterpartySummary()` in `transfers.ts`
- [x] For an entity address, a cross-network banner links to the same entity's wallet on the other network — verified: `otherWallets` `StatusBanner` in `AddressDetailPage`
- [x] Unknown (not-in-address-book) addresses still render a detail page from pure chain data — verified: `entry?.label ?? 'Unknown address'` + External badge path
- [x] History fetched via US-004 including its fallback path; fallback mode is visibly labeled — verified: truncated banner copy on AddressDetailPage
- [x] Typecheck/lint passes — verified with US-003 gate
- [ ] Verify in browser using dev-browser skill — **left unticked:** no browser session in this docs task

### US-007: Relationship graph
**Description:** As a viewer, I want an interactive node-and-edge graph of the addresses so the structure of the system is visible in one picture.

**Acceptance Criteria:**
- [x] Graph view (React Flow or Cytoscape) for the selected network: nodes = known addresses (styled by role), edges = aggregated token transfer volume between address pairs from US-004 data — verified: `@xyflow/react` + `RelationshipGraph.tsx` / `GraphPage.tsx`
- [x] Edge thickness/label reflects total volume per token pair; direction shown with arrows — verified: `strokeWidth` from volume + `MarkerType.ArrowClosed` + edge `label`
- [x] Clicking a node opens a side panel with its summary (balances, recent transfers) and a "full detail" link to US-006 — verified: `onNodeClick` + side panel + `Full detail` `Link`
- [x] Unknown counterparties that appear in transfers render as neutral "external" nodes — verified: `role: 'external'` nodes in `RelationshipGraph`
- [ ] Layout is legible with the ~10 known nodes per network (no overlapping labels at default zoom); pan/zoom works — **left unticked:** pan/zoom props present (`fitView`, `MiniMap pannable zoomable`); legibility at default zoom needs a browser look
- [x] Empty/loading/error states exist — a failed history fetch shows the nodes with an edges-unavailable notice — verified: `edgesUnavailable` / "Nodes shown; edges unavailable" banner
- [x] Typecheck/lint passes — verified with US-003 gate
- [ ] Verify in browser using dev-browser skill — **left unticked:** no browser session; no `GraphPage`/`RelationshipGraph` test file

### US-008: Cross-network entity view
**Description:** As a viewer, I want a per-entity page joining its wallets on both networks so the cross-chain settlement story reads end-to-end.

**Acceptance Criteria:**
- [x] Route `/entity/:entityId` shows the entity's name and one section per network: wallet address, balances, recent transfers — verified: `EntityPage.tsx` + `App.tsx` route
- [x] A merged, time-sorted activity timeline across both networks, each item tagged with its network — verified: `MergedTimeline` in `EntityPage.tsx`
- [ ] The demo narrative is visible: ACME US's mockUSDC escrow deposits on Base Sepolia and Tokyo Trading KK's mockJPY receipts on Amoy appear in the respective sections — **left unticked:** page structure supports per-network panels + merged timeline; live presence of those specific transfers needs a browser + chain-data check
- [x] Entity pages are linked from the overview and from address detail pages — verified: Overview + AddressDetail `Link to={/entity/...}`
- [x] Typecheck/lint passes — verified with US-003 gate
- [ ] Verify in browser using dev-browser skill — **left unticked:** no browser session in this docs task

### US-009: Resilience and polish pass
**Description:** As a viewer on a flaky public RPC, I want the app to stay usable so a dead endpoint never kills a demo.

**Acceptance Criteria:**
- [x] Every remote read has loading, error, and retry affordances; errors name the failing source (RPC vs explorer API), not a stack trace — verified: `useAsync` + AddressDetailPage "RPC unavailable" / "Explorer / RPC history failed" + retry buttons
- [x] Rate-limit responses (429) from the keyless explorer tier trigger backoff + the getLogs fallback rather than an error wall — verified: `etherscanAccountAction` 429 sleep/retry then throw → outer fallback to `eth_getLogs`
- [x] App shell, navigation, and the address book render fully with **all** remote sources down — verified by code: `AppShell`/address book are local config; balances/transfers load async into unavailable/error states
- [x] Mobile-width layout is usable (tables scroll horizontally; graph remains pannable) — verified: `overflow-x: auto` + `@media (max-width: …)` in `src/index.css`; React Flow `MiniMap pannable zoomable`
- [x] Typecheck/lint passes — verified with US-003 gate
- [ ] Verify in browser using dev-browser skill — **left unticked:** no browser session in this docs task

### US-010: Deploy
**Description:** As Stephen, I want the explorer live on a public URL so it can be shared as the independent view of SettlementOS.

**Acceptance Criteria:**
- [x] Static deploy configured (Vercel or GitHub Pages) with SPA routing rewrites so deep links work — verified: `vercel.json` rewrite to `index.html`; README also documents Render Node deploy with Express SPA fallback
- [x] `VITE_ETHERSCAN_API_KEY` documented as optional; the deployed site works without it — verified: `.env.example` + README Quick start
- [x] CI (GitHub Actions) runs typecheck + lint + tests + build on every push/PR — verified: `.github/workflows/ci.yml`
- [x] README documents the deploy and how to update the address book after a redeploy of SettlementOS contracts — verified: README deploy + address-book update sections
- [ ] Live URL loads and shows real Base Sepolia data — **left unticked:** `curl -sI https://settlementos-explorer-ihgo.onrender.com` → HTTP 200 and `/api/health` `{"ok":true,…}` confirm the host is up; "shows real Base Sepolia data" needs a browser/RPC check this task did not run

## Functional Requirements

- FR-1: The app must read exclusively public data: public RPC endpoints and public explorer APIs. It must never require or contain a private key, an API key to SettlementOS, or any SettlementOS database access.
- FR-2: All known addresses (contracts, tokens, operator, treasuries, entity wallets on both networks) must be defined in one bundled address-book config, with roles and display labels; address comparison must be case-insensitive.
- FR-3: The app must support three networks — Base Sepolia (84532), Polygon Amoy (80002), and ForteL2 Sepolia (`fortel2-sepolia`, 852) — selected via a global switcher reflected in the URL.
- FR-4: Every address view must show native balance and mock-token balances using each token's correct decimals (mockJPY = 0), computed with bigint math.
- FR-5: Every address view must show ERC-20 transfer history with labeled counterparties, sourced from the Etherscan V2 API with an `eth_getLogs` fallback over a bounded recent window.
- FR-6: Every address, transaction, and token reference must deep-link to the network's public explorer (Basescan / Amoy Polygonscan).
- FR-7: The relationship graph must render known addresses as role-styled nodes and aggregated transfer volumes as directed edges, with node click-through to detail.
- FR-8: Entities must be modeled once with per-network wallets, and an entity page must merge both networks' activity into one labeled timeline.
- FR-9: Any single failed remote source must degrade to an inline unavailable/fallback state; the app shell and address book must render with zero connectivity.
- FR-10: Remote reads must be cached (~30s) and batched; the app must function keyless against free-tier rate limits.
- FR-11: The app must build to a static bundle deployable to Vercel/GitHub Pages with working deep links.

## Non-Goals (Out of Scope)

- No SettlementOS API or database integration — no payment records, compliance status, audit-chain data, or MMF positions (treasury parking is a SettlementOS surface; the explorer stays payments/settlement-state only).
- No local Hardhat chains (31337/31338) — real testnets only.
- No write operations of any kind: no transactions, no wallet connection (MetaMask etc.), no faucet features.
- No authentication or user accounts — the app is fully public.
- No backend or database; no historical indexing beyond what explorer APIs return.
- No real-time push updates — refresh/poll on navigation is enough.
- No mainnet networks, ENS resolution, or arbitrary-address search beyond rendering unknown addresses that appear in transfer histories.

## Design Considerations

- Three main surfaces: **Overview** (directory + entry to the graph), **Graph**, **Detail** (address and entity pages). Keep navigation flat.
- Role color-coding used consistently across list badges and graph nodes (e.g. contracts violet, platform blue, entities green, unknown/external gray).
- The graph is the demo centerpiece — default layout should immediately read as "senders → escrow → treasury → recipients."
- Follow the dataviz skill's guidance for any charts/graph styling; support light and dark themes.
- Amount formatting mirrors SettlementOS conventions (mockJPY has no decimal places).

## Technical Considerations

- **Stack:** Vite + React + TypeScript, viem for RPC reads, React Flow (or Cytoscape) for the graph, vitest for tests. No server.
- **Address book provenance:** values are copied from the settlementos repo's gitignored `chain/deployments.<network>.json` — but only the *addresses*, which are public on-chain anyway. The README must state that private keys never enter this repo, and describe re-syncing after any fresh testnet deploy (a redeploy creates new contract addresses but reuses wallets).
- **Explorer API:** Etherscan V2 unified API covers both chains with one optional key (`chainid=84532` / `80002`). A browser-exposed free-tier key is acceptable for this demo; the keyless tier plus the getLogs fallback is the floor.
- **Public RPC behavior:** both RPCs are load-balanced replicas with rate limits and bounded `eth_getLogs` ranges — cap log queries (e.g. last ~50k blocks in chunks) and treat failures as normal (see the settlementos "public RPC resilience" invariant for prior art).
- **PaymentSettlement ABI:** copy the event fragments (initiate/settle/refund) from the settlementos contract into this repo's config to decode escrow lifecycle events; keep it to events only.

## Success Metrics

- From the deployed URL, a first-time viewer can identify who paid whom in the $25k USD→JPY demo settlement (ACME US → escrow on Base Sepolia; treasury → Tokyo Trading KK on Amoy) in under 2 minutes, without any explanation.
- Every claim the UI makes is one click from independent verification on Basescan/Polygonscan.
- The app renders its shell and directory with all remote sources blocked (verifiable in devtools offline mode).
- Fresh clone to running dev server in under 5 minutes with no secrets provisioned.

## Open Questions

- Should the graph aggregate across both networks into one picture (entity nodes spanning chains), or stay strictly per-network with the entity page as the cross-chain join? (PRD assumes per-network graph for v1.)
- Is gas-dust funding (operator → entity wallets' native-token top-ups) worth showing as edges, or is it noise next to the token flows?
- Repo naming and hosting: `settlementos-explorer` under the same GitHub account, Vercel vs GitHub Pages — any preference?
- Should the address book eventually be published *by* SettlementOS (e.g. a JSON the main repo exports) instead of hand-copied? Out of scope for v1 but affects how sync drift is handled.
