// Phase 8 guardrails and segregation, end to end: the properties a compliance
// reviewer needs to see hold — parked funds sit in the fund contract and never in
// the escrow, only an eligible + opted-in institution may park, liquidity promised
// to an in-flight payment can never be swept in, and every treasury action lands on
// the hash-chained audit log in order.
//
// Runs against the fixture chain + DB with real token movements, so each test
// unwinds itself. The park -> accrue -> recall block is LAST: accrual is one-way
// (the fund's index is monotonic), and the tests above it must not see a moved index.

import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { API_KEY_HEADER } from "@/lib/auth";
import { API_KEYS } from "../fixture";
import { POST as parkPOST } from "@/app/api/treasury/park/route";
import { prisma } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit";
import { fromBaseUnits, toBaseUnits } from "@/lib/assets";
import {
  accountsFor,
  mmfAddress,
  mmfOperatorWrite,
  networkContracts,
  publicClientFor,
  tokenBalance,
  MMF_ABI,
} from "@/lib/chain";
import {
  accrueDaily,
  park,
  recall,
  valueOfShares,
  TreasuryError,
  TREASURY_ACCRUED,
  TREASURY_PARKED,
  TREASURY_RECALLED,
} from "@/lib/treasury";
import { createDraftPayment } from "../helpers/payments";

const NETWORK = "base-local";
const USDC_DECIMALS = 6;

const treasuryAddress = () => accountsFor(NETWORK).treasury.address;
const usdcAddress = () => networkContracts(NETWORK).tokens.mockUSDC.address;
const escrowAddress = () => networkContracts(NETWORK).PaymentSettlement;

const sharesHeld = () =>
  publicClientFor(NETWORK).readContract({
    address: mmfAddress(NETWORK)!,
    abi: MMF_ABI,
    functionName: "sharesOf",
    args: [treasuryAddress()],
  });

/** Redeem everything the treasury holds and drop the rows this file created. */
async function unwind() {
  const shares = await sharesHeld();
  if (shares > 0n) await mmfOperatorWrite(NETWORK, "redeem", [treasuryAddress(), shares]);
  await prisma.treasuryPosition.deleteMany();
}

function parkRequest(body: Record<string, unknown>) {
  return new NextRequest("http://test.local/api/treasury/park", {
    method: "POST",
    headers: { "content-type": "application/json", [API_KEY_HEADER]: API_KEYS.operator },
    body: JSON.stringify(body),
    // undici requires duplex when a body is present on a constructed Request
    ...({ duplex: "half" } as object),
  });
}

afterAll(unwind);

describe("institutional-only guardrail", () => {
  it("refuses to park for an entity that has not opted in, at the lib layer and via the API", async () => {
    // ACME is the one cleared institution — revoke its opt-in for the duration.
    await prisma.entity.update({ where: { externalId: "ent_acme_us" }, data: { mmfOptIn: false } });
    try {
      const attempt = park({
        networkId: NETWORK,
        asset: "mockUSDC",
        amount: "1000.00",
        entityId: "ent_acme_us",
      });
      await expect(attempt).rejects.toThrow(TreasuryError);
      await expect(attempt).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });

      const res = await parkPOST(
        parkRequest({ network: NETWORK, asset: "mockUSDC", amount: "1000.00", entity_id: "ent_acme_us" })
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("NOT_ELIGIBLE");
    } finally {
      await prisma.entity.update({ where: { externalId: "ent_acme_us" }, data: { mmfOptIn: true } });
    }

    // A counterparty that was never cleared is refused on the eligibility flag too.
    const supplier = parkPOST(
      parkRequest({ network: NETWORK, asset: "mockUSDC", amount: "1000.00", entity_id: "ent_tokyo_supplier" })
    );
    expect((await supplier).status).toBe(403);

    // Nothing was parked: no position row, no shares, no audit event.
    expect(await prisma.treasuryPosition.count()).toBe(0);
    expect(await sharesHeld()).toBe(0n);
  });

  it("refuses to park liquidity reserved for an in-flight payment", async () => {
    const balance = await tokenBalance(NETWORK, usdcAddress(), treasuryAddress());
    const headroom = toBaseUnits("500.00", USDC_DECIMALS);
    expect(balance).toBeGreaterThan(headroom);

    // Promise everything but 500 mockUSDC to a payment in flight.
    const payment = await createDraftPayment();
    await prisma.liquidityReservation.create({
      data: {
        paymentId: payment.id,
        asset: "mockUSDC",
        network: NETWORK,
        amount: fromBaseUnits(balance - headroom, USDC_DECIMALS),
      },
    });

    try {
      const attempt = park({ networkId: NETWORK, asset: "mockUSDC", amount: "600.00" });
      await expect(attempt).rejects.toMatchObject({ code: "INSUFFICIENT_FREE_BALANCE" });

      const res = await parkPOST(
        parkRequest({ network: NETWORK, asset: "mockUSDC", amount: "600.00", entity_id: "ent_acme_us" })
      );
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("INSUFFICIENT_FREE_BALANCE");

      // The reserved asset never left the treasury wallet.
      expect(await tokenBalance(NETWORK, usdcAddress(), treasuryAddress())).toBe(balance);
      expect(await prisma.treasuryPosition.count()).toBe(0);
      expect(await sharesHeld()).toBe(0n);
    } finally {
      await prisma.liquidityReservation.delete({ where: { paymentId: payment.id } });
      await unwind();
    }
  });
});

