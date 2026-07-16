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
