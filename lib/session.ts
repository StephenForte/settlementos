// Browser-session glue for the API-key identity model.
//
// lib/auth.ts stays framework-free (it takes a plain `Request`) so route tests can
// call it without Next's request context. This module is the Next-only half: it
// resolves the same principal from the `sos_key` cookie for server components,
// which render with no Request object in hand.

import { cookies } from "next/headers";
import { API_KEY_COOKIE, principalForKey, type Principal } from "./auth";

/** Cookie lifetime — a demo session, re-authenticated by pasting the key again. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // The demo runs on plain http://localhost; only force TLS-only off-localhost.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * The signed-in principal for a server component, or null when anonymous or the
 * cookie holds a key that no longer resolves (e.g. `npm run setup` reseeded the
 * keys under a live session). Fails closed like authenticate() — the caller
 * decides whether that means "redirect to /login" or "render the public view".
 */
export async function currentPrincipal(): Promise<Principal | null> {
  const raw = (await cookies()).get(API_KEY_COOKIE)?.value;
  if (!raw) return null;
  return principalForKey(raw);
}
