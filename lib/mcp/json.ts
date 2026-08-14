// JSON helpers for MCP tool results. Framework-free so tests can call them
// without the SDK or Next.

import type { ApiErrorCode } from "../api-errors";

export function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function textJson(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(toJsonSafe(payload), null, 2),
      },
    ],
  };
}

export function toolError(code: ApiErrorCode | "chain_unavailable", message: string) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error_code: code, message }),
      },
    ],
  };
}
