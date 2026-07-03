/** One decomposed leave day — the payroll-facing slice of `LeaveRequest.dayBreakdown`. */
export interface LeaveDaySegmentLite {
  date: Date;
  leaveTypeId: string;
  quantity: number;
}

/**
 * Sum the day-quantities of leave segments that fall inside the inclusive UTC
 * window `[windowStart, windowEnd]` and belong to a paid leave type.
 *
 * Drives the payroll "approved paid leave is a credited day" coupling: paid
 * segments add to `creditedDays`, while unpaid (LWP) segments are skipped so
 * they stay docked. Pure — the salary service resolves the inputs.
 */
export function sumPaidLeaveCredit(
  segments: LeaveDaySegmentLite[],
  isPaidByTypeId: Map<string, boolean>,
  windowStart: Date,
  windowEnd: Date,
): number {
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();
  let credit = 0;
  for (const seg of segments) {
    const t = seg.date.getTime();
    if (t < startMs || t > endMs) continue;
    if (isPaidByTypeId.get(seg.leaveTypeId) === true) credit += seg.quantity;
  }
  return credit;
}
