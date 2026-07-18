// The HTTP half of lib/pagination.ts — turn a PaginationError into the 400
// every list route already returns, so handlers do not each re-copy the try/
// catch. Framework-free parsePageRequest stays in lib/; this is the NextResponse
// wrapper, the same split as guard.ts over lib/auth.ts.

import { NextResponse } from "next/server";
import { PaginationError, parsePageRequest, type PageRequest } from "@/lib/pagination";
import { invalidRequest } from "./guard";

/** Parse `limit`/`cursor`, or hand back the 400 to return. */
export function parsePageOr400(searchParams: URLSearchParams): PageRequest | NextResponse {
  try {
    return parsePageRequest(searchParams);
  } catch (e) {
    if (e instanceof PaginationError) return invalidRequest(e.message);
    throw e;
  }
}
