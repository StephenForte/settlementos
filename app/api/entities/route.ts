import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { actorOf, invalidRequest, isPlatformRole, requirePrincipal, requireRole } from "../guard";
import { beginWrite } from "../limits";

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

/** Onboard a counterparty. Platform administration, so OPERATOR only. */
export async function POST(req: NextRequest) {
  const principal = await requireRole(req, "OPERATOR");
  if (principal instanceof NextResponse) return principal;

  const gate = await beginWrite(req, principal);
  if (gate instanceof NextResponse) return gate;
  const body = gate.body;
  if (!body || typeof body !== "object") return invalidRequest("body must be a JSON object");
  const {
    name,
    country,
    role = "RECIPIENT",
    wallet_address,
    approved_corridors = [],
  } = body as {
    name?: string;
    country?: string;
    role?: string;
    wallet_address?: string;
    approved_corridors?: string[];
  };
  if (!name || !country) {
    return invalidRequest("name and country are required");
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
  await audit("entity.created", { externalId, name, country }, undefined, actorOf(principal));
  return NextResponse.json({ entity }, { status: 201 });
}
