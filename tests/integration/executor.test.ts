import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { executePayment } from "@/lib/executor";
import { accountsFor, tokenBalance, networkContracts } from "@/lib/chain";
import { toBaseUnits } from "@/lib/assets";
import { createApprovedPayment, createDraftPayment } from "../helpers/payments";
import type { Address } from "viem";

async function treasuryUsdc(networkId: string): Promise<bigint> {
  const contracts = networkContracts(networkId);
  return tokenBalance(
    networkId,
    contracts.tokens.mockUSDC.address,
    accountsFor(networkId).treasury.address as Address
  );
}

describe("executePayment — single chain", () => {
  it("settles a USD→JPY payment end-to-end with real on-chain escrow", async () => {
    const treasuryBefore = await treasuryUsdc("base-local");
    const payment = await createApprovedPayment({ amount: "100000.00" });

    const settled = await executePayment(payment.id);

    expect(settled.status).toBe("SETTLED");
    expect(settled.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(settled.settleTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(settled.destinationTxHash).toBeNull(); // no bridge leg on single chain
    expect(Number(settled.destinationAmount)).toBeGreaterThan(0);

    // Escrowed mockUSDC was released to the treasury on settlement.
    const treasuryAfter = await treasuryUsdc("base-local");
    expect(treasuryAfter - treasuryBefore).toBe(toBaseUnits("100000.00", 6));

    // Fiat leg: recipient got a JPY ledger credit matching the quote.
    const credits = await prisma.ledgerCredit.findMany({ where: { paymentId: payment.id } });
    expect(credits).toHaveLength(1);
    expect(credits[0].currency).toBe("JPY");
    expect(credits[0].amount).toBe(settled.destinationAmount);

    // Liquidity reservation was consumed, not leaked.
    const reservation = await prisma.liquidityReservation.findUnique({ where: { paymentId: payment.id } });
    expect(reservation?.status).toBe("CONSUMED");

    // Every hop left an audit trail.
    const actions = (
      await prisma.auditEvent.findMany({ where: { paymentId: payment.id }, orderBy: { id: "asc" } })
    ).map((e) => e.action);
    for (const expected of [
      "payment.status.liquidity_reserved",
      "payment.status.submitted_onchain",
      "payment.status.confirmed_onchain",
      "payment.status.fx_or_swap_completed",
      "payout.ledger_credit",
      "payment.status.settled",
    ]) {
      expect(actions).toContain(expected);
    }
  });

  it("refuses to execute a payment that is not APPROVED", async () => {
    const draft = await createDraftPayment();
    await expect(executePayment(draft.id)).rejects.toThrow(/must be APPROVED/);
  });
});

describe("executePayment — cross chain (simulated bridge)", () => {
  it("escrows on the source chain and pays out real tokens on the destination chain", async () => {
    const contracts = networkContracts("polygon-local");
    const recipient = accountsFor("polygon-local").entityWallets.ent_tokyo_supplier.address as Address;
    const jpyBefore = await tokenBalance("polygon-local", contracts.tokens.mockJPY.address, recipient);

    const payment = await createApprovedPayment({
      amount: "50000.00",
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });
    const settled = await executePayment(payment.id);

    expect(settled.status).toBe("SETTLED");
    expect(settled.destinationTxHash).toMatch(/^0x[0-9a-f]{64}$/); // real tx on chain 2

    // Recipient's wallet on the DESTINATION chain received the mockJPY payout.
    const jpyAfter = await tokenBalance("polygon-local", contracts.tokens.mockJPY.address, recipient);
    expect(jpyAfter - jpyBefore).toBe(toBaseUnits(settled.destinationAmount!, 0));

    const actions = (await prisma.auditEvent.findMany({ where: { paymentId: payment.id } })).map(
      (e) => e.action
    );
    expect(actions).toContain("bridge.destination_payout");
  });
});

describe("executePayment — failure handling", () => {
  it("fails cleanly when destination liquidity is insufficient (before any escrow)", async () => {
    // Treasury holds 100M mockJPY per chain; $800k → ~125M JPY exceeds it.
    const payment = await createApprovedPayment({ amount: "800000.00" });

    await expect(executePayment(payment.id)).rejects.toThrow(/Insufficient mockJPY liquidity/);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("FAILED");
    expect(after.failureReason).toMatch(/Insufficient/);
    expect(after.txHash).toBeNull(); // nothing ever hit the chain
  });

  it("releases the reservation when a later payment fails", async () => {
    const payment = await createApprovedPayment({ amount: "800000.00" });
    await executePayment(payment.id).catch(() => {});

    // A failed pre-escrow payment must not leave RESERVED liquidity behind,
    // otherwise it would poison availableLiquidity for every later quote.
    const reservation = await prisma.liquidityReservation.findUnique({ where: { paymentId: payment.id } });
    expect(reservation?.status ?? "NONE").not.toBe("RESERVED");
  });
});
