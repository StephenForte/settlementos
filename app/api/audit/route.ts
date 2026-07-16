import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit";
import { PaginationError, parsePageRequest, toPage } from "@/lib/pagination";
import { invalidRequest, requireRole } from "../guard";

export async function GET(req: NextRequest) {
  // The log spans every tenant, so it is platform-roles only.
  const principal = await requireRole(req, "OPERATOR", "REVIEWER");
  if (principal instanceof NextResponse) return principal;

  let page;
  try {
    page = parsePageRequest(req.nextUrl.searchParams);
  } catch (e) {
    if (e instanceof PaginationError) return invalidRequest(e.message);
    throw e;
  }

  // The cursor is an AuditEvent id, which is an autoincrement Int. A cursor that
  // is not one is a client bug, not a lookup that returns nothing.
  let cursorId: number | null = null;
  if (page.cursor !== null) {
    if (!/^[0-9]+$/.test(page.cursor)) return invalidRequest("cursor is not valid");
    cursorId = Number(page.cursor);
  }

  const [rows, integrity] = await Promise.all([
    prisma.auditEvent.findMany({
      orderBy: { id: "desc" },
      take: page.limit + 1,
      ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
    }),
    // Verification always covers the WHOLE chain, never just the page: the
    // integrity of the log is not a property of the rows a caller happened to
    // ask for, and an anchored verify is cheap regardless of the page size.
    verifyAuditChain(),
  ]);

  const { rows: events, nextCursor, hasMore } = toPage(rows, page.limit, (e) => String(e.id));

  return NextResponse.json({
    integrity: {
      valid: integrity.valid,
      broken_at_id: integrity.brokenAtId,
      reason: integrity.reason,
      // How much of this answer the signed anchor vouched for, and how much was
      // re-hashed just now.
      mode: integrity.mode,
      anchored: integrity.anchored,
      events_verified: integrity.eventsVerified,
      checkpoint: integrity.checkpoint && {
        id: integrity.checkpoint.id,
        last_event_id: integrity.checkpoint.lastEventId,
        created_at: integrity.checkpoint.createdAt,
      },
    },
    events,
    next_cursor: nextCursor,
    has_more: hasMore,
  });
}
