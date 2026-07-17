import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  isPlatformRole,
  notFound,
  requirePrincipal,
  scrubAuditDetail,
  scrubFailureReason,
} from "../../guard";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const { id } = await params;
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      sender: { include: { wallets: true } },
      recipient: { include: { wallets: true } },
      complianceChecks: { orderBy: { createdAt: "asc" } },
      auditEvents: { orderBy: { id: "asc" } },
      ledgerCredits: true,
      reservation: true,
    },
  });
  if (!payment) return notFound();
  // Another tenant's payment is indistinguishable from a nonexistent one: 404,
  // never 403, so no response can confirm that an id exists.
  if (!isPlatformRole(principal) && ![payment.senderId, payment.recipientId].includes(principal.entityId!)) {
    return notFound();
  }
  // Two boundaries, not one: the failureReason column *and* the audit-event detail
  // that can echo the same operator diagnostics.
  const scrubbed = scrubFailureReason(principal, payment);
  return NextResponse.json({
    payment: { ...scrubbed, auditEvents: scrubAuditDetail(principal, scrubbed.auditEvents) },
  });
}
