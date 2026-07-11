// Shared compliance-provider contract. Every provider — mock or real vendor
// sandbox — returns this shape; lib/compliance.ts re-exports it so existing
// imports keep working.

export type ComplianceStatus = "PASS" | "FAIL" | "MANUAL_REVIEW" | "EXEMPT_TESTNET";

export interface ProviderResult {
  status: ComplianceStatus;
  score: number;
  reason_codes: string[];
  provider: string;
  timestamp: string;
  /** Verbatim provider response, persisted on ComplianceCheck as audit evidence. Mocks omit it. */
  raw?: unknown;
}

export function providerResult(
  provider: string,
  status: ComplianceStatus,
  score: number,
  reasons: string[] = [],
  raw?: unknown
): ProviderResult {
  return {
    status,
    score,
    reason_codes: reasons,
    provider,
    timestamp: new Date().toISOString(),
    raw,
  };
}
