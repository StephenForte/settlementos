import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { actorOf, requireRole } from "../guard";

/** Reconciliation export: one CSV row per payment with full settlement detail. */
export async function GET(req: NextRequest) {
  // The export spans every tenant's payments, so it is platform-roles only.
  const principal = await requireRole(req, "OPERATOR", "REVIEWER");
  if (principal instanceof NextResponse) return principal;

  const payments = await prisma.payment.findMany({
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

  await audit("reconciliation.exported", { paymentCount: payments.length }, undefined, actorOf(principal));

  return new NextResponse([header.join(","), ...rows].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="settlementos-reconciliation.csv"`,
    },
  });
}
