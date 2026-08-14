// MCP JSON / pagination / safe-error helpers. No DB, no chain.

import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError } from "@/lib/api-errors";
import { PaginationError } from "@/lib/pagination";
import { ChainUnavailableError, runTool } from "@/lib/mcp/errors";
import { pageFromArgs } from "@/lib/mcp/page";
import { toolError, textJson } from "@/lib/mcp/json";

afterEach(() => vi.restoreAllMocks());

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

describe("pageFromArgs", () => {
  it("defaults to 50 with no cursor", () => {
    expect(pageFromArgs({})).toEqual({ limit: 50, cursor: null });
  });

  it("rejects a limit past the cap rather than clamping", () => {
    expect(() => pageFromArgs({ limit: 201 })).toThrow(PaginationError);
    expect(() => pageFromArgs({ limit: 201 })).toThrow(/at most 200/);
  });

  it("rejects a non-canonical limit the same way parsePageRequest does", () => {
    // JSON numbers are already canonical; the gate still refuses 0.
    expect(() => pageFromArgs({ limit: 0 })).toThrow(/at least 1/);
  });
});

describe("runTool", () => {
  it("returns structured JSON on success", async () => {
    const result = await runTool("t", async () => ({ ok: true }));
    expect(JSON.parse(toolText(result))).toEqual({ ok: true });
    expect("isError" in result).toBe(false);
  });

  it("passes a PaginationError through as invalid_request", async () => {
    const result = await runTool("t", async () => {
      throw new PaginationError("limit must be at most 200");
    });
    expect("isError" in result && result.isError).toBe(true);
    expect(JSON.parse(toolText(result))).toEqual({
      error_code: "invalid_request",
      message: "limit must be at most 200",
    });
  });

  it("passes a chosen ApiError through", async () => {
    const result = await runTool("t", async () => {
      throw new ApiError("not_found");
    });
    expect(JSON.parse(toolText(result))).toEqual({ error_code: "not_found", message: "not found" });
  });

  it("swallows a thrown error's message — no address, URL, or revert data", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error(
      "revert 0x9d8b8b7c476ab02306046f3da719d380fa0456aa at https://sepolia.base.org: execution reverted"
    );

    const result = await runTool("list_payments", async () => {
      throw boom;
    });

    const text = toolText(result);
    expect("isError" in result && result.isError).toBe(true);
    expect(JSON.parse(text)).toEqual({ error_code: "internal", message: "internal error" });
    expect(text).not.toMatch(/0x9d8b8b7c|sepolia\.base\.org|reverted/i);
    expect(spy).toHaveBeenCalledWith("[api]", "mcp.list_payments", boom);
  });
});

describe("toolError / textJson", () => {
  it("stringifies bigint fields rather than throwing", () => {
    const result = textJson({ shares: 10n });
    expect(JSON.parse(toolText(result))).toEqual({ shares: "10" });
  });

  it("shapes a client-safe error body", () => {
    expect(JSON.parse(toolText(toolError("forbidden", "forbidden")))).toEqual({
      error_code: "forbidden",
      message: "forbidden",
    });
  });
});

describe("chain_unavailable", () => {
  // REST GET /api/balances answers `chain_unavailable` (503) with setup
  // instructions. `toolError` already admits that code; mapping it to
  // `internal` would show an operator a generic failure instead of the
  // dedicated "you have not run setup" signal.
  it("maps ChainUnavailableError to its own code, not internal", async () => {
    const result = await runTool("get_balances", async () => {
      throw new ChainUnavailableError("Chains not set up. Run: npm run setup");
    });
    expect(JSON.parse(toolText(result))).toEqual({
      error_code: "chain_unavailable",
      message: "Chains not set up. Run: npm run setup",
    });
  });
});
