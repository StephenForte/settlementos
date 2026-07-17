// The HTTP half of idempotent writes. lib/idempotency.ts owns the record and the
// race; this turns its outcomes into responses, the same way app/api/guard.ts
// does for lib/auth.ts.
//
// A handler wraps its body in three lines:
//
//   const idem = await beginIdempotency(req, principal, route, body);
//   if (idem instanceof NextResponse) return idem;   // replay, 422, or 409
//   try { return await idem.complete(await handle(...)); }
//   catch (e) { await idem.abandon(); throw e; }
//
// A caller that sends no Idempotency-Key gets a no-op scope, so the wrapper is
// uniform and the browser demo (which sends none) is unaffected.

import { NextResponse } from "next/server";
import type { Principal } from "@/lib/auth";
import {
  abandonIdempotent,
  beginIdempotent,
  completeIdempotent,
  hashRequest,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from "@/lib/idempotency";
import { errorResponse, invalidRequest } from "./guard";

export interface IdempotentScope {
  /** Store the handler's response for replay, and return it unchanged. */
  complete(res: NextResponse): Promise<NextResponse>;
  /** Release the key — the handler threw, so no outcome is worth replaying. */
  abandon(): Promise<void>;
}

/** What an un-keyed request gets: the response passes straight through. */
const PASSTHROUGH: IdempotentScope = {
  async complete(res) {
    return res;
  },
  async abandon() {},
};

/**
 * Claim the request's Idempotency-Key, or hand back the response to return.
 * `route` must identify the *target*, not the template — `POST /api/payments/
 * pay_x/execute`, so one key aimed at two payments is caught as a mismatch.
 */
export async function beginIdempotency(
  req: Request,
  principal: Principal,
  route: string,
  body: unknown
): Promise<IdempotentScope | NextResponse> {
  const key = req.headers.get(IDEMPOTENCY_HEADER);
  if (!key) return PASSTHROUGH;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return invalidRequest(`Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }

  const outcome = await beginIdempotent(principal.keyId, key, route, hashRequest(body));
  switch (outcome.kind) {
    case "replay":
      // Byte-identical to the original, so a retry cannot be told from the first
      // call except by the replay header.
      return new NextResponse(outcome.body, {
        status: outcome.status,
        headers: { "content-type": "application/json", "idempotent-replay": "true" },
      });
    case "mismatch":
      return errorResponse("idempotency_conflict");
    case "in_flight":
      return errorResponse("conflict", "a request with this Idempotency-Key is still in flight");
    case "fresh":
      return {
        async complete(res) {
          // clone(): the body stream can only be read once, and the caller still
          // needs it.
          await completeIdempotent(outcome.recordId, res.status, await res.clone().text());
          return res;
        },
        async abandon() {
          await abandonIdempotent(outcome.recordId);
        },
      };
  }
}
