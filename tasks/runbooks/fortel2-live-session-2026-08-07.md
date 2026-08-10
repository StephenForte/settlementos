# ForteL2 live session results — 2026-08-07

**Outcome: F4 (MMF) and F7/US-F008 (bridge) both verified live on ForteL2 852.**

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

## F7 / US-F008 — simulated bridge with a live ForteL2 leg ✅

The cross-chain work initially looked blocked: this machine had no
`deployments.base-sepolia.json` / `deployments.polygon-amoy.json` (absent and
never committed — correct, they hold generated wallet private keys). At the
time we treated Base Sepolia as unusable and Stephen's call was to
`npm run setup` — wiping the local DB to restore `base-local` / `polygon-local`
as the second leg — after this session's evidence was preserved on-chain and
committed. The reset left the ForteL2 overlay (including the new
`TokenizedMMF`) untouched and re-registered all four ForteL2 entity wallets.

**Correction (2026-08-10):** what was lost was narrower than "signing keys
unrecoverable." The **generated treasury/entity keys** in the overlay were
gone, but the contracts and `DEPLOYER_PRIVATE_KEY` (on-chain operator) in
`.env` survived. Base Sepolia is adoptable without redeploy — see
`tasks/runbooks/adopt-base-sepolia.md` and `scripts/deploy-testnet.mjs --adopt`.
A fresh full deploy would still break the same-address property; adopt is the
path that preserves it.

**Forward — `base-local` → `fortel2-sepolia`** (`pay_6f678a415d2b`):

- Quote matched T1's hermetic prediction exactly: `BRIDGE_AND_SETTLE`
  recommended, `bridge_fee_bps: 5`, destination **3,915,077** mockJPY against
  the single-chain fallback's 3,917,040 — the 5bps bridge fee, visible.
- Escrow `0x6ab3c11ad80e0ee65b02366abb6290d11545c5912e5b28a3935937af981709cf`
  and settle `0x22e9507a54dcd4eb51fba9ea8120095d189e338a70becccc5a34d225b4db862e`
  on base-local; **destination payout on ForteL2**
  `0x30ad783a7beac85f0456b2be4f01b41438300bf749fc62513dd9b64946aef725`
  (block 732,051, status success).
- Recipient balance moved **exactly** as quoted: Tokyo +3,915,077 mockJPY,
  treasury −3,915,077, on the live L2.
- **SETTLED in ~4.5s.**

**Reverse — `fortel2-sepolia` → `base-local`** (`pay_302fbe6a0541`), proving
ForteL2 works as a bridge *source*, not only a destination:

- $10,000.00 → 1,566,344 mockJPY, `bridge_fee_bps: 5`.
- Escrow `0xb68b1e9b823592c47a89045a630964c881b4fdaecdfd0b8327cf8fbe58d04c1e`
  and settle `0x2c9f97808743a1298c6c9d12286371ac343ab1b6f5ecbc3809dd1dd8ca1a158c`
  **on ForteL2**; destination payout on base-local
  `0x11d8220325306dc51fb577f0688906c1a8fd589e3319ce5c4cdb325df79e641f`.
- **SETTLED in ~12.5s.**

**T4's persist-on-submit design verified in production.** Each cross-chain
payment wrote exactly two bridge events in the right order —
`bridge.destination_payout_submitted` (the attempt, hash persisted before the
receipt is awaited) then `bridge.destination_payout` (receipt confirmed) — 4
events across the 2 payments. That is the PR #37 fix behaving live, and it is
the seam that stops a lost receipt from compensating a recipient who was
already paid. Audit chain **INTACT** throughout (28 events).

## Not completed this session

**3 of T4's 4 live checks** — receipt-loss-completes-forward, unresolved-stays-
`PAYOUT_PENDING`, and repair-refuses-on-confirmed. Each requires injecting a
failure at a precise instant (RPC dropping *after* the destination transfer
mines but *before* its receipt returns). `executorTestHooks` is deliberately
test-only — the Proxy throws outside the test runner — so staging these live
would mean interrupting the sequencer mid-payment with second-level timing, on
the chain holding the demo history. The hermetic tests in
`tests/integration/executor-rpc-resilience.test.ts` cover all three, and the
live run confirmed the observable half of the same mechanism (both events, in
order, with the payment completing correctly).

**T4's fourth check** (ForteL2 failures surfacing immediately rather than after
~8s of replica-lag retries) stays covered by the `replicaLagRetries` unit
tests. Provoking it live means deliberately failing a payment, and the error
strings the classifier keys on (`"not initiated"`, `"insufficient allowance"`)
are awkward to produce honestly — an insufficient *balance* takes a different
path, so the test would not isolate what it claims to.

## Follow-ups

- The three staged-failure T4 checks, if ever worth the setup — low marginal
  value over the hermetic coverage.
- Flip the doc claims this session earns (PRD US-F005 / US-F008, README and
  CLAUDE "live-sequencer run pending", DEMO ForteL2 treasury + bridge beats).
- **Back up `chain/deployments.fortel2-sepolia.json` offline.** It is the only
  copy of ForteL2's generated treasury and entity wallet keys, gitignored by
  design. Losing it costs the generated wallets — not the contracts or the
  deployer/operator key in `.env`. Base Sepolia's overlay loss is the worked
  example: adopt (`--adopt`) regenerates wallets against the live contracts.
  This session's ForteL2 copy is in the session scratchpad, which is not durable.
- Base Sepolia is adoptable (J1 / `tasks/runbooks/adopt-base-sepolia.md`).
  Polygon Amoy is the same class of loss and is not yet adopted. A **full
  redeploy** of either would still break the documented "same address on every
  network" property and orphan demo history — prefer `--adopt`.
