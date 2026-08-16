# Linking SettlementOS to the ForteL2 explorer

**For:** whoever implements the SettlementOS side · **Status:** explorer side is merged and live
**Written:** 2026-08-14, verified against `settlementos` at `f4b3402` and
`settlementos-explorer` at `5de764f`

SettlementOS renders an escrow-tx cell per payment. On Base it links to Basescan; on
ForteL2 it renders a **bare hash that goes nowhere**, because chain 852 has no public
explorer. That gap is now closed on the explorer side: transaction pages, block pages,
and two MCP tools all resolve chain-852 hashes with labelled counterparties and decoded
escrow events.

This doc is what you need to wire it up — **including the two things that will bite you**,
both of which are about SettlementOS's own code rather than the explorer's.

---

## 1. The change is one function, and you already have the chokepoint

Every tx link in SettlementOS goes through **one** helper:

```ts
// lib/networks.ts:102
export function explorerTxUrl(networkId: string, txHash?: string | null): string | null {
  const n = NETWORKS[networkId];
  if (!n?.explorerUrl || !txHash) return null;
  return `${n.explorerUrl}/tx/${txHash}`;
}
```

Its six call sites — `app/page.tsx:168`, `app/payments/page.tsx:114`,
`app/payments/[id]/page.tsx:365,372,384`, `app/payments/stuck/page.tsx:44` — all pass
through it, and `Hash` (`components/ui.tsx:73`) already degrades to plain text when the
href is null. **So the feature is a change to `explorerTxUrl` and nothing else.** No
component changes, no prop changes.

---

## 2. ⚠️ Do not fix this by setting `explorerUrl` on the ForteL2 entry

This is the obvious move and it is wrong. `explorerUrl` feeds **two** helpers, and only
one of them would work:

| SettlementOS call | Produces | Explorer route? |
|---|---|---|
| `explorerTxUrl('fortel2-sepolia', h)` | `<base>/tx/<h>` | ✅ works — see the alias contract in §3 |
| `explorerAddressUrl('fortel2-sepolia', a)` | `<base>/address/<a>` | ❌ **no such route** |

The explorer's address route is `/{networkId}/address/{address}` — there is no bare
`/address/…`. An unmatched path hits the catch-all, which does
`<Navigate to="/base-sepolia" replace />`. So a ForteL2 address link would **silently
land the reader on the Base Sepolia overview page** — wrong network, no error, looks
like a working link. `app/liquidity/page.tsx:107` already calls `explorerAddressUrl`,
so this is reachable today.

Setting `explorerUrl` also changes an API contract: it is published as `explorer_url`
by `app/api/networks/route.ts:13` and `lib/mcp/tools.ts:48`, where consumers reasonably
read it as "a Basescan-shaped explorer".

**Do this instead** — a ForteL2-specific base that only the tx helper consults.
Unset falls back to the live explorer; empty string disables (tests).

```ts
// lib/networks.ts
export const DEFAULT_FORTEL2_EXPLORER_URL = "https://settlementos-explorer-ihgo.onrender.com";

export function explorerTxUrl(networkId: string, txHash?: string | null): string | null {
  if (!txHash) return null;
  if (networkId === "fortel2-sepolia") {
    const raw = process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL;
    if (raw === "") return null;
    const base = (raw ?? DEFAULT_FORTEL2_EXPLORER_URL).replace(/\/+$/, "");
    return `${base}/fortel2-sepolia/tx/${txHash}`;
  }
  const n = NETWORKS[networkId];
  if (!n?.explorerUrl) return null;
  return `${n.explorerUrl}/tx/${txHash}`;
}
```

Use the **canonical** path form (`/fortel2-sepolia/tx/<hash>`) rather than the bare
alias — it is one extra string segment and it survives any future change to the default
(§3). Leave `explorerAddressUrl` alone until someone deliberately adds address linking;
if you want it, the correct shape is `<base>/fortel2-sepolia/address/<addr>`.

