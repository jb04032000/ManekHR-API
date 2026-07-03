/**
 * bonus.util.vitest.ts - Pure unit tests for bonus computation utilities.
 *
 * Tests:
 *   A. isStatutoryBonusEligible
 *      A1. eligible member (within ceiling, enough months)
 *      A2. ineligible: wage above ceiling
 *      A3. ineligible: zero months worked
 *      A4. ineligible: new establishment
 *
 *   B. deriveBonusCalcWage
 *      B1. actual wage > floor -> use floor
 *      B2. actual wage < floor -> use actual wage
 *      B3. minimumWage higher than statutory floor -> use minimumWage
 *      B4. minimumWage null -> falls back to statutory floor
 *
 *   C. deriveApplicableBonusPercent
 *      C1. allocableSurplus=0 -> minPercent returned
 *      C2. allocableSurplus within range -> clamped correctly
 *      C3. allocableSurplus > maxPercent -> capped at maxPercent
 *      C4. allocableSurplus < minPercent -> raised to minPercent
 *
 *   D. computeStatutoryBonusAmount
 *      D1. full year (monthsWorked=12)
 *      D2. proportionate (mid-year joiner, 6 months)
 *      D3. one month worked
 *      D4. rounding: result is integer
 *
 *   E. countMonthsWorked
 *      E1. all 12 months present -> returns 12
 *      E2. mid-year joiner (Apr-Sep 2025, 6 months)
 *      E3. absent months are not counted
 *      E4. months outside FY are ignored
 *      E5. zero months present -> returns 0
 *
 *   F. buildFyMonthSet
 *      F1. FY 2025-26 contains Apr 2025 - Mar 2026
 *      F2. FY 2024-25 contains Apr 2024 - Mar 2025
 */

import { describe, it, expect } from 'vitest';
import {
  isStatutoryBonusEligible,
  deriveBonusCalcWage,
  deriveApplicableBonusPercent,
  computeStatutoryBonusAmount,
  countMonthsWorked,
  buildFyMonthSet,
} from '../bonus.util';

// ---------------------------------------------------------------------------
// A. isStatutoryBonusEligible
// ---------------------------------------------------------------------------

