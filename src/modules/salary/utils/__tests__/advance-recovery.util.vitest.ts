import { describe, it, expect } from 'vitest';
import { buildInstallmentSchedule } from '../advance-recovery.util';

describe('buildInstallmentSchedule', () => {
  it('splits evenly by count', () => {
    expect(buildInstallmentSchedule(60000, { installmentCount: 6 })).toEqual([
      10000, 10000, 10000, 10000, 10000, 10000,
    ]);
  });

  it('count mode: last installment absorbs the remainder (sum === total)', () => {
    const parts = buildInstallmentSchedule(40000, { installmentCount: 6 });
    expect(parts).toHaveLength(6);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(40000);
    // first 5 equal, last absorbs remainder
    expect(new Set(parts.slice(0, 5)).size).toBe(1);
  });

  it('amount mode: derives count and last absorbs remainder', () => {
    const parts = buildInstallmentSchedule(40000, { installmentAmount: 15000 });
    // ceil(40000/15000)=3 -> [15000,15000,10000]
    expect(parts).toEqual([15000, 15000, 10000]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(40000);
  });

  it('amount >= total clamps to a single installment', () => {
    expect(buildInstallmentSchedule(40000, { installmentAmount: 50000 })).toEqual([40000]);
  });

  it('count of 1 returns the whole total', () => {
    expect(buildInstallmentSchedule(40000, { installmentCount: 1 })).toEqual([40000]);
  });

  it('rejects when neither count nor amount is provided', () => {
    expect(() => buildInstallmentSchedule(40000, {})).toThrow();
  });

  it('rejects when both count and amount are provided', () => {
    expect(() =>
      buildInstallmentSchedule(40000, { installmentCount: 6, installmentAmount: 10000 }),
    ).toThrow();
  });

  it('rejects non-positive total', () => {
    expect(() => buildInstallmentSchedule(0, { installmentCount: 6 })).toThrow();
    expect(() => buildInstallmentSchedule(-100, { installmentCount: 6 })).toThrow();
  });

  it('handles non-divisible totals with paise rounding (sum === total)', () => {
    const parts = buildInstallmentSchedule(10000, { installmentCount: 3 });
    expect(parts).toHaveLength(3);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(10000, 2);
  });
});
