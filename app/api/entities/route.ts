import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isPlatformRole, requirePrincipal } from "../guard";

export async function GET(req: NextRequest) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const entities = await prisma.entity.findMany({
    where: isPlatformRole(principal) ? {} : { id: principal.entityId },
    include: { wallets: true, ledgerCredits: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ entities });
}

export async function POST(req: NextRequest) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const body = await req.json();
  const { name, country, role = "RECIPIENT", wallet_address, approved_corridors = [] } = body;
  if (!name || !country) {
    return NextResponse.json({ error: "name and country are required" }, { status: 400 });
  }
  const externalId = `ent_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24)}_${randomBytes(2).toString("hex")}`;
  const entity = await prisma.entity.create({
    data: {
      externalId,
      name,
      country,
      role,
      kybStatus: "PENDING", // new entities always start unverified
      approvedCorridors: JSON.stringify(approved_corridors),
      wallets: wallet_address
        ? { create: { address: wallet_address, network: "local-anvil", allowlisted: false, riskScore: 50 } }
        : undefined,
    },
    include: { wallets: true },
  });
  await audit("entity.created", { externalId, name, country });
  return NextResponse.json({ entity }, { status: 201 });
}
