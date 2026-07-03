import { describe, it, expect } from 'vitest';
import { generateReferralCode } from '../referral-code.util';

/**
 * Unit coverage for the referral code generator (Phase 4a, Task 7). Verifies the
 * shape contract (6-10 chars, uppercase, unambiguous alphabet) + the name stem +
 * the fallback when the seed has no usable letters. rng is injected for
 * determinism.
 */
describe('generateReferralCode', () => {
  it('produces a clean 6-10 char code (uppercase, no ambiguous glyphs)', () => {
    const code = generateReferralCode('Rajesh Patel', () => 0.5);
    expect(code).toMatch(/^[A-Z2-9]{6,10}$/);
    expect(code).not.toMatch(/[0O1lI]/);
  });

  it('starts with an alpha stem derived from the name', () => {
    const code = generateReferralCode('Rajesh Patel', () => 0);
    expect(code.startsWith('RAJE')).toBe(true);
  });

  it('strips non-letters from the seed when building the stem', () => {
    const code = generateReferralCode('a1b2c3 x', () => 0);
    // Only letters survive into the stem (max 4): A B C X.
    expect(code.startsWith('ABCX')).toBe(true);
    expect(code).toMatch(/^[A-Z2-9]{6,10}$/);
  });

  it("falls back to a 'CR' stem when the seed has no letters", () => {
    const code = generateReferralCode('12345', () => 0);
    expect(code.startsWith('CR')).toBe(true);
    expect(code).toMatch(/^[A-Z2-9]{6,10}$/);
  });

  it("handles an empty seed with the 'CR' fallback", () => {
    const code = generateReferralCode('', () => 0);
    expect(code.startsWith('CR')).toBe(true);
    expect(code.length).toBeGreaterThanOrEqual(6);
    expect(code.length).toBeLessThanOrEqual(10);
  });

  it('is deterministic: same seed + same rng -> the same code (uses injected rng)', () => {
    // A counting rng walks the alphabet deterministically; two identical
    // invocations MUST yield identical codes. This is the regression guard for
    // the suffix loop accidentally falling back to Math.random.
    const makeRng = () => {
      let i = 0;
      return () => {
        const seq = [0, 0.1, 0.2, 0.3];
        return seq[i++ % seq.length];
      };
    };
    const a = generateReferralCode('Rajesh Patel', makeRng());
    const b = generateReferralCode('Rajesh Patel', makeRng());
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Z2-9]{6,10}$/);
  });

  it('never emits an ambiguous glyph across the alphabet sweep', () => {
    // Sweep rng across the full [0,1) range to touch every alphabet index.
    for (let i = 0; i < 31; i++) {
      const r = i / 31;
      const code = generateReferralCode('Test', () => r);
      expect(code).not.toMatch(/[0O1lI]/);
      expect(code).toMatch(/^[A-Z2-9]{6,10}$/);
    }
  });
});
