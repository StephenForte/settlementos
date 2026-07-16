import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { CANCELLABLE_STATES, type PaymentStatus } from "@/lib/state";
import { requirePrincipal } from "../../../guard";

/** Cancel a payment before execution. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Identity only — role/tenant rules for writes land in US-004.
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return NextResponse.json({ error: "payment not found" }, { status: 404 });
  if (!CANCELLABLE_STATES.includes(payment.status as PaymentStatus)) {
    return NextResponse.json(
      { error: `payment cannot be cancelled from status ${payment.status}` },
      { status: 409 }
    );
  }
  const updated = await prisma.payment.update({ where: { id }, data: { status: "CANCELLED" } });
  await audit("payment.status.cancelled", { from: payment.status }, id);
  return NextResponse.json({ payment_id: id, status: updated.status });
}
