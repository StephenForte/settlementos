# SettlementOS — End-to-End Demo Script

A complete, from-scratch walkthrough: environment setup, the 5-minute core demo on
the local chains, and the Base Sepolia finale with public Basescan links. Timings
assume a warm machine; the full script runs comfortably in ~15 minutes.

> Testnet demo only. Mock assets, simulated FX, simulated payout. No real funds.

---

## 0. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | `node -v` |
| npm install ran | `npm install` in the repo root |
| 3 terminal tabs | two chains + the app |
| (Base Sepolia only) funded deployer | see [Part C](#part-c--base-sepolia-real-public-testnet) |

---

## Part A — Environment up (2 min)

Open three terminals in the repo root:

```bash
# Terminal 1 — Base (local), chainId 31337 on :8545
npm run chain

# Terminal 2 — Polygon Amoy (local), chainId 31338 on :8546
npm run chain:polygon

# Terminal 3 — deploy contracts to BOTH chains + seed demo data, then the app
npm run setup
npm run dev
```

Open **http://localhost:3000**.

`npm run setup` is your reset button: re-run it any time to wipe the database and
redeploy fresh contracts (it also re-registers Base Sepolia wallets if you've
deployed there — see Part C).

**Seeded demo entities:**

| Entity | Country | KYB | Role in the demo |
|---|---|---|---|
| ACME US Inc | US | PASSED | Sender with 1,000,000 mockUSDC |
| Tokyo Trading KK | JP | PASSED | Happy-path recipient |
| Singapore Imports Pte Ltd | SG | PASSED | USD→SGD / SGD→JPY corridors |
| Osaka Parts Co | JP | PENDING | Triggers the manual-review path |

---

## Part B — Core demo on local chains (~5 min)

### 1. Dashboard (30 s)

Point out: settled volume, in-flight payments, compliance alerts, recent payments
table with on-chain tx hashes.

### 2. Happy path: USD → JPY, single chain (90 s)

**New Payment** →

| Field | Value |
|---|---|
| Sender | ACME US Inc |
| Recipient | Tokyo Trading KK |
| Amount | `100000.00` |
| Source / destination currency | USD → JPY |
| Source / destination chain | Base (local) → Base (local) |
| Purpose / reference | supplier payment / `INV-2026-001` |

1. **Create Draft Payment** — nothing moves yet.
2. **Get Route Quote** — two routes: *INSTANT_ESCROW_SETTLEMENT* (recommended) vs
   *BATCHED_NETTING_WINDOW*. Show FX rate vs mid-market, fees in bps, gas, time,
   liquidity availability.
3. **Run Compliance & Execute** — 7 checks pass (KYB ×2, sanctions, wallet risk ×2,
   transaction risk, corridor). The payment walks the full lifecycle to **SETTLED**:
   escrow tx + settlement tx on-chain, ¥ ledger credit to the recipient.
4. Scroll the **Audit Trail** — every state transition, hash-chained.

### 3. Cross-chain route via simulated bridge (90 s)

Same as above, but **Source chain: Base (local) → Destination chain: Polygon Amoy
(local)**, amount `50000.00` USD → JPY.

- The quote now shows **BRIDGE_AND_SETTLE** (recommended) with a bridge fee, plus a
  single-chain fallback.
- After execution, the Settlement Detail shows **three** transactions: escrow +
  settlement on Base, and a real ERC-20 payout of mockJPY to the recipient's wallet
  **on the Polygon chain**.

### 4. Manual review path (60 s)

**New Payment**: ACME US Inc → **Osaka Parts Co**, `300000.00` USD → JPY.

Three findings trip the gate: KYB pending, wallet not allowlisted, amount above the
$250k review threshold. The payment parks in **MANUAL_REVIEW** → open the
**Compliance Queue**, approve as reviewer, then **Execute Settlement**.

### 5. Liquidity & Treasury + close-out (60 s)

- **Liquidity & Treasury** — live on-chain treasury balances per network, active
  reservations, the tokenized T-bill placeholder (disabled by design, per PRD).
- **Dashboard → Export reconciliation CSV** — per-network tx hashes included.
- **Compliance page** — audit chain **INTACT** badge (append-only, hash-chained,
  tamper-evident).

---

## Part C — Base Sepolia (real public testnet)

Same contracts, real chain (chainId 84532), every transaction publicly visible on
[Basescan](https://sepolia.basescan.org).

### One-time setup

1. **Deployer key** — `.env` (gitignored) needs `DEPLOYER_PRIVATE_KEY`, a fresh key
   that is the settlement *operator*. **Never reuse a mainnet key.** One is already
   generated in this workspace's `.env`.
2. **Gas** — fund the deployer address with **~0.02 Base Sepolia ETH**:
   - [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet) (free)
   - [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia)
   - or bridge Sepolia ETH via [Superbridge](https://superbridge.app/base-sepolia)

   Only gas is needed — settlement assets are self-deployed mock tokens.
3. **Deploy:**

   ```bash
   npm run deploy:base-sepolia
   ```

   The script prints a Basescan link for every step: it deploys the three mock
   tokens + `PaymentSettlement`, generates treasury/entity wallets (funding each
   with dust ETH for approvals), mints demo balances, pre-approves the settlement
   contract, registers the wallets in the app database, and writes
   `chain/deployments.base-sepolia.json` (gitignored — holds the generated
   dust-wallet keys; your funded deployer key never leaves `.env`).
   Re-running is safe: generated wallets are reused.

Optional `.env` settings: `BASE_SEPOLIA_RPC_URL` (defaults to the public
`https://sepolia.base.org`; use an Alchemy/Infura URL if it rate-limits) and
`TREASURY_PRIVATE_KEY` (defaults to a generated wallet).

### The demo finale (2 min)

1. Restart the app if it was running (`npm run dev`) — **Base Sepolia — public
   testnet** now appears in the chain dropdowns and on Liquidity & Treasury.
2. **New Payment**: ACME US Inc → Tokyo Trading KK, `100000.00` USD → JPY,
   **Base Sepolia → Base Sepolia**.
3. Quote → Execute. Settlement takes a few seconds per transaction (real ~2 s
   blocks instead of instant local mining).
4. **The payoff:** on the payment detail page, the escrow and settlement tx hashes
   are now **links — click through to Basescan** and show the audience a real
   public block explorer displaying your settlement, live on Base's testnet.
   The Liquidity page links the `PaymentSettlement` contract itself.
5. Optional flex: create a **Base Sepolia → Polygon Amoy (local)** payment — the
   bridge route escrows on the real testnet and pays out on the local chain,
   mixing a public and a private network in one settlement.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Chains not set up" banner | Both local chains running? Then `npm run setup` |
| `base-sepolia` missing from dropdowns | `npm run deploy:base-sepolia` hasn't run (or `chain/deployments.base-sepolia.json` was deleted) |
| Deploy script says balance too low | Fund the printed deployer address from a faucet (needs ≥ 0.01 ETH) |
| `not operator` revert on execute | `DEPLOYER_PRIVATE_KEY` in `.env` differs from the key that deployed — redeploy or restore the key |
| Base Sepolia RPC flaky / rate-limited | Set `BASE_SEPOLIA_RPC_URL` to an Alchemy/Infura endpoint; balances pages degrade gracefully in the meantime |
| Weird state mid-demo | `npm run setup` resets DB + local chains; Base Sepolia contracts/wallets survive |

## Reset / cleanup

```bash
npm run setup        # wipe DB, redeploy local chains, re-register sepolia wallets
```

To retire a Base Sepolia deployment entirely, delete
`chain/deployments.base-sepolia.json` (any leftover dust ETH stays with those
generated wallets, so keep the file if you plan to redeploy).
