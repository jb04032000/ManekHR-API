import { describe, it, expect } from 'vitest';
import {
  roundToHalf,
  prorateUpfrontCredit,
  periodMonths,
  periodsForYear,
  isPeriodAccruable,
  proratePeriodCredit,
} from '../leave-accrual.util';

describe('leave-accrual.util', () => {
  describe('roundToHalf', () => {
    it('rounds to the nearest half-day', () => {
      expect(roundToHalf(1.24)).toBe(1);
      expect(roundToHalf(1.25)).toBe(1.5);
      expect(roundToHalf(1.74)).toBe(1.5);
      expect(roundToHalf(1.75)).toBe(2);
    });
  });

  describe('prorateUpfrontCredit', () => {
    it('gives the full quantity when there is no join date', () => {
      expect(prorateUpfrontCredit(7, null, 2026)).toBe(7);
    });

    it('gives the full quantity when joined before the leave year', () => {
      expect(prorateUpfrontCredit(7, new Date(Date.UTC(2024, 5, 1)), 2026)).toBe(7);
    });

    it('gives 0 when joined after the leave year', () => {
      expect(prorateUpfrontCredit(7, new Date(Date.UTC(2027, 0, 1)), 2026)).toBe(0);
    });

    it('prorates by remaining months, join month inclusive', () => {
      // Joined April → Apr–Dec = 9 months → 12 × 9/12 = 9.
      expect(prorateUpfrontCredit(12, new Date(Date.UTC(2026, 3, 15)), 2026)).toBe(9);
      // Joined January → full 12 months.
      expect(prorateUpfrontCredit(12, new Date(Date.UTC(2026, 0, 10)), 2026)).toBe(12);
      // Joined December → 1 month → 12 × 1/12 = 1.
      expect(prorateUpfrontCredit(12, new Date(Date.UTC(2026, 11, 5)), 2026)).toBe(1);
    });

    it('rounds the prorated result to a half-day', () => {
      // 7 × 9/12 = 5.25 → 5.5.
      expect(prorateUpfrontCredit(7, new Date(Date.UTC(2026, 3, 1)), 2026)).toBe(5.5);
    });
  });

  describe('periodMonths', () => {
    it('maps frequency to its month span', () => {
      expect(periodMonths('monthly')).toBe(1);
      expect(periodMonths('quarterly')).toBe(3);
      expect(periodMonths('annual')).toBe(12);
    });
  });

  describe('periodsForYear', () => {
    it('produces 12 monthly periods with UTC boundaries', () => {
      const p = periodsForYear(2026, 'monthly');
      expect(p).toHaveLength(12);
      expect(p[0].key).toBe('2026-01');
      expect(p[0].start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(p[0].end.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(p[11].key).toBe('2026-12');
    });

    it('produces 4 quarterly periods', () => {
      const keys = periodsForYear(2026, 'quarterly').map((x) => x.key);
      expect(keys).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
    });

    it('produces 1 annual period', () => {
      const p = periodsForYear(2026, 'annual');
      expect(p).toHaveLength(1);
      expect(p[0].key).toBe('2026');
    });
  });

  describe('isPeriodAccruable', () => {
    const jan = periodsForYear(2026, 'monthly')[0];

    it('is false before the period has fully elapsed', () => {
      expect(
        isPeriodAccruable(jan, new Date(Date.UTC(2026, 0, 20)), new Date(Date.UTC(2026, 0, 1))),
      ).toBe(false);
    });

    it('is true once elapsed and the member was active in it', () => {
      expect(
        isPeriodAccruable(jan, new Date(Date.UTC(2026, 1, 2)), new Date(Date.UTC(2026, 0, 1))),
      ).toBe(true);
    });

    it('is false when the member joined after the period', () => {
      expect(
        isPeriodAccruable(jan, new Date(Date.UTC(2026, 5, 1)), new Date(Date.UTC(2026, 2, 1))),
      ).toBe(false);
    });
  });

  describe('proratePeriodCredit', () => {
    const jan = periodsForYear(2026, 'monthly')[0]; // 31 days

    it('gives the full rate when active for the whole period', () => {
      expect(proratePeriodCredit(1.5, jan, new Date(Date.UTC(2026, 0, 1)))).toBe(1.5);
    });

    it('gives the full rate when accrual started before the period', () => {
      expect(proratePeriodCredit(1.5, jan, new Date(Date.UTC(2025, 11, 1)))).toBe(1.5);
    });

    it('prorates + rounds to a half-day for a mid-period start', () => {
      // accrualStart Jan 17 → active 15/31 of the month → 1.5 × 0.484 ≈ 0.73 → 0.5.
      expect(proratePeriodCredit(1.5, jan, new Date(Date.UTC(2026, 0, 17)))).toBe(0.5);
    });
  });
});
