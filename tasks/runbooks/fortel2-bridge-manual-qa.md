# Manual QA — Base Sepolia ↔ ForteL2 simulated bridge (US-F008 / F7)

Step-by-step verification for a human with a reachable ForteL2 sequencer RPC.
This is the **existing simulated bridge** (escrow + FX on source, treasury ERC-20
payout on destination) — the same honesty as Base↔Amoy, not a lock-and-mint
protocol.

Hermetic quoting for both directions is covered by
`tests/db/fortel2-bridge-route.test.ts`. This runbook covers what those tests
cannot: live treasury reads (`recall_required`), dual on-chain tx hashes, and
failure/repair paths.

## Preconditions

### Env / RPC

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | local SQLite |
| `DEPLOYER_PRIVATE_KEY` | yes | operator on both live networks (see AGENTS.md) |
| `FORTEL2_SEPOLIA_RPC_URL` | yes | sequencer; default loopback only works **on the ForteL2 host** |
| `FORTEL2_SEPOLIA_READ_RPC_URL` | optional | Render replica for balance/display reads only |
| `BASE_SEPOLIA_RPC_URL` | optional | defaults to public Base Sepolia RPC |

Do **not** expose the ForteL2 sequencer port to the public internet. Prefer
running this session on the L2 machine, or tunnel/Tailscale per
`tasks/fortel2-l2-prereqs.md`.

### Health checks (ForteL2 side)

```bash
cast chain-id     --rpc-url "$FORTEL2_SEPOLIA_RPC_URL"   # must return 852
cast block-number --rpc-url "$FORTEL2_SEPOLIA_RPC_URL"   # must advance
cast balance 0x5128889F20Ec13e0Be38b2BeBC568594159B652d --rpc-url "$FORTEL2_SEPOLIA_RPC_URL"
```

Deployer needs L2 ETH via the Sepolia Standard Bridge deposit path in
`tasks/fortel2-l2-prereqs.md` (≥ 0.05 ETH comfortable).

### Deployments present

Both overlays must exist and merge into what the app loads
(`chain/deployments.base-sepolia.json` + `chain/deployments.fortel2-sepolia.json`):

- `PaymentSettlement` + `mockUSDC` / `mockJPY` / `mockSGD` on **both** networks
- Entity wallets for ACME + Tokyo registered on **both** networks
  (`npm run setup` re-registers live-network wallets from overlays; it does not
  redeploy them)
- Treasury on the **destination** network funded with enough destination asset
  for the payout (and free of blocking RESERVED rows)

Confirm the app sees both networks:

```bash
curl -s http://localhost:3000/api/networks | jq '.[].id'
# expect … base-sepolia … fortel2-sepolia …
```

Creating a payment whose network is missing from deployments returns 400
(`network … has no deployed contracts`).

### Funding state (spot-check)

- **Source** entity wallet (ACME on Base Sepolia): enough `mockUSDC` for the
  payment amount + gas dust for the exact per-payment allowance tx
- **Destination** treasury (ForteL2): enough `mockJPY` (or dest asset) free —
  not parked/reserved — to cover `estimated_destination_amount`
- Operator/deployer gas on both chains

### App up

Signed in as OPERATOR (key from `npm run setup` / `chain/dev-api-keys.json`).
Dev server on `:3000`.

## Happy path — base-sepolia → fortel2-sepolia

Use a modest notional so destination liquidity is not the story
(e.g. `$25000.00` USD→JPY). Mirror README "API".

### 1. Create (DRAFT)

```bash
KEY='<OPERATOR key>'

curl -s -X POST http://localhost:3000/api/payments \
  -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" \
  -d '{
    "sender_id": "ent_acme_us",
    "recipient_id": "ent_tokyo_supplier",
    "amount": "25000.00",
    "source_currency": "USD",
    "destination_currency": "JPY",
    "source_network": "base-sepolia",
    "destination_network": "fortel2-sepolia",
    "purpose": "supplier_payment",
    "reference_id": "FORTE-BRIDGE-QA-001"
  }' | tee /tmp/forte-bridge-create.json | jq .
```

Record `PAY_ID` from `payment_id` in the response. Confirm networks via a follow-up GET if needed.

### 2. Quote

```bash
curl -s -X POST "http://localhost:3000/api/payments/$PAY_ID/quote" \
  -H "x-api-key: $KEY" | tee /tmp/forte-bridge-quote.json | jq .
```

Assert:

- A route with `strategy: "BRIDGE_AND_SETTLE"` is present and `recommended: true`
- `source_network: "base-sepolia"`, `destination_network: "fortel2-sepolia"`
- `bridge_fee_bps: 5`
- `destination_asset: "mockJPY"`, `source_asset: "mockUSDC"`
- Description / hops name **Base Sepolia** and **ForteL2 Sepolia**
- `liquidity_available: true`

**Gap the hermetic tests leave open:** if destination free treasury is short
but parked MMF liquidity covers, the live quote should show
`recall_required: true`. Confirm that flag only when you have an ACTIVE
position on ForteL2 large enough to matter; the DB tests deliberately do not
assert it (no live fortel2 treasury read in CI).

