import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { transitionStatus } from "@/lib/transitions";
import { CANCELLABLE_STATES, type PaymentStatus } from "@/lib/state";
import {
  actorOf,
  authorizePaymentWrite,
  caughtErrorResponse,
  conflict,
  notFound,
  requirePrincipal,
} from "../../../guard";
import { enforceWriteRateLimit } from "../../../limits";

/** Cancel a payment before execution. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const limited = enforceWriteRateLimit(req, principal);
  if (limited) return limited;

  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return notFound();

  const denied = authorizePaymentWrite(principal, payment);
  if (denied) return denied;

  if (!CANCELLABLE_STATES.includes(payment.status as PaymentStatus)) {
    return conflict(`payment cannot be cancelled from status ${payment.status}`);
  }
  // A payment can start executing between the read above and this write, so the
  // CAS — not the CANCELLABLE_STATES check — is what makes the cancel safe.
  try {
    const updated = await transitionStatus(payment, "CANCELLED", { actor: actorOf(principal) });
    return NextResponse.json({ payment_id: id, status: updated.status });
  } catch (e) {
    return caughtErrorResponse(e, "internal", "payments.cancel");
  }
}
