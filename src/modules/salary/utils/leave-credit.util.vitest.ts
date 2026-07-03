import { describe, it, expect } from 'vitest';
import { sumPaidLeaveCredit, LeaveDaySegmentLite } from './leave-credit.util';

const d = (y: number, m: number, day: number): Date => new Date(Date.UTC(y, m, day));

describe('sumPaidLeaveCredit', () => {
  const start = d(2026, 3, 1); // 01 Apr 2026
  const end = d(2026, 3, 30); // 30 Apr 2026
  const isPaid = new Map<string, boolean>([
    ['CL', true],
    ['LWP', false],
  ]);

  it('counts a paid full-day segment inside the window', () => {
    const segs: LeaveDaySegmentLite[] = [{ date: d(2026, 3, 10), leaveTypeId: 'CL', quantity: 1 }];
    expect(sumPaidLeaveCredit(segs, isPaid, start, end)).toBe(1);
  });

  it('counts a paid half-day segment as 0.5', () => {
    const segs: LeaveDaySegmentLite[] = [
      { date: d(2026, 3, 10), leaveTypeId: 'CL', quantity: 0.5 },
    ];
    expect(sumPaidLeaveCredit(segs, isPaid, start, end)).toBe(0.5);
  });

  it('skips an unpaid (LWP) segment so it stays docked', () => {
    const segs: LeaveDaySegmentLite[] = [
      { date: d(2026, 3, 12), leaveTypeId: 'CL', quantity: 1 },
      { date: d(2026, 3, 13), leaveTypeId: 'LWP', quantity: 1 },
    ];
    expect(sumPaidLeaveCredit(segs, isPaid, start, end)).toBe(1);
  });

  it('skips a segment outside the window', () => {
    const segs: LeaveDaySegmentLite[] = [
      { date: d(2026, 2, 28), leaveTypeId: 'CL', quantity: 1 },
      { date: d(2026, 4, 1), leaveTypeId: 'CL', quantity: 1 },
    ];
    expect(sumPaidLeaveCredit(segs, isPaid, start, end)).toBe(0);
  });

  it('treats the window boundaries as inclusive', () => {
    const segs: LeaveDaySegmentLite[] = [
      { date: start, leaveTypeId: 'CL', quantity: 1 },
      { date: end, leaveTypeId: 'CL', quantity: 1 },
    ];
    expect(sumPaidLeaveCredit(segs, isPaid, start, end)).toBe(2);
  });

  it('skips a segment whose type is absent from the paid map', () => {
    const segs: LeaveDaySegmentLite[] = [
      { date: d(2026, 3, 10), leaveTypeId: 'UNKNOWN', quantity: 1 },
    ];
    expect(sumPaidLeaveCredit(segs, isPaid, start, end)).toBe(0);
  });
});
