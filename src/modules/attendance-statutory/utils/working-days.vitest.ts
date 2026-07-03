import { describe, it, expect } from 'vitest';
import { computeWorkingDaysInMonth, DEFAULT_WORKING_DAYS_MON_SAT } from './working-days.util';

describe('computeWorkingDaysInMonth', () => {
  it('returns 26 for April 2026 with Mon-Sat schedule (4 Sundays)', () => {
    expect(computeWorkingDaysInMonth(2026, 4, DEFAULT_WORKING_DAYS_MON_SAT)).toBe(26);
  });

  it('returns 20 for Feb 2026 with Mon-Fri schedule (28 - 8 weekends)', () => {
    expect(computeWorkingDaysInMonth(2026, 2, [1, 2, 3, 4, 5])).toBe(20);
  });

  it('returns 25 for Feb 2024 leap year Mon-Sat (29 - 4 Sundays)', () => {
    expect(computeWorkingDaysInMonth(2024, 2, DEFAULT_WORKING_DAYS_MON_SAT)).toBe(25);
  });

  it('returns 30 when all 7 days are working', () => {
    expect(computeWorkingDaysInMonth(2026, 4, [0, 1, 2, 3, 4, 5, 6])).toBe(30);
  });

  it('throws on invalid month', () => {
    expect(() => computeWorkingDaysInMonth(2026, 13, [1])).toThrow(/Invalid month/);
    expect(() => computeWorkingDaysInMonth(2026, 0, [1])).toThrow(/Invalid month/);
  });
});
