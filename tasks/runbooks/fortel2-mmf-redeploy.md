# Runbook: TokenizedMMF live on fortel2-sepolia

Operator checklist for TokenizedMMF on ForteL2 Sepolia (chainId **852**).
F4 / US-F005 closed live on 2026-08-07: T2's MMF **add-on** wrote
`TokenizedMMF` `0xaed29387417dad9ab1993332e2c2b99d35ffe7ff` into the
existing overlay; escrow and tokens were untouched. A re-run against that
overlay is a **no-op**. This runbook is how you confirm that state, how
you run the add-on if an overlay is still pre-MMF, and how you avoid a
full redeploy that would replace the live escrow and orphan every cited
tx hash.

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

`scripts/deploy-testnet.mjs` (T2 / PR #34) auto-detects a mode from the
network's overlay. **Run `--preflight-only` first.** It prints the detected
mode and planned actions without sending a transaction.

```bash
# On a host that can reach the ForteL2 sequencer RPC:
node --env-file=.env scripts/deploy-testnet.mjs fortel2-sepolia --preflight-only
```

| Overlay state | Mode | What the script does |
|---|---|---|
| No overlay | `full` | Deploys MockERC20 tokens + `PaymentSettlement` + `TokenizedMMF`. **New addresses.** |
| Escrow + tokens present, no `TokenizedMMF` | `mmf_addon` | Deploys the fund, mints the 50,000 mockUSDC yield buffer, treasury MAX-approves mockUSDC, merges `TokenizedMMF` into the existing overlay. **Escrow and tokens untouched.** |
| Overlay already carrying a fund | `noop` | No transactions. |

The live `fortel2-sepolia` overlay has carried `TokenizedMMF`
`0xaed29387417dad9ab1993332e2c2b99d35ffe7ff` since the 2026-08-07 add-on.
A re-run against that overlay is **`noop`**. That is the expected result.
Do not move the overlay aside and do not pass `--force-full-deploy` to
"make it do something."

If preflight reports `mmf_addon` (pre-F4 overlay: escrow + tokens, no fund),
then run the add-on:

```bash
npm run deploy:fortel2-sepolia
# → npm run compile && node --env-file=.env scripts/deploy-testnet.mjs fortel2-sepolia
```

What `mmf_addon` does:

1. Reuses the overlay's `PaymentSettlement` and mockUSDC.
2. Deploys **`TokenizedMMF(mockUSDC)` only**.
3. Mints a 50,000 mockUSDC yield buffer to the new fund
   (`MMF_YIELD_BUFFER = 50_000n * 10n ** 6n`).
4. Has the **treasury approve the fund** `MAX_UINT256` for mockUSDC
   (`subscribe` pulls via `transferFrom`).
5. Merges `contracts.TokenizedMMF` into `chain/deployments.fortel2-sepolia.json`.
   Other overlay entries are untouched.

**Add-on idempotency is mode-level only** (decisions log T2-2). A run that
dies between the fund deploy and the overlay merge leaves the overlay
fund-less; a re-run re-detects `mmf_addon` and deploys a **second** fund.
The helpers that look like per-step skips (`mmfYieldBufferSatisfied` /
`treasuryMmfApprovalSatisfied`) check the *fresh* address, which is empty,
so they never reuse the orphan. That orphan's minted 50k yield buffer is
**unrecoverable**: `TokenizedMMF` has no rescue path (T5-8). Accepted for
this mock-asset testnet. `--preflight-only` first shrinks the window; it
does not close it.

**A full redeploy of fresh contracts requires moving the overlay aside
first.** Auto-detect will not choose `full` while the overlay still carries
escrow + tokens. After a ForteL2 re-genesis wipe the overlay is for the
*old* chain and must be moved aside before a full deploy onto the new one.

**When the overlay is lost but the contracts survived, use `--adopt`, not a
bare deploy.** Auto-detect treats "no overlay" as `full` and would redeploy
PaymentSettlement and tokens at new addresses. `--adopt` bytecode-verifies
the addresses in `ADOPTABLE_NETWORKS` and regenerates only the wallets
around them. `ADOPTABLE_NETWORKS` currently lists **only `base-sepolia`**;
ForteL2 is not in it, so `--adopt fortel2-sepolia` refuses until an entry
exists. A missing ForteL2 overlay would auto-detect `full`. Stop rather
than run a bare `npm run deploy:fortel2-sepolia` in that case.

Confirm the overlay carries the fund:

```bash
node -e "const d=require('./chain/deployments.fortel2-sepolia.json'); console.log(d.networks['fortel2-sepolia'].contracts.TokenizedMMF)"
```

A non-empty address means `mmfAddress('fortel2-sepolia')` will resolve and
treasury park/recall leave the `NO_FUND` path.

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
