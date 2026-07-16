// The one way a payment's status changes.
//
// `assertTransition` (lib/state.ts) says whether a move is *legal*; this module
// says whether it still *applies*. Every write is a compare-and-swap against the
// status the caller believes the row is in, so two writers racing from the same
// status cannot both win: the loser's updateMany matches zero rows and throws
// StaleTransitionError rather than overwriting whatever the winner just did.
//
// The audit event is written only after a successful swap — a losing writer must
// not leave a record of a change it did not make.
//
// Framework-free (same reason as lib/auth.ts and lib/api-errors.ts): callable
// from plain vitest, no next/server import.

import type { Payment } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { assertTransition, type PaymentStatus } from "./state";
import { ApiError } from "./api-errors";

/**
 * A legal transition that no longer applies: the row moved out of `from` before
 * this writer got there (a concurrent execute, a reviewer deciding at the same
 * moment, a retry of an already-applied request).
 *
 * An ApiError so route handlers need no mapping table — `caughtErrorResponse`
 * already turns it into a 409. The message names no internals.
 */
export class StaleTransitionError extends ApiError {
  constructor(
    readonly paymentId: string,
    readonly expectedFrom: string,
    readonly to: PaymentStatus
  ) {
    super("conflict", "payment status changed while the request was in flight");
    this.name = "StaleTransitionError";
  }
}

export interface TransitionOpts {
  /** Extra columns to write in the same statement as the status. */
  data?: Partial<Payment>;
  /** Merged into the audit detail alongside { from, to, ...data }. */
  detail?: Record<string, unknown>;
  /** Defaults to `payment.status.<to>`; override for domain events (reviews). */
  action?: string;
  /** Defaults to "system" — the machine acting on its own initiative. */
  actor?: string;
}

/**
 * Move a payment `from → to` if and only if it is still in `from`.
 *
 * Returns the updated row. Throws on an illegal move (a bug — the caller asked
 * for something the state machine forbids) and StaleTransitionError on a lost
 * race (not a bug — expected under concurrency).
 */
export async function transitionStatus(
  payment: { id: string; status: string },
  to: PaymentStatus,
  opts: TransitionOpts = {}
): Promise<Payment> {
  const { data = {}, detail = {}, action, actor } = opts;
  const from = payment.status;
  assertTransition(from, to);

  // The CAS: `status: from` in the WHERE is what makes this safe. A plain
  // update({ where: { id } }) would clobber a concurrent writer's result.
  const { count } = await prisma.payment.updateMany({
    where: { id: payment.id, status: from },
    data: { status: to, ...data },
  });
  if (count === 0) throw new StaleTransitionError(payment.id, from, to as PaymentStatus);

  const updated = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  await audit(
    action ?? `payment.status.${to.toLowerCase()}`,
    { from, to, ...data, ...detail },
    payment.id,
    actor
  );
  return updated;
}
