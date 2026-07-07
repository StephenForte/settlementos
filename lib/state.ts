// Payment lifecycle state machine, per PRD section 16.

export const PAYMENT_STATES = [
  "DRAFT",
  "QUOTED",
  "COMPLIANCE_PENDING",
  "MANUAL_REVIEW",
  "APPROVED",
  "LIQUIDITY_RESERVED",
  "SUBMITTED_ONCHAIN",
  "CONFIRMED_ONCHAIN",
  "FX_OR_SWAP_COMPLETED",
  "PAYOUT_PENDING",
  "SETTLED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
  "EXPIRED",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATES)[number];

const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  DRAFT: ["QUOTED", "CANCELLED", "EXPIRED"],
  QUOTED: ["COMPLIANCE_PENDING", "QUOTED", "CANCELLED", "EXPIRED"],
  COMPLIANCE_PENDING: ["APPROVED", "MANUAL_REVIEW", "REJECTED", "CANCELLED"],
  MANUAL_REVIEW: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["LIQUIDITY_RESERVED", "CANCELLED", "FAILED"],
  LIQUIDITY_RESERVED: ["SUBMITTED_ONCHAIN", "FAILED", "CANCELLED"],
  SUBMITTED_ONCHAIN: ["CONFIRMED_ONCHAIN", "FAILED"],
  CONFIRMED_ONCHAIN: ["FX_OR_SWAP_COMPLETED", "FAILED", "REFUNDED"],
  FX_OR_SWAP_COMPLETED: ["PAYOUT_PENDING", "FAILED", "REFUNDED"],
  PAYOUT_PENDING: ["SETTLED", "FAILED", "REFUNDED"],
  SETTLED: [],
  REJECTED: [],
  FAILED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
  EXPIRED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: string, to: PaymentStatus): void {
  if (!canTransition(from as PaymentStatus, to)) {
    throw new Error(`Invalid payment state transition: ${from} → ${to}`);
  }
}

/** States from which a payment can still be cancelled by the user. */
export const CANCELLABLE_STATES: PaymentStatus[] = [
  "DRAFT",
  "QUOTED",
  "COMPLIANCE_PENDING",
  "MANUAL_REVIEW",
  "APPROVED",
];

export const TERMINAL_STATES: PaymentStatus[] = [
  "SETTLED",
  "REJECTED",
  "CANCELLED",
  "REFUNDED",
  "EXPIRED",
];
