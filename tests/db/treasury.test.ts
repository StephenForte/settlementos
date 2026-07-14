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
import {
  accrueDaily,
  currentIndexOf,
  dailyIndex,
  freeTreasuryBalance,
  park,
  recall,
  valueOfShares,
  TreasuryError,
  MMF_ANNUAL_RATE_BPS,
  TREASURY_ACCRUED,
  TREASURY_PARKED,
  TREASURY_RECALLED,
} from "@/lib/treasury";
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

describe("treasury recall", () => {
  it("redeems a parked position T+0, returning the principal at an unchanged index", async () => {
    const usdc = networkContracts(NETWORK).tokens.mockUSDC.address;
    const fund = mmfAddress(NETWORK)!;
    const treasuryBefore = await tokenBalance(NETWORK, usdc, treasuryAddress());
    const liquidityBefore = await availableLiquidity("mockUSDC", NETWORK);

    const parked = await park({ networkId: NETWORK, asset: "mockUSDC", amount: "25000.00" });
    const fundAfterPark = await tokenBalance(NETWORK, usdc, fund);

    const result = await recall(parked.positionId);

    // Index never moved, so the redemption returns exactly the principal.
    expect(result.positionId).toBe(parked.positionId);
    expect(result.shares).toBe(parked.shares);
    expect(result.indexAtExit).toBe(parked.indexAtEntry);
    expect(result.assetAmount).toBe(parked.assetAmount);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.txHash).not.toBe(parked.txHash);

    // The asset came back out of the fund and into the treasury wallet.
    expect(await tokenBalance(NETWORK, usdc, treasuryAddress())).toBe(treasuryBefore);
    expect(await tokenBalance(NETWORK, usdc, fund)).toBe(fundAfterPark - parked.assetAmount);
    expect(await sharesHeld()).toBe(0n);

    // ...and is available liquidity again.
    const liquidityAfter = await availableLiquidity("mockUSDC", NETWORK);
    expect(liquidityAfter.available).toBe(liquidityBefore.available);
    expect(liquidityAfter.onchain).toBe(liquidityBefore.onchain);

    // The row is updated in place, never deleted — append-only position history.
    const position = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: parked.positionId } });
    expect(position).toMatchObject({
      status: "RECALLED",
      shares: parked.shares.toString(),
      txHashPark: parked.txHash,
      txHashRecall: result.txHash,
    });
    expect(position.recalledAt).toBeInstanceOf(Date);

    const event = await prisma.auditEvent.findFirst({
      where: { action: TREASURY_RECALLED },
      orderBy: { id: "desc" },
    });
    expect(event).not.toBeNull();
    expect(JSON.parse(event!.detail)).toMatchObject({
      positionId: parked.positionId,
      network: NETWORK,
      asset: "mockUSDC",
      shares: parked.shares.toString(),
      amount: "25000",
      principal: "25000",
      yield: "0",
      indexAtExit: parked.indexAtEntry.toString(),
      txHash: result.txHash,
    });
    await expect(verifyAuditChain()).resolves.toEqual({ valid: true });

    await unwind();
  });

  it("refuses to recall an unknown position or one that is already recalled", async () => {
    await expect(recall("pos_does_not_exist")).rejects.toThrow(TreasuryError);
    await expect(recall("pos_does_not_exist")).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });

    const parked = await park({ networkId: NETWORK, asset: "mockUSDC", amount: "1000.00" });
    await recall(parked.positionId);

    const second = recall(parked.positionId);
    await expect(second).rejects.toThrow(TreasuryError);
    await expect(second).rejects.toMatchObject({ code: "POSITION_NOT_ACTIVE" });

    // A rejected re-recall neither moves funds nor drops the history row.
    expect(await sharesHeld()).toBe(0n);
    const position = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: parked.positionId } });
    expect(position.status).toBe("RECALLED");

    await unwind();
  });
});

// Accrual is irreversible (the contract's index is monotonic), so this block runs
// last in the file: everything above assumes the shared fixture fund is still at par.
describe("treasury accrual", () => {
  it("accrues a day of simulated yield, so recalling returns more than the principal", async () => {
    const usdc = networkContracts(NETWORK).tokens.mockUSDC.address;
    const fund = mmfAddress(NETWORK)!;

    const parked = await park({ networkId: NETWORK, asset: "mockUSDC", amount: "100000.00" });
    const treasuryAfterPark = await tokenBalance(NETWORK, usdc, treasuryAddress());
    const fundAfterPark = await tokenBalance(NETWORK, usdc, fund);

    const accrual = await accrueDaily(NETWORK);
    expect(accrual.annualRateBps).toBe(MMF_ANNUAL_RATE_BPS);
    expect(accrual.oldIndex).toBe(parked.indexAtEntry);
    expect(accrual.newIndex).toBe(dailyIndex(parked.indexAtEntry));
    expect(accrual.newIndex).toBeGreaterThan(accrual.oldIndex);
    expect(await currentIndexOf(NETWORK)).toBe(accrual.newIndex);

    // The position row is untouched by accrual — its value is derived, not stored.
    const row = await prisma.treasuryPosition.findUniqueOrThrow({ where: { id: parked.positionId } });
    expect(row.assetAmountIn).toBe(parked.assetAmount.toString());
    expect(row.indexAtEntry).toBe(parked.indexAtEntry.toString());
    const derived = valueOfShares(BigInt(row.shares), accrual.newIndex);
    expect(derived).toBeGreaterThan(parked.assetAmount);

    const event = await prisma.auditEvent.findFirst({
      where: { action: TREASURY_ACCRUED },
      orderBy: { id: "desc" },
    });
    expect(event).not.toBeNull();
    expect(JSON.parse(event!.detail)).toMatchObject({
      network: NETWORK,
      oldIndex: accrual.oldIndex.toString(),
      newIndex: accrual.newIndex.toString(),
      annualRateBps: "350",
      txHash: accrual.txHash,
    });

    // Recall pays principal + yield: the extra asset comes out of the fund's buffer.
    const result = await recall(parked.positionId);
    expect(result.indexAtExit).toBe(accrual.newIndex);
    expect(result.assetAmount).toBe(derived);
    expect(result.assetAmount).toBeGreaterThan(parked.assetAmount);

    const yielded = result.assetAmount - parked.assetAmount;
    expect(await tokenBalance(NETWORK, usdc, treasuryAddress())).toBe(treasuryAfterPark + result.assetAmount);
    expect(await tokenBalance(NETWORK, usdc, fund)).toBe(fundAfterPark - result.assetAmount);
    expect(await sharesHeld()).toBe(0n);

    const recalledEvent = await prisma.auditEvent.findFirst({
      where: { action: TREASURY_RECALLED },
      orderBy: { id: "desc" },
    });
    expect(JSON.parse(recalledEvent!.detail)).toMatchObject({
      positionId: parked.positionId,
      principal: "100000",
      yield: fromBaseUnits(yielded, USDC_DECIMALS),
      indexAtExit: accrual.newIndex.toString(),
    });
    await expect(verifyAuditChain()).resolves.toEqual({ valid: true });

    await unwind();
  });

  it("refuses to accrue on a network with no fund", async () => {
    await expect(accrueDaily("base-sepolia")).rejects.toThrow(TreasuryError);
    await expect(accrueDaily("base-sepolia")).rejects.toMatchObject({ code: "NO_FUND" });
  });
});
