import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit";
import { requireRole } from "../guard";

export async function GET(req: NextRequest) {
  // The log spans every tenant, so it is platform-roles only.
  const principal = await requireRole(req, "OPERATOR", "REVIEWER");
  if (principal instanceof NextResponse) return principal;

  const [events, integrity] = await Promise.all([
    prisma.auditEvent.findMany({ orderBy: { id: "desc" }, take: 200 }),
    verifyAuditChain(),
  ]);
  return NextResponse.json({ integrity, events });
}
