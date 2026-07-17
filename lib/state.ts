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
  "COMPENSATION_PENDING",
  "COMPENSATED",
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
  // COMPENSATION_PENDING is reachable from every status at which the escrow may
  // already have been released on-chain — once it is, there is nothing left to
  // refund and a failure must compensate instead. That is not just PAYOUT_PENDING:
  // settlePayment lands before the DB knows it did, so a throw in between strands a
  // released escrow at CONFIRMED_ONCHAIN (receipt never read) or
  // FX_OR_SWAP_COMPLETED (settled, next write threw). Which one actually applies is
  // decided by reading the escrow, never by the status alone (see lib/executor.ts).
  CONFIRMED_ONCHAIN: ["FX_OR_SWAP_COMPLETED", "FAILED", "REFUNDED", "COMPENSATION_PENDING"],
  FX_OR_SWAP_COMPLETED: ["PAYOUT_PENDING", "FAILED", "REFUNDED", "COMPENSATION_PENDING"],
  PAYOUT_PENDING: ["SETTLED", "FAILED", "REFUNDED", "COMPENSATION_PENDING"],
  SETTLED: [],
  COMPENSATION_PENDING: ["COMPENSATED"],
  COMPENSATED: [],
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
  "COMPENSATED",
  "REJECTED",
  "CANCELLED",
  "REFUNDED",
  "EXPIRED",
];

/**
 * States at which an execution attempt is over, so the payment's execution lease
 * must be released (see `Payment.executionLeaseId`). FAILED is not terminal — a
 * refund can still follow — but the attempt that failed is done with the row, and
 * holding the lease past it would block an operator retry the state machine allows.
 */
export const LEASE_RELEASE_STATES: PaymentStatus[] = [...TERMINAL_STATES, "FAILED"];
