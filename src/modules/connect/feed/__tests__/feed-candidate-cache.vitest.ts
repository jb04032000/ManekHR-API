import { describe, it, expect } from 'vitest';
import { TtlLruCache } from '../feed-candidate-cache';

/**
 * Unit coverage for the For-You candidate-generation cache. The clock is injected
 * (`get`/`set` take `now`) so TTL + LRU behaviour is deterministic with no timers.
 */
describe('TtlLruCache', () => {
  it('returns a live value within the TTL and a miss after it', () => {
    const c = new TtlLruCache<number>(1000, 10);
    c.set('a', 42, 0);
    expect(c.get('a', 500)).toBe(42); // within TTL
    expect(c.get('a', 999)).toBe(42); // edge, still live
    expect(c.get('a', 1000)).toBeUndefined(); // expired exactly at TTL
    expect(c.get('a', 1500)).toBeUndefined();
  });

  it('is a miss for an unknown key', () => {
    const c = new TtlLruCache<number>(1000, 10);
    expect(c.get('missing', 0)).toBeUndefined();
  });

  it('refreshes the TTL on re-set', () => {
    const c = new TtlLruCache<number>(1000, 10);
    c.set('a', 1, 0);
    c.set('a', 2, 800); // re-set extends the window from 800
    expect(c.get('a', 1500)).toBe(2); // would have expired at 1000 without the re-set
  });

  it('evicts the least-recently-used entry past the size cap', () => {
    const c = new TtlLruCache<number>(10_000, 2);
    c.set('a', 1, 0);
    c.set('b', 2, 0);
    // Touch 'a' so 'b' becomes the coldest, then overflow with 'c'.
    expect(c.get('a', 1)).toBe(1);
    c.set('c', 3, 1);
    expect(c.get('b', 2)).toBeUndefined(); // 'b' evicted (LRU)
    expect(c.get('a', 2)).toBe(1);
    expect(c.get('c', 2)).toBe(3);
    expect(c.size).toBe(2); // never grows beyond the cap
  });

  it('delete drops a key', () => {
    const c = new TtlLruCache<number>(1000, 10);
    c.set('a', 1, 0);
    c.delete('a');
    expect(c.get('a', 0)).toBeUndefined();
  });
});
