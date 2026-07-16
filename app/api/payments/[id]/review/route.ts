import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { transitionStatus } from "@/lib/transitions";
import {
  actorOf,
  caughtErrorResponse,
  conflict,
  invalidRequest,
  notFound,
  requireRole,
} from "../../../guard";
import { beginWrite } from "../../../limits";

/**
 * Compliance reviewer decision on a MANUAL_REVIEW payment. The four-eyes check
 * only means something if the reviewer is the authenticated key: the identity
 * comes from the principal, and the request body cannot name one.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requireRole(req, "REVIEWER", "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const gate = await beginWrite(req, principal);
  if (gate instanceof NextResponse) return gate;
  const body = (gate.body ?? {}) as { decision?: unknown; note?: unknown };

  const { id } = await params;
  const decision = body.decision as string;
  const note = (body.note as string) || "";

  if (!["approve", "reject"].includes(decision)) {
    return invalidRequest("decision must be 'approve' or 'reject'");
  }

  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return notFound();
  if (payment.status !== "MANUAL_REVIEW") {
    return conflict(`payment is not in MANUAL_REVIEW (current: ${payment.status})`);
  }

  // The status check above is advisory — two reviewers can read MANUAL_REVIEW at
  // the same moment. The CAS is what actually decides; the loser gets a 409.
  const status = decision === "approve" ? "APPROVED" : "REJECTED";
  try {
    const updated = await transitionStatus(payment, status, {
      detail: { note },
      action: `payment.review.${decision}d`,
      actor: actorOf(principal),
    });
    return NextResponse.json({ payment_id: id, status: updated.status });
  } catch (e) {
    return caughtErrorResponse(e, "internal", "payments.review");
  }
}
