import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requirePrincipal } from "../../../guard";

/** Compliance reviewer decision on a MANUAL_REVIEW payment. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Identity only — REVIEWER-gating and taking the reviewer from the principal
  // (rather than the request body) land in US-004.
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const decision = body.decision as string;
  const reviewer = (body.reviewer as string) || "compliance_reviewer";
  const note = (body.note as string) || "";

  if (!["approve", "reject"].includes(decision)) {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 });
  }

  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return NextResponse.json({ error: "payment not found" }, { status: 404 });
  if (payment.status !== "MANUAL_REVIEW") {
    return NextResponse.json({ error: `payment is not in MANUAL_REVIEW (current: ${payment.status})` }, { status: 409 });
  }

  const status = decision === "approve" ? "APPROVED" : "REJECTED";
  const updated = await prisma.payment.update({ where: { id }, data: { status } });
  await audit(`payment.review.${decision}d`, { note }, id, reviewer);

  return NextResponse.json({ payment_id: id, status: updated.status });
}
