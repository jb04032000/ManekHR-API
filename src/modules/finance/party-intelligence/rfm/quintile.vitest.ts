/**
 * Phase 17 / FIN-16-01 — quintile.util unit tests.
 *
 * Tests the pure scoreValue function across:
 *   1. Empty cutoffs returns 1
 *   2. Value below all cutoffs lands in bucket 1 (or 5 inverted)
 *   3. Value above all cutoffs lands in bucket 5 (or 1 inverted)
 *   4. Inverted scoring: lowest recencyDays → highest score
 *   5. Boundary equality (value === cutoff[i]) lands in bucket i+1 (lower)
 *   6. Null value returns 1
 *
 * Project vitest discovery is `src/**\/*.vitest.ts`; plan path stub at
 * `__tests__/unit/party-intelligence/quintile.spec.ts` re-points here.
 */
import { describe, it, expect } from 'vitest';
import { scoreValue } from './quintile.util';

describe('scoreValue — pure quintile scorer', () => {
  // 4 cutoffs => 5 buckets.
  // bucket 1: value <= 10, bucket 2: <= 20, bucket 3: <= 30, bucket 4: <= 40, bucket 5: > 40
  const cutoffs = [10, 20, 30, 40];

  it('Test 1 — empty cutoffs returns 1', () => {
    expect(scoreValue(15, [], false)).toBe(1);
    expect(scoreValue(15, [], true)).toBe(1);
  });

  it('Test 2 — null value returns 1', () => {
    expect(scoreValue(null, cutoffs, false)).toBe(1);
    expect(scoreValue(undefined, cutoffs, false)).toBe(1);
  });

  it('Test 3 — value below all cutoffs lands in bucket 1', () => {
    expect(scoreValue(5, cutoffs, false)).toBe(1);
  });

  it('Test 4 — value above all cutoffs lands in bucket 5', () => {
    expect(scoreValue(100, cutoffs, false)).toBe(5);
  });

  it('Test 5 — boundary equality lands in lower bucket (value <= cutoff)', () => {
    // value === cutoffs[0] (10) → bucket 1
    expect(scoreValue(10, cutoffs, false)).toBe(1);
    // value === cutoffs[1] (20) → bucket 2
    expect(scoreValue(20, cutoffs, false)).toBe(2);
  });

  it('Test 6 — middle-range bucket assignment', () => {
    expect(scoreValue(25, cutoffs, false)).toBe(3); // > 20, <= 30 → bucket 3
    expect(scoreValue(35, cutoffs, false)).toBe(4); // > 30, <= 40 → bucket 4
  });

  it('Test 7 — inverted scoring (recency): low value → high score', () => {
    // recency=5 days → bucket 1 forward → invert → 5 (BEST)
    expect(scoreValue(5, cutoffs, true)).toBe(5);
    // recency=100 days → bucket 5 forward → invert → 1 (WORST)
    expect(scoreValue(100, cutoffs, true)).toBe(1);
    // recency=25 days → bucket 3 forward → invert → 3 (middle)
    expect(scoreValue(25, cutoffs, true)).toBe(3);
  });
});
