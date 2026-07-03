/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

import { AdProfileService } from '../services/ad-profile.service';
import type { AdProfile } from '../lib/targeting';
import type { AdProfileSource } from '../services/ad-profile.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_PROFILE: AdProfile = {
  role: 'manager',
  skills: ['textile'],
  district: 'surat',
  companySize: '50-200',
  connectionDegree: 1,
};

const USER_ID = 'user-abc-123';
const CACHE_KEY = `adprofile:${USER_ID}`;

// Fake Redis: simple in-memory get/set with spy wrappers.
function makeFakeRedis(initialGet?: string | null) {
  const store = new Map<string, string>();
  if (initialGet !== undefined && initialGet !== null) {
    store.set(CACHE_KEY, initialGet);
  }

  const getSpy = vi.fn(
    (key: string): Promise<string | null> => Promise.resolve(store.get(key) ?? null),
  );
  const setSpy = vi.fn((..._args: unknown[]): Promise<'OK'> => {
    // Minimal set: store[key] = value (we only care it was called with right args).
    const [key, value] = _args as [string, string];
    store.set(key, value);
    return Promise.resolve('OK');
  });

  return { getSpy, setSpy, _store: store };
}

// Fake AdProfileSource.
function makeFakeSource(profile: AdProfile = SAMPLE_PROFILE) {
  const buildForSpy = vi.fn((_userId: string): Promise<AdProfile> => Promise.resolve(profile));
  const source: AdProfileSource = { buildFor: buildForSpy };
  return { source, buildForSpy };
}

function makeFakeRedisObj(fakeRedis: ReturnType<typeof makeFakeRedis>) {
  return { get: fakeRedis.getSpy, set: fakeRedis.setSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdProfileService', () => {
  describe('get - cache HIT', () => {
    it('returns the parsed cached profile without calling source.buildFor', async () => {
      const fakeRedis = makeFakeRedis(JSON.stringify(SAMPLE_PROFILE));
      const { source, buildForSpy } = makeFakeSource();
      const svc = new AdProfileService(makeFakeRedisObj(fakeRedis) as any, source);

      const result = await svc.get(USER_ID);

      expect(result).toEqual(SAMPLE_PROFILE);
      expect(buildForSpy).not.toHaveBeenCalled();
    });

    it('does NOT call redis.set on a cache hit', async () => {
      const fakeRedis = makeFakeRedis(JSON.stringify(SAMPLE_PROFILE));
      const { source } = makeFakeSource();
      const svc = new AdProfileService(makeFakeRedisObj(fakeRedis) as any, source);

      await svc.get(USER_ID);

      expect(fakeRedis.setSpy).not.toHaveBeenCalled();
    });

    it('handles a profile with all fields correctly (full round-trip JSON)', async () => {
      const profile: AdProfile = {
        role: 'worker',
        skills: ['garment'],
        district: 'vadodara',
        companySize: '10-50',
        connectionDegree: 2,
      };
      const fakeRedis = makeFakeRedis(JSON.stringify(profile));
      const { source } = makeFakeSource(profile);
      const svc = new AdProfileService(makeFakeRedisObj(fakeRedis) as any, source);

      const result = await svc.get('other-user');

      expect(result.role).toBe('worker');
      expect(result.district).toBe('vadodara');
      expect(result.connectionDegree).toBe(2);
    });
  });

  describe('get - cache MISS', () => {
    it('calls source.buildFor(userId) exactly once when cache is empty', async () => {
      const fakeRedis = makeFakeRedis(null);
      const { source, buildForSpy } = makeFakeSource();
      const svc = new AdProfileService(makeFakeRedisObj(fakeRedis) as any, source);

      await svc.get(USER_ID);

      expect(buildForSpy).toHaveBeenCalledTimes(1);
      expect(buildForSpy).toHaveBeenCalledWith(USER_ID);
    });

    it('returns the profile produced by source.buildFor on a cache miss', async () => {
      const fakeRedis = makeFakeRedis(null);
      const { source } = makeFakeSource();
      const svc = new AdProfileService(makeFakeRedisObj(fakeRedis) as any, source);

      const result = await svc.get(USER_ID);

      expect(result).toEqual(SAMPLE_PROFILE);
    });

    it('calls redis.set with (key, jsonString, "EX", 900) on a cache miss', async () => {
      const fakeRedis = makeFakeRedis(null);
      const { source } = makeFakeSource();
      const svc = new AdProfileService(makeFakeRedisObj(fakeRedis) as any, source);

      await svc.get(USER_ID);

      expect(fakeRedis.setSpy).toHaveBeenCalledTimes(1);
      expect(fakeRedis.setSpy).toHaveBeenCalledWith(
        CACHE_KEY,
        JSON.stringify(SAMPLE_PROFILE),
        'EX',
        900,
      );
    });

    it('does NOT call redis.set when get returns a non-null hit (no double-write)', async () => {
      const fakeRedis = makeFakeRedis(JSON.stringify(SAMPLE_PROFILE));
      const { source } = makeFakeSource();
      const svc = new AdProfileService(makeFakeRedisObj(fakeRedis) as any, source);

      await svc.get(USER_ID);
      await svc.get(USER_ID); // second call, still hits cache

      expect(fakeRedis.setSpy).not.toHaveBeenCalled();
    });
  });

  describe('get - key format', () => {
    it('uses the correct Redis key: adprofile:{userId}', async () => {
      const fakeRedis = makeFakeRedis(null);
      const { source } = makeFakeSource();
      const svc = new AdProfileService(makeFakeRedisObj(fakeRedis) as any, source);

      await svc.get('my-special-user');

      expect(fakeRedis.getSpy).toHaveBeenCalledWith('adprofile:my-special-user');
    });
  });
});
