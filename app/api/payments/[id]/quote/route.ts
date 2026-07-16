import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertTransition } from "@/lib/state";
import { quoteRoutes } from "@/lib/routing";
import { actorOf, authorizePaymentWrite, notFound, requirePrincipal } from "../../../guard";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return notFound();

  const denied = authorizePaymentWrite(principal, payment);
  if (denied) return denied;

  try {
    assertTransition(payment.status, "QUOTED");
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }

  const routes = await quoteRoutes(id);
  const recommended = routes.find((r) => r.recommended) ?? routes[0];
  await prisma.payment.update({
    where: { id },
    data: {
      status: "QUOTED",
      quoteJson: JSON.stringify(routes),
      selectedRouteId: recommended.route_id,
      fxRate: recommended.estimated_fx_rate,
      destinationAmount: recommended.estimated_destination_amount,
      feeJson: JSON.stringify({
        platform_fee: recommended.platform_fee,
        platform_fee_bps: recommended.platform_fee_bps,
        fx_spread_bps: recommended.fx_spread_bps,
        slippage_bps: recommended.slippage_bps,
        estimated_gas_usd: recommended.estimated_gas_usd,
      }),
    },
  });
  await audit("payment.quoted", { routes: routes.map((r) => r.route_id) }, id, actorOf(principal));

  return NextResponse.json({ payment_id: id, status: "QUOTED", routes });
}
