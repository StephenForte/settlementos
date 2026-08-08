// Execute-time recall when free liquidity is short (T5-6 / T7).
//
// recall_required is a quote-time snapshot. A flaky RPC during quoting freezes
// it false even when parked MMF liquidity would cover — execution must measure
// free balance and recall when short, not trust the flag. The inverse trap:
// do not recall when free already covers (recall is one-way).
//
// Shares the fixture fund with other MMF suites — unwind leaves zero treasury
// shares. Derive expectations from the live fund, not par.

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit";
import { executePayment } from "@/lib/executor";
import { fromBaseUnits, toBaseUnits } from "@/lib/assets";
import { accountsFor, mmfAddress, mmfOperatorWrite, publicClientFor, MMF_ABI } from "@/lib/chain";
import { type RouteOption } from "@/lib/routing";
import {
  freeTreasuryBalance,
  park,
  parkedBalance,
  recall,
  TREASURY_AUTO_RECALLED,
} from "@/lib/treasury";
import { createApprovedPayment } from "../helpers/payments";

const NETWORK = "base-local";
const USDC_DECIMALS = 6;
const HEADROOM = toBaseUnits("20000.00", USDC_DECIMALS);

const treasuryAddress = () => accountsFor(NETWORK).treasury.address;

const sharesHeld = () =>
  publicClientFor(NETWORK).readContract({
    address: mmfAddress(NETWORK)!,
    abi: MMF_ABI,
    functionName: "sharesOf",
    args: [treasuryAddress()],
  });

async function unwind() {
  const shares = await sharesHeld();
  if (shares > 0n) await mmfOperatorWrite(NETWORK, "redeem", [treasuryAddress(), shares]);
  await prisma.treasuryPosition.deleteMany();
}

afterAll(unwind);

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

const usdPayment = () =>
  createApprovedPayment({
    amount: "100000.00",
    sourceCurrency: "USD",
    destinationCurrency: "USD",
    sourceNetwork: NETWORK,
    destinationNetwork: NETWORK,
  });

describe("execute-time recall when free is short (T7)", () => {
  it("settles by recalling parked liquidity when recall_required was frozen false", async () => {
    // Quote while free covers (the RPC-degrade / snapshot case), then park so
    // execute-time free is short but parked would cover — today's bug fails
    // the payment without ever calling recallForPayment.
    try {
      const payment = await usdPayment();
      const route = (JSON.parse(payment.quoteJson!) as RouteOption[])[0];
      expect(route.recall_required).toBe(false);

      await parkAllButHeadroom();
      const sharesBefore = await sharesHeld();
      expect(sharesBefore).toBeGreaterThan(0n);
      const freeBefore = await freeTreasuryBalance(NETWORK, "mockUSDC");
      expect(freeBefore.free).toBeLessThan(
        toBaseUnits(route.estimated_destination_amount, USDC_DECIMALS)
      );

      const settled = await executePayment(payment.id);

      expect(settled.status).toBe("SETTLED");
      expect(await sharesHeld()).toBeLessThan(sharesBefore);

      const events = await prisma.auditEvent.findMany({ where: { paymentId: payment.id } });
      expect(events.map((e) => e.action)).toContain(TREASURY_AUTO_RECALLED);
      await expect(verifyAuditChain()).resolves.toMatchObject({ valid: true });
    } finally {
      await unwind();
    }
  });

  it("does not recall when free liquidity already covers at execute", async () => {
    // Park a small position so the fund is non-empty, but leave free above the
    // payment — recalling would be wasteful and one-way.
    try {
      await park({
        networkId: NETWORK,
        asset: "mockUSDC",
        amount: "10000.00",
        entityId: "ent_acme_us",
      });
      const payment = await usdPayment();
      expect((JSON.parse(payment.quoteJson!) as RouteOption[])[0].recall_required).toBe(false);

      const sharesBefore = await sharesHeld();
      expect(sharesBefore).toBeGreaterThan(0n);

      const settled = await executePayment(payment.id);

      expect(settled.status).toBe("SETTLED");
      expect(await sharesHeld()).toBe(sharesBefore);

      const events = await prisma.auditEvent.findMany({ where: { paymentId: payment.id } });
      expect(events.map((e) => e.action)).not.toContain(TREASURY_AUTO_RECALLED);
    } finally {
      await unwind();
    }
  });

  it("fails at step 1 with insufficient liquidity when neither free nor parked covers", async () => {
    try {
      const parked = await parkAllButHeadroom();
      const payment = await usdPayment();

      // Drop the position row without redeeming — asset stranded in the fund,
      // parkedBalance is 0, free is short. Step 0 skips recall; step 1 owns
      // the honest insufficient-liquidity failure (nothing escrowed/reserved).
      await prisma.treasuryPosition.delete({ where: { id: parked.positionId } });
      expect(await parkedBalance(NETWORK, "mockUSDC")).toBe(0n);

      await expect(executePayment(payment.id)).rejects.toThrow(
        /Insufficient mockUSDC liquidity on base-local/
      );

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe("FAILED");
      expect(after.failureReason).toMatch(/Insufficient mockUSDC liquidity/);
      expect(after.txHash).toBeNull();

      const reservation = await prisma.liquidityReservation.findUnique({
        where: { paymentId: payment.id },
      });
      expect(reservation?.status ?? "NONE").not.toBe("RESERVED");
      await expect(verifyAuditChain()).resolves.toMatchObject({ valid: true });
    } finally {
      await unwind();
    }
  });

  it("no-ops when recall_required is frozen true but free now covers", async () => {
    try {
      const parked = await parkAllButHeadroom();
      const payment = await usdPayment();
      const route = (JSON.parse(payment.quoteJson!) as RouteOption[])[0];
      expect(route.recall_required).toBe(true);

      await recall(parked.positionId);
      expect(await parkedBalance(NETWORK, "mockUSDC")).toBe(0n);
      const free = await freeTreasuryBalance(NETWORK, "mockUSDC");
      expect(free.free).toBeGreaterThan(
        toBaseUnits(route.estimated_destination_amount, USDC_DECIMALS)
      );

      const settled = await executePayment(payment.id);

      expect(settled.status).toBe("SETTLED");
      const events = await prisma.auditEvent.findMany({ where: { paymentId: payment.id } });
      expect(events.map((e) => e.action)).not.toContain(TREASURY_AUTO_RECALLED);
    } finally {
      await unwind();
    }
  });
});
