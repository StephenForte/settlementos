import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { runComplianceChecks } from "@/lib/compliance";
import { executePayment } from "@/lib/executor";
import { requirePrincipal } from "../../../guard";

/**
 * Execute a payment. From QUOTED: runs the compliance gate first; if all checks
 * pass the payment auto-approves and settles. A MANUAL_REVIEW outcome parks the
 * payment for a compliance reviewer (POST .../review). From APPROVED (i.e.
 * after reviewer sign-off): settles directly.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Identity only — role/tenant rules for writes land in US-004.
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  let payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return NextResponse.json({ error: "payment not found" }, { status: 404 });

  if (body.route_id && payment.status === "QUOTED") {
    const routes = payment.quoteJson ? JSON.parse(payment.quoteJson) : [];
    const route = routes.find((r: { route_id: string }) => r.route_id === body.route_id);
    if (!route) return NextResponse.json({ error: "unknown route_id" }, { status: 400 });
    payment = await prisma.payment.update({
      where: { id },
      data: {
        selectedRouteId: route.route_id,
        fxRate: route.estimated_fx_rate,
        destinationAmount: route.estimated_destination_amount,
      },
    });
  }

  if (payment.status === "QUOTED") {
    payment = await prisma.payment.update({ where: { id }, data: { status: "COMPLIANCE_PENDING" } });
    await audit("payment.status.compliance_pending", {}, id);

    const outcome = await runComplianceChecks(id);
    if (outcome.overall === "REJECTED") {
      payment = await prisma.payment.update({ where: { id }, data: { status: "REJECTED" } });
      await audit("payment.status.rejected", { by: "compliance_gate" }, id);
      return NextResponse.json({ payment_id: id, status: payment.status, compliance: outcome }, { status: 200 });
    }
    if (outcome.overall === "MANUAL_REVIEW") {
      payment = await prisma.payment.update({ where: { id }, data: { status: "MANUAL_REVIEW" } });
      await audit("payment.status.manual_review", { reason: "compliance_flags" }, id);
      return NextResponse.json({ payment_id: id, status: payment.status, compliance: outcome }, { status: 200 });
    }
    payment = await prisma.payment.update({ where: { id }, data: { status: "APPROVED" } });
    await audit("payment.status.approved", { by: "compliance_gate" }, id);
  }

  if (payment.status !== "APPROVED") {
    return NextResponse.json(
      { error: `payment cannot be executed from status ${payment.status}` },
      { status: 409 }
    );
  }

  try {
    const settled = await executePayment(id);
    return NextResponse.json({
      payment_id: id,
      status: settled.status,
      transaction_hash: settled.txHash,
      settlement_transaction_hash: settled.settleTxHash,
    });
  } catch (e) {
    const current = await prisma.payment.findUnique({ where: { id } });
    return NextResponse.json(
      { payment_id: id, status: current?.status, error: (e as Error).message },
      { status: 500 }
    );
  }
}
