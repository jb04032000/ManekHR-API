/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AttendanceService.markBulk — MEMBER_OFFBOARDED and SoD skips (OQ-A3 / OQ-A5).
 *
 * These tests prove that a bulk mark run containing:
 *   a) a soft-deleted (offboarded) member's record → silently SKIPPED, counted
 *      in `skippedOffboarded`, never written to the event stream.
 *   b) a non-owner marking their OWN record via a bulk run → silently SKIPPED,
 *      counted in `skippedSelf`, never written (SoD-ATTEND-1 bulk path).
 *   c) a mix of eligible + ineligible records → only eligible ones are marked.
 *
 * The write guard (AttendanceWriteGuardService) throws ForbiddenException for
 * offboarded members. markBulk catches the throw and increments skippedOffboarded
 * (fail-safe: a single offboarded record must not abort the whole batch).
 *
 * Mirrors the skippedLocked tests in attendance.service.critical.vitest.ts.
 */

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

import { Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import { AttendanceService } from '../attendance.service';

const workspaceId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();
const memberA = new Types.ObjectId().toString(); // active member
const memberB = new Types.ObjectId().toString(); // offboarded member
const managerMemberId = new Types.ObjectId().toString(); // the caller's own member row

// A past date (not future) so the future-skip branch is not triggered.
const PAST_DATE = '2026-05-11';

function buildService(opts: {
  offboardedIds?: string[];
  callerMemberId?: string;
  isOwner?: boolean;
}) {
  const offboardedSet = new Set(opts.offboardedIds ?? []);

  const salaryModel = {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null), // no payroll lock
    }),
  };

  const attendanceModel = {
    findOneAndUpdate: vi.fn().mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({ _id: new Types.ObjectId(), status: 'present' }),
    }),
  };

  const eventService = {
    createEvent: vi.fn().mockResolvedValue(undefined),
    voidAllByPunchTypeForMemberDay: vi.fn().mockResolvedValue(undefined),
    bulkInsertEvents: vi.fn().mockResolvedValue(undefined),
  };

  const projectionService = { recompute: vi.fn().mockResolvedValue(undefined) };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };

  const callerScope = {
    resolve: vi.fn().mockResolvedValue({
      isOwner: opts.isOwner ?? false,
      teamMemberId: opts.callerMemberId ?? null,
      permissions: [],
      permissionPaths: [{ path: 'attendance.record.mark', scope: 'all' }],
    }),
    effectivePathScope: vi.fn().mockReturnValue('all'),
    selfPathFilterValue: vi.fn().mockReturnValue(null),
  };

  const redisStub = {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
  };

  // Write guard: throws MEMBER_OFFBOARDED for members in the offboarded set.
  const writeGuard = {
    assertMemberWritable: vi.fn().mockImplementation((wsId: string, memberId: string) => {
      if (offboardedSet.has(memberId)) {
        throw new ForbiddenException({ code: 'MEMBER_OFFBOARDED', message: 'removed' });
      }
      return Promise.resolve();
    }),
    assertNotSelfAttendanceEdit: vi.fn().mockResolvedValue(undefined),
  };

  const svc = new AttendanceService(
    attendanceModel as any,
    {} as any, // teamMemberModel unused in markBulk
    salaryModel as any,
    eventService as any,
    projectionService as any,
    writeGuard as any,
    auditService as any,
    postHog as any,
    callerScope as any,
    redisStub as any,
  );

  return { svc, writeGuard, eventService, projectionService, auditService, postHog };
}

