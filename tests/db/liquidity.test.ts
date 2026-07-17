// The liquidity boundary (lib/routing). Both sides are bigint base units, so
// "can the treasury fund this payment?" is decided by exact arithmetic — not by
// where a float happened to land. Runs against the fixture chain + DB: the
// treasury's real balance is one side of every comparison here.

import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { fromBaseUnits, type AssetSymbol } from "@/lib/assets";
import { accountsFor, networkContracts, tokenBalance } from "@/lib/chain";
import { availableLiquidity, liquidityCheck } from "@/lib/routing";
import { freeTreasuryBalance } from "@/lib/treasury";
import { createDraftPayment } from "../helpers/payments";

const NETWORK = "base-local";
const USDC_DECIMALS = 6;

const balanceOf = (symbol: AssetSymbol) =>
  tokenBalance(NETWORK, networkContracts(NETWORK).tokens[symbol].address, accountsFor(NETWORK).treasury.address);

/** Reservation rows this file created, dropped after each test. */
const created: string[] = [];

/** Promise `amount` of an asset to a fresh in-flight payment. */
async function reserve(symbol: AssetSymbol, amount: string) {
  const payment = await createDraftPayment();
  await prisma.liquidityReservation.create({
    data: { paymentId: payment.id, asset: symbol, network: NETWORK, amount },
  });
  created.push(payment.id);
}

/** Promise everything but `keep` base units, so free liquidity lands on a known number. */
async function reserveAllBut(symbol: AssetSymbol, keep: bigint, decimals: number) {
  const balance = await balanceOf(symbol);
  expect(balance).toBeGreaterThan(keep);
  await reserve(symbol, fromBaseUnits(balance - keep, decimals));
}

afterEach(async () => {
  // Only this file's rows: a leaked reservation would withhold liquidity from
  // every later suite's quote. The payments stay (deleting an audited payment
  // breaks the hash chain — see AGENTS.md); a DRAFT with no reservation is inert.
  await prisma.liquidityReservation.deleteMany({ where: { paymentId: { in: created.splice(0) } } });
});

describe("the liquidity boundary", () => {
  it("funds a payment at exactly the available balance and refuses one minor unit more", async () => {
    // mockJPY: 0 decimals, so a minor unit *is* a base unit and the boundary is 1 yen.
    await reserveAllBut("mockJPY", 1_000n, 0);
    expect((await availableLiquidity("mockJPY", NETWORK)).availableUnits).toBe(1_000n);

    expect(await liquidityCheck("mockJPY", NETWORK, "999")).toEqual({ ok: true, recallRequired: false });
    expect(await liquidityCheck("mockJPY", NETWORK, "1000")).toEqual({ ok: true, recallRequired: false });
    expect(await liquidityCheck("mockJPY", NETWORK, "1001")).toEqual({ ok: false, recallRequired: false });
  });

  it("scales a destination amount into token base units before comparing", async () => {
    // A parked position would make the shortfall recallable instead of fatal,
    // which is a different assertion (auto-recall.test.ts) — this file assumes none.
    expect(await prisma.treasuryPosition.count({ where: { status: "ACTIVE" } })).toBe(0);

    // 1000.00 USD of headroom. USD counts cents; mockUSDC counts millionths.
    await reserveAllBut("mockUSDC", 1_000_000_000n, USDC_DECIMALS);
    const liq = await availableLiquidity("mockUSDC", NETWORK);
    expect(liq.availableUnits).toBe(1_000_000_000n);
    expect(liq.decimals).toBe(USDC_DECIMALS);

    expect((await liquidityCheck("mockUSDC", NETWORK, "1000.00")).ok).toBe(true);
    // One cent over is 10,000 base units over. Comparing the raw minor units
    // (100_001) against base units (1_000_000_000) would wave this through.
    expect((await liquidityCheck("mockUSDC", NETWORK, "1000.01")).ok).toBe(false);
    expect((await liquidityCheck("mockUSDC", NETWORK, "999.99")).ok).toBe(true);
  });

  it("sums reservations exactly where a float would not", async () => {
    const balance = await balanceOf("mockUSDC");
    expect(0.1 + 0.2).not.toBe(0.3); // the arithmetic this check used to run on

    await reserve("mockUSDC", "0.10");
    await reserve("mockUSDC", "0.20");

    const liq = await availableLiquidity("mockUSDC", NETWORK);
    expect(liq.reservedUnits).toBe(300_000n);
    expect(liq.availableUnits).toBe(balance - 300_000n);
    // The old Number path rendered this as ...69999999995 and then refused a
    // payment for the amount it had just claimed was available.
    expect(liq.available).toBe(fromBaseUnits(balance - 300_000n, USDC_DECIMALS));
    expect((await liquidityCheck("mockUSDC", NETWORK, liq.available)).ok).toBe(true);
  });

  it("throws (never quotes fundable) when a reservation amount is unreadable", async () => {
    // A corrupt reservation string surfaces from freeTreasuryBalance as a
    // TreasuryError, not a MoneyError. liquidityCheck used to rethrow only
    // MoneyError, so this fell through to `{ ok: true }` — quoting a route as
    // fundable because we could not parse what a rival payment already promised.
    const payment = await createDraftPayment();
    await prisma.liquidityReservation.create({
      // Excess precision for 6-decimal mockUSDC — the parser rejects it.
      data: { paymentId: payment.id, asset: "mockUSDC", network: NETWORK, amount: "99.8765432" },
    });
    created.push(payment.id);

    await expect(liquidityCheck("mockUSDC", NETWORK, "10.00")).rejects.toThrow();
  });

  it("agrees with the park guard on the same rows, to the base unit", async () => {
    // Routing and treasury answer the same question for two different callers (a
    // payment and a park). They must never disagree about what is free.
    await reserve("mockUSDC", "1234.56");

    const liq = await availableLiquidity("mockUSDC", NETWORK);
    const free = await freeTreasuryBalance(NETWORK, "mockUSDC");
    expect(liq.reservedUnits).toBe(1_234_560_000n);
    expect(liq.onchainUnits).toBe(free.balance);
    expect(liq.reservedUnits).toBe(free.reserved);
    expect(liq.availableUnits).toBe(free.free);
  });
});
