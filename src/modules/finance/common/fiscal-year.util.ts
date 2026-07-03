/**
 * Fiscal-year helpers shared between Plan 02 (Tally Export) and Plan 03
 * (FY-Lock guard + close service). Single source of truth — both plans import
 * from here; do NOT duplicate this logic.
 *
 * Indian default fiscal year: April 1 → March 31. `fyStartMonth` lives on the
 * Firm document (1-12, default 4 — see Firm.fyStartMonth).
 */
import { BadRequestException } from '@nestjs/common';

export interface FiscalYearWindow {
  /** Calendar year in which the FY starts (e.g. 2025 for FY 2025-26). */
  startYear: number;
  /** First instant of the FY at UTC midnight. */
  startDate: Date;
  /** Last instant of the FY (last day's 23:59:59.999 in UTC). */
  endDate: Date;
}

/**
 * Returns the fiscal-year window that contains `date`.
 *
 * @param date          — any timestamp (UTC).
 * @param fyStartMonth  — 1..12 calendar month at which the FY begins. Default 4.
 */
export function getFiscalYearOfDate(date: Date, fyStartMonth: number /* 1-12 */): FiscalYearWindow {
  const m = date.getUTCMonth() + 1;
  const y = date.getUTCFullYear();
  const startYear = m >= fyStartMonth ? y : y - 1;
  const startDate = new Date(Date.UTC(startYear, fyStartMonth - 1, 1, 0, 0, 0, 0));
  // Last day of FY = (startYear+1, fyStartMonth, 1) − 1 ms
  const endExclusive = Date.UTC(startYear + 1, fyStartMonth - 1, 1, 0, 0, 0, 0);
  const endDate = new Date(endExclusive - 1);
  return { startYear, startDate, endDate };
}

/**
 * Returns the canonical FY label (e.g. "2025-26") that contains `date`.
 *
 * THE single source of truth for the `financialYear` string stamped on every
 * voucher/receipt/payment. Derived from `getFiscalYearOfDate` so the label can
 * never disagree with the FY-lock window that guards the same date. Always
 * derive the label from the document's own DATE — never from `new Date()` and
 * never from a client-supplied value — so a back-dated voucher lands (and is
 * numbered) in its true fiscal year.
 *
 * @param date          — the voucher/receipt/payment date.
 * @param fyStartMonth  — 1..12 calendar month the FY begins. Default 4 (April, India).
 */
export function financialYearOf(date: Date, fyStartMonth = 4): string {
  const { startYear } = getFiscalYearOfDate(date, fyStartMonth);
  return `${startYear}-${(startYear + 1).toString().slice(2)}`;
}

/**
 * Throws BadRequestException if `from` and `to` fall in different fiscal years
 * (D-08 — single-FY hard cap on Tally exports).
 */
export function assertSameFy(from: Date, to: Date, fyStartMonth: number): void {
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException('fromDate must be on or before toDate');
  }
  const a = getFiscalYearOfDate(from, fyStartMonth);
  const b = getFiscalYearOfDate(to, fyStartMonth);
  if (a.startYear !== b.startYear) {
    throw new BadRequestException(
      `Date range must fall within a single fiscal year (${a.startYear}-${a.startYear + 1}). Split multi-year exports manually.`,
    );
  }
}
