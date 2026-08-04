// The one place an error becomes something a client is allowed to see.
//
// Two rules drive this module:
//
//  1. A message only reaches a caller if a route *chose* it. Thrown errors carry
//     internals — contract addresses, RPC URLs, prisma SQL, stack frames — so
//     `fromThrown` logs the real error and answers with a canned message keyed
//     off a stable `error_code`. A route that wants to say something specific
//     says it explicitly via `apiError`, or throws an `ApiError` it built.
//  2. Codes are stable and small. Clients branch on `error_code`; `message` is
//     for humans and may be reworded at any time.
//
// Framework-free on purpose (same reason as lib/auth.ts): the NextResponse
// wrappers live in app/api/guard.ts, so this stays callable from plain vitest.

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "idempotency_conflict"
  | "payload_too_large"
  | "rate_limited"
  | "execution_failed"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  // 422, not 409: the request is well-formed and the resource is fine — the
  // *key* contradicts an earlier one, which is a client bookkeeping bug.
  idempotency_conflict: 422,
  payload_too_large: 413,
  rate_limited: 429,
  execution_failed: 500,
  internal: 500,
};

/**
 * What a caller sees when a route did not pick a message itself. Deliberately
 * says nothing about *why* beyond the code — the detail is in the server log.
 */
const CANNED: Record<ApiErrorCode, string> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  not_found: "not found",
  invalid_request: "invalid request",
  conflict: "the request conflicts with the current state of the resource",
  idempotency_conflict: "this Idempotency-Key was already used for a different request",
  payload_too_large: "request body is too large",
  rate_limited: "too many requests",
  execution_failed: "execution failed",
  internal: "internal error",
};

export interface ApiErrorBody {
  error_code: ApiErrorCode;
  message: string;
}

export interface ApiErrorResult {
  status: number;
  body: ApiErrorBody;
}

/**
 * An error a route (or a lib it calls) raises knowing exactly what the client
 * should be told. `fromThrown` passes an ApiError's own message through; every
 * other thrown type gets a canned one.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message?: string
  ) {
    super(message ?? CANNED[code]);
    this.name = "ApiError";
  }
}

/** Build a client-safe error the route has chosen deliberately. */
export function apiError(code: ApiErrorCode, message?: string): ApiErrorResult {
  return { status: STATUS[code], body: { error_code: code, message: message ?? CANNED[code] } };
}

/**
 * Map a caught error to a client-safe response, logging the real thing to the
 * server console first. `fallback` is the code to use when the error is not an
 * ApiError — i.e. when we genuinely do not know what went wrong and must not
 * guess out loud. `context` labels the log line (usually the route).
 */
export function fromThrown(e: unknown, fallback: ApiErrorCode, context: string): ApiErrorResult {
  console.error("[api]", context, e);
  if (e instanceof ApiError) return apiError(e.code, e.message);
  return apiError(fallback);
}

/**
 * What an ENTITY caller sees in place of `Payment.failureReason`. The stored
 * reason names assets, networks, balances, and RPC failures — operator detail,
 * not tenant detail.
 */
export const SAFE_FAILURE_SUMMARY = "Payment could not be completed. Contact your operator for details.";
