import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { CURRENCY_TO_ASSET } from "@/lib/assets";
import { supportedCorridors, corridorCode } from "@/lib/fx";
import { NETWORKS } from "@/lib/networks";
import { isChainReady, loadDeployments } from "@/lib/chain";
import {
  actorOf,
  forbidden,
  invalidRequest,
  isPlatformRole,
  notFound,
  requirePrincipal,
  scrubFailureReason,
} from "../guard";

export async function GET(req: NextRequest) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  // A tenant sees only the payments it is party to; operators and reviewers see all.
  const payments = await prisma.payment.findMany({
    where: isPlatformRole(principal)
      ? {}
      : { OR: [{ senderId: principal.entityId }, { recipientId: principal.entityId }] },
    orderBy: { createdAt: "desc" },
    include: { sender: true, recipient: true },
  });
  return NextResponse.json({ payments: payments.map((p) => scrubFailureReason(principal, p)) });
}

export async function POST(req: NextRequest) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  // An unparseable body must be a 400 we chose, not an unhandled throw that
  // Next renders as a 500 (with a stack, in dev).
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return invalidRequest("body must be a JSON object");
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

  // A tenant may only originate payments it is sending; a REVIEWER decides on
  // manual reviews and never originates one. The comparison runs before the
  // sender lookup below, so a mismatch cannot reveal whether the sender_id the
  // caller named exists.
  if (principal.role === "REVIEWER") return forbidden();
  if (principal.role === "ENTITY") {
    const own = principal.entityId
      ? await prisma.entity.findUnique({ where: { id: principal.entityId } })
      : null;
    if (!own || own.externalId !== sender_id) return forbidden();
  }

  if (!NETWORKS[source_network] || !NETWORKS[destination_network]) {
    return invalidRequest(`unknown network — supported: ${Object.keys(NETWORKS).join(", ")}`);
  }
  if (isChainReady()) {
    const deployed = loadDeployments().networks;
    const missing = [source_network, destination_network].find((n) => !deployed[n]);
    if (missing) {
      return invalidRequest(
        `network ${missing} has no deployed contracts — ${
          NETWORKS[missing]?.live ? `run: npm run deploy:${missing}` : "run: npm run setup"
        }`
      );
    }
  }

  if (!sender_id || !recipient_id || !amount || !source_currency || !destination_currency) {
    return invalidRequest(
      "sender_id, recipient_id, amount, source_currency, destination_currency are required"
    );
  }
  if (Number(amount) <= 0 || Number.isNaN(Number(amount))) {
    return invalidRequest("amount must be a positive number");
  }
  const sourceAsset = CURRENCY_TO_ASSET[source_currency];
  const destAsset = CURRENCY_TO_ASSET[destination_currency];
  if (!sourceAsset || !destAsset) {
    return invalidRequest("unsupported currency");
  }
  if (
    source_currency !== destination_currency &&
    !supportedCorridors().includes(corridorCode(source_currency, destination_currency))
  ) {
    return invalidRequest("unsupported corridor");
  }

  const [sender, recipient] = await Promise.all([
    prisma.entity.findUnique({ where: { externalId: sender_id } }),
    prisma.entity.findUnique({ where: { externalId: recipient_id } }),
  ]);
  if (!sender || !recipient) {
    // Deliberately does not say *which* of the two is unknown.
    return notFound();
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
    id,
    actorOf(principal)
  );

  return NextResponse.json({ payment_id: payment.id, status: payment.status }, { status: 201 });
}
