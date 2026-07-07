import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { accountsFor, isChainReady, loadDeployments, tokenBalance } from "@/lib/chain";
import { fromBaseUnits } from "@/lib/assets";

/** Treasury + entity balances by network and asset, reservations, and ledger credits. */
export async function GET() {
  if (!isChainReady()) {
    return NextResponse.json(
      { error: "Chains not set up. Run: npm run chain, npm run chain:polygon, then npm run setup" },
      { status: 503 }
    );
  }
  const dep = loadDeployments();
  const entities = await prisma.entity.findMany({ include: { wallets: true } });

  const networks: Record<
    string,
    {
      balances: { label: string; kind: string; address: string; tokens: Record<string, string> }[];
      error?: string;
    }
  > = {};

  for (const [networkId, net] of Object.entries(dep.networks)) {
    // Account roles and entity addresses differ per network on real testnets.
    const holders: { label: string; kind: string; address: string }[] = [
      { label: "Settlement Treasury", kind: "treasury", address: accountsFor(networkId).treasury.address },
      ...entities.flatMap((e) => {
        const w = e.wallets.find((x) => x.network === networkId) ?? e.wallets[0];
        return w ? [{ label: e.name, kind: "entity", address: w.address }] : [];
      }),
    ];
    try {
      const balances = await Promise.all(
        holders.map(async (h) => {
          const perToken: Record<string, string> = {};
          for (const [symbol, token] of Object.entries(net.contracts.tokens)) {
            const raw = await tokenBalance(networkId, token.address, h.address as `0x${string}`);
            perToken[symbol] = fromBaseUnits(raw, token.decimals);
          }
          return { ...h, tokens: perToken };
        })
      );
      networks[networkId] = { balances };
    } catch {
      // A single unreachable RPC (e.g. the public Base Sepolia endpoint) must not
      // take down balances for every network.
      networks[networkId] = { balances: [], error: `RPC unreachable for ${networkId}` };
    }
  }

  const reservations = await prisma.liquidityReservation.findMany({
    where: { status: "RESERVED" },
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
    networks,
    reservations: reservations.map((r) => ({
      payment_id: r.paymentId,
      asset: r.asset,
      network: r.network,
      amount: r.amount,
      status: r.status,
    })),
    ledgerTotals,
    pendingPayments,
  });
}
