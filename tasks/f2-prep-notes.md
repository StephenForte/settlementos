# F2 prep notes — deploy to ForteL2 Sepolia (852)

> **SUPERSEDED for addresses — ForteL2 re-genesised chain 852 on 2026-08-22.**
> Every ForteL2 address below is pre-wipe and dead, including the
> OptimismPortalProxy. Do **not** deposit using an address from this file; the
> old portal still accepts ETH and the deposit is unrecoverable. Current values:
> ForteL2 `deployments/rail-interface.json` at v7 or later. Retained as a dated
> record of the F2 prep, not as current guidance.

Prep snapshot taken 2026-07-24, after F1 (network registry) merged in PR #21.
The F2 session should verify balances again before spending.

## Prerequisite status

| Check | Status |
|---|---|
| F1 registry (`fortel2-sepolia` in lib/networks.ts, read/write RPC split) | ✅ merged (PR #21) |
| `DEPLOYER_PRIVATE_KEY` in `.env` → `0x5128889F20Ec13e0Be38b2BeBC568594159B652d` | ✅ confirmed (same dev wallet as Base Sepolia / Amoy) |
| Deployer Sepolia **L1** balance (funds the L1→L2 deposit) | ✅ 0.7998 ETH (2026-07-24) |
| Deployer Base Sepolia balance (reference only) | 2.048 ETH |
| ForteL2 sequencer | ✅ running — but on a **separate machine**, so F2 executes there (or via an exposed RPC); loopback from this Mac fails by design |
| Deployer **L2 (852)** balance | assume 0 → needs a bridge deposit (see `tasks/fortel2-l2-prereqs.md`) |

**Separate-machine consequence:** the plan is to clone this repo on the L2
machine and run the F2 session there (`.env` with `DEPLOYER_PRIVATE_KEY`
recreated by hand — never transmitted in the clear). The L2-operator side of
the prep — funding the deployer on 852, RPC exposure options, health checks —
is handed off in `tasks/fortel2-l2-prereqs.md`. None of ForteL2's own accounts
(SEQUENCER / CHALLENGER / DEMO_A / DEMO_B) are used by SettlementOS.

## Funding path (no faucet — ForteL2 has no genesis funding)

L2 ETH arrives via an L1→L2 deposit through the Sepolia Standard Bridge
(per ForteL2 `deployments/rail-interface.json`):

- OptimismPortalProxy: `0xb4679b1c65e5c07bac95988583c2d7a65108c624`
- A plain ETH send from the deployer to the portal on Sepolia L1 mints the same
  amount to the deployer's address on L2 852 once the derivation pipeline sees
  the L1 block (follow ForteL2's `deposit-eth-sepolia.sh` patterns).
- Suggested deposit: **0.05–0.1 ETH** — Base Sepolia deploy cost ~0.002 ETH and
  ForteL2 is a quiet OP Stack chain, so this covers deploy + dust + many demos.
- Deposit only after checking the L2 balance — it may already be funded.

## What F2 changes in this repo

1. `scripts/deploy-testnet.mjs` — add a `fortel2-sepolia` entry to
   `NETWORK_CONFIGS` (chainId 852, `rpcEnv: "FORTEL2_SEPOLIA_RPC_URL"`,
   `defaultRpc: "http://127.0.0.1:9545"`). Two structural gaps to close:
   - **No explorer**: the script templates `${EXPLORER}/tx/...` into every log
     line and writes `explorerUrl` into the overlay JSON. Make both null-safe
     (log raw hashes; omit `explorerUrl`) — F1 already renders null links.
   - **"Fund from faucet" messaging**: replace faucet URLs with the bridge
     deposit instruction for this network.
   - Gas-dust targets: start from the Base Sepolia numbers (sub-gwei OP Stack
     chain), confirm against `eth_gasPrice` once the sequencer is up.
2. `package.json` — `deploy:fortel2-sepolia` script (mirrors the other two).
3. `scripts/setup.mjs` — add `fortel2-sepolia` to its `LIVE_NETWORK_IDS`
   wallet re-registration list (line ~225), so `npm run setup` re-binds
   ForteL2 entity wallets after a DB reset.
4. **TokenizedMMF** — ✅ shipped in F4 (PR #29). `deploy-testnet.mjs` now
   deploys the fund on every live network, mints the 50k mockUSDC yield
   buffer, and has the treasury approve it. Older overlays without a fund
   still settle (`mmfAddress()` → `undefined`).
5. Overlay `chain/deployments.fortel2-sepolia.json` is written by the script
   (gitignored — holds generated dust-wallet keys). `loadDeployments()`
   already looks for it since F1 made the network `live: true`.

## Reminders

- Entity wallets need L2 gas dust: each payment signs its own exact-amount
  approve (no standing allowances), same as Base Sepolia / Amoy.
- Public-RPC replica-lag retries (`retryOnReplicaLag`) are already in
  `operatorWrite`; a single local sequencer shouldn't need them, but they're
  harmless.
- Reset policy: Sepolia deployment pinned through ForteL2 learning Phase 6;
  a Phase 7 wipe requires redeploying all SOS contracts (coordinated).
- Do not commit `.env`, deployment overlays, or any ForteL2 keys.
