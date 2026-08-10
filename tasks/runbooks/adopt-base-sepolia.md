# Adopt Base Sepolia contracts into a fresh overlay

**When:** `chain/deployments.base-sepolia.json` is missing (or was deleted) but
the 2026-07-07 contracts are still live and `DEPLOYER_PRIVATE_KEY` in `.env`
still derives the on-chain operator
`0x5128889F20Ec13e0Be38b2BeBC568594159B652d`.

**Why not a full redeploy:** auto-detect treats "no overlay" as `full` and would
deploy new escrow/tokens, breaking the documented same-`PaymentSettlement`
address property and orphaning every Basescan link in the docs. `--adopt` never
deploys PaymentSettlement or MockERC20.

## Preconditions

| Check | Notes |
|---|---|
| `DEPLOYER_PRIVATE_KEY` in `.env` | Must be the original operator (see table in AGENTS.md). |
| No `chain/deployments.base-sepolia.json` | Adopt refuses to overwrite an existing overlay. |
| Deployer gas | Dust + one TokenizedMMF deploy; ~2 ETH is ample. |
| Do **not** touch `deployments.fortel2-sepolia.json` | Only copy of ForteL2 wallet keys. |

## Procedure

```bash
# 1) Preflight — bytecode verify + plan; no transactions
node --env-file=.env scripts/deploy-testnet.mjs base-sepolia --adopt --preflight-only

# Expect: Deploy mode: adopt; every listed contract "ok" with non-zero bytes;
# TokenizedMMF add-on in the plan (Base Sepolia predates F4).

# 2) Live adopt
node --env-file=.env scripts/deploy-testnet.mjs base-sepolia --adopt

# 3) Prove it — ACME → Tokyo USD→JPY on base-sepolia (after npm run setup / dev)
# create → quote → execute; expect SETTLED with escrow + settle hashes on Basescan.
```

## What adopt does

1. Verifies bytecode at every address in `ADOPTABLE_NETWORKS["base-sepolia"]`.
2. Generates **new** treasury + entity wallets (old ones cannot sign).
3. Funds them with gas dust (Base Sepolia per-network targets).
4. Mints demo mock balances (permissionless `MockERC20.mint`).
5. Deploys `TokenizedMMF`, mints the 50k mockUSDC yield buffer, treasury MAX-approves.
6. Writes `chain/deployments.base-sepolia.json` and registers wallets in the DB.

## Traps

- Bare `npm run deploy:base-sepolia` without `--adopt` → full redeploy. Don't.
- Empty bytecode at any registered address → abort; do not improvise addresses.
- No standing entity→escrow allowances (exact per-payment at execute time).
- Overlay holds private keys — never commit it; back it up offline like ForteL2's.

## Network-generic reuse

`ADOPTABLE_NETWORKS` is keyed by network id. A ForteL2 Phase 7/8 re-genesis
gets a new entry (new contract addresses after the wipe), then the same
`--adopt` flag. See AGENTS.md "Where addresses come from, and when they change."
