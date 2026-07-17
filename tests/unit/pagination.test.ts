// Page-request parsing and page assembly (US-018). Pure — no DB, no routes.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PaginationError,
  parsePageRequest,
  toPage,
} from "@/lib/pagination";

const parse = (qs: string) => parsePageRequest(new URLSearchParams(qs));

describe("parsePageRequest", () => {
  it("defaults to 50 rows from the start", () => {
    expect(parse("")).toEqual({ limit: DEFAULT_PAGE_LIMIT, cursor: null });
  });

  it("takes a limit and a cursor", () => {
    expect(parse("limit=10&cursor=pay_abc")).toEqual({ limit: 10, cursor: "pay_abc" });
  });

  it("accepts the boundaries", () => {
    expect(parse("limit=1").limit).toBe(1);
    expect(parse(`limit=${MAX_PAGE_LIMIT}`).limit).toBe(MAX_PAGE_LIMIT);
  });

  it("treats an empty limit or cursor as absent", () => {
    expect(parse("limit=&cursor=")).toEqual({ limit: DEFAULT_PAGE_LIMIT, cursor: null });
  });

  it("rejects a limit past the cap rather than clamping to it", () => {
    // Clamping would answer a different question than the one asked, quietly.
    expect(() => parse(`limit=${MAX_PAGE_LIMIT + 1}`)).toThrow(PaginationError);
    expect(() => parse("limit=100000")).toThrow(PaginationError);
  });

  it("rejects zero and non-canonical integers — never coerces", () => {
    // Every one of these is a number to `Number()`, which is exactly why the
    // grammar is a regex (same rule as lib/money's parseAmount).
    for (const bad of ["0", "-5", "1e3", "1.5", " 10", "10 ", "0x10", "Infinity", "abc", "+5"]) {
      expect(() => parse(`limit=${encodeURIComponent(bad)}`), bad).toThrow(PaginationError);
    }
  });

  it("rejects an absurdly long cursor", () => {
    expect(() => parse(`cursor=${"a".repeat(201)}`)).toThrow(PaginationError);
  });
});

describe("toPage", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
  const id = (r: { id: string }) => r.id;

  it("reports no more when the extra row did not arrive", () => {
    expect(toPage(rows(3), 5, id)).toEqual({ rows: rows(3), nextCursor: null, hasMore: false });
  });

  it("a full page with no extra row is the last page", () => {
    // The subtle one: exactly `limit` rows means the table ran out, not that a
    // page boundary was hit.
    expect(toPage(rows(5), 5, id)).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("drops the probe row and points the cursor at the last kept row", () => {
    const page = toPage(rows(6), 5, id);
    expect(page.hasMore).toBe(true);
    expect(page.rows).toHaveLength(5);
    expect(page.rows.at(-1)).toEqual({ id: "r4" });
    expect(page.nextCursor).toBe("r4");
  });

  it("an empty result is a terminal page", () => {
    expect(toPage([], 5, id)).toEqual({ rows: [], nextCursor: null, hasMore: false });
  });
});
