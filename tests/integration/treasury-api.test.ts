// Treasury/MMF API route handlers invoked directly (no HTTP server): validation
// contracts, the institutional-only guardrail, and a park -> positions -> recall
// round-trip against the fixture chain.
//
// Parking moves real fixture mockUSDC, so every test unwinds itself. The accrual
// block runs LAST in the file: the fund's index is monotonic, so accruing is
// one-way and later assertions must not assume par.

import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { API_KEY_HEADER } from "@/lib/auth";
import { API_KEYS } from "../fixture";
import { POST as accruePOST } from "@/app/api/treasury/accrue/route";
import { POST as parkPOST } from "@/app/api/treasury/park/route";
import { GET as positionsGET } from "@/app/api/treasury/positions/route";
import { POST as recallPOST } from "@/app/api/treasury/recall/route";
import { prisma } from "@/lib/db";
import { accountsFor, mmfAddress, mmfOperatorWrite, publicClientFor, MMF_ABI } from "@/lib/chain";
import { currentIndexOf, dailyIndex, MMF_ANNUAL_RATE_BPS } from "@/lib/treasury";

const NETWORK = "base-local";

function postJson(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://test.local/api/treasury/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [API_KEY_HEADER]: API_KEYS.operator },
    body: JSON.stringify(body),
    // undici requires duplex when a body is present on a constructed Request
    ...({ duplex: "half" } as object),
  });
}

/** Authenticated GET for the positions handler (reads are OPERATOR/REVIEWER only). */
function getRequest(path: string) {
  return new NextRequest(`http://test.local/api/treasury/${path}`, {
    headers: { [API_KEY_HEADER]: API_KEYS.operator },
  });
}

const parkBody = (over: Record<string, unknown> = {}) => ({
  network: NETWORK,
  asset: "mockUSDC",
  amount: "10000.00",
  entity_id: "ent_acme_us",
  ...over,
});

/** Redeem everything the treasury holds and drop the rows this file created. */
async function unwind() {
  const treasury = accountsFor(NETWORK).treasury.address;
  const shares = await publicClientFor(NETWORK).readContract({
    address: mmfAddress(NETWORK)!,
    abi: MMF_ABI,
    functionName: "sharesOf",
    args: [treasury],
  });
  if (shares > 0n) await mmfOperatorWrite(NETWORK, "redeem", [treasury, shares]);
  await prisma.treasuryPosition.deleteMany();
}

afterAll(unwind);

describe("POST /api/treasury/park", () => {
  it("parks for an eligible, opted-in entity and records the position", async () => {
    const res = await parkPOST(postJson("park", parkBody()));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ACTIVE");
    expect(data.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

    const position = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: data.position_id } });
    expect(position).toMatchObject({
      network: NETWORK,
      asset: "mockUSDC",
      status: "ACTIVE",
      shares: data.shares,
      txHashPark: data.tx_hash,
    });

    await unwind();
  });

  it("replays a retried park with the same Idempotency-Key instead of parking twice", async () => {
    const key = "park-idem-001";
    const request = () =>
      new NextRequest("http://test.local/api/treasury/park", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: API_KEYS.operator,
          "idempotency-key": key,
        },
        body: JSON.stringify(parkBody({ amount: "5000.00" })),
        ...({ duplex: "half" } as object),
      });

    const first = await parkPOST(request());
    const second = await parkPOST(request());
    const firstData = await first.json();
    const secondData = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The retry replays the first response — same position, not a second park.
    expect(secondData.position_id).toBe(firstData.position_id);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(await prisma.treasuryPosition.count({ where: { status: "ACTIVE" } })).toBe(1);

    await unwind();
  });

  it("rejects an entity that is not MMF-eligible or has not opted in", async () => {
    // ent_tokyo_supplier is a normal counterparty: neither cleared nor opted in.
    const res = await parkPOST(postJson("park", parkBody({ entity_id: "ent_tokyo_supplier" })));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe("NOT_ELIGIBLE");
    expect(data.message).toMatch(/not cleared for MMF parking/);

    const unknown = await parkPOST(postJson("park", parkBody({ entity_id: "ent_ghost" })));
    expect(unknown.status).toBe(403);

    // A refused park leaves no position behind.
    expect(await prisma.treasuryPosition.count()).toBe(0);
  });

  it("rejects missing fields, unknown networks, bad amounts, and unbacked assets", async () => {
    const missing = await parkPOST(postJson("park", { network: NETWORK, asset: "mockUSDC" }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).message).toMatch(/required/);

    const badNetwork = await parkPOST(postJson("park", parkBody({ network: "arbitrum-one" })));
    expect(badNetwork.status).toBe(400);
    expect((await badNetwork.json()).message).toMatch(/unknown network/);

    for (const amount of ["0", "-5", "ten"]) {
      const res = await parkPOST(postJson("park", parkBody({ amount })));
      expect(res.status, `amount=${amount}`).toBe(400);
    }

    // The fund is backed by mockUSDC only, and no fund is deployed on a real testnet.
    const wrongAsset = await parkPOST(postJson("park", parkBody({ asset: "mockJPY", amount: "1000" })));
    expect(wrongAsset.status).toBe(400);
    expect((await wrongAsset.json()).code).toBe("UNSUPPORTED_ASSET");

    const noFund = await parkPOST(postJson("park", parkBody({ network: "base-sepolia" })));
    expect(noFund.status).toBe(400);
    expect((await noFund.json()).code).toBe("NO_FUND");

    expect(await prisma.treasuryPosition.count()).toBe(0);
  });

  it("refuses to park more than the unreserved treasury balance", async () => {
    const res = await parkPOST(postJson("park", parkBody({ amount: "999999999.00" })));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe("INSUFFICIENT_FREE_BALANCE");

    expect(await prisma.treasuryPosition.count()).toBe(0);
  });
});

