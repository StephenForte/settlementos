# SettlementOS — End-to-End Demo Script

A complete, from-scratch walkthrough of everything built through Phase 6:
environment setup, the 5-minute core demo on the local chains (Phases 1–3),
real compliance screening against OpenSanctions and the Chainalysis oracle
(Phase 6), and the Base Sepolia finale with public Basescan links (Phase 4).
Timings assume a warm machine; the full script runs comfortably in ~18 minutes.

> Testnet demo only. Mock assets, simulated FX, simulated payout. No real funds.
> Sanctions and wallet screening optionally run against **real** services (Part C).

---

## 0. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | `node -v` |
| npm install ran | `npm install` in the repo root |
| 3 terminal tabs | two chains + the app |
| (real compliance only) `.env` config | see [Part C](#part-c--real-compliance-screening-phase-6) |
| (Base Sepolia only) funded deployer | see [Part D](#part-d--base-sepolia-real-public-testnet) |

Confidence check before a live audience: `npm test` (91 tests, fully
self-contained — Phase 5's suite + CI is the quiet phase; green checks on the
GitHub repo are the demo artifact).

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
deployed there — see Part D).

**Compliance mode** is decided by `.env` (details in Part C): with
`OPENSANCTIONS_API_KEY` and `CHAINALYSIS_ORACLE_RPC_URL` set, sanctions and
wallet screening are **real**; with them absent/commented out, deterministic
mocks run and the whole demo works offline. Every Part B beat works identically
in both modes — real mode just adds the live-provider flourish noted in step 2.

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
   With real providers on, point at the **Provider** column in the Compliance
   Checks table: `opensanctions` and `chainalysis_oracle` — this payment was
   really screened (expect ~1–2 s extra on this step for the live calls).
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

## Part C — Real compliance screening (Phase 6)

Sanctions and wallet screening against **real services** — OpenSanctions
(consolidated OFAC/EU/UN lists) and the Chainalysis sanctions oracle (a free
public smart contract on Ethereum mainnet, read live). KYB, transaction-risk,
and corridor checks stay mocked by design.

### One-time setup

Two lines in `.env` (each switches on independently; both are already set in
this workspace):

```bash
# Self-service key: https://www.opensanctions.org/account/ (free trial,
# then pay-as-you-go ~€0.10/call — one call per payment execution)
OPENSANCTIONS_API_KEY=...

# Any public Ethereum mainnet RPC — the oracle contract is free and keyless
CHAINALYSIS_ORACLE_RPC_URL=https://ethereum-rpc.publicnode.com
```

Restart `npm run dev` after changing them. To force offline/mock mode for a
venue with bad wifi, comment both lines out and restart.

### The demo (2–3 min)

1. **Real screening on a normal payment** — any Part B payment now shows
   `opensanctions` / `chainalysis_oracle` in the Compliance Checks table's
   Provider column. Every wallet in the payment was just checked against the
   live OFAC sanctions oracle on Ethereum mainnet.

2. **A real sanctions hit.** Register a genuinely sanctioned counterparty
   (Rosneft has been on the OFAC/EU lists since 2014):

   ```bash
   curl -s -X POST localhost:3000/api/entities \
     -H 'Content-Type: application/json' \
     -d '{"name": "Rosneft Oil Company", "country": "RU"}'
   ```

   **New Payment**: ACME US Inc → Rosneft Oil Company, `50000.00` USD → JPY,
   then **Run Compliance**. The gate comes back **REJECTED**: the SANCTIONS row
   shows **FAIL, score 100** from `opensanctions` with
   `recipient_sanctions_list_match` — a real match against the live
   consolidated lists (the new entity's pending KYB and missing wallet flag
   too, but the sanctions FAIL is what rejects it).

3. **The audit evidence.** The verbatim vendor response is persisted on every
   real check — grab the payment id from the URL and show it:

   ```bash
   curl -s localhost:3000/api/payments/<payment_id> \
     | jq '.payment.complianceChecks[] | select(.checkType == "SANCTIONS") | {provider, status, raw: (.rawResponse | fromjson)}'
   ```

   For the OFAC-listed entity you'll see the actual OpenSanctions match data
   (names, datasets, score); wallet checks store the oracle contract address,
   the screened wallet, the verdict, and the mainnet **block number** it was
   read at. This is the regulator story: every screening decision carries its
   original evidence.

4. **Fail-safe talking point** — if a provider is down or times out mid-demo,
   nothing breaks: the check resolves MANUAL_REVIEW (never fail-open) and the
   payment parks in the Compliance Queue with `provider_error` on the row.

> Mock-mode note: without the env config, sanctions FAIL is triggered by the
> demo hook instead (any entity whose *name* contains "sanctioned") — real mode
> matches real lists, so the name trick doesn't apply there.

---

## Part D — Base Sepolia (real public testnet)

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
| Compliance rows show `provider_error` / payment parks in MANUAL_REVIEW | A provider or RPC hiccup — the fail-safe parked it (never fail-open). Approve in the Compliance Queue and continue, or comment out the provider lines in `.env` + restart for mock mode |
| Sanctions check PASSes for a "Sanctioned …"-named entity | You're in real mode — the name hook is mock-only. Use a genuinely listed name instead (Part C step 2) |
| Weird state mid-demo | `npm run setup` resets DB + local chains; Base Sepolia contracts/wallets survive (and `.env` compliance config is untouched) |

## Reset / cleanup

```bash
npm run setup        # wipe DB, redeploy local chains, re-register sepolia wallets
```

To retire a Base Sepolia deployment entirely, delete
`chain/deployments.base-sepolia.json` (any leftover dust ETH stays with those
generated wallets, so keep the file if you plan to redeploy).
