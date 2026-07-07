import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isChainReady, loadDeployments, tokenBalance } from "@/lib/chain";
import { fromBaseUnits } from "@/lib/assets";

/** Treasury + entity balances by asset, liquidity reservations, and ledger credits. */
export async function GET() {
  if (!isChainReady()) {
    return NextResponse.json(
      { error: "Chain not set up. Run: npm run chain, then npm run setup" },
      { status: 503 }
    );
  }
  const dep = loadDeployments();
  const entities = await prisma.entity.findMany({ include: { wallets: true } });

  const holders: { label: string; kind: string; address: string }[] = [
    { label: "Settlement Treasury", kind: "treasury", address: dep.accounts.treasury.address },
    ...entities
      .filter((e) => e.wallets[0])
      .map((e) => ({ label: e.name, kind: "entity", address: e.wallets[0].address })),
  ];

  const balances = await Promise.all(
    holders.map(async (h) => {
      const perToken: Record<string, string> = {};
      for (const [symbol, token] of Object.entries(dep.contracts.tokens)) {
        const raw = await tokenBalance(token.address, h.address as `0x${string}`);
        perToken[symbol] = fromBaseUnits(raw, token.decimals);
      }
      return { ...h, tokens: perToken };
    })
  );

  const reservations = await prisma.liquidityReservation.findMany({
    where: { status: "RESERVED" },
    include: { payment: true },
  });

  // Amounts are stored as decimal strings, so aggregate in JS rather than SQL.
  const credits = await prisma.ledgerCredit.findMany({ include: { entity: true } });
  const ledgerTotals: Record<string, Record<string, number>> = {};
  for (const c of credits) {
    ledgerTotals[c.entity.name] ??= {};
    ledgerTotals[c.entity.name][c.currency] =
      (ledgerTotals[c.entity.name][c.currency] ?? 0) + Number(c.amount);
  }

  const pendingPayments = await prisma.payment.count({
    where: { status: { notIn: ["SETTLED", "REJECTED", "CANCELLED", "REFUNDED", "EXPIRED", "FAILED", "DRAFT"] } },
  });

  return NextResponse.json({
    network: dep.network,
    settlementContract: dep.contracts.PaymentSettlement,
    balances,
    reservations: reservations.map((r) => ({
      payment_id: r.paymentId,
      asset: r.asset,
      amount: r.amount,
      status: r.status,
    })),
    ledgerTotals,
    pendingPayments,
  });
}
