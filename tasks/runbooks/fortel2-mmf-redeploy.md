# Runbook: TokenizedMMF live on fortel2-sepolia

Operator checklist for bringing overnight liquidity parking live on
ForteL2 Sepolia (chainId **852**) once a reachable sequencer RPC exists.
SettlementOS already deploys `TokenizedMMF` on every live network via
`scripts/deploy-testnet.mjs` (F4 / US-F005); the live `fortel2-sepolia`
overlay from 2026-07-24 predates that path and has **no** `TokenizedMMF`
field — this runbook is how you close that gap.

This is ops work on the ForteL2 machine (or any host that can dial its
RPC). Coding agents cannot execute it from a sandbox that only sees
loopback on a different host.

---

## 1. Preconditions

| Check | Why |
|---|---|
| Sequencer up and reachable | Writes go to `FORTEL2_SEPOLIA_RPC_URL` (default `http://127.0.0.1:9545` on the **sequencer host**). Confirm `eth_chainId` → `0x354` (852). |
| Optional read replica | `FORTEL2_SEPOLIA_READ_RPC_URL=http://fortel2-replica:10000` on Render Oregon — display/balance paths only (~3 min lag); deploy + park/recall/accrue still write via the sequencer URL. |
| `DEPLOYER_PRIVATE_KEY` in `.env` | Same funded key used for Base Sepolia / Amoy (`0x5128889F20Ec13e0Be38b2BeBC568594159B652d` in the F2 prep notes). Never commit it. |
| Deployer L2 balance ≥ ~0.005 ETH | Script preflight (`minDeployerBalance`); covers contract deploys + entity/treasury gas dust. Bridge more from Sepolia L1 via OptimismPortalProxy if short — see `tasks/f2-prep-notes.md` / ForteL2 `deposit-eth-sepolia.sh`. |
| `DATABASE_URL` + seeded entities | Overlay wallet registration upserts into the app DB; `npm run setup` (or a prior F2/F3 seed) must have created the demo entities. |
| Compiled artifacts | `npm run deploy:fortel2-sepolia` runs `npm run compile` first. |

Do **not** hand-edit or commit `chain/deployments.fortel2-sepolia.json` — the
script writes it (gitignored; holds generated dust-wallet keys).

---

## 2. Deploy step (current script behavior)

**Today** (`scripts/deploy-testnet.mjs` as of F4 / PR #29): a full live-network
deploy. There is no MMF-only add-on mode yet.

```bash
# On a host that can reach the ForteL2 sequencer RPC:
npm run deploy:fortel2-sepolia
# → npm run compile && node --env-file=.env scripts/deploy-testnet.mjs fortel2-sepolia
```

What the script does for the MMF path (same as base-sepolia / polygon-amoy):

1. Deploys `MockERC20` tokens + `PaymentSettlement` + **`TokenizedMMF(mockUSDC)`**.
2. Approves the three mock assets on the escrow.
3. Mints demo balances, **including a 50,000 mockUSDC yield buffer to the MMF
   address** (`MMF_YIELD_BUFFER = 50_000n * 10n ** 6n`).
4. Has the **treasury approve the fund** `MAX_UINT256` for mockUSDC
   (`subscribe` pulls via `transferFrom`).
5. Writes `chain/deployments.fortel2-sepolia.json` with `contracts.TokenizedMMF`
   and re-registers entity wallets for `fortel2-sepolia` in the DB.

**Consequence of a full re-run on an existing F2 overlay:** you get **fresh**
token + escrow + MMF contracts (new addresses). Reused treasury/entity wallet
keys/addresses keep their gas dust, but any prior escrowed payments or
settled demo state on the old contracts are orphaned. Prefer this path only
when a clean redeploy is acceptable (or after a ForteL2 Phase 7 wipe).

Confirm the overlay now carries the fund:

```bash
node -e "const d=require('./chain/deployments.fortel2-sepolia.json'); console.log(d.networks['fortel2-sepolia'].contracts.TokenizedMMF)"
```

A non-empty address means `mmfAddress('fortel2-sepolia')` will resolve and
treasury park/recall leave the `NO_FUND` path.

### Once T2's add-on mode lands

> **VARIANT — do not use until T2 (`fortel2/deploy-hardening`) has merged.**
>
> T2 is adding an idempotent **MMF add-on** path so an existing
> `fortel2-sepolia` overlay (escrow + tokens already live) can gain
> `TokenizedMMF` + yield buffer + treasury approval **without** redeploying
> the settlement contracts. When that lands, prefer the add-on / preflight
> flags documented in T2's handback (expected shape: `--preflight-only` to
> validate RPC/chain-id/balance, then an add-on re-run that only deploys the
> fund and updates the overlay). Until then, use the full deploy above and
> accept new escrow/token addresses.

---

## 3. Yield buffer + treasury approval — why they matter

Both steps are inside the current deploy script; if you ever provision the
fund out-of-band you must still do them by hand.

