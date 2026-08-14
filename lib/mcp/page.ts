// MCP tools take limit/cursor as JSON fields; the house pagination gate
// reads URLSearchParams. This is the one conversion — still reject-never-repair.

import { parsePageRequest, type PageRequest } from "../pagination";

export function pageFromArgs(args: { limit?: number; cursor?: string } = {}): PageRequest {
  const params = new URLSearchParams();
  if (args.limit !== undefined) params.set("limit", String(args.limit));
  if (args.cursor !== undefined && args.cursor !== "") params.set("cursor", args.cursor);
  return parsePageRequest(params);
}
