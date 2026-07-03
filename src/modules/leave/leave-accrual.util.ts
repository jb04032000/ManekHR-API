import type { LeaveAccrualFrequency } from './schemas/leave-type.schema';

/** Round to the nearest half-day — leave is granted in 0.5-day units. */
export function roundToHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

/**
 * Prorate an `upfront_annual` credit for a member who joined mid-year.
 *
 * - Joined before `year` (or no join date) → full `annualQuantity`.
 * - Joined within `year` → a share by remaining whole months, join month
 *   inclusive (e.g. joined in April → 9/12 of the annual quantity).
 * - Joined after `year` → 0.
 *
 * Rounded to the nearest half-day.
 */
export function prorateUpfrontCredit(
  annualQuantity: number,
  dateOfJoining: Date | null | undefined,
  year: number,
): number {
  if (!dateOfJoining) return annualQuantity;
  const joinYear = dateOfJoining.getUTCFullYear();
  if (joinYear < year) return annualQuantity;
  if (joinYear > year) return 0;
  const joinMonth = dateOfJoining.getUTCMonth() + 1; // 1–12
  const monthsRemaining = 13 - joinMonth; // join month counts
  return roundToHalf((annualQuantity * monthsRemaining) / 12);
}

/** Calendar months spanned by one accrual period. */
export function periodMonths(frequency: LeaveAccrualFrequency): number {
  if (frequency === 'monthly') return 1;
  if (frequency === 'quarterly') return 3;
  return 12;
}

export interface AccrualPeriod {
  /** UTC midnight of the period's first day. */
  start: Date;
  /** UTC midnight of the day after the period (exclusive end). */
  end: Date;
  /** Stable dedup key — "2026-03" / "2026-Q2" / "2026". */
  key: string;
}

/** Every accrual period of a calendar `year`, chronologically. */
export function periodsForYear(year: number, frequency: LeaveAccrualFrequency): AccrualPeriod[] {
  const step = periodMonths(frequency);
  const periods: AccrualPeriod[] = [];
  for (let m = 0; m < 12; m += step) {
    const start = new Date(Date.UTC(year, m, 1));
    const end = new Date(Date.UTC(year, m + step, 1));
    let key: string;
    if (frequency === 'monthly') {
      key = `${year}-${String(m + 1).padStart(2, '0')}`;
    } else if (frequency === 'quarterly') {
      key = `${year}-Q${m / 3 + 1}`;
    } else {
      key = `${year}`;
    }
    periods.push({ start, end, key });
  }
  return periods;
}

/**
 * A period is accruable once it has fully elapsed (`asOf` ≥ its end) and the
 * member's accrual window overlaps it (`accrualStart` before its end).
 */
export function isPeriodAccruable(period: AccrualPeriod, asOf: Date, accrualStart: Date): boolean {
  if (asOf.getTime() < period.end.getTime()) return false;
  return accrualStart.getTime() < period.end.getTime();
}

/**
 * Credit earned for one period: the full `rate`, or a prorated share when the
 * member joined / became eligible partway through it. Rounded to a half-day.
 */
export function proratePeriodCredit(
  rate: number,
  period: AccrualPeriod,
  accrualStart: Date,
): number {
  const periodStart = period.start.getTime();
  const periodEnd = period.end.getTime();
  const activeFrom = Math.max(periodStart, accrualStart.getTime());
  if (activeFrom <= periodStart) return rate; // active for the whole period
  const activeFraction = (periodEnd - activeFrom) / (periodEnd - periodStart);
  return roundToHalf(rate * activeFraction);
}
