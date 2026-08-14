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

**Do this instead** — a ForteL2-specific base that only the tx helper consults:

```ts
// lib/networks.ts
const FORTEL2_EXPLORER_URL = process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL; // no trailing slash

export function explorerTxUrl(networkId: string, txHash?: string | null): string | null {
  if (!txHash) return null;
  if (networkId === "fortel2-sepolia" && FORTEL2_EXPLORER_URL) {
    return `${FORTEL2_EXPLORER_URL}/fortel2-sepolia/tx/${txHash}`;
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

## 4. ⚠️ The deployment reality — read this before you point users at it

The explorer is deployed at `https://settlementos-explorer-ihgo.onrender.com` and it is
up (health endpoint returns `ok:true`). **But its ForteL2 RPC URL is
`http://127.0.0.1:9545`, baked into the production JavaScript bundle at build time.**
I confirmed this by grepping the live bundle (`/assets/index-*.js`) — the string is
there.

The consequence is not "the server can't reach the chain". It is stranger than that:

> **The page runs in the reader's browser, so it asks the *reader's own machine* for
> chain 852 — not the server, and not your Mac.**

- On the ForteL2 host (your Mac, sequencer running): works perfectly.
- Anyone else: connection refused → the page shows an RPC-unavailable banner with an
  override form. Not a crash, but not useful either.
- Over HTTPS this is also **mixed content**. Chrome/Firefox treat loopback as
  trustworthy and allow it; **Safari is stricter and may block it outright.**

**What this means for SettlementOS:** ForteL2 tx links are useful to *operators on the
host* today, and are a dead end for everyone else. That is a deployment fact, not a code
gap, and nothing in the SOS integration changes when it is fixed.

**The fix, when someone does it** (explorer-side, decision D32): set
`VITE_FORTEL2_SEPOLIA_READ_RPC_URL` to a public replica and **rebuild** — Vite inlines
`import.meta.env`, so restarting the Node service serves the old URL. The replica also
needs CORS (`--http.corsdomain`, `--http.vhosts`) and HTTPS. The explorer already puts
`readRpcUrl` first in its URL list, so reads prefer the replica automatically with no
code change.

**Suggested posture:** gate the ForteL2 link on the env var above. Unset in
environments where it would be a dead end, set where readers are on the host. That is
one env var, no code branching.

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
3. With the env var unset, ForteL2 renders raw — no half-configured broken link.
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
  precedence). Authoritative status is that repo's `docs/PLAN.md` §0 — re-read it rather
  than trusting any checkbox here.
- Explorer tasks that built this: F6u (tx page, #49), F6v (block page, #51),
  F6w (`get_transaction`, #53), F6x (`get_block`, #55). All merged 2026-08-14, each
  verified against the live chain-852 sequencer.
