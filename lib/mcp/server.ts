import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Principal } from "../auth";
import { runTool } from "./errors";
import {
  getBalances,
  getPayment,
  listEntities,
  listNetworks,
  listPayments,
  listTreasuryPositions,
  verifyAuditChainTool,
} from "./tools";

const pageInput = {
  limit: z
    .number()
    .int()
    .optional()
    .describe("Page size (1–200, default 50). Values over 200 are an error, not a clamp."),
  cursor: z.string().optional().describe("Id of the last row of the previous page."),
};

export const MCP_SERVER_NAME = "settlementos";
export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_TOOL_NAMES = [
  "list_networks",
  "list_payments",
  "get_payment",
  "list_entities",
  "list_treasury_positions",
  "get_balances",
  "verify_audit_chain",
] as const;

/**
 * A fresh MCP server closed over one already-resolved principal. The HTTP
 * layer authenticates; this layer never sees an anonymous caller.
 */
export function createSettlementMcpServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  server.registerTool(
    "list_networks",
    {
      title: "List networks",
      description:
        "List SettlementOS networks in the registry, with whether contracts are deployed on each.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => runTool("list_networks", () => listNetworks())
  );

  server.registerTool(
    "list_payments",
    {
      title: "List payments",
      description:
        "List payments visible to the caller. An ENTITY sees only payments it sends or receives. Paginated.",
      inputSchema: pageInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => runTool("list_payments", () => listPayments(principal, args))
  );

  server.registerTool(
    "get_payment",
    {
      title: "Get payment",
      description:
        "Fetch one payment by id, including compliance checks and audit events. A tenant asking for another tenant's id gets not-found, not forbidden.",
      inputSchema: {
        payment_id: z.string().describe("Payment id (pay_…)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => runTool("get_payment", () => getPayment(principal, args))
  );

  server.registerTool(
    "list_entities",
    {
      title: "List entities",
      description:
        "List entities visible to the caller. An ENTITY sees only itself. Paginated.",
      inputSchema: pageInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => runTool("list_entities", () => listEntities(principal, args))
  );

  server.registerTool(
    "list_treasury_positions",
    {
      title: "List treasury positions",
      description:
        "List parked TokenizedMMF positions with live derived value. Platform operators and reviewers only.",
      inputSchema: pageInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => runTool("list_treasury_positions", () => listTreasuryPositions(principal, args))
  );

  server.registerTool(
    "get_balances",
    {
      title: "Get balances",
      description:
        "Treasury and entity token balances by network, plus open reservations and ledger totals. Platform operators and reviewers only.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => runTool("get_balances", () => getBalances(principal))
  );

  server.registerTool(
    "verify_audit_chain",
    {
      title: "Verify audit chain",
      description:
        "Re-hash the append-only audit log from genesis and return INTACT/BROKEN with mode, anchored, and events_verified. Platform roles only. An un-anchored INTACT is a weaker claim than a signed one.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => runTool("verify_audit_chain", () => verifyAuditChainTool(principal))
  );

  return server;
}
