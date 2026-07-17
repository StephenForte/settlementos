# PRD: SettlementOS Explorer

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
- [ ] New repository `settlementos-explorer` with Vite + React + TypeScript
- [ ] `npm run dev` serves a placeholder page; `npm run build` produces a static bundle
- [ ] ESLint + `tsc --noEmit` wired into `npm run lint` / `npm run typecheck`, both green
- [ ] README states what the app is, that it holds **no secrets**, and how to run it
- [ ] `.gitignore` covers `node_modules/`, `dist/`, `.env*`

### US-002: Address book and network registry
**Description:** As a developer, I need a typed, bundled config of every known address so the whole app labels chain data consistently.

**Acceptance Criteria:**
- [ ] `src/config/networks.ts`: Base Sepolia (84532, `https://sepolia.base.org`, basescan) and Polygon Amoy (80002, `https://rpc-amoy.polygon.technology`, amoy.polygonscan) with explorer URL helpers for address/tx
- [ ] `src/config/address-book.ts`: every known address with `{ address, role, label, networkId }` — roles: `escrow-contract`, `token-contract`, `operator`, `treasury`, `entity`
- [ ] Entries cover: PaymentSettlement (`0x9d8b8b7c476ab02306046f3da719d380fa0456aa`, same on both networks), the three tokens (mockUSDC/mockJPY/mockSGD, same addresses on both networks, with decimals 6/0/6), the operator (`0x5128889F20Ec13e0Be38b2BeBC568594159B652d`, shared), and the per-network treasury + four entity wallets (values from settlementos `chain/deployments.<network>.json` — **public addresses only, never keys**)
- [ ] Entities carry a stable `entityId` (`ent_acme_us`, `ent_tokyo_supplier`, `ent_sg_supplier`, `ent_osaka_parts`) and display name (ACME US Inc, Tokyo Trading KK, Singapore Imports Pte Ltd, Osaka Parts Co) so the same entity is linkable across networks
- [ ] `lookupAddress(networkId, address)` resolves case-insensitively (chain reads return EIP-55 checksummed, config may be lowercase) and returns `undefined` for unknown addresses
- [ ] Unit tests for lookup (case-insensitivity, unknown address) pass

### US-003: Chain read layer — balances
**Description:** As a developer, I need a data layer that reads live balances so pages have something true to show.

**Acceptance Criteria:**
- [ ] viem clients per network using the public RPCs from the network registry
- [ ] `getBalances(networkId, address)` returns native gas balance plus each mock token's `balanceOf`, formatted with the token's decimals (bigint math; no JS floats on raw units)
- [ ] Reads are batched (multicall or `Promise.allSettled`) — one call per address, not per token serially
- [ ] A failed RPC read returns a typed `unavailable` result for that field, never throws to the UI
- [ ] Responses cached in-memory for ~30s so navigating between pages doesn't re-hammer public RPCs
- [ ] Typecheck/lint passes

### US-004: Chain read layer — transfer history
**Description:** As a developer, I need each address's token-transfer history so activity and relationships can be shown.

