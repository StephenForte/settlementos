// Read-only MCP server: identity, tenant isolation, pagination, scrubbing.
//
// Tool implementations are invoked directly (the HTTP layer is authenticate +
// transport). Isolation tests spy the Prisma `where` so a post-filter refactor
// fails even when the returned rows happen to look right.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { POST as mcpPOST } from "@/app/api/mcp/route";
import { API_KEY_COOKIE, API_KEY_HEADER, principalForKey } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { SAFE_FAILURE_SUMMARY } from "@/lib/api-errors";
import { createSettlementMcpServer, MCP_TOOL_NAMES } from "@/lib/mcp/server";
import {
  getBalances,
  getPayment,
  listEntities,
  listPayments,
  listTreasuryPositions,
  verifyAuditChainTool,
} from "@/lib/mcp/tools";
import { excludeSupersededByRegenesisWhere } from "@/lib/networks";
import { API_KEYS } from "../fixture";

afterEach(() => vi.restoreAllMocks());

const CREATED: string[] = [];

async function seedPayment(
  senderExternalId: string,
  recipientExternalId: string,
  over: { id?: string; createdAt?: Date; failureReason?: string } = {}
) {
  const [sender, recipient] = await Promise.all([
    prisma.entity.findUniqueOrThrow({ where: { externalId: senderExternalId } }),
    prisma.entity.findUniqueOrThrow({ where: { externalId: recipientExternalId } }),
  ]);
  const payment = await prisma.payment.create({
    data: {
      id: over.id ?? `pay_mcp_${senderExternalId.slice(4, 12)}_${recipient.id.slice(-4)}_${CREATED.length}`,
      senderId: sender.id,
      recipientId: recipient.id,
      amount: "1000.00",
      sourceCurrency: "USD",
      destinationCurrency: "USD",
      sourceAsset: "mockUSDC",
      destinationAsset: "mockUSDC",
      sourceNetwork: "base-local",
      destinationNetwork: "base-local",
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      ...(over.failureReason ? { failureReason: over.failureReason } : {}),
    },
  });
  CREATED.push(payment.id);
  return payment;
}

let acmePrincipal: NonNullable<Awaited<ReturnType<typeof principalForKey>>>;
let operatorPrincipal: NonNullable<Awaited<ReturnType<typeof principalForKey>>>;
let acmePayment = "";
let othersPayment = "";

beforeAll(async () => {
  const [acme, operator] = await Promise.all([
    principalForKey(API_KEYS.entities.ent_acme_us),
    principalForKey(API_KEYS.operator),
  ]);
  if (!acme || !operator) throw new Error("fixture keys did not resolve");
  acmePrincipal = acme;
  operatorPrincipal = operator;
  acmePayment = (await seedPayment("ent_acme_us", "ent_tokyo_supplier")).id;
  othersPayment = (await seedPayment("ent_sg_supplier", "ent_osaka_parts")).id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { id: { in: CREATED } } });
});

function mcpPost(body: unknown, key?: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (key) headers[API_KEY_HEADER] = key;
  return new NextRequest("http://test.local/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...({ duplex: "half" } as object),
  });
}

const initializeBody = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "0.0.0" },
  },
};

