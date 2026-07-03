import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SingleFlightService } from '../single-flight.service';

/** Minimal ioredis stub exposing only what the service touches. */
function makeRedis() {
  return {
    set: vi.fn(),
    eval: vi.fn().mockResolvedValue(1),
  };
}

describe('SingleFlightService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let svc: SingleFlightService;

  beforeEach(() => {
    redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc = new SingleFlightService(redis as any);
  });

  it('runs fn and releases the lock when the claim is acquired', async () => {
    redis.set.mockResolvedValue('OK');
    const fn = vi.fn().mockResolvedValue('done');

    const out = await svc.runExclusive('job.test', '2026-06-04', fn);

    expect(out).toEqual({ ran: true, result: 'done' });
    expect(fn).toHaveBeenCalledOnce();
    // NX + PX claim on the occurrence-scoped key.
    expect(redis.set).toHaveBeenCalledWith(
      'cron-lock:job.test:2026-06-04',
      expect.any(String),
      'PX',
      15 * 60_000,
      'NX',
    );
    // Safe compare-and-delete release.
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it('skips fn and does not release when the claim is already held', async () => {
    redis.set.mockResolvedValue(null); // NX failed — someone else owns it
    const fn = vi.fn();

    const out = await svc.runExclusive('job.test', '2026-06-04', fn);

    expect(out).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('honors a custom ttl', async () => {
    redis.set.mockResolvedValue('OK');
    await svc.runExclusive('job.long', 'p', vi.fn().mockResolvedValue(undefined), {
      ttlMs: 60_000,
    });
    expect(redis.set).toHaveBeenCalledWith(
      'cron-lock:job.long:p',
      expect.any(String),
      'PX',
      60_000,
      'NX',
    );
  });

  it('releases the lock even when fn throws', async () => {
    redis.set.mockResolvedValue('OK');
    const boom = new Error('boom');

    await expect(svc.runExclusive('job.test', 'p', () => Promise.reject(boom))).rejects.toThrow(
      'boom',
    );
    expect(redis.eval).toHaveBeenCalledOnce(); // finally released
  });

  it('swallows a release failure (lock will TTL-expire)', async () => {
    redis.set.mockResolvedValue('OK');
    redis.eval.mockRejectedValue(new Error('redis down'));

    // Should resolve, not reject, despite the release error.
    const out = await svc.runExclusive('job.test', 'p', vi.fn().mockResolvedValue('ok'));
    expect(out).toEqual({ ran: true, result: 'ok' });
  });

  describe('withLock (blocking mutex)', () => {
    it('acquires on first try, runs fn, and releases', async () => {
      redis.set.mockResolvedValue('OK');
      const fn = vi.fn().mockResolvedValue('value');

      const out = await svc.withLock('auth:admin-roster', fn);

      expect(out).toBe('value');
      expect(fn).toHaveBeenCalledOnce();
      expect(redis.set).toHaveBeenCalledWith(
        'mutex-lock:auth:admin-roster',
        expect.any(String),
        'PX',
        5_000,
        'NX',
      );
      expect(redis.eval).toHaveBeenCalledOnce(); // compare-and-delete release
    });

    it('waits (retries) while the lock is held, then runs once free', async () => {
      // Held for the first two attempts, free on the third.
      redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
      const fn = vi.fn().mockResolvedValue('done');

      const out = await svc.withLock('k', fn, { pollMs: 1, waitMs: 1_000 });

      expect(out).toBe('done');
      expect(fn).toHaveBeenCalledOnce();
      expect(redis.set).toHaveBeenCalledTimes(3); // retried until acquired
    });

    it('throws if it cannot acquire within the wait window (never runs fn)', async () => {
      redis.set.mockResolvedValue(null); // always held
      const fn = vi.fn();

      await expect(svc.withLock('k', fn, { pollMs: 1, waitMs: 10 })).rejects.toThrow(
        /could not acquire mutex/,
      );
      expect(fn).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled(); // never held → never released
    });

    it('releases the lock even when fn throws', async () => {
      redis.set.mockResolvedValue('OK');

      await expect(svc.withLock('k', () => Promise.reject(new Error('boom')))).rejects.toThrow(
        'boom',
      );
      expect(redis.eval).toHaveBeenCalledOnce(); // finally released
    });
  });
});
