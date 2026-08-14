import { NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { caughtErrorResponse, requirePrincipal } from "../guard";
import { createSettlementMcpServer } from "@/lib/mcp/server";

/**
 * Read-only MCP endpoint. Identity is the same `authenticate()` path every
 * other route uses (`x-api-key`, then the `sos_key` cookie). There is no
 * MCP_API_KEY and no Bearer scheme.
 *
 * Stateless Streamable HTTP with JSON responses: a fresh server+transport per
 * POST, closed afterwards. We use the Web Standard transport, not the Node
 * wrapper — the wrapper pulls in Hono's `getRequestListener`, which overwrites
 * global `Response` and breaks every other App Router route.
 */
export async function POST(req: Request) {
  const principal = await requirePrincipal(req);
  if (principal instanceof NextResponse) return principal;

  const server = createSettlementMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (e) {
    return caughtErrorResponse(e, "internal", "POST /api/mcp");
  } finally {
    await Promise.allSettled([transport.close(), server.close()]);
  }
}
