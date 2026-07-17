// Authorization glue for the route handlers. lib/auth answers *who* the caller
// is; this answers *whether they may*. Colocated under app/api because it is an
// HTTP concern (statuses, response bodies) — lib/ stays framework-free.
//
// Errors are deliberately generic: an anonymous or invalid key both get the same
// 401, and a tenant asking for someone else's payment gets a 404 rather than a
// 403, so no response tells an attacker what exists.

import { NextResponse } from "next/server";
import { authenticate, isPlatformRole, type Principal, type Role } from "@/lib/auth";
import { apiError, fromThrown, SAFE_FAILURE_SUMMARY, type ApiErrorCode } from "@/lib/api-errors";

// Re-exported so route handlers keep importing it from the guard layer while the
// pure definition lives beside Principal in lib/auth.ts (server components use it).
export { isPlatformRole };

/** Turn a client-safe error into the response to return. */
export function errorResponse(code: ApiErrorCode, message?: string): NextResponse {
  const { status, body } = apiError(code, message);
  return NextResponse.json(body, { status });
}

/**
 * The catch-path helper every handler uses: logs the real error server-side and
 * answers with a canned body. `fallback` applies when the thrown error is not an
 * ApiError; `context` labels the server log line.
 */
export function caughtErrorResponse(e: unknown, fallback: ApiErrorCode, context: string): NextResponse {
  const { status, body } = fromThrown(e, fallback, context);
  return NextResponse.json(body, { status });
}

export function unauthorized(): NextResponse {
  return errorResponse("unauthorized");
}

export function forbidden(): NextResponse {
  return errorResponse("forbidden");
}

export function notFound(): NextResponse {
  return errorResponse("not_found");
}

export function invalidRequest(message: string): NextResponse {
  return errorResponse("invalid_request", message);
}

export function conflict(message: string): NextResponse {
  return errorResponse("conflict", message);
}

/**
 * Identify the caller, or hand back the 401 to return. Callers narrow with
 * `if (result instanceof NextResponse) return result;`.
 */
export async function requirePrincipal(req: Request): Promise<Principal | NextResponse> {
  const principal = await authenticate(req);
  return principal ?? unauthorized();
}

/** As requirePrincipal, but the caller's role must be one of `roles` (else 403). */
export async function requireRole(req: Request, ...roles: Role[]): Promise<Principal | NextResponse> {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;
  return roles.includes(principal.role) ? principal : forbidden();
}

/**
 * The audit-trail actor for a principal. The audit log records who the key says
 * they are, never what a request body claims — a caller cannot forge an actor.
 */
export function actorOf(principal: Principal): string {
  return `${principal.label} (${principal.role})`;
}

/**
 * Redact a payment's stored failure detail for tenant callers. The reason the
 * executor writes names assets, networks, free balances, and RPC failures —
 * operator diagnostics, not something to hand a counterparty. Platform roles
 * still see it verbatim.
 *
 * Returns a copy: never mutate the prisma row, which callers may still use.
 */
export function scrubFailureReason<T extends { failureReason: string | null }>(
  principal: Principal,
  payment: T
): T {
  if (isPlatformRole(principal) || payment.failureReason === null) return payment;
  return { ...payment, failureReason: SAFE_FAILURE_SUMMARY };
}

/** What a tenant sees in place of an audit event's raw detail. Valid JSON, so a
 *  consumer that parses `detail` still gets an object. */
const REDACTED_AUDIT_DETAIL = JSON.stringify({ redacted: true });

/**
 * Redact audit-event detail for tenant callers. Event detail is free-form and
 * routinely carries operator diagnostics — failure reasons naming treasury
 * balances and networks (transitionStatus merges the written columns in), and raw
 * viem/RPC error strings. Scrubbing only Payment.failureReason is not enough when
 * the same text rides inside an included audit event. Platform roles see detail
 * verbatim; a tenant still gets each event's action, timestamps, and hash (the
 * chain is intact — the hash was computed server-side over the original detail and
 * is verified against the DB, never this response). Never mutate the prisma rows.
 */
export function scrubAuditDetail<T extends { detail: string }>(principal: Principal, events: T[]): T[] {
  if (isPlatformRole(principal)) return events;
  return events.map((e) => ({ ...e, detail: REDACTED_AUDIT_DETAIL }));
}

/**
 * Authorize a write that drives one payment (quote/execute/cancel): the
 * OPERATOR, or the payment's sender — the party whose funds move. Returns the
 * response to send, or null when the caller may proceed.
 *
 * A REVIEWER decides on manual reviews but does not drive settlement, and the
 * recipient may watch a payment but not move it: both get 403. A tenant that is
 * not party to the payment gets the same 404 a nonexistent id gets, so no write
 * route becomes the existence oracle the read routes refuse to be.
 */
export function authorizePaymentWrite(
  principal: Principal,
  payment: { senderId: string; recipientId: string }
): NextResponse | null {
  if (principal.role === "OPERATOR") return null;
  if (principal.role !== "ENTITY") return forbidden();
  if (principal.entityId === payment.senderId) return null;
  return principal.entityId === payment.recipientId ? forbidden() : notFound();
}