describe("POST /api/mcp authentication", () => {
  it("gives a generic 401 to anonymous callers — same body as every other route", async () => {
    const res = await mcpPOST(mcpPost(initializeBody));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error_code: "unauthorized", message: "unauthorized" });
  });

  it("treats an invalid key exactly like anonymous — no oracle for which keys exist", async () => {
    const anonymous = await mcpPOST(mcpPost(initializeBody));
    const invalid = await mcpPOST(mcpPost(initializeBody, "sos_not_a_real_key"));
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual(await anonymous.json());
  });

  it("does not accept Authorization Bearer — there is no second key scheme", async () => {
    const res = await mcpPOST(
      mcpPost(initializeBody, undefined, { authorization: `Bearer ${API_KEYS.operator}` })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error_code: "unauthorized", message: "unauthorized" });
  });

  it("does not consult MCP_API_KEY even when set", async () => {
    vi.stubEnv("MCP_API_KEY", "would-be-a-bypass-if-we-read-it");
    const res = await mcpPOST(mcpPost(initializeBody, "would-be-a-bypass-if-we-read-it"));
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });

  it("accepts the session cookie as well as the header", async () => {
    const req = new NextRequest("http://test.local/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        cookie: `${API_KEY_COOKIE}=${API_KEYS.operator}`,
      },
      body: JSON.stringify(initializeBody),
      ...({ duplex: "half" } as object),
    });
    expect((await mcpPOST(req)).status).toBe(200);
  });

  it("initializes for a valid x-api-key", async () => {
    const res = await mcpPOST(mcpPost(initializeBody, API_KEYS.operator));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo).toMatchObject({ name: "settlementos" });
  });
});

describe("list_payments tenant isolation", () => {
  it("puts the tenant OR in the Prisma where — a post-filter would not", async () => {
    const findMany = vi.spyOn(prisma.payment, "findMany");
    await listPayments(acmePrincipal, { limit: 10 });

    expect(findMany).toHaveBeenCalled();
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({
      AND: [
        { OR: [{ senderId: acmePrincipal.entityId }, { recipientId: acmePrincipal.entityId }] },
        excludeSupersededByRegenesisWhere(),
      ],
    });
  });

  it("still returns in-scope rows when newer out-of-scope rows would fill the page", async () => {
    // 3 foreign payments dated in the far future, so they are the newest rows in
    // the table. limit=2 → take 3. A where-filter returns 2 of the tenant's
    // payments. A post-filter of the newest 3 returns nothing — all three are
    // another tenant's.
    await seedPayment("ent_sg_supplier", "ent_osaka_parts", {
      id: "pay_mcp_where_f1",
      createdAt: new Date("2099-01-01T00:00:00Z"),
    });
    await seedPayment("ent_sg_supplier", "ent_osaka_parts", {
      id: "pay_mcp_where_f2",
      createdAt: new Date("2099-01-02T00:00:00Z"),
    });
    await seedPayment("ent_sg_supplier", "ent_osaka_parts", {
      id: "pay_mcp_where_f3",
      createdAt: new Date("2099-01-03T00:00:00Z"),
    });

    const page = await listPayments(acmePrincipal, { limit: 2 });
    const ids = page.payments.map((p) => p.id);
    // Post-filter of take(3) would be empty — the newest three rows are foreign.
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain("pay_mcp_where_f1");
    expect(ids).not.toContain("pay_mcp_where_f2");
    expect(ids).not.toContain("pay_mcp_where_f3");
  });

  it("does not leak payment existence through the cursor", async () => {
    await expect(listPayments(acmePrincipal, { cursor: othersPayment })).rejects.toMatchObject({
      code: "invalid_request",
      message: "cursor is not valid",
    });
    await expect(listPayments(acmePrincipal, { cursor: "pay_does_not_exist" })).rejects.toMatchObject({
      code: "invalid_request",
      message: "cursor is not valid",
    });
  });

  it("errors rather than clamping a limit past the cap", async () => {
    await expect(listPayments(acmePrincipal, { limit: 201 })).rejects.toThrow(/at most 200/);
  });
});

