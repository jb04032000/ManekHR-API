/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// FrequencyCapService only uses plain Redis incr/expire - no Mongoose decorators
// transitively, so no vi.mock('@nestjs/mongoose') needed here.

import { FrequencyCapService } from '../services/frequency-cap.service';

// ---------------------------------------------------------------------------
// Fake Redis
// Mimics the ioredis client surface used by FrequencyCapService:
//   incr(key) -> number (auto-increments an in-memory map)
//   expire(key, ttl) -> void
// ---------------------------------------------------------------------------

function makeFakeRedis() {
  const counters = new Map<string, number>();
  const expireSpy = vi.fn();

  const redis = {
    incr: (key: string): Promise<number> => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return Promise.resolve(next);
    },
    expire: expireSpy,
    // expose internals for assertions
    _counters: counters,
    _expireSpy: expireSpy,
  };

  return redis;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FrequencyCapService', () => {
  describe('hitAndCheck - basic cap enforcement', () => {
    it('returns true for calls 1..cap and false on cap+1 (cap=2)', async () => {
      const redis = makeFakeRedis();
      const svc = new FrequencyCapService(redis as any);

      const r1 = await svc.hitAndCheck('u1', 'ad1', 86400, 2);
      const r2 = await svc.hitAndCheck('u1', 'ad1', 86400, 2);
      const r3 = await svc.hitAndCheck('u1', 'ad1', 86400, 2);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(r3).toBe(false);
    });

    it('returns true for all calls when cap=3 with exactly 3 calls', async () => {
      const redis = makeFakeRedis();
      const svc = new FrequencyCapService(redis as any);

      const results = await Promise.all([
        svc.hitAndCheck('u2', 'ad2', 3600, 3),
        svc.hitAndCheck('u2', 'ad2', 3600, 3),
        svc.hitAndCheck('u2', 'ad2', 3600, 3),
      ]);

      expect(results).toEqual([true, true, true]);
    });

    it('returns false immediately on cap+1=1 when cap=0', async () => {
      const redis = makeFakeRedis();
      const svc = new FrequencyCapService(redis as any);

      const r = await svc.hitAndCheck('u3', 'ad3', 60, 0);

      expect(r).toBe(false);
    });
  });

  describe('hitAndCheck - expire called exactly once on first hit', () => {
    it('calls expire exactly once (n===1) with the right windowSec', async () => {
      const redis = makeFakeRedis();
      const svc = new FrequencyCapService(redis as any);

      await svc.hitAndCheck('u4', 'ad4', 7200, 5);
      await svc.hitAndCheck('u4', 'ad4', 7200, 5);
      await svc.hitAndCheck('u4', 'ad4', 7200, 5);

      expect(redis._expireSpy).toHaveBeenCalledTimes(1);
      expect(redis._expireSpy).toHaveBeenCalledWith('freqcap:u4:ad4:7200', 7200);
    });

    it('expire is NOT called at all when key was already incremented (simulate by pre-filling counter)', async () => {
      // Pre-fill the counter to 1 so the first hitAndCheck sees n=2, not n=1.
      const redis = makeFakeRedis();
      redis._counters.set('freqcap:u5:ad5:300', 1);
      const svc = new FrequencyCapService(redis as any);

      await svc.hitAndCheck('u5', 'ad5', 300, 5);

      // n was 2 on the first call (counter pre-seeded at 1), so expire must not fire.
      expect(redis._expireSpy).not.toHaveBeenCalled();
    });
  });

  describe('hitAndCheck - key isolation', () => {
    it('different userId produces an independent counter', async () => {
      const redis = makeFakeRedis();
      const svc = new FrequencyCapService(redis as any);

      // cap=1 for both; each user has their own counter.
      const r1a = await svc.hitAndCheck('userA', 'same-ad', 86400, 1);
      const r1b = await svc.hitAndCheck('userB', 'same-ad', 86400, 1);

      expect(r1a).toBe(true);
      expect(r1b).toBe(true);

      // Second hit for userA exceeds cap, but userB's counter is still at 1.
      const r2a = await svc.hitAndCheck('userA', 'same-ad', 86400, 1);
      const r2b = await svc.hitAndCheck('userB', 'same-ad', 86400, 1);

      expect(r2a).toBe(false);
      expect(r2b).toBe(false);
    });

    it('different adSetId produces an independent counter', async () => {
      const redis = makeFakeRedis();
      const svc = new FrequencyCapService(redis as any);

      const r1 = await svc.hitAndCheck('same-user', 'adA', 86400, 1);
      const r2 = await svc.hitAndCheck('same-user', 'adB', 86400, 1);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
    });

    it('different windowSec produces an independent counter', async () => {
      const redis = makeFakeRedis();
      const svc = new FrequencyCapService(redis as any);

      // cap=1 for both windows; they share user+ad but different windowSec.
      const r1 = await svc.hitAndCheck('same-user', 'same-ad', 3600, 1);
      const r2 = await svc.hitAndCheck('same-user', 'same-ad', 86400, 1);

      expect(r1).toBe(true); // 3600 window: n=1 <= 1
      expect(r2).toBe(true); // 86400 window: n=1 <= 1 (separate key)
    });

    it('uses the correct Redis key format: freqcap:{userId}:{adSetId}:{windowSec}', async () => {
      const redis = makeFakeRedis();
      const svc = new FrequencyCapService(redis as any);

      await svc.hitAndCheck('uid-99', 'adset-77', 1800, 10);

      expect(redis._counters.has('freqcap:uid-99:adset-77:1800')).toBe(true);
    });
  });
});
