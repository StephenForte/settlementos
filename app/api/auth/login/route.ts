import { NextRequest, NextResponse } from "next/server";
import { API_KEY_COOKIE, principalForKey } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/session";

/**
 * Exchange a raw API key for the `sos_key` session cookie. The error is
 * deliberately generic and identical for a missing, malformed, and unknown key —
 * a caller must not be able to probe which keys exist.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const raw = typeof body.api_key === "string" ? body.api_key.trim() : "";

  const principal = raw ? await principalForKey(raw) : null;
  if (!principal) {
    return NextResponse.json(
      { error_code: "unauthorized", message: "invalid api key" },
      { status: 401 }
    );
  }

  const res = NextResponse.json({ role: principal.role, label: principal.label });
  res.cookies.set(API_KEY_COOKIE, raw, sessionCookieOptions());
  return res;
}
