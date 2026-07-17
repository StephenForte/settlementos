// The audit-anchor routes (US-017), handlers invoked directly (no HTTP server).

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET as auditGET } from "@/app/api/audit/route";
import { POST as checkpointPOST } from "@/app/api/audit/checkpoint/route";
import { API_KEY_HEADER } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { API_KEYS } from "../fixture";

function req(path: string, key?: string) {
  return new NextRequest(`http://test.local${path}`, {
    method: "POST",
    headers: key ? { [API_KEY_HEADER]: key } : {},
  });
}

describe("POST /api/audit/checkpoint", () => {
  it("anchors the chain for an OPERATOR", async () => {
    const tip = await audit("test.checkpoint_route", {});

    const res = await checkpointPOST(req("/api/audit/checkpoint", API_KEYS.operator));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ last_event_id: tip.id, chain_hash: tip.hash });
    expect(await prisma.auditCheckpoint.findUnique({ where: { id: body.id } })).toBeTruthy();
  });

  it("is closed to REVIEWER, ENTITY, and anonymous callers", async () => {
    const responses = await Promise.all([
      checkpointPOST(req("/api/audit/checkpoint", API_KEYS.reviewer)),
      checkpointPOST(req("/api/audit/checkpoint", API_KEYS.entities.ent_acme_us)),
      checkpointPOST(req("/api/audit/checkpoint")),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 401]);
  });
});

describe("GET /api/audit", () => {
  it("reports checkpoint coverage alongside the verdict", async () => {
    await audit("test.coverage", {});
    await checkpointPOST(req("/api/audit/checkpoint", API_KEYS.operator));
    await audit("test.after_coverage", {});

    const res = await auditGET(
      new NextRequest("http://test.local/api/audit", { headers: { [API_KEY_HEADER]: API_KEYS.operator } })
    );
    const { integrity } = await res.json();
    expect(integrity).toMatchObject({ valid: true, mode: "full", anchored: true });
    // Verification always re-hashes the whole chain (the count is shared-suite
    // dependent, so just assert it covered the log, not an exact number).
    expect(integrity.events_verified).toBeGreaterThan(0);
    expect(integrity.checkpoint.last_event_id).toBeGreaterThan(0);
  });
});
