import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit";

export async function GET() {
  const [events, integrity] = await Promise.all([
    prisma.auditEvent.findMany({ orderBy: { id: "desc" }, take: 200 }),
    verifyAuditChain(),
  ]);
  return NextResponse.json({ integrity, events });
}
