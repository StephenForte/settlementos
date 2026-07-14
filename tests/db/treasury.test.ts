// Parking idle treasury liquidity into the tokenized MMF (lib/treasury.park).
// Runs against the fixture chains + DB: park moves real mockUSDC from the
// treasury wallet into the fund, so every test unwinds itself and afterAll
// leaves the shared fixture fund back at zero shares (later suites assume par).

import { describe, it, expect, afterAll } from "vitest";
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
import { availableLiquidity } from "@/lib/routing";
import { freeTreasuryBalance, park, TreasuryError, TREASURY_PARKED } from "@/lib/treasury";
import { createDraftPayment } from "../helpers/payments";

const NETWORK = "base-local";
const USDC_DECIMALS = 6;

const treasuryAddress = () => accountsFor(NETWORK).treasury.address;

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

afterAll(unwind);

describe("treasury parking", () => {
  it("parks unreserved liquidity, records the position, and shrinks available liquidity", async () => {
    const before = await availableLiquidity("mockUSDC", NETWORK);
    const fund = mmfAddress(NETWORK)!;
    const usdc = networkContracts(NETWORK).tokens.mockUSDC.address;
    const fundBefore = await tokenBalance(NETWORK, usdc, fund);

    const result = await park({ networkId: NETWORK, asset: "mockUSDC", amount: "50000.00" });

    const parked = toBaseUnits("50000.00", USDC_DECIMALS);
    expect(result.assetAmount).toBe(parked);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Shares are minted at the live index: shares x index / 1e18 == the asset parked.
    expect(result.shares).toBeGreaterThan(0n);
    expect((result.shares * result.indexAtEntry) / 10n ** 18n).toBe(parked);

    const position = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: result.positionId } });
    expect(position).toMatchObject({
      network: NETWORK,
      asset: "mockUSDC",
      status: "ACTIVE",
      shares: result.shares.toString(),
      assetAmountIn: parked.toString(),
      indexAtEntry: result.indexAtEntry.toString(),
      txHashPark: result.txHash,
      txHashRecall: null,
      recalledAt: null,
    });

    // The asset left the treasury for the fund — segregated from the escrow contract.
    expect(await tokenBalance(NETWORK, usdc, fund)).toBe(fundBefore + parked);
    const after = await availableLiquidity("mockUSDC", NETWORK);
    expect(Number(before.available) - Number(after.available)).toBe(50_000);
    expect(Number(before.onchain) - Number(after.onchain)).toBe(50_000);

    const event = await prisma.auditEvent.findFirst({
      where: { action: TREASURY_PARKED },
      orderBy: { id: "desc" },
    });
    expect(event).not.toBeNull();
    expect(JSON.parse(event!.detail)).toMatchObject({
      positionId: result.positionId,
      network: NETWORK,
      asset: "mockUSDC",
      amount: "50000",
      shares: result.shares.toString(),
      txHash: result.txHash,
    });
    await expect(verifyAuditChain()).resolves.toEqual({ valid: true });

    await unwind();
  });

  it("refuses to park liquidity that is reserved for an in-flight payment", async () => {
    const { free } = await freeTreasuryBalance(NETWORK, "mockUSDC");
    const headroom = toBaseUnits("1000.00", USDC_DECIMALS);
    expect(free).toBeGreaterThan(headroom);

    // Reserve everything but 1,000 mockUSDC against a payment in flight.
    const payment = await createDraftPayment();
    await prisma.liquidityReservation.create({
      data: {
        paymentId: payment.id,
        asset: "mockUSDC",
        network: NETWORK,
        amount: fromBaseUnits(free - headroom, USDC_DECIMALS),
      },
    });

    try {
      const attempt = park({ networkId: NETWORK, asset: "mockUSDC", amount: "2000.00" });
      await expect(attempt).rejects.toThrow(TreasuryError);
      await expect(attempt).rejects.toMatchObject({ code: "INSUFFICIENT_FREE_BALANCE" });

      expect(await prisma.treasuryPosition.count()).toBe(0);
      expect(await sharesHeld()).toBe(0n);

      // The unreserved remainder is still parkable.
      const ok = await park({ networkId: NETWORK, asset: "mockUSDC", amount: "1000.00" });
      expect(ok.assetAmount).toBe(headroom);
    } finally {
      await prisma.liquidityReservation.delete({ where: { paymentId: payment.id } });
      await unwind();
    }
  });

  it("rejects a bad amount, an asset the fund does not hold, and a network with no fund", async () => {
    await expect(park({ networkId: NETWORK, asset: "mockUSDC", amount: "0" })).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    });
    await expect(park({ networkId: NETWORK, asset: "mockUSDC", amount: "ten" })).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    });
    await expect(park({ networkId: NETWORK, asset: "mockJPY", amount: "1000" })).rejects.toMatchObject({
      code: "UNSUPPORTED_ASSET",
    });
    await expect(
      park({ networkId: "base-sepolia", asset: "mockUSDC", amount: "1000.00" })
    ).rejects.toMatchObject({ code: "NO_FUND" });

    expect(await prisma.treasuryPosition.count()).toBe(0);
  });
});
