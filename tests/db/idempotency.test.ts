// Reserve-then-abandon: a thrown handler must free the Idempotency-Key so a
// retry can run. The HTTP wrapper calls abandon() on every catch; this locks
// the lib half that actually deletes the row.

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  abandonIdempotent,
  beginIdempotent,
  completeIdempotent,
  hashRequest,
} from "@/lib/idempotency";

const freshKey = () => `idem_lib_${randomBytes(8).toString("hex")}`;

describe("beginIdempotent / abandonIdempotent", () => {
  it("frees a reservation so the same key can be claimed again", async () => {
    const operator = await prisma.apiKey.findFirstOrThrow({ where: { role: "OPERATOR" } });
    const key = freshKey();
    const route = "POST /api/payments";
    const hash = hashRequest({ amount: "1.00" });

    const first = await beginIdempotent(operator.id, key, route, hash);
    expect(first).toMatchObject({ kind: "fresh" });
    if (first.kind !== "fresh") throw new Error("expected fresh");

    // What a thrown handler does: drop the unstamped row rather than leave it
    // answering 409 in-flight until the TTL.
    await abandonIdempotent(first.recordId);
    expect(await prisma.idempotencyRecord.findUnique({ where: { id: first.recordId } })).toBeNull();

    const retry = await beginIdempotent(operator.id, key, route, hash);
    expect(retry.kind).toBe("fresh");
  });

  it("replays a stamped response and does not abandon it", async () => {
    const operator = await prisma.apiKey.findFirstOrThrow({ where: { role: "OPERATOR" } });
    const key = freshKey();
    const route = "POST /api/payments";
    const hash = hashRequest({ amount: "2.00" });

    const first = await beginIdempotent(operator.id, key, route, hash);
    if (first.kind !== "fresh") throw new Error("expected fresh");
    await completeIdempotent(first.recordId, 201, JSON.stringify({ payment_id: "pay_x" }));

    const replay = await beginIdempotent(operator.id, key, route, hash);
    expect(replay).toEqual({
      kind: "replay",
      status: 201,
      body: JSON.stringify({ payment_id: "pay_x" }),
    });
  });
});
