import { describe, it, expect } from 'vitest';
import {
  dampenFactor,
  deriveAuthorDampen,
  NOT_INTERESTED_POST_FACTOR,
  NOT_INTERESTED_HALF_LIFE_DAYS,
  NOT_INTERESTED_AUTHOR_THRESHOLD,
} from '../feed-feedback';

/**
 * Pure dampening math for reader feedback (Phase 7d). No Mongo — just the decay
 * function + author-derivation rule the feed read uses to turn stored "not
 * interested" marks into score multipliers.
 */
describe('feed-feedback — pure dampening math (Phase 7d)', () => {
  describe('dampenFactor', () => {
    it('returns the full fresh penalty at age 0', () => {
      expect(dampenFactor(0, NOT_INTERESTED_POST_FACTOR)).toBe(NOT_INTERESTED_POST_FACTOR);
    });

    it('clamps a negative age to the fresh penalty', () => {
      expect(dampenFactor(-5, NOT_INTERESTED_POST_FACTOR)).toBe(NOT_INTERESTED_POST_FACTOR);
    });

    it('halves the remaining penalty after one half-life', () => {
      // base 0.5 -> penalty 0.5; after one half-life the penalty halves to 0.25,
      // so the multiplier rises to 0.75.
      expect(dampenFactor(NOT_INTERESTED_HALF_LIFE_DAYS, 0.5)).toBeCloseTo(0.75, 6);
    });

    it('decays toward 1 (no effect) for a very old mark', () => {
      expect(dampenFactor(NOT_INTERESTED_HALF_LIFE_DAYS * 20, 0.5)).toBeCloseTo(1, 4);
    });

    it('is monotonically increasing with age (penalty always fading)', () => {
      const a = dampenFactor(5, 0.5);
      const b = dampenFactor(20, 0.5);
      const c = dampenFactor(60, 0.5);
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
    });
  });

  describe('deriveAuthorDampen', () => {
    it('derives an author dampen at exactly the threshold of distinct post marks', () => {
      expect(deriveAuthorDampen(NOT_INTERESTED_AUTHOR_THRESHOLD)).toBe(true);
    });

    it('does not derive below the threshold', () => {
      expect(deriveAuthorDampen(NOT_INTERESTED_AUTHOR_THRESHOLD - 1)).toBe(false);
    });

    it('derives above the threshold', () => {
      expect(deriveAuthorDampen(NOT_INTERESTED_AUTHOR_THRESHOLD + 4)).toBe(true);
    });
  });
});
