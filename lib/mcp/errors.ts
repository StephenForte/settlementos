// Map a thrown value to a client-safe MCP tool error. Same vocabulary as
// lib/api-errors: a chosen ApiError/PaginationError message is shown; anything
// else is logged server-side and replaced with a canned body.

import { ApiError, fromThrown } from "../api-errors";
import { PaginationError } from "../pagination";
import { textJson, toolError } from "./json";

export type McpToolResult = ReturnType<typeof textJson> | ReturnType<typeof toolError>;

export async function runTool(name: string, fn: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    return textJson(await fn());
  } catch (e) {
    if (e instanceof PaginationError) return toolError("invalid_request", e.message);
    if (e instanceof ApiError) return toolError(e.code, e.message);
    const { body } = fromThrown(e, "internal", `mcp.${name}`);
    return toolError(body.error_code, body.message);
  }
}
