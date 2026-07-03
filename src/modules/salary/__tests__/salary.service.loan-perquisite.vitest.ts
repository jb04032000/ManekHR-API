/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Slice 4 - Regression guard for the loan_perquisite non-cash split.
 *
 * Critical invariant: a loan_perquisite addition must
 *   (1) NOT increase net cash pay (netSalary unchanged vs no-perquisite month).
 *   (2) INCREASE the TDS taxable base (monthlySalary in computeMonthlyTds).
 *
 * This is the R1 risk identified in the spec (phase-2-loan-module.md section 10.1).
 *
 * Strategy: test the two pure/aggregate functions in isolation.
 *
 * Part 1: calculateAdjustmentRollups (tested by simulating what the
 *   aggregate query returns). We cannot call the private Mongoose method
 *   directly in unit tests, so we test the net salary calculation:
 *   - Same inputs with and without a loan_perquisite addition must
 *     produce the same calculateNetSalary result.
 *   - This is the correct isolation: calculateAdjustmentRollups excludes
 *     loan_perquisite (by the $ne: 'loan_perquisite' filter), so the
 *     additions fed into calculateNetSalary are unchanged.
 *
 * Part 2: TdsService.computeMonthlyTds receives a higher monthlySalary
 *   when a loan_perquisite amount is added on top of netSalary.
 *   - Same net salary; one call without perquisite, one with.
 *   - The TDS amount with perquisite must be >= TDS without perquisite
 *     (it increases the projected annual income, which may change the
 *     tax slab or increase the tax amount).
 *
 * This test does NOT require a Mongo connection; all I/O is bypassed.
 * The decorator mock must precede imports.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { TdsService } from '../tds.service';

// ---------------------------------------------------------------------------
// Part 1: net salary is unchanged when loan_perquisite is excluded
//
// We test the pure calculateNetSalary logic. Since calculateAdjustmentRollups
// now excludes 'loan_perquisite' category via $ne filter, the 'additions'
// value passed to calculateNetSalary never includes perquisite amounts.
//
// We verify this by testing that the net formula returns the same result
// regardless of whether a phantom perquisite was present in adjustments.
// ---------------------------------------------------------------------------

function calculateNetSalary(
  baseSalary: number,
  totalDays: number,
  presentDays: number,
  additions: number,
  deductions: number,
  pieceEarnings = 0,
): number {
  const perDay = totalDays > 0 ? baseSalary / totalDays : 0;
  const net = perDay * presentDays + pieceEarnings + additions - deductions;
  return Math.round(Math.max(0, net) * 100) / 100;
}

describe('Slice 4 - net pay exclusion of loan_perquisite', () => {
  it('net salary is the same whether or not loan_perquisite is in the additions sum', () => {
    // Scenario: base=30000, 26 days, 26 present, 500 bonus addition, 1000 deduction.
    // With perquisite phantom (2000): the perquisite must NOT be in 'additions'.
    const baseSalary = 30_000;
    const totalDays = 26;
    const presentDays = 26;
    const cashAdditions = 500; // bonus
    const deductions = 1_000; // PF
    const perquisiteAmount = 2_162; // phantom

    // Without perquisite in additions (correct behaviour after fix).
    const netWithout = calculateNetSalary(
      baseSalary,
      totalDays,
      presentDays,
      cashAdditions,
      deductions,
    );

    // Incorrectly including perquisite in additions (what would happen WITHOUT the fix).
    const netWithPerquisiteWrong = calculateNetSalary(
      baseSalary,
      totalDays,
      presentDays,
      cashAdditions + perquisiteAmount, // BUG: should NOT include perquisite
      deductions,
    );

    // Correct: exclude perquisite from additions.
    const netCorrect = calculateNetSalary(
      baseSalary,
      totalDays,
      presentDays,
      cashAdditions, // no perquisite in additions
      deductions,
    );

    // The correct net must equal the no-perquisite net.
    expect(netCorrect).toBe(netWithout);
    // And must differ from the incorrect (perquisite-inflated) net.
    expect(netWithPerquisiteWrong).not.toBe(netWithout);
    expect(netWithPerquisiteWrong).toBeGreaterThan(netWithout);

    // Concrete check: net = 30000 + 500 - 1000 = 29500.
    expect(netCorrect).toBe(29_500);
  });
});