describe("GET /api/treasury/positions and POST /api/treasury/recall", () => {
  it("lists a parked position with its derived value, then recalls it T+0", async () => {
    const parked = await (await parkPOST(postJson("park", parkBody({ amount: "20000.00" })))).json();

    const listed = await (await positionsGET(getRequest("positions"))).json();
    expect(listed.positions).toHaveLength(1);
    // The list is paginated (append-only history that only grows), so the paging
    // envelope is present.
    expect(listed).toMatchObject({ has_more: false });
    expect(listed).toHaveProperty("next_cursor");
    const active = listed.positions[0];
    expect(active).toMatchObject({
      position_id: parked.position_id,
      network: NETWORK,
      asset: "mockUSDC",
      status: "ACTIVE",
      shares: parked.shares,
      amount_in: "20000",
      index_at_entry: parked.index_at_entry,
      tx_hash_park: parked.tx_hash,
      tx_hash_recall: null,
      recalled_at: null,
    });
    // Value is derived from the fund's live index, never stored on the row.
    expect(active.current_index).toBe((await currentIndexOf(NETWORK)).toString());
    expect(Number(active.current_value)).toBeGreaterThanOrEqual(20_000 - 0.000_001);
    expect(Number(active.accrued_yield)).toBeGreaterThanOrEqual(0);

    const res = await recallPOST(postJson("recall", { position_id: parked.position_id }));
    expect(res.status).toBe(200);
    const recalled = await res.json();
    expect(recalled).toMatchObject({ position_id: parked.position_id, status: "RECALLED" });
    expect(recalled.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(recalled.amount)).toBeGreaterThanOrEqual(20_000 - 0.000_001);

    // The row is history now: still listed, flipped in place, with both tx hashes.
    const after = await (await positionsGET(getRequest("positions"))).json();
    expect(after.positions[0]).toMatchObject({
      position_id: parked.position_id,
      status: "RECALLED",
      tx_hash_park: parked.tx_hash,
      tx_hash_recall: recalled.tx_hash,
      current_index: null,
      current_value: null,
    });
    expect(after.positions[0].recalled_at).not.toBeNull();

    await unwind();
  });

  it("rejects a missing, unknown, or already-recalled position", async () => {
    const missing = await recallPOST(postJson("recall", {}));
    expect(missing.status).toBe(400);
    expect((await missing.json()).message).toMatch(/position_id is required/);

    const unknown = await recallPOST(postJson("recall", { position_id: "pos_does_not_exist" }));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("POSITION_NOT_FOUND");

    const parked = await (await parkPOST(postJson("park", parkBody({ amount: "1000.00" })))).json();
    const first = await recallPOST(postJson("recall", { position_id: parked.position_id }));
    expect(first.status).toBe(200);

    const second = await recallPOST(postJson("recall", { position_id: parked.position_id }));
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("POSITION_NOT_ACTIVE");

    await unwind();
  });
});

// Accrual raises the shared fixture fund's index for good (the contract's index is
// monotonic), so this block is last in the file.
describe("POST /api/treasury/accrue", () => {
  it("rejects a missing network, an unknown network, and one with no fund", async () => {
    const missing = await accruePOST(postJson("accrue", {}));
    expect(missing.status).toBe(400);
    expect((await missing.json()).message).toMatch(/network is required/);

    const badNetwork = await accruePOST(postJson("accrue", { network: "arbitrum-one" }));
    expect(badNetwork.status).toBe(400);
    expect((await badNetwork.json()).message).toMatch(/unknown network/);

    const noFund = await accruePOST(postJson("accrue", { network: "base-sepolia" }));
    expect(noFund.status).toBe(400);
    expect((await noFund.json()).code).toBe("NO_FUND");
  });

  it("advances the fund by one day of simulated yield", async () => {
    const before = await currentIndexOf(NETWORK);

    const res = await accruePOST(postJson("accrue", { network: NETWORK }));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toMatchObject({
      network: NETWORK,
      old_index: before.toString(),
      new_index: dailyIndex(before, MMF_ANNUAL_RATE_BPS).toString(),
      annual_rate_bps: MMF_ANNUAL_RATE_BPS.toString(),
    });
    expect(BigInt(data.new_index)).toBeGreaterThan(BigInt(data.old_index));
    expect(await currentIndexOf(NETWORK)).toBe(BigInt(data.new_index));
  });
});