describe("get_payment tenant isolation", () => {
  it("scopes the lookup in the where, not after the load", async () => {
    const findFirst = vi.spyOn(prisma.payment, "findFirst");
    await getPayment(acmePrincipal, { payment_id: othersPayment }).catch(() => undefined);

    expect(findFirst).toHaveBeenCalled();
    expect(findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: othersPayment,
      OR: [{ senderId: acmePrincipal.entityId }, { recipientId: acmePrincipal.entityId }],
    });
  });

  it("returns not-found for another tenant's id, identical to a nonexistent id", async () => {
    // Build both matchers before awaiting either. `expect(p).rejects` attaches
    // its handler synchronously, so awaiting in sequence leaves the second
    // promise rejected-and-unhandled for a turn — which Vitest reports as an
    // unhandled rejection and exits non-zero on, even with every test passing.
    // Whether it fires is pure timing, so it passed locally and failed in CI.
    const notFound = { code: "not_found", message: "not found" };
    const foreign = expect(
      getPayment(acmePrincipal, { payment_id: othersPayment })
    ).rejects.toMatchObject(notFound);
    const ghost = expect(
      getPayment(acmePrincipal, { payment_id: "pay_does_not_exist" })
    ).rejects.toMatchObject(notFound);
    await Promise.all([foreign, ghost]);
  });

  it("lets the tenant read its own payment", async () => {
    const { payment } = await getPayment(acmePrincipal, { payment_id: acmePayment });
    expect(payment.id).toBe(acmePayment);
  });
});

describe("failureReason and audit-event scrubbing", () => {
  it("scrubs failureReason for a tenant and leaves it intact for an OPERATOR", async () => {
    const secret = "Insufficient mockJPY on polygon-local: need 5, available 1 (rpc https://secret.example)";
    const row = await seedPayment("ent_acme_us", "ent_tokyo_supplier", {
      id: "pay_mcp_failreason",
      failureReason: secret,
    });

    const asEntity = await listPayments(acmePrincipal, { limit: 50 });
    const entityRow = asEntity.payments.find((p) => p.id === row.id);
    expect(entityRow?.failureReason).toBe(SAFE_FAILURE_SUMMARY);
    expect(JSON.stringify(entityRow)).not.toContain("mockJPY");
    expect(JSON.stringify(entityRow)).not.toContain("secret.example");

    const asOperator = await listPayments(operatorPrincipal, { limit: 50 });
    const operatorRow = asOperator.payments.find((p) => p.id === row.id);
    expect(operatorRow?.failureReason).toBe(secret);
  });

  it("scrubs audit-event detail for a tenant and leaves it intact for an OPERATOR", async () => {
    // Audited rows cannot be deleted (AGENTS.md) — leak this one.
    const [sender, recipient] = await Promise.all([
      prisma.entity.findUniqueOrThrow({ where: { externalId: "ent_acme_us" } }),
      prisma.entity.findUniqueOrThrow({ where: { externalId: "ent_tokyo_supplier" } }),
    ]);
    const id = "pay_mcp_scrub_audit";
    await prisma.payment.upsert({
      where: { id },
      update: {},
      create: {
        id,
        senderId: sender.id,
        recipientId: recipient.id,
        amount: "1000.00",
        sourceCurrency: "USD",
        destinationCurrency: "USD",
        sourceAsset: "mockUSDC",
        destinationAsset: "mockUSDC",
        sourceNetwork: "base-local",
        destinationNetwork: "base-local",
      },
    });
    const secret = "Insufficient mockJPY on polygon-local: need 5, available 1 (rpc https://secret.example)";
    await audit("payment.status.failed", { reason: secret }, id, "system");

    const asEntity = await getPayment(acmePrincipal, { payment_id: id });
    const entityDetail = asEntity.payment.auditEvents.map((e) => e.detail).join(" ");
    expect(entityDetail).not.toContain(secret);
    expect(entityDetail).not.toContain("mockJPY");
    expect(entityDetail).toContain("redacted");

    const asOperator = await getPayment(operatorPrincipal, { payment_id: id });
    const operatorDetail = asOperator.payment.auditEvents.map((e) => e.detail).join(" ");
    expect(operatorDetail).toContain(secret);
  });
});

