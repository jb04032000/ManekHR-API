import { describe, it, expect } from 'vitest';
import { firstDepreciationMonth } from '../acquisition-depreciation.util';

describe('firstDepreciationMonth', () => {
  // Companies Act 2013 Schedule II: depreciation is pro-rata from the date the
  // asset is available for use, so the acquisition month IS depreciated (the
  // depreciation-math service pro-rates the partial month from purchaseDate).
  it('returns the acquisition month itself for a mid-month purchase', () => {
    expect(firstDepreciationMonth(new Date(2026, 2, 15))).toBe('2026-03');
  });

  it('returns the acquisition month for a first-of-month purchase', () => {
    expect(firstDepreciationMonth(new Date(2026, 3, 1))).toBe('2026-04');
  });

  it('handles a December purchase without rolling the year forward', () => {
    expect(firstDepreciationMonth(new Date(2026, 11, 20))).toBe('2026-12');
  });

  it('handles a January purchase', () => {
    expect(firstDepreciationMonth(new Date(2027, 0, 5))).toBe('2027-01');
  });
});
