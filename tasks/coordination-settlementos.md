# ForteL2 ↔ SettlementOS coordination

**Canonical copy:** lives in the ForteL2 repo at `tasks/coordination-settlementos.md`.  
Keep this file as a pointer so SOS agents find ownership rules without cloning ForteL2 first.

## Product split

```text
SettlementOS  = payments product
ForteL2       = settlement rail (OP Stack)
```

## SOS may start now

Target network: **`fortel2-sepolia`**, L2 chain ID **852**.  
Rail interface: ForteL2 `deployments/rail-interface.json`.  
Handoff PRD: `tasks/prd-fortel2-integration.md`.

## Do not rebuild on ForteL2

`PaymentSettlement`, `TokenizedMMF`, compliance, FX, payment state machine, audit DB — all stay in SettlementOS.

## Replica

ForteL2 Render replica is already live. Optional **read** RPC for SOS/explorer.  
Genesis republish only when ForteL2 does a Sepolia redeploy (Phase 7). Not a blocker for F1–F5.