Select the bridge route if the UI/API requires an explicit select (browser
demo selects recommended by default on execute after quote).

### 3. Execute

```bash
curl -s -X POST "http://localhost:3000/api/payments/$PAY_ID/execute" \
  -H "x-api-key: $KEY" | tee /tmp/forte-bridge-execute.json | jq '{payment_id, status, transaction_hash, settlement_transaction_hash}'
```

Expect `status: "SETTLED"` (synchronous; allow ~tens of seconds across two
live networks). The execute response carries source-chain hashes only —
read `destinationTxHash` from the detail GET below.

If compliance returns `MANUAL_REVIEW`, approve as REVIEWER then re-execute:

```bash
curl -s -X POST "http://localhost:3000/api/payments/$PAY_ID/review" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <REVIEWER key>" \
  -d '{"decision":"APPROVE"}'
```

### 4. SETTLED evidence to capture

Payment detail returns the Prisma row shape (camelCase) under `payment`:

```bash
curl -s "http://localhost:3000/api/payments/$PAY_ID" \
  -H "x-api-key: $KEY" | tee /tmp/forte-bridge-detail.json | jq '.payment | {
    status,
    sourceNetwork,
    destinationNetwork,
    txHash,
    settleTxHash,
    destinationTxHash,
    destinationAmount,
    selectedRouteId
  }'
```

| Evidence | Where | Pass criteria |
|---|---|---|
| Source escrow + settle txs | `payment.txHash`, `payment.settleTxHash` | Non-null `0x…` on **Base Sepolia**; Basescan links work |
| Destination payout tx | `payment.destinationTxHash` | Non-null `0x…` on **ForteL2**; no explorer URL — verify via `cast` / raw RPC |
| Audit actions | `payment.auditEvents[].action` | Includes `bridge.destination_payout` with detail `network: "fortel2-sepolia"` |
| Chain integrity | `GET /api/audit` | verdict **INTACT** |
| Recipient balance | ForteL2 `mockJPY` of Tokyo wallet | Increased by `destinationAmount` (0 decimals) |

Verify the ForteL2 payout without an explorer:

```bash
DEST_TX=$(jq -r '.payment.destinationTxHash' /tmp/forte-bridge-detail.json)
cast receipt "$DEST_TX" --rpc-url "$FORTEL2_SEPOLIA_RPC_URL"
cast tx     "$DEST_TX" --rpc-url "$FORTEL2_SEPOLIA_RPC_URL"
```

### 5. Optional reverse leg

Repeat create→quote→execute with
`source_network: "fortel2-sepolia"` and
`destination_network: "base-sepolia"`. Escrow txs land on ForteL2 (raw hashes);
`destination_tx_hash` is a Base Sepolia transfer (Basescan link). Same audit /
INTACT checks.

## Failure / repair spot-checks

Do these on a **separate** payment (do not corrupt the happy-path SETTLED row).
Prefer staging failures with operator tooling or a deliberately underfunded
destination treasury rather than killing the sequencer mid-flight on a shared
demo chain.

### Stuck list

- UI: `/payments/stuck` (OPERATOR)
- API: `GET /api/payments?stuck=true` with OPERATOR key

A payment that still holds sender funds (reservation + escrow INITIATED/SETTLED
or unknown RPC) must remain listed. A flaky ForteL2 read must **not** hide it
(`escrow_state: null` is kept — see AGENTS.md stuckPayments invariant).

### Compensation path (destination payout failed after source settle)

When the source escrow is already SETTLED and the destination payout did **not**
land (`destination_tx_hash` still null):

1. Payment should move to `COMPENSATION_PENDING` (or already `COMPENSATED` if the
   automatic treasury repayment succeeded).
2. Compensation is on the **source** network / **source** asset back to the
   sender — never `failAndRefund` on a released escrow.
3. If stuck in `COMPENSATION_PENDING`:  
   `POST /api/payments/$PAY_ID/repair` as OPERATOR (idempotent; must not
   double-pay once `COMPENSATED`).
4. Confirm audit contains `payment.compensation_transfer` (or repair equivalent)
   and **no** pairing of that with a kept recipient credit / `destination_tx_hash`
   (treasury double-pay).

### Forward-complete (payout landed, bookkeeping threw)

If `destination_tx_hash` is set but status was not yet SETTLED, repair/recovery
must **complete forward** to SETTLED — never compensate. Spot-check: recipient
keeps ForteL2 tokens; sender is not also repaid.

## Explicit non-goals for this run

- Do not expect a real OP Stack / Standard Bridge message — SettlementOS
  simulates the bridge in-app.
- Do not require a ForteL2 block explorer (F1: links stay null).
- MMF park→accrue→recall on ForteL2 is a separate runbook
  (`tasks/runbooks/fortel2-mmf-redeploy.md` once present); only touch it here
  if validating `recall_required` on the bridge quote.
