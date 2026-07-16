// The sliding window itself (US-018). `now` is a parameter, so the window is
// driven directly rather than with fake timers.

import { describe, it, expect, beforeEach } from "vitest";
import { consumeRateLimit, resetRateLimits } from "@/lib/rate-limit";

const OPTS = { limit: 3, windowMs: 60_000 };
const at = (now: number) => ({ ...OPTS, now });

describe("consumeRateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit and refuses beyond it", () => {
    for (let i = 0; i < 3; i++) {
      expect(consumeRateLimit("k", at(1000)).allowed).toBe(true);
    }
    expect(consumeRateLimit("k", at(1000))).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("counts down the remaining budget", () => {
    expect(consumeRateLimit("k", at(1000)).remaining).toBe(2);
    expect(consumeRateLimit("k", at(1000)).remaining).toBe(1);
    expect(consumeRateLimit("k", at(1000)).remaining).toBe(0);
  });

  it("keys are independent — one caller cannot exhaust another's budget", () => {
    for (let i = 0; i < 3; i++) consumeRateLimit("a", at(1000));
    expect(consumeRateLimit("a", at(1000)).allowed).toBe(false);
    expect(consumeRateLimit("b", at(1000)).allowed).toBe(true);
  });

  it("frees a slot once the oldest hit ages out of the window", () => {
    consumeRateLimit("k", at(1000));
    consumeRateLimit("k", at(2000));
    consumeRateLimit("k", at(3000));
    expect(consumeRateLimit("k", at(4000)).allowed).toBe(false);

    // The 1000ms hit is still inside a 60s window at t=60_000...
    expect(consumeRateLimit("k", at(60_000)).allowed).toBe(false);
    // ...and has aged out of it by t=61_000, freeing exactly one slot.
    expect(consumeRateLimit("k", at(61_000)).allowed).toBe(true);
    expect(consumeRateLimit("k", at(61_000)).allowed).toBe(false);
  });

  it("reports a Retry-After that actually frees a slot, never 0", () => {
    for (let i = 0; i < 3; i++) consumeRateLimit("k", at(1000));
    const refused = consumeRateLimit("k", at(30_000));
    expect(refused.allowed).toBe(false);
    // The oldest hit (t=1000) leaves the window at t=61_000, i.e. 31s away.
    expect(refused.retryAfterSeconds).toBe(31);

    // Ceil, not floor: a Retry-After the window has not honoured yet would
    // invite a retry that refuses again.
    const boundary = consumeRateLimit("k", at(60_999));
    expect(boundary.retryAfterSeconds).toBe(1);
  });

  it("does not record a refused hit — a hammering caller still recovers", () => {
    for (let i = 0; i < 3; i++) consumeRateLimit("k", at(1000));
    // Keep hitting it right up to the moment the window rolls (the t=1000 hit
    // leaves the window at t=61_000, so 60_000 is the last refusal).
    for (let t = 2000; t <= 60_000; t += 1000) {
      expect(consumeRateLimit("k", at(t)).allowed).toBe(false);
    }
    // If refusals had been recorded, the window would be full of them here.
    expect(consumeRateLimit("k", at(61_000)).allowed).toBe(true);
  });

  it("resetRateLimits forgets every window", () => {
    for (let i = 0; i < 3; i++) consumeRateLimit("k", at(1000));
    expect(consumeRateLimit("k", at(1000)).allowed).toBe(false);
    resetRateLimits();
    expect(consumeRateLimit("k", at(1000)).allowed).toBe(true);
  });
});
