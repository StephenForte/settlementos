// Cursor pagination for the collection reads.
//
// An unbounded `findMany` is a denial-of-service the caller does not even have
// to mean: the audit log and the payments table grow without limit, and one GET
// would load every row into memory and serialise it. Every list read is bounded
// here instead, and a caller that wants the rest asks for the next page.
//
// Cursors are opaque to the client but are just the last row's id — the routes
// order by a tiebroken key ending in `id`, so a cursor names exactly one row and
// a walk visits every row exactly once even when timestamps collide.
//
// Framework-free: routes map PaginationError to a 400 (see lib/money.ts, whose
// reject-never-repair rule this follows — `Number("1e3")` is 1000, so `limit`
// is matched against a canonical grammar, not coerced).

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export class PaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaginationError";
  }
}

export interface PageRequest {
  /** Rows to return: 1..MAX_PAGE_LIMIT, defaulting to DEFAULT_PAGE_LIMIT. */
  limit: number;
  /** The id of the last row of the previous page, or null for the first page. */
  cursor: string | null;
}

const CANONICAL_INT = /^[0-9]+$/;

/** Read `limit` and `cursor` off a query string, or throw PaginationError. */
export function parsePageRequest(params: URLSearchParams): PageRequest {
  const rawLimit = params.get("limit");
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== null && rawLimit !== "") {
    if (!CANONICAL_INT.test(rawLimit)) throw new PaginationError("limit must be a positive integer");
    limit = Number(rawLimit);
    if (limit < 1) throw new PaginationError("limit must be at least 1");
    if (limit > MAX_PAGE_LIMIT) throw new PaginationError(`limit must be at most ${MAX_PAGE_LIMIT}`);
  }

  const rawCursor = params.get("cursor");
  const cursor = rawCursor === null || rawCursor === "" ? null : rawCursor;
  if (cursor !== null && cursor.length > 200) throw new PaginationError("cursor is not valid");

  return { limit, cursor };
}

export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Turn `limit + 1` fetched rows into a page. Fetching one extra row is what
 * makes `has_more` exact without a second count query — the extra row is the
 * evidence, and it is dropped rather than returned.
 */
export function toPage<T>(rows: T[], limit: number, idOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page,
    hasMore,
    nextCursor: hasMore && page.length > 0 ? idOf(page[page.length - 1]) : null,
  };
}