| Step | What | Why (AGENTS.md gotchas) |
|---|---|---|
| Mint ~50k mockUSDC **to the MMF address** | Yield buffer | Accrual raises the share index but **does not mint asset into the fund**. Simulated yield on redeem is paid from this buffer. An underfunded buffer makes `redeem` **revert** rather than shortchange a redeemer. |
| Treasury `approve(MMF, MAX)` for mockUSDC | Parking allowance | `park()` / `subscribe` pulls via `transferFrom`. The treasury is the platform account, so MAX is intentional (unlike entity→escrow exact per-payment allowances). `ensureTreasuryAllowance` can self-heal, but approving at deploy means the first park needs no extra tx. |

**Accrual is one-way.** `accrueDaily()` only raises the index; the contract
reverts on any decrease. There is no un-accrue. After one accrue, a
park→recall round-trip returns **more** than principal (assert `>=`, not
`==`). Floor division can shave a base unit of dust off a re-subscribe.

**Segregation.** Parked funds live in `TokenizedMMF` and never pass through
`PaymentSettlement` — the two contracts make no cross-calls and hold
separate balances. Escrow balance must stay untouched through the
park→accrue→recall cycle below.

---

## 4. Verification sequence (park → accrue → recall)

Sign in as OPERATOR (seeded key / `x-api-key`). App must see the updated
overlay (`loadDeployments()` merges `deployments.fortel2-sepolia.json`).
Entity used for park must be `mmfEligible` + `mmfOptIn` (seeded ACME is).

Replace `$KEY` and use amounts in asset units (mockUSDC, 6 decimals).

### 4a. Snapshot escrow before

Read the escrow contract's mockUSDC balance (RPC `balanceOf` on mockUSDC for
`PaymentSettlement`, or the liquidity page). Record it — it must be unchanged
after the cycle.

### 4b. Park

```bash
curl -s -X POST http://localhost:3000/api/treasury/park \
  -H "content-type: application/json" -H "x-api-key: $KEY" \
  -d '{"network":"fortel2-sepolia","asset":"mockUSDC","amount":"50000.00","entity_id":"<acme-entity-id>"}'
```

Expect `status: "ACTIVE"`, a `position_id`, `tx_hash`, and `shares` / `index_at_entry`.
Audit: `TREASURY_PARKED`.

### 4c. Accrue one day

```bash
curl -s -X POST http://localhost:3000/api/treasury/accrue \
  -H "content-type: application/json" -H "x-api-key: $KEY" \
  -d '{"network":"fortel2-sepolia"}'
```

Expect `annual_rate_bps: "350"` (3.5% APY) and `new_index` > `old_index`.
Default math (pure bigint, floor):

```
newIndex = oldIndex + (oldIndex * 350) / (10_000 * 365)
```

At par (`1e18`), one day → `1000095890410958904`. On **50,000** mockUSDC
parked at par, one-day yield ≈ **4.794520** mockUSDC
(`50000 * 350 / (10000 * 365)`), matching the local demo's +4.79 on 50k/day.
Audit: `TREASURY_ACCRUED`.

### 4d. Recall

```bash
curl -s -X POST http://localhost:3000/api/treasury/recall \
  -H "content-type: application/json" -H "x-api-key: $KEY" \
  -d '{"position_id":"<position_id from park>"}'
```

Expect principal + accrued yield back to the treasury (recall amount ≥ park
amount). Position flips to `RECALLED`. Audit: `TREASURY_RECALLED`.

### 4e. Segregation check

Re-read the escrow mockUSDC balance from 4a — **unchanged**. MMF and escrow
balances move independently; that is the segregation invariant.

UI alternative: Liquidity page → ForteL2 section → MMF card (Park / Accrue /
Recall), then `router.refresh()`.

---

## 5. Audit-trail checks

```bash
curl -s "http://localhost:3000/api/audit?limit=50" -H "x-api-key: $KEY"
```

| Check | Expect |
|---|---|
| Park / accrue / recall events | Actions `TREASURY_PARKED`, `TREASURY_ACCRUED`, `TREASURY_RECALLED` (and `TREASURY_AUTO_RECALLED` only if a payment pulled liquidity). Detail includes `network: "fortel2-sepolia"` and tx hashes. |
| Chain integrity | Response / Audit UI reports **INTACT** (`verifyAuditChain`). A BROKEN tip after a reset usually means checkpoints were wiped without the events — re-run `npm run setup` only if you intend a full local reset; do not delete `AuditEvent` rows by hand. |

---

## 6. Done when

- [ ] Overlay has `contracts.TokenizedMMF`
- [ ] Park → accrue → recall succeeds on `fortel2-sepolia`
- [ ] One-day yield matches 3.5%/365 floor math on the parked notional
- [ ] Escrow mockUSDC balance unchanged through the cycle
- [ ] `TREASURY_*` events present; audit chain INTACT

Report the MMF address + the three tx hashes back for DEMO / explorer notes
(integrator doc pass — do not edit README/DEMO from this runbook alone).
