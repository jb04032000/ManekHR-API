import { Injectable } from '@nestjs/common';

/**
 * LoanScheduleService — pure stateless EMI computation service.
 *
 * No constructor injection; all methods are deterministic given inputs.
 * Pattern mirrors DepreciationMathService (fixed-assets module).
 *
 * EMI formula (reducing-balance):
 *   r_monthly = annualRate / 12 / 100
 *   EMI = P × r × (1+r)^n / ((1+r)^n − 1)   [standard case]
 *   EMI = P / n                                 [zero-rate special case]
 *
 * Rounding: all paise values rounded to nearest integer.
 * Last instalment: principal absorbs all rounding drift so sum(principal) === P exactly.
 */

export interface ScheduleRow {
  monthIndex: number;             // 0-based
  month: string;                  // YYYY-MM
  openingPrincipalPaise: number;
  emiAmountPaise: number;
  principalComponentPaise: number;
  interestComponentPaise: number;
  closingPrincipalPaise: number;
}

export interface LoanScheduleInput {
  sanctionedAmountPaise: number;
  interestRateAnnual: number;     // percentage, e.g. 12.5
  tenureMonths: number;
  repaymentStartDate: Date;       // date of first EMI
}

@Injectable()
export class LoanScheduleService {
  // ─── Static utility helpers ────────────────────────────────────────────────

  /** Compute rounded monthly EMI using reducing-balance formula. */
  static computeEmi(P: number, rMonthly: number, n: number): number {
    if (n <= 0) throw new Error('Tenure must be > 0');
    if (rMonthly === 0) return Math.round(P / n);
    const factor = Math.pow(1 + rMonthly, n);
    return Math.round((P * rMonthly * factor) / (factor - 1));
  }

  /** Format a Date as YYYY-MM string. */
  static formatYearMonth(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  /** Return a new Date advanced by n calendar months. */
  static addMonths(d: Date, n: number): Date {
    const r = new Date(d);
    r.setMonth(r.getMonth() + n);
    return r;
  }

  // ─── Schedule computation ──────────────────────────────────────────────────

  /**
   * Generate the full amortisation schedule for a term loan.
   * Throws for invalid inputs (zero tenure, negative amount, out-of-range rate).
   *
   * Guarantees:
   *   sum(principalComponentPaise) === sanctionedAmountPaise exactly (drift absorbed in last row)
   *   last row closingPrincipalPaise === 0
   */
  computeSchedule(input: LoanScheduleInput): ScheduleRow[] {
    const { sanctionedAmountPaise: P, interestRateAnnual, tenureMonths: n, repaymentStartDate } = input;

    if (n <= 0) throw new Error('Tenure must be > 0');
    if (P <= 0) throw new Error('Sanctioned amount must be > 0');
    if (interestRateAnnual < 0 || interestRateAnnual > 50) {
      throw new Error('Interest rate must be between 0 and 50 percent');
    }

    const rMonthly = interestRateAnnual / 12 / 100;
    const standardEmi = LoanScheduleService.computeEmi(P, rMonthly, n);

    const rows: ScheduleRow[] = [];
    let opening = P;

    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const interest = Math.round(opening * rMonthly);
      // Last instalment: principal = entire remaining opening (absorbs all rounding drift)
      const principal = isLast ? opening : Math.min(opening, standardEmi - interest);
      const actualEmi = principal + interest;
      const closing = opening - principal;

      rows.push({
        monthIndex: i,
        month: LoanScheduleService.formatYearMonth(
          LoanScheduleService.addMonths(repaymentStartDate, i),
        ),
        openingPrincipalPaise: opening,
        emiAmountPaise: actualEmi,
        principalComponentPaise: principal,
        interestComponentPaise: interest,
        closingPrincipalPaise: closing,
      });

      opening = closing;
    }

    return rows;
  }

  /**
   * Recompute remaining schedule after a prepayment.
   *
   * Strategy: PRESERVE EMI, SHORTEN TENURE.
   * The new schedule starts from remainingPrincipalPaise (after prepayment is subtracted),
   * uses the same monthly EMI as the original loan, and runs until principal is fully
   * repaid (fewer months than original remaining tenure).
   *
   * @param remainingPrincipalPaise  Outstanding principal AFTER prepayment is applied
   * @param originalEmiPaise         Standard EMI from original schedule (preserved)
   * @param rateAnnual               Annual interest rate (percentage)
   * @param startMonth               YYYY-MM of the NEXT unpaid month
   * @returns New ScheduleRow[] replacing all pending rows from startMonth onward
   */
  recomputeAfterPrepayment(
    remainingPrincipalPaise: number,
    originalEmiPaise: number,
    rateAnnual: number,
    startMonth: string,
  ): ScheduleRow[] {
    if (remainingPrincipalPaise <= 0) return [];

    const rMonthly = rateAnnual / 12 / 100;
    const rows: ScheduleRow[] = [];
    let opening = remainingPrincipalPaise;
    let monthIndex = 0;

    // Parse startMonth YYYY-MM into a Date object (day=1)
    const [yearStr, monthStr] = startMonth.split('-');
    const startDate = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, 1);

    while (opening > 0) {
      const interest = Math.round(opening * rMonthly);
      const isLast = opening <= originalEmiPaise - interest || monthIndex > 600; // safety cap
      const principal = isLast ? opening : Math.min(opening, originalEmiPaise - interest);
      const actualEmi = principal + interest;
      const closing = opening - principal;

      rows.push({
        monthIndex,
        month: LoanScheduleService.formatYearMonth(
          LoanScheduleService.addMonths(startDate, monthIndex),
        ),
        openingPrincipalPaise: opening,
        emiAmountPaise: actualEmi,
        principalComponentPaise: principal,
        interestComponentPaise: interest,
        closingPrincipalPaise: closing,
      });

      opening = closing;
      monthIndex++;

      if (isLast) break;
    }

    return rows;
  }
}