**`fortel2-local` (chain 901) is not in the explorer.** It knows exactly three networks.
Keep local-devnet links raw — the guard above does that by only matching
`fortel2-sepolia`.

---

## 3. The URL contract

Treat these as an integration contract, not internal routes.

**Canonical** (prefer these):

```
/{networkId}/tx/{txHash}
/{networkId}/block/{blockNumberOrHash}
```

`networkId` ∈ `base-sepolia` (84532) · `fortel2-sepolia` (852) · `polygon-amoy` (80002).

**Basescan-shaped aliases**, if you ever want one base URL across corridors:

```
/tx/{txHash}?network=fortel2-sepolia
/tx/{txHash}?chainId=852
/tx/{txHash}                          → defaults to fortel2-sepolia   (decision D33)
```

The bare form defaults to ForteL2 deliberately: Base and Amoy have public explorers, so
a link *into this app* with no network stated is by construction a chain-852 link. All
aliases `Navigate`-replace onto the canonical path, so the address bar and back button
settle on one form.

**Guarantees:**

- `txHash` is matched case-insensitively and normalised to lowercase.
- Block ids accept a decimal number **or** a `0x…` 32-byte block hash; `0979595`
  canonicalises to `979595`.
- A malformed hash renders an invalid-input page and **never reaches the RPC**.
- Deep links survive a hard refresh (the server falls through to `index.html`) —
  verified: `GET /fortel2-sepolia/tx/0x8763…` returns 200 on the deployed site.
- "Not found" and "RPC unreachable" are **different** renderings on purpose. One is an
  answer about the chain, the other about the connection, and a reader who confuses
  them draws the wrong conclusion about whether their payment happened.

---

## 4. The public replica — explorer tx pages are reachable

The explorer is deployed at `https://settlementos-explorer-ihgo.onrender.com`.
ForteL2 reads go to the public replica `https://fortel2-replica-rpc.onrender.com`
(`VITE_FORTEL2_SEPOLIA_READ_RPC_URL` / `FORTEL2_SEPOLIA_READ_RPC_URL`, inlined
at Vite build for the browser; CORS `Access-Control-Allow-Origin: *`). Writes
and SettlementOS `confirm()` stay on the Access write hostname — never point
those at the replica.

**What this means for SettlementOS:** ForteL2 escrow and settlement hashes
should link into the explorer. `explorerTxUrl` defaults to that live URL;
`NEXT_PUBLIC_FORTEL2_EXPLORER_URL=""` disables (tests). A value change on
Render needs a rebuild (`NEXT_PUBLIC_*` is baked at `next build`).

---

## 5. What the page shows that Basescan couldn't

Worth knowing, because it is the reason to link rather than to wait for a real explorer.
The explorer holds the SettlementOS address book and ABIs, so it decodes a settlement
into something a finance reader can act on. Real chain-852 example:

```
0x876325b2…8045c7   Success · block 979595 · L2 execution fee 49.399396137 gwei
  Transfer         mockUSDC   PaymentSettlement → Treasury   100000
  PaymentSettled   paymentId 0xa022e0d4…331c · settled as mockJPY
```

and its initiation two blocks earlier:

```
  PaymentInitiated  ACME US Inc → Tokyo Trading KK · USD → JPY · 100000 mockUSDC
```

Labelled entity names, not raw addresses. Basescan cannot render that for Base either,
because it does not know these labels.

One naming detail worth mirroring if you surface fees: the row is labelled **"L2
execution fee"**, not "transaction fee", because it is `gasUsed × effectiveGasPrice` and
therefore **excludes the OP-stack L1 data fee**. Calling it the transaction fee publishes
a number that is quietly too low.

---

## 6. For agents: two MCP tools

If SettlementOS agents (or Claude/ChatGPT connectors) need to answer "what happened in
this tx" without scraping HTML, the explorer's MCP server exposes:

| Tool | Arguments | Returns |
|---|---|---|
| `get_transaction` | `networkId`, `txHash` | status, labelled from/to, `l2ExecutionFeeWei` **and** `…Gwei`, decoded ERC-20 + escrow logs |
| `get_block` | `networkId`, `blockNumberOrHash` | header fields, labelled miner, `txCount`, labelled tx rows |

