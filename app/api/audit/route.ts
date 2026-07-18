import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit";
import { toPage } from "@/lib/pagination";
import { invalidRequest, requireRole } from "../guard";
import { parsePageOr400 } from "../pagination";

export async function GET(req: NextRequest) {
  // The log spans every tenant, so it is platform-roles only.
  const principal = await requireRole(req, "OPERATOR", "REVIEWER");
  if (principal instanceof NextResponse) return principal;

  const page = parsePageOr400(req.nextUrl.searchParams);
  if (page instanceof NextResponse) return page;

  // The cursor is an AuditEvent id, which is an autoincrement 32-bit Int. A cursor
  // that is not one is a client bug, not a lookup that returns nothing — including
  // one past the Int range, which Prisma would otherwise reject with an uncaught
  // 500 rather than the 400 every other bad input gets.
  const INT4_MAX = 2147483647;
  let cursorId: number | null = null;
  if (page.cursor !== null) {
    const n = Number(page.cursor);
    if (!/^[0-9]+$/.test(page.cursor) || !Number.isSafeInteger(n) || n > INT4_MAX) {
      return invalidRequest("cursor is not valid");
    }
    cursorId = n;
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
