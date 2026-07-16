// A small in-memory sliding-window rate limiter.
//
// Deliberately per-process: this is a single-instance demo, and the honest
// bound is "one node's worth of requests". Behind more than one instance it
// becomes a per-instance limit — the fix is a shared store (Redis), not a
// cleverer Map, and the seam for that is `consumeRateLimit`'s signature.
//
// Framework-free (same reason as lib/auth.ts): the HTTP glue — who the key is,
// what the limit is, how a refusal renders — lives in app/api/limits.ts, so
// this stays callable from plain vitest.
//
// `now` is a parameter rather than a `Date.now()` call so the window can be
// tested without fake timers.

export interface RateLimitOptions {
  /** Requests permitted within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Current time (ms since epoch). */
  now: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still permitted in the current window (0 when refused). */
  remaining: number;
  /**
   * Seconds until the caller may retry — always >= 1 when refused, since a
   * `Retry-After: 0` invites an immediate retry that would refuse again.
   */
  retryAfterSeconds: number;
}

/** Hit timestamps per key, oldest first. Pruned on read; see sweep() below. */
const hits = new Map<string, number[]>();

/**
 * Record a hit against `key` and say whether it is allowed. A refused request
 * is NOT recorded: a caller hammering a limit would otherwise push its own
 * window forward forever and never recover.
 */
export function consumeRateLimit(key: string, { limit, windowMs, now }: RateLimitOptions): RateLimitDecision {
  const cutoff = now - windowMs;
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

  if (recent.length >= limit) {
    hits.set(key, recent);
    // The window frees a slot when its oldest hit ages out.
    const retryAfterMs = recent[0] + windowMs - now;
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  recent.push(now);
  hits.set(key, recent);
  sweep(now, windowMs);
  return { allowed: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
}

/**
 * Drop keys with no hits left in the window. Without this the map grows once
 * per distinct principal/IP and never shrinks — a slow leak that an unauthed,
 * IP-keyed endpoint turns into a fast one. Amortised: only every SWEEP_EVERY
 * admitted request, since it walks the whole map.
 */
const SWEEP_EVERY = 500;
let sinceSweep = 0;

function sweep(now: number, windowMs: number): void {
  if (++sinceSweep < SWEEP_EVERY) return;
  sinceSweep = 0;
  const cutoff = now - windowMs;
  for (const [key, times] of hits) {
    if (times.length === 0 || times[times.length - 1] <= cutoff) hits.delete(key);
  }
}

/** Test-only: forget every window. */
export function resetRateLimits(): void {
  hits.clear();
  sinceSweep = 0;
}
