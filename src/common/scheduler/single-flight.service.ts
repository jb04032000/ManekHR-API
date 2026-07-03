import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Default lock TTL. Long enough that any healthy scheduled job finishes well
 * inside it, short enough that a crashed worker's lock auto-expires and the next
 * occurrence is not blocked forever. Jobs that legitimately run longer pass an
 * explicit `ttlMs`.
 */
const DEFAULT_TTL_MS = 15 * 60_000;

/**
 * Release only if we still own the lock (compare-and-delete). Prevents a slow
 * run whose TTL already expired from deleting a lock a *different* worker has
 * since acquired for the same occurrence.
 */
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Redis single-flight lock for scheduled jobs (scheduler-contract ADR, Layer 1).
 *
 * `runExclusive` guarantees that a given scheduled occurrence runs on at most one
 * worker, for ANY number of worker instances - so single-fire does not depend on
 * "run only one worker", which breaks silently on misconfiguration. The role gate
 * (web stops all crons at boot) is the first line; this lock is the structural
 * guarantee behind it.
 *
 * This is mutual exclusion for the *execution window*, not a durable
 * once-per-period marker: a job that fails or crashes releases the lock (or it
 * TTL-expires) so it can be retried. Protection against a retry double-applying a
 * side effect is the job's own DB-level idempotency (Layer 2), not this lock.
 */
@Injectable()
export class SingleFlightService {
  private readonly logger = new Logger(SingleFlightService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Run `fn` iff this worker wins the claim on `{jobKey}:{periodKey}`.
   *
   * @param jobKey    Stable job identity (use the `CronJobKey` value).
   * @param periodKey The occurrence bucket (e.g. `2026-06-04` for a daily job,
   *                  `2026-06-04T08` for hourly). Two genuinely different
   *                  occurrences have different keys and never block each other.
   * @returns `{ ran: true, result }` when this worker executed `fn`, or
   *          `{ ran: false }` when another worker already holds the occurrence.
   */
  async runExclusive<T>(
    jobKey: string,
    periodKey: string,
    fn: () => Promise<T>,
    opts?: { ttlMs?: number },
  ): Promise<{ ran: boolean; result?: T }> {
    const lockKey = `cron-lock:${jobKey}:${periodKey}`;
    const token = randomUUID();
    const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

    const acquired = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') {
      // Losing the claim is the EXPECTED path on every worker that did not win
      // the occurrence (N-1 of N workers each minute). Logging it at LOG level
      // floods the logs once per worker per tick — pure noise that reads like a
      // problem. Keep it at DEBUG so it is available when diagnosing the lock
      // but silent by default. (The real "is the job running?" signal lives on
      // the winning worker, which runs `fn` below.)
      this.logger.debug(
        `[${jobKey}] occurrence ${periodKey} already claimed; skipping on this worker.`,
      );
      return { ran: false };
    }

    try {
      // Positive signal: exactly ONE worker reaches here per occurrence. Emitted
      // at DEBUG so it pairs with the skip log above when diagnosing whether the
      // job actually ran (previously there was no "this worker ran it" marker).
      this.logger.debug(`[${jobKey}] occurrence ${periodKey} claimed; running on this worker.`);
      const result = await fn();
      return { ran: true, result };
    } finally {
      await this.redis.eval(RELEASE_LUA, 1, lockKey, token).catch((err) => {
        this.logger.warn(
          `[${jobKey}] lock release failed (will TTL-expire): ${(err as Error).message}`,
        );
      });
    }
  }

  /**
   * Mutual-exclusion variant of {@link runExclusive} that BLOCKS (briefly polls)
   * for the lock instead of skipping when it is already held — so EVERY caller
   * eventually runs `fn`, but never two at once for the same `lockName`.
   *
   * Use this (not `runExclusive`) to serialize a short read-then-write critical
   * section where every caller's work must still happen, just one-at-a-time —
   * e.g. a check-then-act invariant guard (read a count, then mutate based on it)
   * that would otherwise be a TOCTOU race under concurrency. `runExclusive` is
   * for periodic jobs where the loser SHOULD skip; `withLock` is for serializing
   * concurrent requests where the loser must wait its turn.
   *
   * Bounded wait: polls every `pollMs` up to `waitMs` total. If the lock can't be
   * acquired in that window we throw (the caller surfaces a clean error) rather
   * than block forever — the critical section is intended to be sub-second, so a
   * multi-second wait means the holder is wedged.
   *
   * Same safety as `runExclusive`: a unique token + compare-and-delete release,
   * a short TTL so a crashed holder's lock auto-expires, and release-in-`finally`.
   *
   * @param lockName Stable identity for the resource being serialized.
   * @param fn       The critical section to run while holding the lock.
   * @param opts     `ttlMs` lock lifetime, `waitMs` max time to wait to acquire,
   *                 `pollMs` retry interval.
   */
  async withLock<T>(
    lockName: string,
    fn: () => Promise<T>,
    opts?: { ttlMs?: number; waitMs?: number; pollMs?: number },
  ): Promise<T> {
    const lockKey = `mutex-lock:${lockName}`;
    const token = randomUUID();
    const ttlMs = opts?.ttlMs ?? 5_000;
    const waitMs = opts?.waitMs ?? 5_000;
    const pollMs = opts?.pollMs ?? 25;

    const deadline = Date.now() + waitMs;
    let acquired = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
    while (acquired !== 'OK') {
      if (Date.now() >= deadline) {
        throw new Error(
          `[${lockName}] could not acquire mutex within ${waitMs}ms (holder may be wedged).`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
      acquired = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
    }

    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE_LUA, 1, lockKey, token).catch((err) => {
        this.logger.warn(
          `[${lockName}] mutex release failed (will TTL-expire): ${(err as Error).message}`,
        );
      });
    }
  }
}
