import { describe, it, expect } from 'vitest';
import {
  parseWeeklyOff,
  dayKey,
  expandWorkingDays,
  decomposePaidLwp,
  chargeAllToType,
  classifyLeaveType,
  leaveDayStatusValue,
  affectedMonths,
  rangesOverlap,
  buildApproverChainExcludingSelf,
  resolveApproverChainForMember,
} from '../leave-request.util';

const d = (y: number, m: number, day: number): Date => new Date(Date.UTC(y, m, day));

describe('leave-request.util', () => {
  describe('parseWeeklyOff', () => {
    it('maps day names (full + short, any case) to weekday indices', () => {
      expect([...parseWeeklyOff(['Sunday', 'sat'])].sort()).toEqual([0, 6]);
      expect([...parseWeeklyOff(['MON'])]).toEqual([1]);
    });

    it('ignores unknown entries and a missing list', () => {
      expect([...parseWeeklyOff(['funday', ''])]).toEqual([]);
      expect([...parseWeeklyOff(undefined)]).toEqual([]);
    });
  });

  describe('buildApproverChainExcludingSelf', () => {
    it('drops the member from their own approval chain and re-levels the rest', () => {
      const chain = buildApproverChainExcludingSelf(['mgrA', 'hrB'], 'mgrA');
      expect(chain).toEqual([
        { level: 1, approverUserId: 'hrB', decision: null, decidedAt: null, note: null },
      ]);
    });

    it('keeps every approver when the member is not in the list', () => {
      const chain = buildApproverChainExcludingSelf(['mgrA', 'hrB'], 'workerC');
      expect(chain.map((s) => s.approverUserId)).toEqual(['mgrA', 'hrB']);
      expect(chain.map((s) => s.level)).toEqual([1, 2]);
    });

    it('returns an empty chain (auto-approve) when the member was the only approver', () => {
      expect(buildApproverChainExcludingSelf(['mgrA'], 'mgrA')).toEqual([]);
    });

    it('keeps every approver when the member has no linked user (null)', () => {
      expect(buildApproverChainExcludingSelf(['mgrA', 'hrB'], null)).toHaveLength(2);
    });

    it('compares by toString so ObjectId-like ids work', () => {
      const oid = (v: string) => ({ toString: () => v });
      const chain = buildApproverChainExcludingSelf([oid('mgrA'), oid('hrB')], 'mgrA');
      expect(chain).toHaveLength(1);
      expect(chain[0].approverUserId.toString()).toBe('hrB');
    });
  });

  describe('resolveApproverChainForMember', () => {
    const settings = ['hrA', 'hrB'];

    it('routes to the direct manager as a single level, ignoring the settings chain', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'worker',
        manager: { linkedUserId: 'mgr', isActive: true, isDeleted: false },
        settingsApproverUserIds: settings,
        ownerUserId: 'owner',
      });
      expect(chain).toEqual([
        { level: 1, approverUserId: 'mgr', decision: null, decidedAt: null, note: null },
      ]);
    });

    it('falls back to the settings chain when there is no reporting manager', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'worker',
        manager: null,
        settingsApproverUserIds: settings,
        ownerUserId: 'owner',
      });
      expect(chain.map((s) => s.approverUserId)).toEqual(['hrA', 'hrB']);
    });

    it('skips a manager with no linked app user (no account) and uses the settings chain', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'worker',
        manager: { linkedUserId: null, isActive: true, isDeleted: false },
        settingsApproverUserIds: settings,
        ownerUserId: 'owner',
      });
      expect(chain.map((s) => s.approverUserId)).toEqual(['hrA', 'hrB']);
    });

    it('skips an inactive manager', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'worker',
        manager: { linkedUserId: 'mgr', isActive: false, isDeleted: false },
        settingsApproverUserIds: settings,
        ownerUserId: 'owner',
      });
      expect(chain.map((s) => s.approverUserId)).toEqual(['hrA', 'hrB']);
    });

    it('skips a soft-deleted manager', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'worker',
        manager: { linkedUserId: 'mgr', isActive: true, isDeleted: true },
        settingsApproverUserIds: settings,
        ownerUserId: 'owner',
      });
      expect(chain.map((s) => s.approverUserId)).toEqual(['hrA', 'hrB']);
    });

    it('skips the manager when they ARE the applicant (SoD / circular self-reportsTo)', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'worker',
        manager: { linkedUserId: 'worker', isActive: true, isDeleted: false },
        settingsApproverUserIds: settings,
        ownerUserId: 'owner',
      });
      expect(chain.map((s) => s.approverUserId)).toEqual(['hrA', 'hrB']);
    });

    it('falls back to the workspace owner when there is no manager and no settings chain', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'worker',
        manager: null,
        settingsApproverUserIds: [],
        ownerUserId: 'owner',
      });
      expect(chain).toEqual([
        { level: 1, approverUserId: 'owner', decision: null, decidedAt: null, note: null },
      ]);
    });

    it('excludes self from the settings tier and re-levels the rest', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'hrA',
        manager: null,
        settingsApproverUserIds: ['hrA', 'hrB'],
        ownerUserId: 'owner',
      });
      expect(chain).toEqual([
        { level: 1, approverUserId: 'hrB', decision: null, decidedAt: null, note: null },
      ]);
    });

    it('auto-approves (empty chain) when the applicant is the sole owner authority', () => {
      const chain = resolveApproverChainForMember({
        selfUserId: 'owner',
        manager: null,
        settingsApproverUserIds: [],
        ownerUserId: 'owner',
      });
      expect(chain).toEqual([]);
    });

    it('compares ObjectId-like ids by toString across every tier', () => {
      const oid = (v: string) => ({ toString: () => v });
      const chain = resolveApproverChainForMember({
        selfUserId: 'worker',
        manager: { linkedUserId: oid('mgr'), isActive: true, isDeleted: false },
        settingsApproverUserIds: [oid('hrA')],
        ownerUserId: 'owner',
      });
      expect(chain).toHaveLength(1);
      expect(chain[0].approverUserId).toBe('mgr');
    });
  });

  describe('dayKey', () => {
    it('formats a UTC date as YYYY-MM-DD', () => {
      expect(dayKey(d(2026, 2, 5))).toBe('2026-03-05');
    });
  });

  describe('expandWorkingDays', () => {
    it('charges every day when there are no holidays / offs', () => {
      const days = expandWorkingDays(
        d(2026, 0, 5),
        d(2026, 0, 7),
        'none',
        'none',
        new Set(),
        new Set(),
        false,
      );
      expect(days.map((x) => x.quantity)).toEqual([1, 1, 1]);
    });

    it('excludes holidays and weekly-offs', () => {
      // Jan 2026: 5 = Mon, 7 = Wed (holiday), 11 = Sun (weekly off).
      const days = expandWorkingDays(
        d(2026, 0, 5),
        d(2026, 0, 11),
        'none',
        'none',
        new Set(['2026-01-07']),
        new Set([0]),
        false,
      );
      expect(days.map((x) => dayKey(x.date))).toEqual([
        '2026-01-05',
        '2026-01-06',
        '2026-01-08',
        '2026-01-09',
        '2026-01-10',
      ]);
    });

    it('charges every calendar day when sandwich is on', () => {
      const days = expandWorkingDays(
        d(2026, 0, 5),
        d(2026, 0, 11),
        'none',
        'none',
        new Set(['2026-01-07']),
        new Set([0]),
        true,
      );
      expect(days).toHaveLength(7);
    });

    it('applies a half-day on the first and last day', () => {
      const days = expandWorkingDays(
        d(2026, 0, 5),
        d(2026, 0, 7),
        'second_half',
        'first_half',
        new Set(),
        new Set(),
        false,
      );
      expect(days.map((x) => x.quantity)).toEqual([0.5, 1, 0.5]);
    });

    it('handles a single half-day request', () => {
      const days = expandWorkingDays(
        d(2026, 0, 5),
        d(2026, 0, 5),
        'first_half',
        'none',
        new Set(),
        new Set(),
        false,
      );
      expect(days).toEqual([{ date: d(2026, 0, 5), quantity: 0.5 }]);
    });
  });

  describe('decomposePaidLwp', () => {
    const workingDays = (n: number, q = 1) =>
      Array.from({ length: n }, (_, i) => ({ date: d(2026, 0, i + 1), quantity: q }));

    it('charges all days to paid when the balance covers them', () => {
      const r = decomposePaidLwp(workingDays(3), 5, 'CL', 'LWP');
      expect(r.paidDays).toBe(3);
      expect(r.lwpDays).toBe(0);
      expect(r.segments.every((s) => s.leaveTypeId === 'CL')).toBe(true);
    });

    it('splits paid then overflows to LWP (15-day request, 5 paid)', () => {
      const r = decomposePaidLwp(workingDays(15), 5, 'CL', 'LWP');
      expect(r.paidDays).toBe(5);
      expect(r.lwpDays).toBe(10);
      expect(r.totalDays).toBe(15);
      expect(r.segments.slice(0, 5).every((s) => s.leaveTypeId === 'CL')).toBe(true);
      expect(r.segments.slice(5).every((s) => s.leaveTypeId === 'LWP')).toBe(true);
    });

    it('sends everything to LWP when the balance is zero', () => {
      const r = decomposePaidLwp(workingDays(4), 0, 'CL', 'LWP');
      expect(r.paidDays).toBe(0);
      expect(r.lwpDays).toBe(4);
    });

    it('does not split a half-day across the paid / LWP boundary', () => {
      const r = decomposePaidLwp(
        [
          { date: d(2026, 0, 1), quantity: 1 },
          { date: d(2026, 0, 2), quantity: 1 },
          { date: d(2026, 0, 3), quantity: 0.5 },
        ],
        2,
        'CL',
        'LWP',
      );
      expect(r.paidDays).toBe(2);
      expect(r.lwpDays).toBe(0.5);
    });
  });

  describe('chargeAllToType', () => {
    it('charges every working day wholly to one leave type', () => {
      const segs = chargeAllToType(
        [
          { date: d(2026, 0, 1), quantity: 1 },
          { date: d(2026, 0, 2), quantity: 0.5 },
        ],
        'MAT',
      );
      expect(segs).toEqual([
        { date: d(2026, 0, 1), leaveTypeId: 'MAT', quantity: 1 },
        { date: d(2026, 0, 2), leaveTypeId: 'MAT', quantity: 0.5 },
      ]);
    });
  });

  describe('classifyLeaveType', () => {
    it('classifies the system LWP type', () => {
      const c = classifyLeaveType({ code: 'LWP', accrualMode: 'none', isCompOff: false });
      expect(c).toEqual({
        isLwp: true,
        isCompOff: false,
        isEntitlement: false,
        balanceTracked: false,
      });
    });

    it('classifies an accrual type (CL / SL / EL) as balance-tracked', () => {
      expect(classifyLeaveType({ code: 'CL', accrualMode: 'upfront', isCompOff: false })).toEqual({
        isLwp: false,
        isCompOff: false,
        isEntitlement: false,
        balanceTracked: true,
      });
      expect(classifyLeaveType({ code: 'EL', accrualMode: 'periodic', isCompOff: false })).toEqual({
        isLwp: false,
        isCompOff: false,
        isEntitlement: false,
        balanceTracked: true,
      });
    });

    it('classifies a no-accrual type as a fixed entitlement, not balance-tracked', () => {
      expect(classifyLeaveType({ code: 'MAT', accrualMode: 'none', isCompOff: false })).toEqual({
        isLwp: false,
        isCompOff: false,
        isEntitlement: true,
        balanceTracked: false,
      });
    });

    it('classifies a comp-off type as balance-tracked, never an entitlement', () => {
      expect(classifyLeaveType({ code: 'COMP', accrualMode: 'none', isCompOff: true })).toEqual({
        isLwp: false,
        isCompOff: true,
        isEntitlement: false,
        balanceTracked: true,
      });
    });
  });

  describe('leaveDayStatusValue', () => {
    it('maps a full day to on_leave and a part-day to half_day', () => {
      expect(leaveDayStatusValue(1)).toBe('on_leave');
      expect(leaveDayStatusValue(0.5)).toBe('half_day');
    });
  });

  describe('affectedMonths', () => {
    it('returns the single month a within-month range touches', () => {
      expect(affectedMonths(d(2026, 2, 4), d(2026, 2, 20))).toEqual([{ month: 3, year: 2026 }]);
    });

    it('returns every month a multi-month span touches, inclusive', () => {
      expect(affectedMonths(d(2026, 0, 28), d(2026, 2, 2))).toEqual([
        { month: 1, year: 2026 },
        { month: 2, year: 2026 },
        { month: 3, year: 2026 },
      ]);
    });

    it('crosses a year boundary', () => {
      expect(affectedMonths(d(2025, 11, 30), d(2026, 1, 1))).toEqual([
        { month: 12, year: 2025 },
        { month: 1, year: 2026 },
        { month: 2, year: 2026 },
      ]);
    });
  });

  describe('rangesOverlap', () => {
    it('detects an overlap when the ranges intersect', () => {
      expect(rangesOverlap(d(2026, 0, 1), d(2026, 0, 10), d(2026, 0, 5), d(2026, 0, 15))).toBe(
        true,
      );
    });

    it('treats a shared boundary day as an overlap (inclusive)', () => {
      expect(rangesOverlap(d(2026, 0, 1), d(2026, 0, 10), d(2026, 0, 10), d(2026, 0, 20))).toBe(
        true,
      );
    });

    it('returns false for fully disjoint ranges', () => {
      expect(rangesOverlap(d(2026, 0, 1), d(2026, 0, 10), d(2026, 0, 11), d(2026, 0, 20))).toBe(
        false,
      );
    });

    it('detects containment', () => {
      expect(rangesOverlap(d(2026, 0, 1), d(2026, 0, 31), d(2026, 0, 10), d(2026, 0, 12))).toBe(
        true,
      );
    });
  });
});
