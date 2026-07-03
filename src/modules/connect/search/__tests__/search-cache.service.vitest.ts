/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi } from 'vitest';
import { SearchCacheService } from '../search-cache.service';
import { env } from '../../../../config/env';

/**
 * Unit coverage for `SearchCacheService` (SRCH-PERF-1) — the short-TTL Redis
 * prefix cache that fronts the Meilisearch engine round-trip. The cache stores
 * ONLY the viewer-independent engine output (hit ids + facet counts), never the
 * post-hydration / post-block-filter result, so the live author-active gate and
 * the per-viewer block filter still run on every request (the cache key carries
 * no actor / viewer dimension). It must degrade gracefully — a missing Redis
 * client or any Redis fault falls back to computing the value, never throwing.
 */

/** A minimal ioredis stand-in with get/set spies. `getImpl` overrides the GET result. */
function fakeRedis(getImpl?: any) {
  return {
    get: vi.fn(getImpl ?? (() => Promise.resolve(null))),
    set: vi.fn(() => Promise.resolve('OK')),
  };
}

describe('SearchCacheService (SRCH-PERF-1)', () => {
  it('the configured TTL sits in the spec window (30–60s)', () => {
    expect(env.connectSearch.cacheTtlSeconds).toBeGreaterThanOrEqual(30);
    expect(env.connectSearch.cacheTtlSeconds).toBeLessThanOrEqual(60);
  });

  it('with no Redis client it computes the value and never touches Redis', async () => {
    const cache = new SearchCacheService(null);
    const compute = vi.fn().mockResolvedValue(['a', 'b']);

    const result = await cache.wrap('people', { q: 'zari' }, compute);

    expect(result).toEqual(['a', 'b']);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.enabled).toBe(false);
  });

  it('cache MISS: computes, writes Redis with the TTL, returns the value', async () => {
    const redis = fakeRedis(() => Promise.resolve(null));
    const cache = new SearchCacheService(redis as any);
    const compute = vi.fn().mockResolvedValue({ ids: ['x'], total: 1 });

    const result = await cache.wrap(
      'listings',
      { q: 'saree', p: { limit: 25, offset: 0 } },
      compute,
    );

    expect(result).toEqual({ ids: ['x'], total: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledTimes(1);
    // Stored under a namespaced key, JSON-serialized, with an EX TTL from env.
    const [key, value, mode, ttl] = redis.set.mock.calls[0];
    expect(key).toMatch(/^connect:search:listings:/);
    expect(JSON.parse(value)).toEqual({ ids: ['x'], total: 1 });
    expect(mode).toBe('EX');
    expect(ttl).toBe(env.connectSearch.cacheTtlSeconds);
  });

  it('cache HIT: returns the parsed cached value WITHOUT recomputing', async () => {
    const cached = JSON.stringify(['cached-id']);
    const redis = fakeRedis(() => Promise.resolve(cached));
    const cache = new SearchCacheService(redis as any);
    const compute = vi.fn().mockResolvedValue(['fresh-id']);

    const result = await cache.wrap('people', { q: 'zari' }, compute);

    expect(result).toEqual(['cached-id']);
    expect(compute).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('degrades to compute() when Redis GET rejects (never throws)', async () => {
    const redis = fakeRedis(() => Promise.reject(new Error('redis down')));
    const cache = new SearchCacheService(redis as any);
    const compute = vi.fn().mockResolvedValue(['ok']);

    const result = await cache.wrap('posts', { q: 'zari' }, compute);

    expect(result).toEqual(['ok']);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('still returns the computed value when Redis SET rejects (never throws)', async () => {
    const redis = fakeRedis(() => Promise.resolve(null));
    redis.set = vi.fn(() => Promise.reject(new Error('redis write failed')));
    const cache = new SearchCacheService(redis as any);
    const compute = vi.fn().mockResolvedValue(['ok']);

    const result = await cache.wrap('jobs', { q: 'zari' }, compute);

    expect(result).toEqual(['ok']);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('the cache key is stable for identical inputs and varies with the inputs', async () => {
    const redis = fakeRedis(() => Promise.resolve(null));
    const cache = new SearchCacheService(redis as any);
    const compute = vi.fn().mockResolvedValue([]);

    await cache.wrap('people', { q: 'zari', f: { district: 'surat' } }, compute);
    await cache.wrap('people', { q: 'zari', f: { district: 'surat' } }, compute);
    await cache.wrap('people', { q: 'saree', f: { district: 'surat' } }, compute);

    const keys = redis.get.mock.calls.map((c: any) => c[0]);
    expect(keys[0]).toBe(keys[1]); // identical inputs -> identical key (a real prefix cache hit)
    expect(keys[0]).not.toBe(keys[2]); // a different query -> a different key
  });

  it('key order within the parts object does not change the key (stable serialization)', async () => {
    const redis = fakeRedis(() => Promise.resolve(null));
    const cache = new SearchCacheService(redis as any);
    const compute = vi.fn().mockResolvedValue([]);

    await cache.wrap('listings', { q: 'zari', verified: true }, compute);
    await cache.wrap('listings', { verified: true, q: 'zari' }, compute);

    const [k1, k2] = redis.get.mock.calls.map((c: any) => c[0]);
    expect(k1).toBe(k2);
  });
});
