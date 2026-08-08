import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { reconcileUnresolvedPayment } from "@/lib/executor";
import { caughtErrorResponse, notFound, requireRole } from "../../../guard";
import { withIdempotentWrite } from "../../../idempotency";

/**
 * Re-read chain evidence for an unresolved PAYOUT_PENDING or COMPENSATION_PENDING
 * payment and advance only on conclusive outcomes (R1). OPERATOR only — it can
 * complete a settlement or open the compensation state, and a tenant must not
 * drive those transitions.
 *
 * This endpoint never broadcasts a transaction. Confirmed destination → SETTLED;
 * reverted destination → COMPENSATION_PENDING (then /repair to pay); confirmed
 * compensation → COMPENSATED; unknown → unchanged with outcome reported.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const { id } = await params;
  return withIdempotentWrite(req, principal, `POST /api/payments/${id}/reconcile`, () =>
    runReconcile(id)
  );
}

async function runReconcile(id: string): Promise<NextResponse> {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return notFound();

  try {
    const result = await reconcileUnresolvedPayment(id);
    return NextResponse.json({
      payment_id: id,
      status: result.payment.status,
      outcome: result.outcome,
      action: result.action,
      destination_transaction_hash: result.payment.destinationTxHash,
      compensation_transaction_hash: result.payment.compensationTxHash,
    });
  } catch (e) {
    return caughtErrorResponse(e, "execution_failed", "payments.reconcile");
  }
}