**Acceptance Criteria:**
- [ ] `getTransfers(networkId, address)` returns ERC-20 `Transfer` events (from/to/token/amount/txHash/blockNumber/timestamp) where the address is sender or receiver, newest first
- [ ] Primary source: Etherscan V2 multi-chain API (`tokentx` action, chainid param) — one optional API key via `VITE_ETHERSCAN_API_KEY`; app must also work keyless on the free no-key tier at reduced rate
- [ ] Fallback when the explorer API fails: `eth_getLogs` over a bounded recent block window against the public RPC, clearly labeled as "recent activity only"
- [ ] Escrow lifecycle events (PaymentSettlement's initiate/settle/refund event signatures) decoded and merged into the same timeline where the API returns them
- [ ] Every transfer carries resolved labels for both counterparties via the address book (unknown addresses show truncated hex)
- [ ] Unit tests with stubbed fetch cover: happy path, API error → fallback, unknown counterparty labeling
- [ ] Typecheck/lint passes

### US-005: Overview page with address directory
**Description:** As a viewer, I want a landing page listing every known address by role and network so I can see the whole cast at a glance.

**Acceptance Criteria:**
- [ ] Network switcher (Base Sepolia / Polygon Amoy) that every view respects; selection persists in the URL
- [ ] Addresses grouped by role (Contracts / Platform / Entities) with label, truncated address, copy button, and live token balances
- [ ] Each row links to the address detail page (US-006) and has an external link to Basescan/Polygonscan
- [ ] Balance load failures show an inline "unavailable" state per row, not a broken page
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-006: Address detail page
**Description:** As a viewer, I want to click an address and see everything about it so I can drill into any actor's activity.

**Acceptance Criteria:**
- [ ] Route `/:networkId/address/:address` shows: label + role badge, full address with copy, explorer link, native + token balances
- [ ] Transfer history table: direction (in/out), counterparty (labeled, linking to its own detail page), token, amount, time, and tx hash linking to the explorer
- [ ] Counterparty summary: distinct counterparties with aggregate in/out totals per token
- [ ] For an entity address, a cross-network banner links to the same entity's wallet on the other network
- [ ] Unknown (not-in-address-book) addresses still render a detail page from pure chain data
- [ ] History fetched via US-004 including its fallback path; fallback mode is visibly labeled
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-007: Relationship graph
**Description:** As a viewer, I want an interactive node-and-edge graph of the addresses so the structure of the system is visible in one picture.

**Acceptance Criteria:**
- [ ] Graph view (React Flow or Cytoscape) for the selected network: nodes = known addresses (styled by role), edges = aggregated token transfer volume between address pairs from US-004 data
- [ ] Edge thickness/label reflects total volume per token pair; direction shown with arrows
- [ ] Clicking a node opens a side panel with its summary (balances, recent transfers) and a "full detail" link to US-006
- [ ] Unknown counterparties that appear in transfers render as neutral "external" nodes
- [ ] Layout is legible with the ~10 known nodes per network (no overlapping labels at default zoom); pan/zoom works
- [ ] Empty/loading/error states exist — a failed history fetch shows the nodes with an edges-unavailable notice
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-008: Cross-network entity view
**Description:** As a viewer, I want a per-entity page joining its wallets on both networks so the cross-chain settlement story reads end-to-end.

**Acceptance Criteria:**
- [ ] Route `/entity/:entityId` shows the entity's name and one section per network: wallet address, balances, recent transfers
- [ ] A merged, time-sorted activity timeline across both networks, each item tagged with its network
- [ ] The demo narrative is visible: ACME US's mockUSDC escrow deposits on Base Sepolia and Tokyo Trading KK's mockJPY receipts on Amoy appear in the respective sections
- [ ] Entity pages are linked from the overview and from address detail pages
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-009: Resilience and polish pass
**Description:** As a viewer on a flaky public RPC, I want the app to stay usable so a dead endpoint never kills a demo.

**Acceptance Criteria:**
- [ ] Every remote read has loading, error, and retry affordances; errors name the failing source (RPC vs explorer API), not a stack trace
- [ ] Rate-limit responses (429) from the keyless explorer tier trigger backoff + the getLogs fallback rather than an error wall
- [ ] App shell, navigation, and the address book render fully with **all** remote sources down
- [ ] Mobile-width layout is usable (tables scroll horizontally; graph remains pannable)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-010: Deploy
**Description:** As Stephen, I want the explorer live on a public URL so it can be shared as the independent view of SettlementOS.

**Acceptance Criteria:**
- [ ] Static deploy configured (Vercel or GitHub Pages) with SPA routing rewrites so deep links work
- [ ] `VITE_ETHERSCAN_API_KEY` documented as optional; the deployed site works without it
- [ ] CI (GitHub Actions) runs typecheck + lint + tests + build on every push/PR
- [ ] README documents the deploy and how to update the address book after a redeploy of SettlementOS contracts
- [ ] Live URL loads and shows real Base Sepolia data

## Functional Requirements

- FR-1: The app must read exclusively public data: public RPC endpoints and public explorer APIs. It must never require or contain a private key, an API key to SettlementOS, or any SettlementOS database access.
- FR-2: All known addresses (contracts, tokens, operator, treasuries, entity wallets on both networks) must be defined in one bundled address-book config, with roles and display labels; address comparison must be case-insensitive.
- FR-3: The app must support exactly two networks — Base Sepolia (84532) and Polygon Amoy (80002) — selected via a global switcher reflected in the URL.
- FR-4: Every address view must show native balance and mock-token balances using each token's correct decimals (mockJPY = 0), computed with bigint math.
- FR-5: Every address view must show ERC-20 transfer history with labeled counterparties, sourced from the Etherscan V2 API with an `eth_getLogs` fallback over a bounded recent window.
- FR-6: Every address, transaction, and token reference must deep-link to the network's public explorer (Basescan / Amoy Polygonscan).
- FR-7: The relationship graph must render known addresses as role-styled nodes and aggregated transfer volumes as directed edges, with node click-through to detail.
- FR-8: Entities must be modeled once with per-network wallets, and an entity page must merge both networks' activity into one labeled timeline.
- FR-9: Any single failed remote source must degrade to an inline unavailable/fallback state; the app shell and address book must render with zero connectivity.
- FR-10: Remote reads must be cached (~30s) and batched; the app must function keyless against free-tier rate limits.
- FR-11: The app must build to a static bundle deployable to Vercel/GitHub Pages with working deep links.

## Non-Goals (Out of Scope)

- No SettlementOS API or database integration — no payment records, compliance status, audit-chain data, or MMF positions (the MMF exists only on local chains, which are out of scope anyway).
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
