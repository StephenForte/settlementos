# ForteL2 live session results — 2026-08-07

First session with the ForteL2 852 sequencer reachable on the SettlementOS
machine (geth on `127.0.0.1:9545`). Everything below was executed against the
**live** chain, not a fixture. Tx hashes are permanent on-chain evidence and
remain verifiable after any database reset:

```bash
cast tx <hash> --rpc-url http://127.0.0.1:9545
```

ForteL2 has no block explorer, so raw hashes are the evidence (F1 renders null
explorer links by design).

## Chain state at session start

| Check | Result |
|---|---|
| `eth_chainId` | `0x354` = **852** ✅ |
| Block height | 731,631, advancing (1s behind wall clock) |
| Gas price | `0xf433b` ≈ 0.001 gwei (sub-gwei, as the deploy config assumes) |
| Deployer `0x5128…652d` balance | 0.098195 ETH (20× the 0.005 minimum) |
| `PaymentSettlement` `0x9d8b…56aa` | **present** — the 2026-07-24 deploy survived |
| mockUSDC / mockJPY / mockSGD | all **present** |
| `TokenizedMMF` in overlay | **absent** — the F4 gap this session closed |

The July-24 deployment was intact, so no re-genesis had happened; the session
took the MMF **add-on** path rather than a full redeploy.

## F4 / US-F005 — TokenizedMMF live on ForteL2 ✅

The live-sequencer run that had been "pending a reachable RPC" since 2026-08-03.

**Deploy (T2's add-on mode, PR #34):**

- `--preflight-only` correctly detected `mmf_addon` — reuse existing escrow +
  mockUSDC, deploy only the fund.
- **`TokenizedMMF` → `0xaed29387417dad9ab1993332e2c2b99d35ffe7ff`**
- Yield buffer mint (50,000 mockUSDC):
  `0x50e9364e5a06cf914a2e2fcf802385678e61ff4a73ea34f3ff20121fe530b702`
- Treasury MAX approve mockUSDC → fund:
  `0x8c2c007d897f6c407c237fd475b42aead4c4e335238496a99ed7cd9c8002026f`
- Overlay merged; `PaymentSettlement` and the three tokens **unchanged**.
- **Re-running preflight then reported `noop`** — T2's mode-level idempotency
  verified live, not just in unit tests.

Post-deploy contract reads: `currentIndex` = `1e18` (par, never accrued),
`totalShares` = 0, `asset` = mockUSDC, fund balance = exactly 50,000 mockUSDC,
treasury allowance = MAX.

**park → accrue → recall (50,000 mockUSDC):**

| Step | Tx | Result |
|---|---|---|
| Park | `0xf75bcb1c2f7f4cbb83cf03b1f2376a62a3c016a15d7e67c064ea36491c1b5288` | position `ACTIVE`, 50,000,000,000 shares at index `1e18` |
| Accrue | `0x3a17de701d0da26ffa81d70e61596057f05b835a11342c70c28eda8c0ffd2561` | index `1e18` → **`1000095890410958904`** |
| Recall | `0x133c1d45190c9c06aa954c49903622acedeb1d99dd3fab1db1510e0b9d371e6c` | **50004.79452** mockUSDC returned, position `RECALLED` |

The accrued index matched an independent recompute of
`oldIndex + (oldIndex × 350) / (10000 × 365)` exactly, and the yield
(**+4.794520** mockUSDC on 50k for one day) is 3.5%/365 to the base unit —
the same figure the local demo produces.

**Segregation, proven on-chain:**

| Account | Before park | After recall | Delta |
|---|---|---|---|
| Treasury | 600,000.000000 | 600,004.794520 | **+4.794520** |
| MMF fund | 50,000.000000 | 49,995.205480 | **−4.794520** |
| **Escrow** | 0.000000 | 0.000000 | **0.000000** |

Yield came out of the fund's buffer, and the escrow contract's balance was
untouched throughout — the MMF-segregation invariant holding against a live
chain.

Audit: `TREASURY_PARKED`, `TREASURY_ACCRUED`, `TREASURY_RECALLED` all written;
chain verified **INTACT** (`valid: true`, `mode: "full"`, `anchored: true`).

## Live single-chain settle with the fund deployed ✅

Confirms the new MMF does not interfere with settlement (`pay_52e69d8f9a0c`):

- ACME US → Tokyo Trading KK, **$25,000.00 USD → ¥3,917,040 JPY**, both legs
  `fortel2-sepolia`, rate 156.838440.
- Escrow: `0x162edd0b16ea677617b21447ff4b9ff12da4dc405a0208bca057c3d29d898173`
- Settle: `0x37abb72e707b2900eb49f1ed1f823d323dc52303f796d630cdd7707648e6618f`
- **SETTLED in ~13s** end to end.
- `destinationTxHash` is **null** — correct: a same-chain route's proof is the
  ledger credit, never a destination hash (the T4 invariant).
- Through the settlement the **MMF balance moved 0.000000** — segregation holds
  across a real payment, not just the park cycle.

Earlier ForteL2 history confirmed present in the DB before this session:
`pay_8c318fcae804`, the F3 first settle (SETTLED, $100,000.00, 2026-07-25) —
which independently verifies the F3 claim that could not be checked from git.

## Not completed this session

Both blocked by the same cause, not by any code defect:

- **US-F008 bridge QA** (`tasks/runbooks/fortel2-bridge-manual-qa.md`)
- **3 of T4's 4 live checks** (receipt-loss forward-complete, unresolved stays
  stuck, repair 409) — each needs a cross-chain payment, and only a cross-chain
  route sets `destinationTxHash`.

**Cause:** a cross-chain payment needs two live networks; this machine has one.
`chain/deployments.base-sepolia.json` and `deployments.polygon-amoy.json` are
absent here and were never committed (correct — they hold generated wallet
private keys), so the Base Sepolia treasury/entity **signing keys are
unrecoverable**. The contracts remain live on Base Sepolia, but nothing on this
machine can sign as those wallets. Restoring that leg means a fresh deploy,
which would produce new addresses and break the documented "same address on
every network" property.

T4's fourth check (ForteL2 failures surfacing immediately rather than after
~8s of replica-lag retries) stays covered by the `replicaLagRetries` unit
tests; provoking it live would have meant deliberately failing a payment on the
demo chain for little added confidence.

## Follow-ups

- Bridge QA + the three T4 live checks, once a second live network exists.
- Flip the doc claims this session earns (PRD US-F005 "pending live run",
  README/CLAUDE "live-sequencer run pending", DEMO ForteL2 treasury beat).
- The ForteL2 overlay is the **only** copy of its generated wallet keys. It is
  gitignored by design; losing it costs what Base Sepolia's loss cost here.
  Worth an offline backup before any machine migration.