describe('AttendanceService.markBulk — MEMBER_OFFBOARDED skip (OQ-A5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips an offboarded member and increments skippedOffboarded, still marks the eligible member', async () => {
    const { svc } = buildService({ offboardedIds: [memberB] });

    const result = await svc.markBulk(workspaceId, userId, {
      records: [
        { teamMemberId: memberA, date: PAST_DATE, status: 'Present' },
        { teamMemberId: memberB, date: PAST_DATE, status: 'Present' }, // offboarded
      ],
    });

    expect(result).toMatchObject({ marked: 1, skippedOffboarded: 1 });
  });

  it('skips all records when every member is offboarded (zero events written)', async () => {
    const { svc, eventService } = buildService({ offboardedIds: [memberA, memberB] });

    const result = await svc.markBulk(workspaceId, userId, {
      records: [
        { teamMemberId: memberA, date: PAST_DATE, status: 'Present' },
        { teamMemberId: memberB, date: PAST_DATE, status: 'Present' },
      ],
    });

    expect(result).toMatchObject({ marked: 0, skippedOffboarded: 2 });
    expect(eventService.bulkInsertEvents).not.toHaveBeenCalled();
  });

  it('a single offboarded record in a batch does not abort the rest (fail-safe)', async () => {
    const { svc } = buildService({ offboardedIds: [memberB] });

    const result = await svc.markBulk(workspaceId, userId, {
      records: [
        { teamMemberId: memberA, date: PAST_DATE, status: 'Present' },
        { teamMemberId: memberB, date: PAST_DATE, status: 'Present' },
        { teamMemberId: memberA, date: '2026-05-12', status: 'Present' },
      ],
    });

    // memberA has 2 dates; memberB is offboarded.
    expect(result.marked).toBe(2);
    expect(result.skippedOffboarded).toBe(1);
  });
});

describe('AttendanceService.markBulk — SoD self-mark skip in bulk (OQ-A3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a non-owner manager including their own member row skips it (skippedSelf++)', async () => {
    const { svc } = buildService({ callerMemberId: managerMemberId, isOwner: false });

    const result = await svc.markBulk(workspaceId, userId, {
      records: [
        { teamMemberId: memberA, date: PAST_DATE, status: 'Present' },
        { teamMemberId: managerMemberId, date: PAST_DATE, status: 'Present' }, // self
      ],
    });

    expect(result).toMatchObject({ marked: 1, skippedSelf: 1 });
  });

  it('owner bypasses the SoD self-skip (isOwner=true)', async () => {
    const { svc } = buildService({ callerMemberId: managerMemberId, isOwner: true });

    const result = await svc.markBulk(workspaceId, userId, {
      records: [
        { teamMemberId: managerMemberId, date: PAST_DATE, status: 'Present' }, // own row, but owner
      ],
    });

    expect(result.marked).toBe(1);
    expect(result.skippedSelf).toBe(0);
  });

  it('a caller with no teamMemberId never triggers the SoD skip (no own row to protect)', async () => {
    const { svc } = buildService({ callerMemberId: undefined, isOwner: false });

    const result = await svc.markBulk(workspaceId, userId, {
      records: [{ teamMemberId: memberA, date: PAST_DATE, status: 'Present' }],
    });

    expect(result.marked).toBe(1);
    expect(result.skippedSelf).toBe(0);
  });
});

describe('AttendanceService.markBulk — combined skips', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handles offboarded + self + locked all in one batch, marks only the eligible record', async () => {
    const { svc, eventService } = buildService({
      offboardedIds: [memberB],
      callerMemberId: managerMemberId,
      isOwner: false,
    });

    // Override salary mock so memberA on 2026-04-01 is locked.
    const salaryMock = {
      findOne: vi.fn().mockImplementation((filter: any) => {
        const memId = String(filter.teamMemberId);
        // memberA with month=4 year=2026 is locked.
        const isLocked = memId === memberA && filter.month === 4;
        return {
          select: vi.fn().mockReturnThis(),
          lean: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue(isLocked ? { isLocked: true } : null),
        };
      }),
    };
    // Patch the salary model on the service (the private field) — easier than
    // rebuilding the whole service just to override one sub-check.
    (svc as any).salaryModel = salaryMock;

    const result = await svc.markBulk(workspaceId, userId, {
      records: [
        { teamMemberId: memberA, date: '2026-05-11', status: 'Present' }, // eligible
        { teamMemberId: memberB, date: '2026-05-11', status: 'Present' }, // offboarded
        { teamMemberId: managerMemberId, date: '2026-05-11', status: 'Present' }, // self-blocked
        { teamMemberId: memberA, date: '2026-04-01', status: 'Present' }, // payroll locked
      ],
    });

    expect(result.marked).toBe(1);
    expect(result.skippedOffboarded).toBe(1);
    expect(result.skippedSelf).toBe(1);
    expect(result.skippedLocked).toBe(1);
    expect(eventService.bulkInsertEvents).toHaveBeenCalledTimes(1);
  });
});