describe("platform-only tools", () => {
  it("forbids an ENTITY from list_treasury_positions and get_balances", async () => {
    await expect(listTreasuryPositions(acmePrincipal, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(getBalances(acmePrincipal)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("does not put a tenant-wide where on list_entities for an ENTITY", async () => {
    const findMany = vi.spyOn(prisma.entity, "findMany");
    const page = await listEntities(acmePrincipal, { limit: 10 });
    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ id: acmePrincipal.entityId });
    expect(page.entities.map((e) => e.externalId)).toEqual(["ent_acme_us"]);
  });
});

describe("list_entities cursor scoping", () => {
  // The tenant scope for entities is `{ id: entityId }` — the only scope whose
  // key collides with the cursor's own `id`. Spreading it after the cursor id
  // overwrites it, so the check silently validates the caller's own row: a
  // nonexistent cursor then fails inside Prisma as an internal error while a
  // real foreign id passes, which distinguishes whether that id exists.
  it("rejects a foreign entity id and a nonexistent one identically", async () => {
    const foreign = await prisma.entity.findFirst({
      where: { externalId: "ent_tokyo_supplier" },
      select: { id: true },
    });
    expect(foreign).not.toBeNull();
    await expect(listEntities(acmePrincipal, { cursor: foreign!.id })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(listEntities(acmePrincipal, { cursor: "ent_does_not_exist" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("keeps the cursor id in the where — a spread must not overwrite it", async () => {
    const findFirst = vi.spyOn(prisma.entity, "findFirst");
    await listEntities(acmePrincipal, { cursor: "ent_does_not_exist" }).catch(() => undefined);
    expect(findFirst.mock.calls[0]?.[0]?.where).toEqual({
      AND: [{ id: "ent_does_not_exist" }, { id: acmePrincipal.entityId }],
    });
  });

  it("still accepts the caller's own id as a cursor", async () => {
    await expect(listEntities(acmePrincipal, { cursor: acmePrincipal.entityId })).resolves.toEqual(
      expect.objectContaining({ entities: expect.any(Array) })
    );
  });
});

describe("verify_audit_chain", () => {
  it("returns INTACT with mode, anchored, and events_verified — not a flattened verdict", async () => {
    const result = await verifyAuditChainTool(operatorPrincipal);
    expect(result.verdict).toBe("INTACT");
    expect(result.valid).toBe(true);
    expect(result.mode).toBe("full");
    expect(typeof result.anchored).toBe("boolean");
    expect(result.events_verified).toBeGreaterThan(0);
    // The suite pins AUDIT_ANCHOR_KEY, so this INTACT is the stronger claim.
    expect(result.anchored).toBe(true);
  });

  // events_verified counts every tenant's rows, and the re-hash is O(events) on
  // a route with no read-side limit. REST GET /api/audit is platform-only for
  // the first reason; this is gated for both.
  it("forbids an ENTITY — parity with REST GET /api/audit", async () => {
    await expect(verifyAuditChainTool(acmePrincipal)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("MCP protocol surface", () => {
  it("publishes exactly the read-only tools — no execute, park, or repair", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSettlementMcpServer(operatorPrincipal);
    await server.connect(serverTransport);
    const client = new Client({ name: "mcp-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...MCP_TOOL_NAMES].sort());
      expect(names.join(" ")).not.toMatch(/execute|cancel|quote|park|recall|accrue|repair|reconcile|review/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a safe tool error when the implementation throws internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.payment, "findMany").mockRejectedValue(
      new Error("revert 0xdeadbeef at https://rpc.example/path")
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSettlementMcpServer(acmePrincipal);
    await server.connect(serverTransport);
    const client = new Client({ name: "mcp-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "list_payments", arguments: { limit: 10 } });
      const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")
        ?.text;
      expect(result.isError).toBe(true);
      expect(text).toBeDefined();
      expect(JSON.parse(text!)).toEqual({ error_code: "internal", message: "internal error" });
      expect(text).not.toMatch(/0xdeadbeef|rpc\.example/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
