// Fail-safe HTTP plumbing for real compliance providers. Any transport
// problem — network error, timeout, non-2xx, unparseable body — must surface
// as MANUAL_REVIEW (never PASS): a screening we could not perform is treated
// as a screening that needs a human.

import { providerResult, type ProviderResult } from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;

export function providerTimeoutMs(): number {
  const n = Number(process.env.COMPLIANCE_PROVIDER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export async function fetchJson(
  url: string,
  init: RequestInit
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(providerTimeoutMs()) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Provider error/timeout → MANUAL_REVIEW with the failure recorded as evidence. */
export function failSafe(
  provider: string,
  error: unknown,
  httpStatus?: number,
  body?: unknown
): ProviderResult {
  const message = error instanceof Error ? error.message : String(error);
  const reasons = ["provider_error", httpStatus ? `provider_http_${httpStatus}` : "provider_unreachable"];
  return providerResult(provider, "MANUAL_REVIEW", 60, reasons, {
    error: message,
    http_status: httpStatus ?? null,
    body: body ?? null,
  });
}
