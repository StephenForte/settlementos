import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { PaginationError, parsePageRequest, toPage } from "@/lib/pagination";
import { actorOf, invalidRequest, isPlatformRole, requirePrincipal, requireRole } from "../guard";
import { beginWrite } from "../limits";

export async function GET(req: NextRequest) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  let page;
  try {
    page = parsePageRequest(req.nextUrl.searchParams);
  } catch (e) {
    if (e instanceof PaginationError) return invalidRequest(e.message);
    throw e;
  }

  // Bounded like every other list read — an unbounded findMany with wallet and
  // ledger includes is the same self-DoS pagination closes elsewhere. Tiebroken
  // by id (createdAt is not unique) so a cursor walk cannot skip or repeat rows.
  const rows = await prisma.entity.findMany({
    where: isPlatformRole(principal) ? {} : { id: principal.entityId },
    include: { wallets: true, ledgerCredits: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const { rows: entities, nextCursor, hasMore } = toPage(rows, page.limit, (e) => e.id);
  return NextResponse.json({ entities, next_cursor: nextCursor, has_more: hasMore });
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
  // Create and audit in one transaction: the row and the record of it commit or
  // roll back together (atomic-write invariant).
  const entity = await prisma.$transaction(async (tx) => {
    const created = await tx.entity.create({
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
    await audit("entity.created", { externalId, name, country }, undefined, actorOf(principal), tx);
    return created;
  });
  return NextResponse.json({ entity }, { status: 201 });
}
