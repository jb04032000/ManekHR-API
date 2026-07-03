import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { env } from '../../../config/env';

/**
 * Deterministic, key-order-independent serialization of the cache-key parts, so
 * `{ q, verified }` and `{ verified, q }` (or any field-insertion order) resolve
 * to the SAME cache entry — a real prefix cache hit, not a near-miss. Object
 * keys are sorted; `undefined`-valued keys are dropped so an absent filter and
 * an explicitly-undefined filter share one entry.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  // Primitive (string / number / boolean / null) or undefined -> a stable token.
  return value === undefined ? 'null' : JSON.stringify(value);
}

/**
 * `SearchCacheService` (SRCH-PERF-1) — a short-TTL Redis prefix cache fronting
 * the Meilisearch engine round-trip for `GET /connect/search`.
 *
 * **What it caches (and what it deliberately does NOT).** The cache stores only
 * the *viewer-independent* engine output — the matched hit ids and (for
 * listings) the facet-count distributions — keyed on the query text + filters.
 * It NEVER caches the hydrated, post-gate result. That is the whole point: the
 * live author-active gate (`SearchService.inactiveOwnerIds`, re-read from
 * `User.isActive` at hydration — SRCH-LEAK-1/4) and the per-viewer block filter
 * (`FederatedSearchService`) run on EVERY request, over the cached ids. So a
 * banned author or a viewer-blocked author is still dropped within the same
 * request even on a cache hit, and the cache key carries no actor/viewer
 * dimension, so one viewer's results can never be served to another. A spike of
 * identical typeahead prefixes is absorbed here instead of all reaching Meili.
 *
 * **Resilience.** Mirrors the `MeiliClient` contract: the cache is a progressive
 * enhancement, never load-bearing. A missing Redis client (`@Optional()`) or any
 * Redis fault (GET/SET reject) degrades to a direct live query — it MUST NEVER
 * throw into the request thread. TTL `<= 0` disables the cache entirely.
 */
@Injectable()
export class SearchCacheService {
  private readonly logger = new Logger(SearchCacheService.name);
  private readonly ttlSeconds = env.connectSearch.cacheTtlSeconds;

  constructor(
    // @Optional so unit tests (and a no-Redis local stack) construct the service
    // with no client and transparently degrade to compute-only. Unlike the
    // search block-filter (a SECURITY provider, made REQUIRED so it can't fail
    // open — SRCH-LEAK-3), a missing cache fails SAFE (a live query), so optional
    // injection is correct here.
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  /** Whether the cache will actually read/write Redis (client present + TTL > 0). */
  get enabled(): boolean {
    return Boolean(this.redis) && this.ttlSeconds > 0;
  }

  /**
   * Get-or-compute `compute()` under a stable, namespaced cache key derived from
   * `keyParts`. On a hit the cached JSON value is returned without recomputing;
   * on a miss the freshly-computed value is written with an EX TTL. Any Redis
   * fault (or a disabled cache) falls back to a direct `compute()` — never throws.
   */
  async wrap<T>(namespace: string, keyParts: unknown, compute: () => Promise<T>): Promise<T> {
    if (!this.redis || this.ttlSeconds <= 0) return compute();

    const key = this.buildKey(namespace, keyParts);
    try {
      const hit = await this.redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (err) {
      // A read fault means Redis is unhealthy; query live and don't attempt a
      // write (it would fault too). Debug-level — benign, the request succeeds.
      this.logger.debug(
        `cache GET failed for ${namespace}; querying live: ${(err as Error).message}`,
      );
      return compute();
    }

    const value = await compute();
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
    } catch (err) {
      this.logger.debug(`cache SET failed for ${namespace}: ${(err as Error).message}`);
    }
    return value;
  }

  /** `connect:search:<namespace>:<sha1(parts)>` — bounded, collision-resistant. */
  private buildKey(namespace: string, keyParts: unknown): string {
    const hash = createHash('sha1').update(stableStringify(keyParts)).digest('hex');
    return `connect:search:${namespace}:${hash}`;
  }
}
