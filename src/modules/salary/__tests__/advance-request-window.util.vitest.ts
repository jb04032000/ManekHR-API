/**
 * Worker advance-request timing policy. Generalizes the old single
 * `advanceRequestDay` lock into a workspace policy: any_day | window | fixed_day.
 * Pure decision function, unit-tested in isolation; the createRequest guard calls it.
 * Links: advance-request-window.util.ts, advance-salary-request.service.ts createRequest,
 * payroll-config.schema.ts disbursementRules.advanceRequestPolicy.
 */
import { describe, it, expect } from 'vitest';
import { isAdvanceRequestWindowOpen } from '../utils/advance-request-window.util';

describe('isAdvanceRequestWindowOpen', () => {
  it('falls back to the fixed advanceRequestDay when no policy is set (legacy behaviour)', () => {
    expect(isAdvanceRequestWindowOpen(undefined, 15, 15)).toBe(true);
    expect(isAdvanceRequestWindowOpen(undefined, 15, 14)).toBe(false);
  });

  it('any_day mode is always open', () => {
    expect(isAdvanceRequestWindowOpen({ mode: 'any_day' }, 15, 1)).toBe(true);
    expect(isAdvanceRequestWindowOpen({ mode: 'any_day' }, 15, 28)).toBe(true);
  });

  it('fixed_day mode uses policy.fixedDay, not the fallback', () => {
    const p = { mode: 'fixed_day' as const, fixedDay: 5 };
    expect(isAdvanceRequestWindowOpen(p, 15, 5)).toBe(true);
    expect(isAdvanceRequestWindowOpen(p, 15, 15)).toBe(false);
  });

  it('window mode opens within an inclusive day range', () => {
    const p = { mode: 'window' as const, windowStartDay: 10, windowEndDay: 20 };
    expect(isAdvanceRequestWindowOpen(p, 15, 9)).toBe(false);
    expect(isAdvanceRequestWindowOpen(p, 15, 10)).toBe(true);
    expect(isAdvanceRequestWindowOpen(p, 15, 20)).toBe(true);
    expect(isAdvanceRequestWindowOpen(p, 15, 21)).toBe(false);
  });

  it('window mode handles a wrap-around range (end < start, e.g. 28 -> 3)', () => {
    const p = { mode: 'window' as const, windowStartDay: 28, windowEndDay: 3 };
    expect(isAdvanceRequestWindowOpen(p, 15, 28)).toBe(true);
    expect(isAdvanceRequestWindowOpen(p, 15, 2)).toBe(true);
    expect(isAdvanceRequestWindowOpen(p, 15, 15)).toBe(false);
  });
});
