/**
 * Count the number of working days in a calendar month.
 * @param year  Gregorian year (e.g. 2026)
 * @param month 1-12 (Jan=1)
 * @param workingDayNumbers array of weekday numbers (0=Sun, 1=Mon, ..., 6=Sat).
 *        Example: default ISO Mon-Sat = [1,2,3,4,5,6]
 * @returns integer count of days in the month whose weekday is in workingDayNumbers
 */
export function computeWorkingDaysInMonth(
  year: number,
  month: number,
  workingDayNumbers: number[],
): number {
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}. Must be 1..12.`);
  }
  const workingSet = new Set(workingDayNumbers);
  // Last-day-of-month trick: new Date(year, month, 0).getDate() = last day of (month - 1)
  // because JS months are 0-indexed: month=4 means day 0 of May = April 30th.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let day = 1; day <= lastDay; day++) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (workingSet.has(weekday)) count++;
  }
  return count;
}

/**
 * Default per-workspace shift working days when the member's shift has no
 * explicit workingDays configuration. Matches Shift schema default [1..6].
 */
export const DEFAULT_WORKING_DAYS_MON_SAT = [1, 2, 3, 4, 5, 6];
