import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  if (!payment) return NextResponse.json({ error: "payment not found" }, { status: 404 });
  return NextResponse.json({ payment });
}
