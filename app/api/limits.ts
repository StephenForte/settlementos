// The two blunt limits every write endpoint gets: how often a caller may write,
// and how much they may send. Both are HTTP concerns, so they live here rather
// than in lib/ — lib/rate-limit.ts owns the window, this owns the key, the
// config, and the response (same split as guard.ts over lib/auth.ts).
//
// A handler wraps its body in two lines:
//
//   const gate = await beginWrite(req, principal);
//   if (gate instanceof NextResponse) return gate;   // 429 or 413
//   const body = gate.body;                          // parsed JSON, or null
//
// `body` is null when the request carried none or carried something unparseable
// — handlers decide whether that is a 400 or an empty object, exactly as they
// did when they each called `req.json().catch(...)` themselves.

import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import type { Principal } from "@/lib/auth";
import { consumeRateLimit } from "@/lib/rate-limit";

/** Writes permitted per principal (or IP) per minute. */
export const WRITE_RATE_LIMIT = 30;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Largest JSON body any endpoint accepts. Every real request is a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Env override, read per request so a test can move it. Anything non-canonical
 * (including the `Number("")` = 0 trap) falls back to the default rather than
 * silently disabling the limit.
 */
function writeLimit(): number {
  const raw = process.env.RATE_LIMIT_WRITES_PER_MINUTE;
  if (!raw || !/^[0-9]+$/.test(raw)) return WRITE_RATE_LIMIT;
  const n = Number(raw);
  return n > 0 ? n : WRITE_RATE_LIMIT;
}

/**
 * What the limiter counts against. A principal is the real subject — an
 * authenticated caller cannot shed its budget by changing address. The IP
 * fallback is for the endpoints that have no principal yet (the login
 * exchange), and is best-effort: `x-forwarded-for` is client-settable, so it is
 * only trustworthy behind a proxy that overwrites it. That is why it is the
 * fallback and not the key.
 */
export function rateLimitKey(req: Request, principal: Principal | null): string {
  if (principal) return `key:${principal.keyId}`;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || req.headers.get("x-real-ip") || "unknown"}`;
}

/** The 429 to return, with the Retry-After the window actually implies. */
function tooManyRequests(retryAfterSeconds: number): NextResponse {
  const { status, body } = apiError("rate_limited");
  return NextResponse.json(body, {
    status,
    headers: { "retry-after": String(retryAfterSeconds) },
  });
}

/**
 * Rate-limit a write, or hand back the 429. Exposed separately from
 * `beginWrite` for the endpoints with no body to read (POST .../cancel).
 */
export function enforceWriteRateLimit(req: Request, principal: Principal | null): NextResponse | null {
  const decision = consumeRateLimit(rateLimitKey(req, principal), {
    limit: writeLimit(),
    windowMs: RATE_LIMIT_WINDOW_MS,
    now: Date.now(),
  });
  return decision.allowed ? null : tooManyRequests(decision.retryAfterSeconds);
}

/**
 * Read a request body without ever holding more than the cap in memory.
 *
 * Content-Length is checked first because it is free, but it is not the
 * enforcement: a client sets that header, so the stream is measured as it
 * arrives and cancelled the moment it crosses the cap. Trusting the declared
 * length is how a size limit becomes decorative.
 *
 * Returns null when the body is too large.
 */
async function readCappedBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) return null;

  const body = req.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface WriteScope {
  /** The parsed JSON body, or null when absent/unparseable. */
  body: unknown;
}

/** Rate-limit the write and read its body, or hand back the 429 / 413. */
export async function beginWrite(req: Request, principal: Principal | null): Promise<WriteScope | NextResponse> {
  const limited = enforceWriteRateLimit(req, principal);
  if (limited) return limited;

  const text = await readCappedBody(req, MAX_BODY_BYTES).catch(() => "");
  if (text === null) {
    const { status, body } = apiError("payload_too_large");
    return NextResponse.json(body, { status });
  }
  if (text === "") return { body: null };

  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: null };
  }
}
