// The HTTP half of idempotent writes. lib/idempotency.ts owns the record and the
// race; this turns its outcomes into responses, the same way app/api/guard.ts
// does for lib/auth.ts.
//
// Prefer `withIdempotentWrite` for body-bearing writes — it owns the rate-limit
// gate, the key claim, and the complete/abandon choreography so six handlers do
// not each re-copy a race-sensitive pattern. A caller that sends no
// Idempotency-Key gets a no-op scope, so the wrapper is uniform and the browser
// demo (which sends none) is unaffected.

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
import { beginWrite } from "./limits";

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

/**
 * Rate-limit + claim the Idempotency-Key + run `handle`, stamping whatever it
 * answers (including 4xx) so a retry replays rather than re-doing the work. A
 * throw abandons the key — an unknown outcome must stay retryable.
 *
 * `route` must identify the *target* (see beginIdempotency). `handle` receives
 * the parsed body (`null` when absent/unparseable); hash the same value the
 * scope fingerprints so a retry with a different body is a 422.
 */
export async function withIdempotentWrite(
  req: Request,
  principal: Principal,
  route: string,
  handle: (body: unknown) => Promise<NextResponse>
): Promise<NextResponse> {
  const gate = await beginWrite(req, principal);
  if (gate instanceof NextResponse) return gate;

  // Fingerprint the body the handler sees. Absent/unparseable becomes `{}` so
  // an empty park/accrue and a missing JSON object hash the same — matching the
  // previous per-route `(gate.body ?? {})` convention.
  const body = gate.body ?? {};
  const idem = await beginIdempotency(req, principal, route, body);
  if (idem instanceof NextResponse) return idem;
  try {
    return await idem.complete(await handle(gate.body));
  } catch (e) {
    await idem.abandon();
    throw e;
  }
}
