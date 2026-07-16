import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isPlatformRole, notFound, requirePrincipal, scrubFailureReason } from "../../guard";

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
  return NextResponse.json({ payment: scrubFailureReason(principal, payment) });
}
