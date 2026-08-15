import { NextRequest, NextResponse } from "next/server";
import { API_KEY_COOKIE } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/session";
import {
  AdminAuthConfigError,
  ensureAdminCredential,
  resolveOperatorSessionKey,
  verifyAdminLogin,
} from "@/lib/admin-auth";
import { beginWrite } from "../../limits";
import { caughtErrorResponse } from "../../guard";

const UNAUTHORIZED_BODY = { error_code: "unauthorized", message: "invalid credentials" } as const;

function unauthorizedCredentials(): NextResponse {
  return NextResponse.json(UNAUTHORIZED_BODY, { status: 401 });
}

function misconfigured(): NextResponse {
  return NextResponse.json(
    { error_code: "internal", message: "admin session is not configured" },
    { status: 500 }
  );
}

/**
 * Exchange a username/password for the same `sos_key` cookie the API-key
 * login sets. The 401 is byte-identical for an unknown username, a wrong
 * password, a missing field, and a malformed body — usernames are guessable
 * in a way 48-hex keys are not, so any difference is an enumeration oracle.
 *
 * Rate-limited by address via `beginWrite(req, null)`, same as /api/auth/login.
 * A password endpoint is a brute-force target; do not raise this limit.
 */
export async function POST(req: NextRequest) {
  const gate = await beginWrite(req, null);
  if (gate instanceof NextResponse) return gate;

  try {
    const body = (gate.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) return unauthorizedCredentials();

    const cred = await ensureAdminCredential();
    if (!cred) {
      console.error("[api] POST /api/auth/session ADMIN_USERNAME/ADMIN_PASSWORD unset and no credential row exists");
      return misconfigured();
    }

    const ok = await verifyAdminLogin(username, password);
    if (!ok) return unauthorizedCredentials();

    const session = await resolveOperatorSessionKey();
    const res = NextResponse.json({ role: session.role, label: session.label });
    res.cookies.set(API_KEY_COOKIE, session.raw, sessionCookieOptions());
    return res;
  } catch (e) {
    if (e instanceof AdminAuthConfigError) {
      console.error("[api] POST /api/auth/session", e.message);
      return misconfigured();
    }
    return caughtErrorResponse(e, "internal", "POST /api/auth/session");
  }
}
