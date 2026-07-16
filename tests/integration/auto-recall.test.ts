// Parked liquidity is available-with-recall-delay (US-008): a quote still clears
// when the treasury's free balance falls short but the MMF holds enough, and the
// executor redeems those positions T+0 before it reserves and escrows.
//
// Runs against the fixture chains + DB, so every test unwinds: the shared fund
// must be left with zero treasury shares (other suites assume that).

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit";
import { executePayment } from "@/lib/executor";
import { fromBaseUnits, toBaseUnits } from "@/lib/assets";
import { accountsFor, mmfAddress, mmfOperatorWrite, publicClientFor, MMF_ABI } from "@/lib/chain";
import { availableLiquidity, type RouteOption } from "@/lib/routing";
import {
  freeTreasuryBalance,
  park,
  parkedBalance,
  TREASURY_AUTO_RECALLED,
  TREASURY_RECALLED,
} from "@/lib/treasury";
import { createApprovedPayment } from "../helpers/payments";

const NETWORK = "base-local";
const USDC_DECIMALS = 6;
/** Free balance deliberately left behind when parking — far short of a $100k payment. */
const HEADROOM = toBaseUnits("20000.00", USDC_DECIMALS);

const treasuryAddress = () => accountsFor(NETWORK).treasury.address;

const sharesHeld = () =>
  publicClientFor(NETWORK).readContract({
    address: mmfAddress(NETWORK)!,
    abi: MMF_ABI,
    functionName: "sharesOf",
    args: [treasuryAddress()],
  });

/** Redeem anything still parked and drop the rows this file created. */
async function unwind() {
  const shares = await sharesHeld();
  if (shares > 0n) await mmfOperatorWrite(NETWORK, "redeem", [treasuryAddress(), shares]);
  await prisma.treasuryPosition.deleteMany();
}

afterAll(unwind);

/** Park everything but HEADROOM, so a six-figure payment cannot be funded free. */
async function parkAllButHeadroom() {
  const { free } = await freeTreasuryBalance(NETWORK, "mockUSDC");
  expect(free).toBeGreaterThan(HEADROOM);
  return park({
    networkId: NETWORK,
    asset: "mockUSDC",
    amount: fromBaseUnits(free - HEADROOM, USDC_DECIMALS),
    entityId: "ent_acme_us",
  });
}

/** A same-network USD→USD payment, so the destination asset is the MMF's asset. */
const usdPayment = () =>
  createApprovedPayment({
    amount: "100000.00",
    sourceCurrency: "USD",
    destinationCurrency: "USD",
    sourceNetwork: NETWORK,
    destinationNetwork: NETWORK,
  });

describe("quoting with parked liquidity", () => {
  it("flags recall_required when free liquidity falls short but the MMF covers it", async () => {
    const parked = await parkAllButHeadroom();
    try {
      const free = await availableLiquidity("mockUSDC", NETWORK);
      const payment = await usdPayment();
      const routes = JSON.parse(payment.quoteJson!) as RouteOption[];

      // The payment needs more than the treasury holds free, but less than free + parked.
      const needed = Number(routes[0].estimated_destination_amount);
      expect(Number(free.available)).toBeLessThan(needed);
      const parkedUsd = Number(fromBaseUnits(parked.assetAmount, USDC_DECIMALS));
      expect(Number(free.available) + parkedUsd).toBeGreaterThan(needed);

      for (const route of routes) {
        expect(route.liquidity_available).toBe(true);
        expect(route.recall_required).toBe(true);
      }
    } finally {
      await unwind();
    }
  });

  it("leaves recall_required false when free liquidity already covers the payment", async () => {
    expect(await parkedBalance(NETWORK, "mockUSDC")).toBe(0n);

    const payment = await usdPayment();
    const routes = JSON.parse(payment.quoteJson!) as RouteOption[];
    for (const route of routes) {
      expect(route.liquidity_available).toBe(true);
      expect(route.recall_required).toBe(false);
    }
  });
});

describe("executePayment — auto-recall from the MMF", () => {
  it("recalls the parked position, then settles the payment end to end", async () => {
    const parked = await parkAllButHeadroom();
    const payment = await usdPayment();
    const route = (JSON.parse(payment.quoteJson!) as RouteOption[])[0];
    expect(route.recall_required).toBe(true);

    const settled = await executePayment(payment.id);

    expect(settled.status).toBe("SETTLED");
    expect(settled.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(settled.settleTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The parked position funded it: redeemed T+0, marked RECALLED in place.
    const position = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: parked.positionId } });
    expect(position).toMatchObject({ status: "RECALLED", txHashPark: parked.txHash });
    expect(position.txHashRecall).toMatch(/^0x[0-9a-f]{64}$/);
    expect(position.recalledAt).toBeInstanceOf(Date);
    expect(await sharesHeld()).toBe(0n);
    expect(await parkedBalance(NETWORK, "mockUSDC")).toBe(0n);

    // The recall shows up on the payment's own audit trail as well as the fund's.
    const events = await prisma.auditEvent.findMany({
      where: { paymentId: payment.id },
      orderBy: { id: "asc" },
    });
    const autoRecall = events.find((e) => e.action === TREASURY_AUTO_RECALLED);
    expect(autoRecall).toBeDefined();
    expect(JSON.parse(autoRecall!.detail)).toMatchObject({
      network: NETWORK,
      asset: "mockUSDC",
      needed: route.estimated_destination_amount,
      positionIds: [parked.positionId],
    });

    const recalled = await prisma.auditEvent.findFirst({
      where: { action: TREASURY_RECALLED },
      orderBy: { id: "desc" },
    });
    expect(JSON.parse(recalled!.detail)).toMatchObject({ positionId: parked.positionId });

    // Auto-recall runs BEFORE the reservation, so the payment reserved and consumed
    // liquidity that was parked moments earlier.
    const actions = events.map((e) => e.action);
    expect(actions.indexOf(TREASURY_AUTO_RECALLED)).toBeLessThan(
      actions.indexOf("payment.status.liquidity_reserved")
    );
    const reservation = await prisma.liquidityReservation.findUnique({ where: { paymentId: payment.id } });
    expect(reservation?.status).toBe("CONSUMED");

    await expect(verifyAuditChain()).resolves.toMatchObject({ valid: true });
    await unwind();
  });

  it("fails the payment and leaves no reservation when the recall cannot be covered", async () => {
    const parked = await parkAllButHeadroom();
    const payment = await usdPayment();
    expect((JSON.parse(payment.quoteJson!) as RouteOption[])[0].recall_required).toBe(true);

    // Failure injection: drop the position row without redeeming it. The asset is
    // still stranded in the fund, so free liquidity is short and there is no
    // position left to recall — the payment must fail rather than settle.
    await prisma.treasuryPosition.delete({ where: { id: parked.positionId } });

    await expect(executePayment(payment.id)).rejects.toThrow(/Auto-recall of parked mockUSDC/);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("FAILED");
    expect(after.failureReason).toMatch(/Auto-recall/);
    expect(after.txHash).toBeNull(); // nothing ever hit the chain

    const reservation = await prisma.liquidityReservation.findUnique({ where: { paymentId: payment.id } });
    expect(reservation?.status ?? "NONE").not.toBe("RESERVED");
    await expect(verifyAuditChain()).resolves.toMatchObject({ valid: true });

    await unwind(); // redeem the shares the deleted row left behind
  });
});
