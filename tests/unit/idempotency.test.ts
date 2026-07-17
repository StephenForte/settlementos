// Pure fingerprinting for Idempotency-Key body matching. Integration covers the
// HTTP reserve/replay path; this locks the canonical() edge cases that make two
// semantically identical bodies hash alike (and different ones not).

import { describe, it, expect } from "vitest";
import { hashRequest } from "@/lib/idempotency";

describe("hashRequest", () => {
  it("treats object key order as irrelevant at every nesting level", () => {
    const a = { outer: { b: 2, a: 1 }, z: true };
    const b = { z: true, outer: { a: 1, b: 2 } };
    expect(hashRequest(a)).toBe(hashRequest(b));
  });

  it("preserves array order — reordering is a different request", () => {
    expect(hashRequest({ items: [1, 2] })).not.toBe(hashRequest({ items: [2, 1] }));
  });

  it("strips undefined values so omitting a key and setting it undefined match", () => {
    expect(hashRequest({ a: 1, b: undefined })).toBe(hashRequest({ a: 1 }));
    expect(hashRequest({ a: 1, b: null })).not.toBe(hashRequest({ a: 1 }));
  });

  it("is stable for primitives, null, and empty containers", () => {
    expect(hashRequest(null)).toBe(hashRequest(null));
    expect(hashRequest("x")).toBe(hashRequest("x"));
    expect(hashRequest(0)).toBe(hashRequest(0));
    expect(hashRequest({})).toBe(hashRequest({}));
    expect(hashRequest([])).toBe(hashRequest([]));
    expect(hashRequest(null)).not.toBe(hashRequest({}));
  });
});
