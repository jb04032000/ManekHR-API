/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// ---- Will fail until pacing.repo.ts exists (RED) ----
import { PacingRepoRedis } from '../pacing.repo';

// ---------------------------------------------------------------------------
// Fake Redis backed by a Map
// ---------------------------------------------------------------------------

function makeFakeRedis() {
  const store = new Map<string, string>();

  const getSpy = vi.fn((key: string) => Promise.resolve(store.get(key) ?? null));
  const setSpy = vi.fn((key: string, value: string, _ex: string, _ttl: number): Promise<'OK'> => {
    store.set(key, value);
    return Promise.resolve('OK');
  });

  return { getSpy, setSpy, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PacingRepoRedis', () => {
  describe('isThrottled', () => {
    it('returns false when no throttle key exists', async () => {
      const fakeRedis = makeFakeRedis();
      const repo = new PacingRepoRedis({ get: fakeRedis.getSpy, set: fakeRedis.setSpy } as any);

      const result = await repo.isThrottled('camp-1');

      expect(result).toBe(false);
    });

    it('returns true after setThrottle has been called for that campaignId', async () => {
      const fakeRedis = makeFakeRedis();
      const repo = new PacingRepoRedis({ get: fakeRedis.getSpy, set: fakeRedis.setSpy } as any);

      await repo.setThrottle('camp-2', 60);
      const result = await repo.isThrottled('camp-2');

      expect(result).toBe(true);
    });

    it('uses the key pacing:{campaignId} for the Redis GET call', async () => {
      const fakeRedis = makeFakeRedis();
      const repo = new PacingRepoRedis({ get: fakeRedis.getSpy, set: fakeRedis.setSpy } as any);

      await repo.isThrottled('camp-xyz');

      expect(fakeRedis.getSpy).toHaveBeenCalledWith('pacing:camp-xyz');
    });
  });

  describe('setThrottle', () => {
    it('calls redis.set with (key, "1", "EX", ttlSec)', async () => {
      const fakeRedis = makeFakeRedis();
      const repo = new PacingRepoRedis({ get: fakeRedis.getSpy, set: fakeRedis.setSpy } as any);

      await repo.setThrottle('camp-3', 120);

      expect(fakeRedis.setSpy).toHaveBeenCalledWith('pacing:camp-3', '1', 'EX', 120);
    });

    it('different campaigns are independent - only throttled campaign returns true', async () => {
      const fakeRedis = makeFakeRedis();
      const repo = new PacingRepoRedis({ get: fakeRedis.getSpy, set: fakeRedis.setSpy } as any);

      await repo.setThrottle('camp-A', 60);

      expect(await repo.isThrottled('camp-A')).toBe(true);
      expect(await repo.isThrottled('camp-B')).toBe(false);
    });
  });
});
