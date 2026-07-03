import { describe, it, expect } from 'vitest';
import { LoanScheduleService } from './loan-schedule.service';

/**
 * Unit tests for LoanScheduleService — pure EMI math.
 *
 * All tests are stateless: no DB, no NestJS DI, no decorators.
 * Runs via: npx vitest run src/modules/finance/loan-accounts/loan-schedule.spec.ts
 */
describe('LoanScheduleService', () => {
  const svc = new LoanScheduleService();

  // ─── Test 1: Standard 36-month at 12% p.a. ────────────────────────────────

  it('Standard 36-month at 12% — EMI ≈ ₹33,214 (3321431 paise for ₹10L)', () => {
    const rows = svc.computeSchedule({
      sanctionedAmountPaise: 1_000_000_00,  // ₹10,00,000 = 1 lakh paise = 1 crore paise? No: ₹10L = 10,00,000 rupees = 10,00,000 × 100 paise = 100,000,000 paise but let's use ₹10,00,000 = 1000000 rupees × 100 = 100000000 paise... actually ₹10L=₹10,00,000 = 100000000 paise
      // Wait: 1 rupee = 100 paise. ₹10,00,000 = 10 lakh rupees = 100,000,000 paise
      // The plan says ₹10L = EMI ₹33,214.31. Let's use ₹10L exactly.
      // ₹10,00,000 = 10,00,000 * 100 paise = 100,000,000 paise
      // Actually 1_000_000_00 = 100,000,000 paise = ₹10,00,000 ✓
      interestRateAnnual: 12,
      tenureMonths: 36,
      repaymentStartDate: new Date('2025-04-01'),
    });

    expect(rows).toHaveLength(36);
    // EMI for ₹10L at 12% 36 months: ~₹33,214. In paise: ~3,321,400 ± 5000
    expect(rows[0].emiAmountPaise).toBeGreaterThan(3_310_000);
    expect(rows[0].emiAmountPaise).toBeLessThan(3_330_000);
  });

  // ─── Test 2: Sum of principals === sanctioned amount exactly ───────────────

  it('Sum of principals equals sanctioned amount exactly (no rounding drift)', () => {
    const sanctioned = 1_000_000_00;  // ₹10,00,000
    const rows = svc.computeSchedule({
      sanctionedAmountPaise: sanctioned,
      interestRateAnnual: 12,
      tenureMonths: 36,
      repaymentStartDate: new Date('2025-04-01'),
    });
    const sum = rows.reduce((s, r) => s + r.principalComponentPaise, 0);
    expect(sum).toBe(sanctioned);
  });

  // ─── Test 3: Zero tenure throws ───────────────────────────────────────────

  it('Zero tenure throws an error', () => {
    expect(() =>
      svc.computeSchedule({
        sanctionedAmountPaise: 100000,
        interestRateAnnual: 12,
        tenureMonths: 0,
        repaymentStartDate: new Date(),
      }),
    ).toThrow();
  });

  // ─── Test 4: Zero interest rate — equal principal, no interest ────────────

  it('Zero rate yields equal principal each month with zero interest', () => {
    const rows = svc.computeSchedule({
      sanctionedAmountPaise: 1200_00,  // ₹1,200 = 120,000 paise — divisible by 12
      interestRateAnnual: 0,
      tenureMonths: 12,
      repaymentStartDate: new Date('2025-04-01'),
    });
    expect(rows[0].interestComponentPaise).toBe(0);
    expect(rows[0].principalComponentPaise).toBe(100_00);  // 10,000 paise = ₹100
    expect(rows[11].closingPrincipalPaise).toBe(0);
  });

  // ─── Test 5: Last month closing principal === 0 ────────────────────────────

  it('Last-month closing principal is exactly 0 (drift absorbed in last row)', () => {
    const rows = svc.computeSchedule({
      sanctionedAmountPaise: 999_999_99,  // Awkward number to maximise rounding drift
      interestRateAnnual: 11.75,
      tenureMonths: 60,
      repaymentStartDate: new Date('2025-04-01'),
    });
    expect(rows[rows.length - 1].closingPrincipalPaise).toBe(0);
  });

  // ─── Test 6: Month strings increment correctly across year boundary ─────────

  it('Month strings increment YYYY-MM correctly across year boundary', () => {
    const rows = svc.computeSchedule({
      sanctionedAmountPaise: 100000,
      interestRateAnnual: 10,
      tenureMonths: 14,
      repaymentStartDate: new Date('2025-12-01'),
    });
    expect(rows[0].month).toBe('2025-12');
    expect(rows[1].month).toBe('2026-01');
    expect(rows[13].month).toBe('2027-01');
  });

  // ─── Test 7: Prepayment recomputation shortens tenure ─────────────────────

  it('recomputeAfterPrepayment returns fewer rows when prepayment reduces principal', () => {
    // Original: ₹12,000 at 0% for 12 months → EMI = ₹1,000/month
    const originalRows = svc.computeSchedule({
      sanctionedAmountPaise: 12000_00,
      interestRateAnnual: 0,
      tenureMonths: 12,
      repaymentStartDate: new Date('2025-04-01'),
    });
    const originalEmi = originalRows[0].emiAmountPaise;

    // After 3 EMIs paid, remaining principal = ₹9,000. Prepay ₹3,000 → remaining = ₹6,000.
    const remainingAfterPrepay = 6000_00;  // 6000 rupees = 600000 paise
    const newRows = svc.recomputeAfterPrepayment(
      remainingAfterPrepay,
      originalEmi,
      0,                 // zero rate
      '2025-08',        // next month after prepayment
    );

    // 6000 rupees / 1000 EMI = 6 remaining months (shorter than original 9 remaining)
    expect(newRows.length).toBeLessThan(9);
    expect(newRows.length).toBeGreaterThan(0);
    // Sum of principals must equal remainingAfterPrepay
    const sum = newRows.reduce((s, r) => s + r.principalComponentPaise, 0);
    expect(sum).toBe(remainingAfterPrepay);
  });

  // ─── Test 8: Negative tenure throws ──────────────────────────────────────

  it('Negative tenure throws an error', () => {
    expect(() =>
      svc.computeSchedule({
        sanctionedAmountPaise: 100000,
        interestRateAnnual: 10,
        tenureMonths: -1,
        repaymentStartDate: new Date(),
      }),
    ).toThrow();
  });
});
