import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { actorOf, invalidRequest, requireRole } from "../guard";

/** How far back an export reaches when the caller names no range. */
const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const DATE_ONLY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** Named for the shadowing it avoids: the global RangeError is a different thing. */
class ExportRangeError extends Error {}

/**
 * Parse one `from`/`to` bound. A bare `YYYY-MM-DD` is a *day*, not the instant
 * at its midnight: read as an instant, `to=2026-07-16` would silently drop
 * every payment made that day. So a date-only upper bound extends to the end of
 * the day, and the query below uses `lt` to match.
 *
 * `new Date("nonsense")` is an Invalid Date rather than a throw, and
 * `new Date("2026-13-45")` is happily accepted by some parsers — hence the
 * explicit shape check before the parse, and the NaN check after it.
 */
function parseBound(raw: string, param: string, endOfDay: boolean): Date {
  const isDateOnly = DATE_ONLY.test(raw);
  if (!isDateOnly && !raw.includes("T")) {
    throw new ExportRangeError(`${param} must be an ISO date (YYYY-MM-DD) or timestamp`);
  }
  const parsed = new Date(isDateOnly ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(parsed.getTime())) throw new ExportRangeError(`${param} is not a valid date`);
  return isDateOnly && endOfDay ? new Date(parsed.getTime() + DAY_MS) : parsed;
}

interface DateRange {
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

function parseRange(params: URLSearchParams, now: Date): DateRange {
  const rawFrom = params.get("from");
  const rawTo = params.get("to");

  const to = rawTo ? parseBound(rawTo, "to", true) : new Date(now.getTime() + DAY_MS);
  const from = rawFrom ? parseBound(rawFrom, "from", false) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from >= to) throw new ExportRangeError("from must be before to");
  return { from, to };
}

/**
 * Reconciliation export: one CSV row per payment with full settlement detail,
 * bounded to a date range (`from`/`to`, default the last 30 days).
 *
 * The bound is the point: an unbounded export loads and serialises every
 * payment that has ever existed, which is a denial of service an operator can
 * trigger by clicking a link twice.
 *
 * One audit event per export, not one per row (AUDIT.md): the log records that
 * a named actor exported a named range — the interesting fact — where per-row
 * events would bury the chain in noise proportional to the table.
 */
export async function GET(req: NextRequest) {
  // The export spans every tenant's payments, so it is platform-roles only.
  const principal = await requireRole(req, "OPERATOR", "REVIEWER");
  if (principal instanceof NextResponse) return principal;

  let range: DateRange;
  try {
    range = parseRange(req.nextUrl.searchParams, new Date());
  } catch (e) {
    if (e instanceof ExportRangeError) return invalidRequest(e.message);
    throw e;
  }

  const payments = await prisma.payment.findMany({
    where: { createdAt: { gte: range.from, lt: range.to } },
    orderBy: { createdAt: "asc" },
    include: { sender: true, recipient: true, ledgerCredits: true },
  });

  const header = [
    "payment_id",
    "reference_id",
    "created_at",
    "status",
    "sender",
    "recipient",
    "corridor",
    "source_amount",
    "source_asset",
    "fx_rate",
    "destination_amount",
    "destination_currency",
    "platform_fee",
    "source_network",
    "destination_network",
    "escrow_tx_hash",
    "settlement_tx_hash",
    "destination_payout_tx_hash",
    "ledger_credit_amount",
  ];

  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = payments.map((p) => {
    const fee = p.feeJson ? (JSON.parse(p.feeJson).platform_fee as string) : "";
    const credit = p.ledgerCredits.reduce((sum, c) => sum + Number(c.amount), 0);
    return [
      p.id,
      p.referenceId,
      p.createdAt.toISOString(),
      p.status,
      p.sender.name,
      p.recipient.name,
      `${p.sourceCurrency}-${p.destinationCurrency}`,
      p.amount,
      p.sourceAsset,
      p.fxRate ?? "",
      p.destinationAmount ?? "",
      p.destinationCurrency,
      fee,
      p.sourceNetwork,
      p.destinationNetwork,
      p.txHash ?? "",
      p.settleTxHash ?? "",
      p.destinationTxHash ?? "",
      credit || "",
    ]
      .map(esc)
      .join(",");
  });

  await audit(
    "reconciliation.exported",
    { from: range.from.toISOString(), to: range.to.toISOString(), paymentCount: payments.length },
    undefined,
    actorOf(principal)
  );

  return new NextResponse([header.join(","), ...rows].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="settlementos-reconciliation.csv"`,
    },
  });
}
