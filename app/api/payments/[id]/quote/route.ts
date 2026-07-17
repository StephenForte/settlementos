import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { quoteRoutes } from "@/lib/routing";
import { transitionStatus } from "@/lib/transitions";
import {
  actorOf,
  authorizePaymentWrite,
  caughtErrorResponse,
  notFound,
  requirePrincipal,
} from "../../../guard";
import { enforceWriteRateLimit } from "../../../limits";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  // After the auth check, so the limiter counts against the principal rather
  // than an address anyone can spoof. Quoting is cheap but not free: it reads
  // treasury balances off a chain.
  const limited = enforceWriteRateLimit(req, principal);
  if (limited) return limited;

  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return notFound();

  const denied = authorizePaymentWrite(principal, payment);
  if (denied) return denied;

  // Quote can be slow (it reads treasury balances off a chain), so the row may
  // move — a cancel, an execute — while we compute. Writing the status through
  // transitionStatus makes the write a compare-and-swap on the status we read: a
  // racing cancel that already landed CANCELLED wins, and this returns a 409
  // rather than a raw update resurrecting a cancelled payment back to QUOTED. The
  // audit event commits in the same transaction as the swap.
  try {
    const routes = await quoteRoutes(id);
    const recommended = routes.find((r) => r.recommended) ?? routes[0];
    await transitionStatus(payment, "QUOTED", {
      action: "payment.quoted",
      actor: actorOf(principal),
      data: {
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
      // The full quoteJson lives on the row; the log records only which routes
      // were offered, not the whole 2KB blob re-encoded into every event.
      auditData: {},
      detail: { routes: routes.map((r) => r.route_id) },
    });
    return NextResponse.json({ payment_id: id, status: "QUOTED", routes });
  } catch (e) {
    // Illegal move (e.g. from a terminal status) or a lost race — both become a
    // 409 here, never a leaked internal.
    return caughtErrorResponse(e, "conflict", "payments.quote");
  }
}
