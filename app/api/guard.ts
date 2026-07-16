// Authorization glue for the route handlers. lib/auth answers *who* the caller
// is; this answers *whether they may*. Colocated under app/api because it is an
// HTTP concern (statuses, response bodies) — lib/ stays framework-free.
//
// Errors are deliberately generic: an anonymous or invalid key both get the same
// 401, and a tenant asking for someone else's payment gets a 404 rather than a
// 403, so no response tells an attacker what exists.

import { NextResponse } from "next/server";
import { authenticate, type Principal, type Role } from "@/lib/auth";

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export function forbidden(): NextResponse {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export function notFound(): NextResponse {
  return NextResponse.json({ error: "not found" }, { status: 404 });
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

/** True when the principal has platform-wide read access (i.e. is not a tenant). */
export function isPlatformRole(principal: Principal): boolean {
  return principal.role === "OPERATOR" || principal.role === "REVIEWER";
}

/**
 * The audit-trail actor for a principal. The audit log records who the key says
 * they are, never what a request body claims — a caller cannot forge an actor.
 */
export function actorOf(principal: Principal): string {
  return `${principal.label} (${principal.role})`;
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
