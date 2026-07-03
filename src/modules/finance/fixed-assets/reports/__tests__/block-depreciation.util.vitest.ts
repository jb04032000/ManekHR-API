import { describe, it, expect } from 'vitest';
import { isHalfYearAddition, computeBlockDepreciation } from '../block-depreciation.util';

// FY 2024-25 ends 31 Mar 2025. The 180-day cutoff falls on 3 Oct 2024
// (acquired on/before => used >= 180 days => full rate).
const fyEnd = new Date('2025-03-31T00:00:00.000Z');

describe('isHalfYearAddition (s.32 180-day proviso)', () => {
  it('asset acquired at the start of the year gets the full rate', () => {
    expect(isHalfYearAddition(new Date('2024-04-01T00:00:00.000Z'), fyEnd)).toBe(false);
  });

  it('exactly 180 days of use is the full rate (boundary)', () => {
    // 3 Oct 2024 -> 31 Mar 2025 inclusive = 180 days
    expect(isHalfYearAddition(new Date('2024-10-03T00:00:00.000Z'), fyEnd)).toBe(false);
  });

  it('179 days of use is the half rate (just past the boundary)', () => {
    expect(isHalfYearAddition(new Date('2024-10-04T00:00:00.000Z'), fyEnd)).toBe(true);
  });

  it('an asset bought on the last day is the half rate', () => {
    expect(isHalfYearAddition(new Date('2025-03-31T00:00:00.000Z'), fyEnd)).toBe(true);
  });
});

describe('computeBlockDepreciation', () => {
  it('charges the full rate on full-year additions', () => {
    const r = computeBlockDepreciation({
      openingWdvPaise: 0,
      additionsFullPaise: 100_00,
      additionsHalfPaise: 0,
      disposalsPaise: 0,
      itActRate: 0.15,
    });
    // 15% of Rs 100.00 (10000 paise) = 1500 paise
    expect(r.depreciationPaise).toBe(1500);
    expect(r.closingWdvPaise).toBe(8500);
  });

  it('charges HALF the rate on half-year additions (the bug: was full-base/2)', () => {
    const r = computeBlockDepreciation({
      openingWdvPaise: 0,
      additionsFullPaise: 0,
      additionsHalfPaise: 100_00,
      disposalsPaise: 0,
      itActRate: 0.15,
    });
    // half rate = 7.5% of Rs 100.00 (10000 paise) = 750 paise
    expect(r.depreciationPaise).toBe(750);
    expect(r.closingWdvPaise).toBe(9250);
  });

  it('mixes opening WDV, full + half additions independently', () => {
    const r = computeBlockDepreciation({
      openingWdvPaise: 1_000_00,
      additionsFullPaise: 200_00,
      additionsHalfPaise: 100_00,
      disposalsPaise: 0,
      itActRate: 0.1,
    });
    // full: 10% of (100000 + 20000) = 12000 ; half: 5% of 10000 = 500
    expect(r.depreciationPaise).toBe(120_00 + 5_00);
    expect(r.closingWdvPaise).toBe(1_000_00 + 200_00 + 100_00 - (120_00 + 5_00));
  });

  it('reduces the full-rate base by disposals (s.43(6)) and never depreciates a wiped base', () => {
    const r = computeBlockDepreciation({
      openingWdvPaise: 50_00,
      additionsFullPaise: 0,
      additionsHalfPaise: 0,
      disposalsPaise: 80_00, // proceeds exceed WDV -> base negative
      itActRate: 0.15,
    });
    expect(r.depreciationPaise).toBe(0);
  });
});
