/**
 * ManekHR Connect — tiny bounded TTL + LRU cache for the For-You read path.
 *
 * Why in-process (not Redis), even though Redis is the repo's cache store:
 *   The hot thing we cache is the For-You *candidate-generation* stage — a graph
 *   of Mongoose-lean `Post` objects carrying live `ObjectId` + `Date` instances
 *   (plus a `Map` for affinity). Round-tripping that through Redis JSON would
 *   downgrade every `ObjectId` to a string and every `Date` to an ISO string,
 *   forcing fragile re-hydration and risking subtle ranking / identity bugs
 *   (`.equals`, `new Date(...)`, `$in` casts). An in-process store keeps the
 *   NATIVE objects, so the cached stage is byte-identical to the uncached one.
 *
 * Correctness across instances: this is a READ-side scoring optimisation, not
 * shared state. Every instance keeps its own 60s window, and the volatile
 * filters that MUST be instant — hide / mute / block / seen — are applied FRESH
 * AFTER the cached stage (see `FeedService.getFeed`), so a second instance can
 * never serve a hidden/blocked post just because its candidate pool is warm. The
 * task already accepts 60s staleness for dampening + new-post surfacing.
 *
 * Memory is bounded two ways: a hard entry cap (LRU-evict the oldest on
 * overflow) and a per-entry TTL (lazily dropped on read). No timers, no locks.
 *
 * Used by `FeedService` (ranking signals + affinity) and `FeedDiscoveryService`
 * (the merged candidate pool). Keep both keyed by viewer id only — see the
 * call-site comments for why the other inputs are stable within the TTL.
 */
export class TtlLruCache<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  /**
   * @param ttlMs   How long an entry is served before it is recomputed.
   * @param maxSize Hard cap on live entries; the oldest is evicted past it.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number,
  ) {}

  /** Return the live (unexpired) value for `key`, or `undefined` on miss/expiry.
   *  `now` is injected so callers can pass the request clock (and tests can
   *  advance it deterministically). A hit refreshes LRU recency. */
  get(key: string, now: number): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    // Touch — move to the most-recently-used end so eviction drops cold keys.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  /** Insert / refresh `key` with a fresh TTL, evicting the oldest entry if the
   *  cap is exceeded (Map preserves insertion order → first key is the oldest). */
  set(key: string, value: V, now: number): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
    if (this.store.size > this.maxSize) {
      // Map preserves insertion order, so the first key is the oldest (LRU).
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  /** Drop one key (e.g. on a hard invalidation). No-op when absent. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Test/diagnostic helper — current live-entry count (includes not-yet-swept
   *  expired keys, which are pruned lazily on `get`). */
  get size(): number {
    return this.store.size;
  }
}
