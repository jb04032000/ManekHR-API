import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_METADATA_KEY = 'idempotent';

export interface IdempotentOptions {
  /** How long the cached response stays warm. Default: 24 hours. */
  ttlSeconds?: number;
}

/**
 * Mark a route handler as honoring the `Idempotency-Key` request header.
 *
 * Defensive retry safety. Catches the failure mode where the client thinks
 * the request failed (network timeout, app backgrounded mid-request) but the
 * server actually completed the write — without this, an automatic retry
 * produces a duplicate row. With this, the second call returns the cached
 * response and the DB sees only one write.
 *
 * Header is OPTIONAL. Absent → handler runs normally (legacy behavior).
 * Present → `(userId, key)` looked up in Redis: cache hit returns cached
 * body unchanged; cache miss runs the handler and caches on success.
 *
 * Cache lives in Redis; see `IdempotencyInterceptor`.
 */
export const Idempotent = (opts: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_METADATA_KEY, {
    ttlSeconds: opts.ttlSeconds ?? 24 * 60 * 60,
  });
