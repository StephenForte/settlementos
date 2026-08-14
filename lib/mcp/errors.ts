// Map a thrown value to a client-safe MCP tool error. Same vocabulary as
// lib/api-errors: a chosen ApiError/PaginationError message is shown; anything
// else is logged server-side and replaced with a canned body.

import { ApiError, fromThrown } from "../api-errors";
import { PaginationError } from "../pagination";
import { textJson, toolError } from "./json";

export type McpToolResult = ReturnType<typeof textJson> | ReturnType<typeof toolError>;

/**
 * Chains are not deployed or reachable. REST `GET /api/balances` answers 503
 * `chain_unavailable` with setup instructions rather than one of the ApiError
 * codes, and `toolError` already admits that code — mapping this to `internal`
 * would show an operator a generic failure instead of the setup signal.
 *
 * Deliberately not an `ApiError`: `chain_unavailable` is outside `ApiErrorCode`,
 * which carries a status map every REST route depends on.
 */
export class ChainUnavailableError extends Error {}

export async function runTool(name: string, fn: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    return textJson(await fn());
  } catch (e) {
    if (e instanceof PaginationError) return toolError("invalid_request", e.message);
    if (e instanceof ChainUnavailableError) return toolError("chain_unavailable", e.message);
    if (e instanceof ApiError) return toolError(e.code, e.message);
    const { body } = fromThrown(e, "internal", `mcp.${name}`);
    return toolError(body.error_code, body.message);
  }
}
