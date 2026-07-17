import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { repairCompensation } from "@/lib/executor";
import { apiError } from "@/lib/api-errors";
import { caughtErrorResponse, notFound, requireRole } from "../../../guard";
import { beginIdempotency } from "../../../idempotency";
import { beginWrite } from "../../../limits";

/**
 * Finish a compensation an execution attempt could not: the payment sits in
 * COMPENSATION_PENDING because its treasury transfer failed, and the sender is
 * still short. OPERATOR only — it moves treasury funds, and a tenant asking for
 * its own money back is a support conversation, not an API call.
 *
 * Safe to call twice: an already-COMPENSATED payment answers with its stored
 * result rather than paying again (see repairCompensation), and an Idempotency-Key
 * additionally replays the first attempt's response verbatim.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const gate = await beginWrite(req, principal);
  if (gate instanceof NextResponse) return gate;
  const body = gate.body ?? {};

  const { id } = await params;
  const idem = await beginIdempotency(req, principal, `POST /api/payments/${id}/repair`, body);
  if (idem instanceof NextResponse) return idem;
  try {
    return await idem.complete(await runRepair(id));
  } catch (e) {
    await idem.abandon();
    throw e;
  }
}

async function runRepair(id: string): Promise<NextResponse> {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return notFound();

  try {
    const repaired = await repairCompensation(id);
    if (repaired.status !== "COMPENSATED") {
      // The transfer failed again. The payment is still COMPENSATION_PENDING and
      // still repairable; the real cause is in the server log and on the audit
      // trail (payment.compensation_failed), never in this body.
      const { status, body } = apiError("execution_failed");
      return NextResponse.json({ payment_id: id, status: repaired.status, ...body }, { status });
    }
    return NextResponse.json({
      payment_id: id,
      status: repaired.status,
      compensation_transaction_hash: repaired.compensationTxHash,
    });
  } catch (e) {
    return caughtErrorResponse(e, "execution_failed", "payments.repair");
  }
}
