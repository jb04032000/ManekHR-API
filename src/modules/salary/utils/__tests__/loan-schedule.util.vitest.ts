/**
 * Tests for loan-schedule.util.ts
 *
 * Critical correctness assertions for each schedule type:
 *   - Exact EMI computation
 *   - Principal / interest split per installment
 *   - sum(principalPart) === principal  (paise-exact - the key invariant)
 *   - sum(interestPart) === totalInterest (paise-exact)
 *   - Last installment absorbs rounding remainder
 *   - balanceAfter reaches 0 at the end
 */

import { describe, it, expect } from 'vitest';
import {
  buildZeroRateSchedule,
  buildFlatRateSchedule,
  buildReducingBalanceSchedule,
  computeMonthlyPerquisite,
} from '../loan-schedule.util';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sumPrincipal(rows: Array<{ principalPart: number }>): number {
  return Math.round(rows.reduce((s, r) => s + r.principalPart, 0) * 100) / 100;
}

function sumInterest(rows: Array<{ interestPart: number }>): number {
  return Math.round(rows.reduce((s, r) => r.interestPart + s, 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Zero-rate schedule
// ---------------------------------------------------------------------------

describe('buildZeroRateSchedule', () => {
  it('splits 60000 over 6 months evenly, each EMI = 10000', () => {
    const result = buildZeroRateSchedule(60000, 6, 6, 2026);
    expect(result.installments).toHaveLength(6);
    expect(result.installments.every((r) => r.interestPart === 0)).toBe(true);
    expect(result.installments.every((r) => r.principalPart === 10000)).toBe(true);
    expect(result.totalInterest).toBe(0);
    expect(result.totalRepayable).toBe(60000);
  });

  it('sum(principalPart) === principal (paise-exact, non-divisible amount)', () => {
    const result = buildZeroRateSchedule(10000, 3, 1, 2026);
    expect(sumPrincipal(result.installments)).toBe(10000);
  });

  it('sum(principalPart) === principal for a larger odd amount', () => {
    const result = buildZeroRateSchedule(99999, 7, 3, 2026);
    expect(sumPrincipal(result.installments)).toBe(99999);
  });

  it('last installment absorbs the rounding remainder', () => {
    const result = buildZeroRateSchedule(100, 3, 1, 2026);
    // 100 / 3 = 33.33... first two = 33.33, last = 33.34
    const parts = result.installments.map((r) => r.principalPart);
    expect(parts[0]).toBe(33.33);
    expect(parts[1]).toBe(33.33);
    expect(parts[2]).toBe(33.34);
    expect(sumPrincipal(result.installments)).toBe(100);
  });

  it('month/year sequence wraps correctly across Dec->Jan', () => {
    const result = buildZeroRateSchedule(12000, 3, 11, 2026);
    expect(result.installments[0]).toMatchObject({ month: 11, year: 2026 });
    expect(result.installments[1]).toMatchObject({ month: 12, year: 2026 });
    expect(result.installments[2]).toMatchObject({ month: 1, year: 2027 });
  });

  it('single installment returns principal as one EMI', () => {
    const result = buildZeroRateSchedule(50000, 1, 4, 2026);
    expect(result.installments).toHaveLength(1);
    expect(result.installments[0].principalPart).toBe(50000);
    expect(result.installments[0].balanceAfter).toBe(0);
  });

  it('throws for non-positive principal', () => {
    expect(() => buildZeroRateSchedule(0, 6, 1, 2026)).toThrow();
    expect(() => buildZeroRateSchedule(-100, 6, 1, 2026)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Flat-rate schedule
// ---------------------------------------------------------------------------

describe('buildFlatRateSchedule', () => {
  // Example: principal=120000, rate=12%, tenor=12 months
  // totalInterest = 120000 * 12/100 * 12/12 = 14400
  // EMI = (120000 + 14400) / 12 = 11200
  it('computes correct total interest and EMI for standard flat-rate loan', () => {
    const result = buildFlatRateSchedule(120000, 12, 12, 4, 2026);
    expect(result.totalInterest).toBe(14400);
    expect(result.totalRepayable).toBe(134400);
    expect(result.emiAmount).toBe(11200);
    expect(result.installments).toHaveLength(12);
  });

  it('sum(principalPart) === principal (paise-exact)', () => {
    const result = buildFlatRateSchedule(120000, 12, 12, 4, 2026);
    expect(sumPrincipal(result.installments)).toBe(120000);
  });

  it('sum(interestPart) === totalInterest (paise-exact)', () => {
    const result = buildFlatRateSchedule(120000, 12, 12, 4, 2026);
    expect(sumInterest(result.installments)).toBe(result.totalInterest);
  });

  it('handles non-divisible interest with last-installment rounding', () => {
    // principal=100000, rate=10%, tenor=7 months
    // totalInterest = 100000 * 10/100 * 7/12 = 5833.33
    const result = buildFlatRateSchedule(100000, 10, 7, 1, 2026);
    expect(sumPrincipal(result.installments)).toBe(100000);
    expect(sumInterest(result.installments)).toBe(result.totalInterest);
  });

  it('sum(principalPart) === principal for non-divisible principal', () => {
    const result = buildFlatRateSchedule(99999, 8, 7, 1, 2026);
    expect(sumPrincipal(result.installments)).toBe(99999);
  });

  it('zero rate produces zero interest (same as zero-rate schedule)', () => {
    const flat = buildFlatRateSchedule(60000, 0, 6, 1, 2026);
    expect(flat.totalInterest).toBe(0);
    expect(flat.installments.every((r) => r.interestPart === 0)).toBe(true);
    expect(sumPrincipal(flat.installments)).toBe(60000);
  });

  it('all interestPart values are >= 0', () => {
    const result = buildFlatRateSchedule(50000, 15, 12, 6, 2026);
    expect(result.installments.every((r) => r.interestPart >= 0)).toBe(true);
  });

  it('throws for non-positive principal', () => {
    expect(() => buildFlatRateSchedule(-1, 12, 12, 1, 2026)).toThrow();
    expect(() => buildFlatRateSchedule(0, 12, 12, 1, 2026)).toThrow();
  });

  it('throws for negative rate', () => {
    expect(() => buildFlatRateSchedule(100000, -1, 12, 1, 2026)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Reducing-balance schedule
// ---------------------------------------------------------------------------

describe('buildReducingBalanceSchedule', () => {
  // Standard case: 100000 at 12% for 12 months
  // r = 12/12/100 = 0.01
  // EMI = 100000 * 0.01 * 1.01^12 / (1.01^12 - 1) = approx 8884.88
  it('EMI is approximately correct for a standard loan', () => {
    const result = buildReducingBalanceSchedule(100000, 12, 12, 4, 2026);
    // Expected EMI ~ 8884.88 (standard annuity)
    expect(result.emiAmount).toBeCloseTo(8884.88, 1);
  });

  it('sum(principalPart) === principal exactly (paise-exact)', () => {
    const result = buildReducingBalanceSchedule(100000, 12, 12, 4, 2026);
    expect(sumPrincipal(result.installments)).toBe(100000);
  });

  it('sum(principalPart) === principal for non-divisible principal', () => {
    const result = buildReducingBalanceSchedule(99999, 12, 12, 1, 2026);
    expect(sumPrincipal(result.installments)).toBe(99999);
  });

  it('sum(principalPart) === principal for 24-month tenor', () => {
    const result = buildReducingBalanceSchedule(250000, 10, 24, 6, 2026);
    expect(sumPrincipal(result.installments)).toBe(250000);
  });

  it('sum(principalPart) === principal for 60-month tenor (5 years)', () => {
    const result = buildReducingBalanceSchedule(1000000, 8.5, 60, 1, 2026);
    expect(sumPrincipal(result.installments)).toBe(1000000);
  });

  it('balanceAfter reaches 0 (or near 0) at the last installment', () => {
    const result = buildReducingBalanceSchedule(100000, 12, 12, 4, 2026);
    const last = result.installments[result.installments.length - 1];
    expect(last.balanceAfter).toBe(0);
  });

  it('each installment: interestPart >= 0 and principalPart > 0', () => {
    const result = buildReducingBalanceSchedule(100000, 10, 12, 1, 2026);
    for (const row of result.installments) {
      expect(row.interestPart).toBeGreaterThanOrEqual(0);
      expect(row.principalPart).toBeGreaterThan(0);
    }
  });

  it('interestPart decreases monotonically for constant-rate loan', () => {
    const result = buildReducingBalanceSchedule(100000, 12, 12, 1, 2026);
    for (let i = 1; i < result.installments.length - 1; i++) {
      expect(result.installments[i].interestPart).toBeLessThanOrEqual(
        result.installments[i - 1].interestPart,
      );
    }
  });

  it('principalPart increases monotonically for constant-rate loan', () => {
    const result = buildReducingBalanceSchedule(100000, 12, 12, 1, 2026);
    for (let i = 1; i < result.installments.length - 1; i++) {
      expect(result.installments[i].principalPart).toBeGreaterThanOrEqual(
        result.installments[i - 1].principalPart,
      );
    }
  });

  it('last installment absorbs rounding (may differ from standard EMI)', () => {
    const result = buildReducingBalanceSchedule(100000, 12, 12, 4, 2026);
    const last = result.installments[result.installments.length - 1];
    // Last EMI may differ slightly from the computed emi due to rounding absorption
    const secondLast = result.installments[result.installments.length - 2];
    // The difference from standard EMI should be at most a few paise
    expect(Math.abs(last.emiAmount - secondLast.emiAmount)).toBeLessThan(1);
  });

  it('zero annualRate degenerates to equal principal split (zero-rate path)', () => {
    const result = buildReducingBalanceSchedule(60000, 0, 6, 1, 2026);
    expect(result.totalInterest).toBe(0);
    expect(result.installments.every((r) => r.interestPart === 0)).toBe(true);
    expect(sumPrincipal(result.installments)).toBe(60000);
  });

  it('month/year sequence wraps correctly across year boundary', () => {
    const result = buildReducingBalanceSchedule(100000, 12, 3, 11, 2026);
    expect(result.installments[0]).toMatchObject({ month: 11, year: 2026 });
    expect(result.installments[1]).toMatchObject({ month: 12, year: 2026 });
    expect(result.installments[2]).toMatchObject({ month: 1, year: 2027 });
  });

  it('throws for non-positive principal', () => {
    expect(() => buildReducingBalanceSchedule(0, 12, 12, 1, 2026)).toThrow();
    expect(() => buildReducingBalanceSchedule(-1, 12, 12, 1, 2026)).toThrow();
  });

  it('throws for negative rate', () => {
    expect(() => buildReducingBalanceSchedule(100000, -1, 12, 1, 2026)).toThrow();
  });

  it('single installment loan: full principal + 1 month interest', () => {
    const result = buildReducingBalanceSchedule(100000, 12, 1, 6, 2026);
    expect(result.installments).toHaveLength(1);
    expect(result.installments[0].principalPart).toBe(100000);
    expect(result.installments[0].interestPart).toBe(round2(100000 * 0.01));
    expect(result.installments[0].balanceAfter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeMonthlyPerquisite
// ---------------------------------------------------------------------------

describe('computeMonthlyPerquisite', () => {
  it('returns correct perquisite for concessional loan', () => {
    // outstanding = 100000, benchmark = 8.65%, actual = 0%
    // perk = 100000 * (8.65 - 0) / 1200 = 720.83
    const perk = computeMonthlyPerquisite(100000, 8.65, 0);
    expect(perk).toBeCloseTo(720.83, 1);
  });

  it('returns 0 when actualRate >= sbiBenchmarkRate', () => {
    expect(computeMonthlyPerquisite(100000, 8.65, 8.65)).toBe(0);
    expect(computeMonthlyPerquisite(100000, 8.65, 10)).toBe(0);
  });

  it('returns 0 when outstandingBalance <= 0', () => {
    expect(computeMonthlyPerquisite(0, 8.65, 0)).toBe(0);
    expect(computeMonthlyPerquisite(-100, 8.65, 0)).toBe(0);
  });

  it('partial concessional: actual < benchmark but > 0', () => {
    // outstanding = 200000, benchmark = 8.65%, actual = 4%
    // perk = 200000 * (8.65 - 4) / 1200 = 200000 * 4.65 / 1200 = 775
    const perk = computeMonthlyPerquisite(200000, 8.65, 4);
    expect(perk).toBeCloseTo(775, 1);
  });
});

// ---------------------------------------------------------------------------
// Helper used in tests above
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