Endpoint `POST /mcp`, `Authorization: Bearer <MCP_API_KEY>` (OAuth also supported).
Conventions worth knowing on the consuming side:

- **`not_found` is a normal result, not an error** — `isError` is absent and the payload
  is `{status: "not_found", …}`. Only an unreachable RPC sets `isError`. Branch on the
  payload, not on the presence of a result.
- **All bigints are decimal strings** (`"49399396137"`), never JSON numbers — no
  precision loss, but don't do arithmetic on them without `BigInt()`.
- `get_transaction`'s not-found payload carries `otherNetworks` so an agent can retry the
  other corridors; `get_block`'s deliberately does not (a block *number* means nothing
  across chains).
- Every `get_block` tx row carries a `type` key, `null` for the OP-stack deposit tx that
  starts every chain-852 block. Expect one such row per block; it is not a payment.

---

## 7. Suggested acceptance for the SOS change

1. A ForteL2 payment's tx cell is a working link; a Base payment's still goes to
   Basescan. Both asserted, ideally in the same test.
2. A `fortel2-local` (chain 901) payment still renders a raw hash.
3. Empty `NEXT_PUBLIC_FORTEL2_EXPLORER_URL` still renders raw (tests). Unset uses
   the live explorer default — no half-configured broken link.
4. `explorerAddressUrl` behaviour is unchanged (or, if you extended it, it produces
   `/fortel2-sepolia/address/…` and was verified against a real address page).
5. Click through one real settlement end-to-end on the host and confirm the decoded
   events render — `0x876325b2…8045c7` is a known-good chain-852 settlement.

---

## Reference

- **In this repo:** [`tasks/prd-settlementos-explorer.md`](prd-settlementos-explorer.md)
  is the historical PRD from when the explorer was planned here. It is still accurate as
  background; this doc is the consuming-side integration contract, which that PRD
  predates.
- Explorer repo: `StephenForte/settlementos-explorer` — `docs/TX-VIEWER-PRD.md` (full
  spec), `docs/DECISIONS.md` D32 (public reach), D33 (bare `/tx/` default), D34 (link
  precedence), D38 (public sequencer-read first; ForteL2 not-found copy). Authoritative
  status is that repo's `docs/PLAN.md` §0 — re-read it rather than trusting any
  checkbox here.

## 8. Explorer RPC: sequencer-read first, replica fallback

SOS tx links are live. The explorer 404'd a just-settled hash when it talked **only**
to the public replica (`fortel2-replica-rpc`), which derives from L1 and lags ~3
minutes. Do **not** point the browser at `https://fortel2-write.ente.ltd` (Access 403;
writes). The replica repo's `fortel2-sequencer-rpc` service is a filtered public read
door onto the sequencer (Access headers stay server-side; `eth_sendRawTransaction`
is dropped).

On the explorer service, set both and **rebuild** (`VITE_*` is inlined):

| Key | Value |
|---|---|
| `VITE_FORTEL2_SEPOLIA_RPC_URL` | `https://fortel2-sequencer-rpc.onrender.com` (public sequencer-read) |
| `VITE_FORTEL2_SEPOLIA_READ_RPC_URL` | `https://fortel2-replica-rpc.onrender.com` (already set) |
| `FORTEL2_SEPOLIA_RPC_URL` / `FORTEL2_SEPOLIA_READ_RPC_URL` | same pair for the Node MCP |

SOS **server** reads stay on `http://fortel2-replica:10000`. SOS **writes** stay on
`fortel2-write.ente.ltd` + `CF_ACCESS_*`. Never point those at the replica or at this
public sequencer-read URL.
- Explorer tasks that built this: F6u (tx page, #49), F6v (block page, #51),
  F6w (`get_transaction`, #53), F6x (`get_block`, #55). All merged 2026-08-14, each
  verified against the live chain-852 sequencer.
