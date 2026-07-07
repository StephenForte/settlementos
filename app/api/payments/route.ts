import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { CURRENCY_TO_ASSET } from "@/lib/assets";
import { supportedCorridors, corridorCode } from "@/lib/fx";
import { NETWORKS } from "@/lib/networks";

export async function GET() {
  const payments = await prisma.payment.findMany({
    orderBy: { createdAt: "desc" },
    include: { sender: true, recipient: true },
  });
  return NextResponse.json({ payments });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    sender_id,
    recipient_id,
    amount,
    source_currency,
    destination_currency,
    source_network = "base-local",
    destination_network = "base-local",
    purpose = "",
    reference_id = "",
    memo = "",
  } = body;

  if (!NETWORKS[source_network] || !NETWORKS[destination_network]) {
    return NextResponse.json(
      { error: `unknown network — supported: ${Object.keys(NETWORKS).join(", ")}` },
      { status: 400 }
    );
  }

  if (!sender_id || !recipient_id || !amount || !source_currency || !destination_currency) {
    return NextResponse.json(
      { error: "sender_id, recipient_id, amount, source_currency, destination_currency are required" },
      { status: 400 }
    );
  }
  if (Number(amount) <= 0 || Number.isNaN(Number(amount))) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }
  const sourceAsset = CURRENCY_TO_ASSET[source_currency];
  const destAsset = CURRENCY_TO_ASSET[destination_currency];
  if (!sourceAsset || !destAsset) {
    return NextResponse.json({ error: "unsupported currency" }, { status: 400 });
  }
  if (
    source_currency !== destination_currency &&
    !supportedCorridors().includes(corridorCode(source_currency, destination_currency))
  ) {
    return NextResponse.json({ error: "unsupported corridor" }, { status: 400 });
  }

  const [sender, recipient] = await Promise.all([
    prisma.entity.findUnique({ where: { externalId: sender_id } }),
    prisma.entity.findUnique({ where: { externalId: recipient_id } }),
  ]);
  if (!sender || !recipient) {
    return NextResponse.json({ error: "unknown sender_id or recipient_id" }, { status: 404 });
  }

  const id = `pay_${randomBytes(6).toString("hex")}`;
  const payment = await prisma.payment.create({
    data: {
      id,
      senderId: sender.id,
      recipientId: recipient.id,
      amount: String(amount),
      sourceCurrency: source_currency,
      destinationCurrency: destination_currency,
      sourceAsset,
      destinationAsset: destAsset,
      sourceNetwork: source_network,
      destinationNetwork: destination_network,
      purpose,
      referenceId: reference_id,
      memo,
    },
  });
  await audit(
    "payment.created",
    {
      sender: sender_id,
      recipient: recipient_id,
      amount,
      corridor: `${source_currency}-${destination_currency}`,
      route: `${source_network} → ${destination_network}`,
    },
    id
  );

  return NextResponse.json({ payment_id: payment.id, status: payment.status }, { status: 201 });
}