// Accrual raises the shared fixture fund's index for good, so this block runs last.
describe("segregation and the audit chain across park -> accrue -> recall", () => {
  it("holds parked funds in the MMF, leaves the escrow untouched, and audits every step in order", async () => {
    const fund = mmfAddress(NETWORK)!;
    const escrow = escrowAddress();
    const usdc = usdcAddress();

    const escrowBefore = await tokenBalance(NETWORK, usdc, escrow);
    const fundBefore = await tokenBalance(NETWORK, usdc, fund);
    const treasuryBefore = await tokenBalance(NETWORK, usdc, treasuryAddress());
    const auditBefore = await prisma.auditEvent.findFirst({ orderBy: { id: "desc" } });
    const sinceId = auditBefore?.id ?? 0;

    // 1. Park: the asset moves treasury -> fund. The escrow is not on the path.
    const parked = await park({ networkId: NETWORK, asset: "mockUSDC", amount: "80000.00", entityId: "ent_acme_us" });
    const principal = toBaseUnits("80000.00", USDC_DECIMALS);
    expect(parked.assetAmount).toBe(principal);

    expect(await tokenBalance(NETWORK, usdc, fund)).toBe(fundBefore + principal);
    expect(await tokenBalance(NETWORK, usdc, treasuryAddress())).toBe(treasuryBefore - principal);
    expect(await tokenBalance(NETWORK, usdc, escrow)).toBe(escrowBefore);

    // 2. Accrue: the index rises, the position's value is derived from it, and no
    //    asset moves anywhere — least of all through the escrow.
    const accrual = await accrueDaily(NETWORK);
    expect(accrual.newIndex).toBeGreaterThan(accrual.oldIndex);
    expect(await tokenBalance(NETWORK, usdc, escrow)).toBe(escrowBefore);
    expect(await tokenBalance(NETWORK, usdc, fund)).toBe(fundBefore + principal);

    const row = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: parked.positionId } });
    const derived = valueOfShares(BigInt(row.shares), accrual.newIndex);
    expect(derived).toBeGreaterThan(principal);

    // 3. Recall T+0: principal + yield returns to the treasury, still bypassing escrow.
    const recalled = await recall(parked.positionId);
    expect(recalled.assetAmount).toBe(derived);
    expect(recalled.assetAmount).toBeGreaterThan(principal);

    expect(await tokenBalance(NETWORK, usdc, escrow)).toBe(escrowBefore);
    expect(await tokenBalance(NETWORK, usdc, fund)).toBe(fundBefore + principal - recalled.assetAmount);
    expect(await tokenBalance(NETWORK, usdc, treasuryAddress())).toBe(
      treasuryBefore - principal + recalled.assetAmount
    );
    expect(await sharesHeld()).toBe(0n);

    // The three treasury actions are on the hash-chained log, in the order they happened.
    const events = await prisma.auditEvent.findMany({
      where: { id: { gt: sinceId }, action: { in: [TREASURY_PARKED, TREASURY_ACCRUED, TREASURY_RECALLED] } },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual([TREASURY_PARKED, TREASURY_ACCRUED, TREASURY_RECALLED]);
    expect(JSON.parse(events[0].detail)).toMatchObject({
      positionId: parked.positionId,
      entityId: "ent_acme_us",
      amount: "80000",
      fund,
    });
    expect(JSON.parse(events[2].detail)).toMatchObject({
      positionId: parked.positionId,
      principal: "80000",
      yield: fromBaseUnits(recalled.assetAmount - principal, USDC_DECIMALS),
      indexAtExit: accrual.newIndex.toString(),
    });
    await expect(verifyAuditChain()).resolves.toMatchObject({ valid: true });

    // History survives: the row is flipped in place, never deleted.
    const after = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: parked.positionId } });
    expect(after).toMatchObject({
      status: "RECALLED",
      shares: parked.shares.toString(),
      txHashPark: parked.txHash,
      txHashRecall: recalled.txHash,
    });

    await unwind();
  });
});
