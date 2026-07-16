import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { CANCELLABLE_STATES, type PaymentStatus } from "@/lib/state";
import { actorOf, authorizePaymentWrite, conflict, notFound, requirePrincipal } from "../../../guard";

/** Cancel a payment before execution. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return notFound();

  const denied = authorizePaymentWrite(principal, payment);
  if (denied) return denied;

  if (!CANCELLABLE_STATES.includes(payment.status as PaymentStatus)) {
    return conflict(`payment cannot be cancelled from status ${payment.status}`);
  }
  const updated = await prisma.payment.update({ where: { id }, data: { status: "CANCELLED" } });
  await audit("payment.status.cancelled", { from: payment.status }, id, actorOf(principal));
  return NextResponse.json({ payment_id: id, status: updated.status });
}
