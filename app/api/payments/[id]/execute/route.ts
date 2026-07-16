import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runComplianceChecks } from "@/lib/compliance";
import { executePayment } from "@/lib/executor";
import { transitionStatus } from "@/lib/transitions";
import { fromThrown } from "@/lib/api-errors";
import {
  actorOf,
  authorizePaymentWrite,
  caughtErrorResponse,
  conflict,
  invalidRequest,
  notFound,
  requirePrincipal,
} from "../../../guard";
import { beginIdempotency } from "../../../idempotency";
import { beginWrite } from "../../../limits";
import type { Principal } from "@/lib/auth";

/**
 * Execute a payment. From QUOTED: runs the compliance gate first; if all checks
 * pass the payment auto-approves and settles. A MANUAL_REVIEW outcome parks the
 * payment for a compliance reviewer (POST .../review). From APPROVED (i.e.
 * after reviewer sign-off): settles directly.
 *
 * An Idempotency-Key makes the retry of a timed-out execute safe: it replays the
 * first attempt's response rather than reaching the chain twice. (The execution
 * lease already makes a *concurrent* double-execute impossible — this is the
 * cheaper, earlier guard, and the one that survives the first attempt finishing.)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const gate = await beginWrite(req, principal);
  if (gate instanceof NextResponse) return gate;
  const body = (gate.body ?? {}) as { route_id?: string };

  const { id } = await params;
  const idem = await beginIdempotency(req, principal, `POST /api/payments/${id}/execute`, body);
  if (idem instanceof NextResponse) return idem;
  try {
    return await idem.complete(await runExecute(principal, id, body));
  } catch (e) {
    await idem.abandon();
    throw e;
  }
}

async function runExecute(principal: Principal, id: string, body: { route_id?: string }): Promise<NextResponse> {
  let payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return notFound();

  const denied = authorizePaymentWrite(principal, payment);
  if (denied) return denied;

  const actor = actorOf(principal);

  if (body.route_id && payment.status === "QUOTED") {
    const routes = payment.quoteJson ? JSON.parse(payment.quoteJson) : [];
    const route = routes.find((r: { route_id: string }) => r.route_id === body.route_id);
    if (!route) return invalidRequest("unknown route_id");
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
    // Each move is a compare-and-swap, so of two concurrent executes only one
    // enters the compliance gate; the loser 409s here rather than screening (and
    // billing a provider for) the same payment twice.
    try {
      payment = await transitionStatus(payment, "COMPLIANCE_PENDING", { actor });

      const outcome = await runComplianceChecks(id);
      if (outcome.overall === "REJECTED") {
        payment = await transitionStatus(payment, "REJECTED", { detail: { by: "compliance_gate" }, actor });
        return NextResponse.json({ payment_id: id, status: payment.status, compliance: outcome }, { status: 200 });
      }
      if (outcome.overall === "MANUAL_REVIEW") {
        payment = await transitionStatus(payment, "MANUAL_REVIEW", {
          detail: { reason: "compliance_flags" },
          actor,
        });
        return NextResponse.json({ payment_id: id, status: payment.status, compliance: outcome }, { status: 200 });
      }
      payment = await transitionStatus(payment, "APPROVED", { detail: { by: "compliance_gate" }, actor });
    } catch (e) {
      return caughtErrorResponse(e, "internal", "payments.execute");
    }
  }

  if (payment.status !== "APPROVED") {
    return conflict(`payment cannot be executed from status ${payment.status}`);
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
    // Never the thrown message: an executor failure carries contract addresses,
    // RPC URLs, and revert data. The caller gets the resulting status (which the
    // executor has already moved to FAILED/REFUNDED) and a stable code; the real
    // error goes to the server log. Operators read the detail off the payment's
    // failureReason, which stays unredacted for platform roles.
    const current = await prisma.payment.findUnique({ where: { id } });
    const { status, body } = fromThrown(e, "execution_failed", "payments.execute");
    return NextResponse.json({ payment_id: id, status: current?.status, ...body }, { status });
  }
}
