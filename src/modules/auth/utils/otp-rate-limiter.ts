/**
 * Redis-backed sliding-window rate limiter for SMS-OTP per-phone and per-IP
 * caps. Stored as a sorted-set per (subject, window) pair; entries are
 * timestamped on insert and trimmed by score on every check.
 *
 * Why sliding window over fixed window: fixed window allows boundary-burst
 * (e.g. 10 sends in second 59 of the previous hour + 10 in second 1 of the
 * next = 20 in 2 seconds). Sorted-set sliding window is ~3 Redis ops per
 * check — trivial overhead at our volume.
 *
 * Used by SmsOtpService BEFORE OTP minting. Idempotency-window dedup +
 * verify-attempt lockout live elsewhere (idempotency in the service inline,
 * lockout on the User document mirroring `pinAttempts`).
 */

import type Redis from 'ioredis';

export interface SlidingWindowOptions {
  /** Window length in seconds (e.g. 3600 for hourly, 86400 for daily). */
  windowSec: number;
  /** Max events allowed within the window. */
  limit: number;
}

export interface SlidingWindowResult {
  allowed: boolean;
  count: number;
  /** Seconds until the oldest event in the window expires (lower = sooner room). */
  retryAfterSec: number;
}

/**
 * Records a new event for `key` and returns whether the window is still under
 * `limit`. The event is recorded ONLY when allowed — denied calls don't
 * pollute the window further.
 */
export async function checkSlidingWindow(
  redis: Redis,
  key: string,
  opts: SlidingWindowOptions,
): Promise<SlidingWindowResult> {
  const now = Date.now();
  const windowMs = opts.windowSec * 1000;
  const cutoff = now - windowMs;

  // Trim expired entries first so ZCARD is honest.
  await redis.zremrangebyscore(key, '-inf', cutoff);
  const count = await redis.zcard(key);

  if (count >= opts.limit) {
    // Find oldest score → retry-after is when it ages out of the window.
    const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
    const oldestScore = oldest.length >= 2 ? Number(oldest[1]) : now;
    const retryAfterSec = Math.max(1, Math.ceil((oldestScore + windowMs - now) / 1000));
    return { allowed: false, count, retryAfterSec };
  }

  // Member must be unique within the window so ZCARD reflects distinct
  // events. Combine timestamp + random suffix.
  const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
  await redis.zadd(key, now, member);
  await redis.expire(key, opts.windowSec);
  return { allowed: true, count: count + 1, retryAfterSec: 0 };
}

/**
 * Read-only peek — does not record a new event. Useful for "are we still
 * locked?" status checks that the caller doesn't want to count.
 */
export async function peekSlidingWindow(
  redis: Redis,
  key: string,
  opts: SlidingWindowOptions,
): Promise<{ count: number; remaining: number }> {
  const now = Date.now();
  const cutoff = now - opts.windowSec * 1000;
  await redis.zremrangebyscore(key, '-inf', cutoff);
  const count = await redis.zcard(key);
  return { count, remaining: Math.max(0, opts.limit - count) };
}

/**
 * Simple SET EX cooldown (used for the 30s per-phone resend cooldown). Returns
 * `{ allowed: true }` when the cooldown was free and now claimed; `{ allowed:
 * false, retryAfterSec }` when blocked.
 */
export async function checkAndSetCooldown(
  redis: Redis,
  key: string,
  cooldownSec: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  // SET … NX EX — atomic claim.
  const claimed = await redis.set(key, '1', 'EX', cooldownSec, 'NX');
  if (claimed === 'OK') {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttl = await redis.ttl(key);
  return { allowed: false, retryAfterSec: ttl > 0 ? ttl : cooldownSec };
}

/**
 * Increment the provider-failure counter that drives the global circuit
 * breaker. Returns the new count and whether the threshold tripped.
 */
export async function recordProviderFailure(
  redis: Redis,
  key: string,
  windowSec: number,
  threshold: number,
): Promise<{ count: number; tripped: boolean }> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec);
  }
  return { count, tripped: count >= threshold };
}

/**
 * Read provider-failure count without incrementing. Drives short-circuit on
 * send-OTP entry: if breaker is tripped we skip the work and return
 * SERVICE_DEGRADED immediately.
 */
export async function isCircuitTripped(
  redis: Redis,
  key: string,
  threshold: number,
): Promise<boolean> {
  const raw = await redis.get(key);
  if (!raw) return false;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= threshold;
}
