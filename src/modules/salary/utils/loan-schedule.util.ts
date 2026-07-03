/**
 * Loan amortization schedule utilities.
 *
 * Pure, zero-dependency functions for computing installment schedules for
 * the three interest types supported by EmployerLoan:
 *   - zero:             equal principal splits (delegates to advance-recovery util)
 *   - flat:             total interest = P * rate% * tenorMonths / 12,
 *                       split evenly across installments
 *   - reducing_balance: standard annuity formula; per-installment interest
 *                       computed on the outstanding principal
 *
 * All monetary values are in INR rounded to 2 decimal places (nearest paisa).
 *
 * Spec reference: phase-2-loan-module.md section 5.2
 */

import { buildInstallmentSchedule } from './advance-recovery.util';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoanInstallmentRow {
  /** 1-based index */
  index: number;
  month: number;
  year: number;
  /** principal portion of this installment */
  principalPart: number;
  /** interest portion of this installment (0 for zero-rate loans) */
  interestPart: number;
  /** principalPart + interestPart */
  emiAmount: number;
  /** outstanding principal AFTER this installment is paid */
  balanceAfter: number;
}

export interface LoanScheduleResult {
  installments: LoanInstallmentRow[];
  /** computed EMI (= installments[0].emiAmount; last may differ due to rounding) */
  emiAmount: number;
  /** sum of all interestPart values */
  totalInterest: number;
  /** principal + totalInterest */
  totalRepayable: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Round to 2 decimal places (nearest paisa). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Advance the (month, year) pair by one calendar month. */
function nextMonth(month: number, year: number): { month: number; year: number } {
  if (month === 12) {
    return { month: 1, year: year + 1 };
  }
  return { month: month + 1, year };
}

// ---------------------------------------------------------------------------
// Zero-rate schedule
// ---------------------------------------------------------------------------

/**
 * Build a zero-interest installment schedule.
 *
 * Delegates to the existing advance-recovery `buildInstallmentSchedule` for
 * the principal amounts; wraps each amount into a `LoanInstallmentRow` with
 * interestPart = 0.
 *
 * Spec: zero interest -> equal principal split, paise-exact (last installment
 * absorbs rounding). phase-2-loan-module.md section 5.2.
 */
export function buildZeroRateSchedule(
  principal: number,
  tenorMonths: number,
  startMonth: number,
  startYear: number,
): LoanScheduleResult {
  if (!(principal > 0)) throw new Error('principal must be positive');
  if (tenorMonths < 1) throw new Error('tenorMonths must be >= 1');

  const principalParts = buildInstallmentSchedule(principal, { installmentCount: tenorMonths });

  const installments: LoanInstallmentRow[] = [];
  let m = startMonth;
  let y = startYear;
  let remaining = round2(principal);

  for (let i = 0; i < principalParts.length; i++) {
    const p = round2(principalParts[i]);
    remaining = round2(remaining - p);
    installments.push({
      index: i + 1,
      month: m,
      year: y,
      principalPart: p,
      interestPart: 0,
      emiAmount: p,
      balanceAfter: remaining,
    });
    const nm = nextMonth(m, y);
    m = nm.month;
    y = nm.year;
  }

  return {
    installments,
    emiAmount: installments[0].emiAmount,
    totalInterest: 0,
    totalRepayable: round2(principal),
  };
}

// ---------------------------------------------------------------------------
// Flat-rate schedule
// ---------------------------------------------------------------------------

/**
 * Build a flat-rate installment schedule.
 *
 * Spec formula (phase-2-loan-module.md section 5.2):
 *   totalInterest = principal * annualRate/100 * tenorMonths/12
 *   EMI = (principal + totalInterest) / tenorMonths
 *
 * Each installment:
 *   principalPart = principal / tenorMonths (equal, last absorbs rounding)
 *   interestPart  = totalInterest / tenorMonths (equal, last absorbs rounding)
 *   emiAmount     = principalPart + interestPart
 *
 * Last installment absorbs any rounding so that:
 *   sum(principalPart) === principal  (paise-exact)
 *   sum(interestPart) === totalInterest (paise-exact)
 */
export function buildFlatRateSchedule(
  principal: number,
  annualRate: number,
  tenorMonths: number,
  startMonth: number,
  startYear: number,
): LoanScheduleResult {
  if (!(principal > 0)) throw new Error('principal must be positive');
  if (annualRate < 0) throw new Error('annualRate must be >= 0');
  if (tenorMonths < 1) throw new Error('tenorMonths must be >= 1');

  // Total interest on the full principal over the full tenor.
  const totalInterest = round2((principal * annualRate * tenorMonths) / (100 * 12));

  const principalParts = buildInstallmentSchedule(principal, { installmentCount: tenorMonths });
  // totalInterest may be 0 for a zero-rate flat call; guard against zero division.
  const interestParts =
    totalInterest > 0
      ? buildInstallmentSchedule(totalInterest, { installmentCount: tenorMonths })
      : Array<number>(tenorMonths).fill(0);

  const installments: LoanInstallmentRow[] = [];
  let m = startMonth;
  let y = startYear;
  let remaining = round2(principal);

  for (let i = 0; i < tenorMonths; i++) {
    const p = round2(principalParts[i]);
    const interest = round2(interestParts[i]);
    remaining = round2(remaining - p);
    installments.push({
      index: i + 1,
      month: m,
      year: y,
      principalPart: p,
      interestPart: interest,
      emiAmount: round2(p + interest),
      balanceAfter: remaining,
    });
    const nm = nextMonth(m, y);
    m = nm.month;
    y = nm.year;
  }

  return {
    installments,
    emiAmount: installments[0].emiAmount,
    totalInterest,
    totalRepayable: round2(principal + totalInterest),
  };
}

// ---------------------------------------------------------------------------
// Reducing-balance schedule
// ---------------------------------------------------------------------------

/**
 * Build a reducing-balance (annuity) installment schedule.
 *
 * Spec formula (phase-2-loan-module.md section 5.2):
 *   r = annualRate / 12 / 100  (monthly rate)
 *   EMI = P * r * (1+r)^n / ((1+r)^n - 1)
 *
 * Per installment:
 *   interestPart    = outstandingPrincipal * r
 *   principalPart   = EMI - interestPart
 *   balanceAfter    = outstandingPrincipal - principalPart
 *
 * The LAST installment absorbs any floating-point rounding remainder so that
 * sum(principalPart) === principal exactly (paise-exact).
 *
 * Special case: annualRate === 0 delegates to buildZeroRateSchedule.
 */
export function buildReducingBalanceSchedule(
  principal: number,
  annualRate: number,
  tenorMonths: number,
  startMonth: number,
  startYear: number,
): LoanScheduleResult {
  if (!(principal > 0)) throw new Error('principal must be positive');
  if (annualRate < 0) throw new Error('annualRate must be >= 0');
  if (tenorMonths < 1) throw new Error('tenorMonths must be >= 1');

  // Zero rate on reducing_balance: degenerate case, behaves like zero-rate.
  if (annualRate === 0) {
    return buildZeroRateSchedule(principal, tenorMonths, startMonth, startYear);
  }

  const r = annualRate / 12 / 100;
  const compoundFactor = Math.pow(1 + r, tenorMonths);

  // Standard annuity EMI formula.
  const emiRaw = (principal * r * compoundFactor) / (compoundFactor - 1);
  const emi = round2(emiRaw);

  const installments: LoanInstallmentRow[] = [];
  let m = startMonth;
  let y = startYear;
  let outstandingPrincipal = round2(principal);
  let totalPrincipalScheduled = 0;

  for (let i = 0; i < tenorMonths; i++) {
    const isLast = i === tenorMonths - 1;

    const interestPart = round2(outstandingPrincipal * r);
    let principalPart: number;
    let installmentEmi: number;

    if (isLast) {
      // Last installment absorbs accumulated rounding so sum(principal) === P.
      principalPart = round2(principal - totalPrincipalScheduled);
      installmentEmi = round2(principalPart + interestPart);
    } else {
      principalPart = round2(emi - interestPart);
      installmentEmi = emi;
    }

    outstandingPrincipal = round2(outstandingPrincipal - principalPart);
    totalPrincipalScheduled = round2(totalPrincipalScheduled + principalPart);

    installments.push({
      index: i + 1,
      month: m,
      year: y,
      principalPart,
      interestPart,
      emiAmount: installmentEmi,
      balanceAfter: Math.max(0, outstandingPrincipal),
    });

    const nm = nextMonth(m, y);
    m = nm.month;
    y = nm.year;
  }

  const totalInterest = round2(installments.reduce((sum, row) => sum + row.interestPart, 0));

  return {
    installments,
    emiAmount: emi,
    totalInterest,
    totalRepayable: round2(principal + totalInterest),
  };
}

// ---------------------------------------------------------------------------
// Monthly perquisite computation
// ---------------------------------------------------------------------------

/**
 * Compute the taxable perquisite value for one month.
 *
 * Spec formula (phase-2-loan-module.md section 5.2 + section 7.1):
 *   perquisiteValue = outstandingBalance * (sbiBenchmarkRate - actualRate) / 1200
 *
 * Returns 0 when:
 *   - actualRate >= sbiBenchmarkRate (no concessional benefit)
 *   - outstandingBalance <= 0
 */
export function computeMonthlyPerquisite(
  outstandingBalance: number,
  sbiBenchmarkRate: number,
  actualRate: number,
): number {
  if (actualRate >= sbiBenchmarkRate || outstandingBalance <= 0) {
    return 0;
  }
  return round2((outstandingBalance * (sbiBenchmarkRate - actualRate)) / 1200);
}