describe('isStatutoryBonusEligible', () => {
  it('A1: eligible when wage <= ceiling and months >= 1', () => {
    const result = isStatutoryBonusEligible({
      lastMonthlyWage: 18000,
      eligibilityWageCeiling: 21000,
      monthsWorked: 12,
    });
    expect(result.eligible).toBe(true);
  });

  it('A2: ineligible when wage exceeds ceiling', () => {
    const result = isStatutoryBonusEligible({
      lastMonthlyWage: 25000,
      eligibilityWageCeiling: 21000,
      monthsWorked: 12,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('exceed');
  });

  it('A2b: ineligible when wage exactly at ceiling boundary is eligible', () => {
    // Exactly at ceiling is still eligible (<=)
    const result = isStatutoryBonusEligible({
      lastMonthlyWage: 21000,
      eligibilityWageCeiling: 21000,
      monthsWorked: 12,
    });
    expect(result.eligible).toBe(true);
  });

  it('A3: ineligible when monthsWorked is 0', () => {
    const result = isStatutoryBonusEligible({
      lastMonthlyWage: 15000,
      eligibilityWageCeiling: 21000,
      monthsWorked: 0,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('30 days');
  });

  it('A4: ineligible when newEstablishment=true', () => {
    const result = isStatutoryBonusEligible({
      lastMonthlyWage: 15000,
      eligibilityWageCeiling: 21000,
      monthsWorked: 12,
      newEstablishment: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('New establishment');
  });
});

// ---------------------------------------------------------------------------
// B. deriveBonusCalcWage
// ---------------------------------------------------------------------------

describe('deriveBonusCalcWage', () => {
  it('B1: actual wage above floor -> returns floor (7000)', () => {
    const wage = deriveBonusCalcWage({
      actualMonthlyWage: 20000,
      calculationWageFloor: 7000,
      minimumWageMonthly: null,
    });
    expect(wage).toBe(7000);
  });

  it('B2: actual wage below floor -> returns actual wage', () => {
    const wage = deriveBonusCalcWage({
      actualMonthlyWage: 5000,
      calculationWageFloor: 7000,
      minimumWageMonthly: null,
    });
    expect(wage).toBe(5000);
  });

  it('B3: minimumWage higher than statutory floor -> uses minimumWage', () => {
    const wage = deriveBonusCalcWage({
      actualMonthlyWage: 20000,
      calculationWageFloor: 7000,
      minimumWageMonthly: 9000,
    });
    // floor = max(7000, 9000) = 9000; actual > 9000 -> calcWage = 9000
    expect(wage).toBe(9000);
  });

  it('B3b: actual wage below minimumWage floor -> returns actual wage', () => {
    const wage = deriveBonusCalcWage({
      actualMonthlyWage: 8000,
      calculationWageFloor: 7000,
      minimumWageMonthly: 9000,
    });
    // floor = max(7000, 9000) = 9000; actual < 9000 -> calcWage = 8000
    expect(wage).toBe(8000);
  });

  it('B4: minimumWage null -> falls back to statutory floor', () => {
    const wage = deriveBonusCalcWage({
      actualMonthlyWage: 20000,
      calculationWageFloor: 7000,
      minimumWageMonthly: null,
    });
    expect(wage).toBe(7000);
  });
});

// ---------------------------------------------------------------------------
// C. deriveApplicableBonusPercent
// ---------------------------------------------------------------------------

describe('deriveApplicableBonusPercent', () => {
  it('C1: allocableSurplus=0 -> minPercent (8.33)', () => {
    const pct = deriveApplicableBonusPercent({
      allocableSurplusPercent: 0,
      minPercent: 8.33,
      maxPercent: 20,
    });
    expect(pct).toBe(8.33);
  });

  it('C2: allocableSurplus within range (15) -> returns 15', () => {
    const pct = deriveApplicableBonusPercent({
      allocableSurplusPercent: 15,
      minPercent: 8.33,
      maxPercent: 20,
    });
    expect(pct).toBe(15);
  });

  it('C3: allocableSurplus above maxPercent -> capped at 20', () => {
    const pct = deriveApplicableBonusPercent({
      allocableSurplusPercent: 25,
      minPercent: 8.33,
      maxPercent: 20,
    });
    expect(pct).toBe(20);
  });

  it('C4: allocableSurplus below minPercent (5) -> raised to 8.33', () => {
    const pct = deriveApplicableBonusPercent({
      allocableSurplusPercent: 5,
      minPercent: 8.33,
      maxPercent: 20,
    });
    expect(pct).toBe(8.33);
  });

  it('C5: negative allocableSurplus -> same as 0 -> returns minPercent', () => {
    const pct = deriveApplicableBonusPercent({
      allocableSurplusPercent: -1,
      minPercent: 8.33,
      maxPercent: 20,
    });
    expect(pct).toBe(8.33);
  });
});

// ---------------------------------------------------------------------------
// D. computeStatutoryBonusAmount
// ---------------------------------------------------------------------------

describe('computeStatutoryBonusAmount', () => {
  it('D1: full year (monthsWorked=12), 8.33%, calcWage=7000', () => {
    // 7000 * 0.0833 * (12/12) = 583.1 -> rounds to 583
    const amount = computeStatutoryBonusAmount({
      calcWage: 7000,
      applicablePercent: 8.33,
      monthsWorked: 12,
    });
    expect(amount).toBe(583);
  });

  it('D2: proportionate (6 months worked), 8.33%, calcWage=7000', () => {
    // 7000 * 0.0833 * (6/12) = 291.55 -> rounds to 292
    const amount = computeStatutoryBonusAmount({
      calcWage: 7000,
      applicablePercent: 8.33,
      monthsWorked: 6,
    });
    expect(amount).toBe(292);
  });

  it('D3: one month worked, 8.33%, calcWage=7000', () => {
    // 7000 * 0.0833 * (1/12) = 48.59 -> rounds to 49
    const amount = computeStatutoryBonusAmount({
      calcWage: 7000,
      applicablePercent: 8.33,
      monthsWorked: 1,
    });
    expect(amount).toBe(49);
  });

  it('D4: result is always an integer', () => {
    const amount = computeStatutoryBonusAmount({
      calcWage: 7000,
      applicablePercent: 8.33,
      monthsWorked: 7,
    });
    expect(Number.isInteger(amount)).toBe(true);
  });

  it('D5: 20% (max) full year, calcWage=7000', () => {
    // 7000 * 0.20 * (12/12) = 1400
    const amount = computeStatutoryBonusAmount({
      calcWage: 7000,
      applicablePercent: 20,
      monthsWorked: 12,
    });
    expect(amount).toBe(1400);
  });
});

// ---------------------------------------------------------------------------
// E. countMonthsWorked
// ---------------------------------------------------------------------------

describe('countMonthsWorked', () => {
  it('E1: all 12 months present -> returns 12', () => {
    const rows = [];
    for (let m = 4; m <= 12; m++) {
      rows.push({ month: m, year: 2025, presentDays: 22 });
    }
    for (let m = 1; m <= 3; m++) {
      rows.push({ month: m, year: 2026, presentDays: 20 });
    }
    expect(countMonthsWorked(rows, 2025)).toBe(12);
  });

  it('E2: mid-year joiner (Apr-Sep 2025, 6 months in FY 2025-26)', () => {
    const rows = [];
    for (let m = 4; m <= 9; m++) {
      rows.push({ month: m, year: 2025, presentDays: 15 });
    }
    expect(countMonthsWorked(rows, 2025)).toBe(6);
  });

  it('E3: absent month (presentDays=0) is not counted', () => {
    const rows = [
      { month: 4, year: 2025, presentDays: 20 },
      { month: 5, year: 2025, presentDays: 0 }, // absent - not counted
      { month: 6, year: 2025, presentDays: 18 },
    ];
    expect(countMonthsWorked(rows, 2025)).toBe(2);
  });

  it('E4: months outside FY are ignored', () => {
    const rows = [
      { month: 4, year: 2025, presentDays: 20 }, // in FY 2025-26
      { month: 1, year: 2025, presentDays: 20 }, // in FY 2024-25, NOT 2025-26
      { month: 3, year: 2027, presentDays: 20 }, // in FY 2026-27, not 2025-26
    ];
    expect(countMonthsWorked(rows, 2025)).toBe(1);
  });

  it('E5: zero months present -> returns 0', () => {
    expect(countMonthsWorked([], 2025)).toBe(0);
  });

  it('E6: March of next year is included in FY 2025-26', () => {
    const rows = [{ month: 3, year: 2026, presentDays: 5 }];
    expect(countMonthsWorked(rows, 2025)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F. buildFyMonthSet
// ---------------------------------------------------------------------------

describe('buildFyMonthSet', () => {
  it('F1: FY 2025-26 contains Apr 2025 - Mar 2026', () => {
    const keys = buildFyMonthSet(2025);
    expect(keys.has('2025-4')).toBe(true);
    expect(keys.has('2025-12')).toBe(true);
    expect(keys.has('2026-1')).toBe(true);
    expect(keys.has('2026-3')).toBe(true);
    expect(keys.size).toBe(12);
  });

  it('F2: FY 2024-25 contains Apr 2024 - Mar 2025', () => {
    const keys = buildFyMonthSet(2024);
    expect(keys.has('2024-4')).toBe(true);
    expect(keys.has('2025-3')).toBe(true);
    expect(keys.has('2025-4')).toBe(false); // Apr 2025 is FY 2025-26
    expect(keys.size).toBe(12);
  });
});