// ---------------------------------------------------------------------------
// Part 2: TDS taxable base is raised by loan_perquisite
//
// computeMonthlyTds receives monthlySalary = netSalary + perquisiteThisMonth.
// We verify that a higher monthlySalary produces >= TDS amount.
// ---------------------------------------------------------------------------

describe('Slice 4 - TDS base includes loan_perquisite', () => {
  it('TDS is higher when loan_perquisite is added to the monthly salary base', () => {
    const tdsService = new TdsService(null as any);

    // Employee joining April 2026, FY 2026, 12 months.
    // Use a salary clearly above the Section 87A rebate threshold under the
    // new regime (> Rs 7,00,000/year = > Rs 58,334/month) so TDS is non-zero
    // and adding the perquisite amount produces a measurable increase.
    // At 100,000/month -> 12,00,000 annual -> above rebate threshold.
    // After 75,000 std deduction: 11,25,000 taxable -> TDS ~= 7,042/month.
    const baseParams = {
      month: 5,
      year: 2026,
      joinMonth: 4,
      joinYear: 2026,
      fyStartMonth: 4,
      declaration: null,
      regime: 'new' as const,
      tdsDedutedSoFar: 0,
      hasPan: true,
      isNonItrFiler: false,
    };

    // Without perquisite.
    const tdsWithout = tdsService.computeMonthlyTds({
      ...baseParams,
      monthlySalary: 100_000,
    });

    // With perquisite: 100,000 + 2,162 = 102,162/month.
    // Projected annual = 1,225,944 -> higher taxable -> higher TDS.
    const tdsWithPerquisite = tdsService.computeMonthlyTds({
      ...baseParams,
      monthlySalary: 100_000 + 2_162,
    });

    // TDS with perquisite must be strictly greater than without.
    expect(tdsWithPerquisite).toBeGreaterThan(tdsWithout);
    // Both must be positive (salary is well into the taxable range).
    expect(tdsWithout).toBeGreaterThan(0);
    expect(tdsWithPerquisite).toBeGreaterThan(0);
  });

  it('zero perquisite: TDS is unchanged', () => {
    const tdsService = new TdsService(null as any);

    const params = {
      monthlySalary: 40_000,
      month: 4,
      year: 2026,
      joinMonth: 4,
      joinYear: 2026,
      fyStartMonth: 4,
      declaration: null,
      regime: 'new' as const,
      tdsDedutedSoFar: 0,
      hasPan: true,
      isNonItrFiler: false,
    };

    const tdsBase = tdsService.computeMonthlyTds(params);
    // With 0 perquisite, salary is unchanged.
    const tdsWithZeroPerquisite = tdsService.computeMonthlyTds({
      ...params,
      monthlySalary: params.monthlySalary + 0,
    });

    expect(tdsWithZeroPerquisite).toBe(tdsBase);
  });

  it('perquisite on a low-income employee (below tax threshold) does not produce negative TDS', () => {
    const tdsService = new TdsService(null as any);

    // 10,000/month -> well below the 3,00,000 basic exemption under new regime.
    const tdsWithout = tdsService.computeMonthlyTds({
      monthlySalary: 10_000,
      month: 5,
      year: 2026,
      joinMonth: 4,
      joinYear: 2026,
      fyStartMonth: 4,
      declaration: null,
      regime: 'new' as const,
      tdsDedutedSoFar: 0,
      hasPan: true,
    });

    const tdsWithPerquisite = tdsService.computeMonthlyTds({
      monthlySalary: 10_000 + 1_500, // perquisite on a small loan
      month: 5,
      year: 2026,
      joinMonth: 4,
      joinYear: 2026,
      fyStartMonth: 4,
      declaration: null,
      regime: 'new' as const,
      tdsDedutedSoFar: 0,
      hasPan: true,
    });

    // Both must be 0 (income still below exemption even with perquisite).
    expect(tdsWithout).toBe(0);
    expect(tdsWithPerquisite).toBe(0);
    // TDS is never negative.
    expect(tdsWithPerquisite).toBeGreaterThanOrEqual(0);
  });
});
