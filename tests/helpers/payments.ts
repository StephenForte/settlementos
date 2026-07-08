// Payment factories for tests. Mirror what POST /api/payments + /quote do,
// without going through HTTP.

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { CURRENCY_TO_ASSET } from "@/lib/assets";
import { quoteRoutes } from "@/lib/routing";

export interface PaymentOpts {
  senderExternalId?: string;
  recipientExternalId?: string;
  amount?: string;
  sourceCurrency?: string;
  destinationCurrency?: string;
  sourceNetwork?: string;
  destinationNetwork?: string;
}

export async function createDraftPayment(opts: PaymentOpts = {}) {
  const {
    senderExternalId = "ent_acme_us",
    recipientExternalId = "ent_tokyo_supplier",
    amount = "100000.00",
    sourceCurrency = "USD",
    destinationCurrency = "JPY",
    sourceNetwork = "base-local",
    destinationNetwork = "base-local",
  } = opts;

  const sender = await prisma.entity.findUniqueOrThrow({ where: { externalId: senderExternalId } });
  const recipient = await prisma.entity.findUniqueOrThrow({ where: { externalId: recipientExternalId } });

  return prisma.payment.create({
    data: {
      id: `pay_test_${randomBytes(6).toString("hex")}`,
      senderId: sender.id,
      recipientId: recipient.id,
      amount,
      sourceCurrency,
      destinationCurrency,
      sourceAsset: CURRENCY_TO_ASSET[sourceCurrency],
      destinationAsset: CURRENCY_TO_ASSET[destinationCurrency],
      sourceNetwork,
      destinationNetwork,
      purpose: "supplier_payment",
      referenceId: "TEST",
    },
  });
}

/** Draft → quoted → APPROVED, ready for executePayment (compliance bypassed). */
export async function createApprovedPayment(opts: PaymentOpts = {}) {
  const payment = await createDraftPayment(opts);
  const routes = await quoteRoutes(payment.id);
  return prisma.payment.update({
    where: { id: payment.id },
    data: {
      quoteJson: JSON.stringify(routes),
      selectedRouteId: routes[0].route_id,
      status: "APPROVED",
    },
  });
}
