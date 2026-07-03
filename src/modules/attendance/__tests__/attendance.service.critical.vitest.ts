/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AttendanceService so
// transitive schema imports don't trip vitest's esbuild metadata reflection.
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
import { AttendanceService } from '../attendance.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { BadRequestException } from '@nestjs/common';

/**
 * W6.16 critical-path coverage for AttendanceService:
 *   - mark(): happy + salary-lock guard
 *   - markBulk(): happy + skip-locked subset
 *   - remove(): happy + audit attribution
 *
 * Verifies audit + PostHog fire-and-forget on success; audit failure is
 * swallowed (never breaks the caller).
 */
describe('AttendanceService — critical paths (W6.16)', () => {
  let attendanceModel: any;
  let teamMemberModel: any;
  let salaryModel: any;
  let eventService: any;
  let projectionService: any;
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let postHog: { capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> };
  let svc: AttendanceService;

  const workspaceId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const memberId = new Types.ObjectId().toString();
  const recordId = new Types.ObjectId();

  const settle = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    // Default: no salary lock — returns null doc.
    salaryModel = {
      findOne: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue(null),
          }),
        }),
      }),
    };

    // findOneAndUpdate chain returns a populated record.
    const populatedRecord = {
      _id: recordId,
      teamMemberId: { _id: memberId, name: 'Test Member', mobile: '9999999999' },
      date: new Date('2026-05-11T00:00:00.000Z'),
      status: 'Present',
      markedBy: userId,
      note: null,
      statusHistory: [],
    };
    const populateChain = {
      populate: vi.fn(),
      exec: vi.fn().mockResolvedValue(populatedRecord),
    };
    populateChain.populate.mockReturnValue(populateChain);
    attendanceModel = {
      findOneAndUpdate: vi.fn().mockReturnValue(populateChain),
      findOne: vi.fn().mockReturnValue(populateChain),
      deleteOne: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      }),
    };

    teamMemberModel = {}; // unused on these paths

    eventService = {
      createEvent: vi.fn().mockResolvedValue(undefined),
      voidAllByPunchTypeForMemberDay: vi.fn().mockResolvedValue(undefined),
      bulkInsertEvents: vi.fn().mockResolvedValue(undefined),
    };

    projectionService = {
      recompute: vi.fn().mockResolvedValue(undefined),
    };

    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn(), identify: vi.fn() };

    // Caller-scope stub (Role Taxonomy P1 self-write guard). G2 (2026-05-24)
    // moved scope resolution onto the path store: the service now calls
    // resolve() then effectivePathScope() / selfPathFilterValue(). Returning
    // 'all' / null short-circuits the self-write assertion + read narrowing so
    // these admin-path tests proceed.
    const callerScope = {
      resolve: vi.fn().mockResolvedValue({
        isOwner: true,
        teamMemberId: null,
        permissions: [],
        permissionPaths: [],
      }),
      effectivePathScope: vi.fn().mockReturnValue('all'),
      selfPathFilterValue: vi.fn().mockReturnValue(null),
    };
    // Redis stub for live-presence cache bust (set/get/del are the only
    // calls used by AttendanceService). Returning resolved-undefined keeps
    // the cache path a no-op in tests.
    const redisStub = {
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
    };

    // Attendance hardening: write-guard stub. Default = writes allowed (member
    // present + non-self), so these admin-path tests proceed unchanged.
    const writeGuard = {
      assertMemberWritable: vi.fn().mockResolvedValue(undefined),
      assertNotSelfAttendanceEdit: vi.fn().mockResolvedValue(undefined),
    };

    svc = new AttendanceService(
      attendanceModel,
      teamMemberModel,
      salaryModel,
      eventService,
      projectionService,
      writeGuard as any,
      auditService as any,
      postHog as any,
      callerScope as any,
      redisStub as any,
    );
  });

  // ── mark() ────────────────────────────────────────────────────────────

  it('mark: happy path emits status_set event, recomputes projection, fires audit + posthog', async () => {
    const result = await svc.mark(workspaceId, userId, {
      teamMemberId: memberId,
      date: '2026-05-11',
      status: 'Present',
      checkIn: '2026-05-11T09:00:00.000Z',
      checkOut: '2026-05-11T18:00:00.000Z',
    });

    expect(result).toBeDefined();
    expect(eventService.createEvent).toHaveBeenCalled();
    expect(projectionService.recompute).toHaveBeenCalledWith(
      workspaceId,
      memberId,
      expect.any(Date),
    );

    await settle();
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'attendance.marked_attendance',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0]).toMatchObject({
      workspaceId,
      module: AppModule.ATTENDANCE,
      entityType: 'attendance',
      action: 'attendance.marked_attendance',
    });
    expect(auditCall[0].meta).toMatchObject({
      status: 'Present',
      hasCheckIn: true,
      hasCheckOut: true,
    });

    expect(postHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: userId,
        event: 'attendance.marked_attendance',
        properties: expect.objectContaining({ workspaceId, memberId, status: 'Present' }),
      }),
    );
  });

  it('mark: throws BadRequestException when salary is locked for the period', async () => {
    salaryModel.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue({ isLocked: true }),
        }),
      }),
    });

    await expect(
      svc.mark(workspaceId, userId, {
        teamMemberId: memberId,
        date: '2026-05-11',
        status: 'Present',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    // No events, no recompute, no audit, no posthog on locked path
    expect(eventService.createEvent).not.toHaveBeenCalled();
    expect(projectionService.recompute).not.toHaveBeenCalled();
    expect(auditService.logEvent).not.toHaveBeenCalled();
    expect(postHog.capture).not.toHaveBeenCalled();
  });

  it('mark: audit failure is swallowed (fire-and-forget)', async () => {
    auditService.logEvent.mockRejectedValueOnce(new Error('audit boom'));

    await expect(
      svc.mark(workspaceId, userId, {
        teamMemberId: memberId,
        date: '2026-05-11',
        status: 'Present',
      } as any),
    ).resolves.toBeDefined();

    await settle();
    expect(auditService.logEvent).toHaveBeenCalled();
  });

  // ── markBulk() ────────────────────────────────────────────────────────

  it('markBulk: marks unlocked records and skips locked ones', async () => {
    const memberA = new Types.ObjectId().toString();
    const memberB = new Types.ObjectId().toString();

    // Member A unlocked; Member B locked for the same date.
    salaryModel.findOne.mockImplementation((filter: any) => {
      const memId = filter.teamMemberId?.toString();
      const isLockedForB = memId === memberB;
      return {
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue(isLockedForB ? { isLocked: true } : null),
          }),
        }),
      };
    });

    const result = await svc.markBulk(workspaceId, userId, {
      records: [
        { teamMemberId: memberA, date: '2026-05-11', status: 'Present' },
        { teamMemberId: memberB, date: '2026-05-11', status: 'Present' },
      ],
    });

    expect(result).toMatchObject({ marked: 1, skippedLocked: 1 });
    expect(eventService.bulkInsertEvents).toHaveBeenCalledTimes(1);
    expect(projectionService.recompute).toHaveBeenCalledTimes(1);
    expect(projectionService.recompute).toHaveBeenCalledWith(
      workspaceId,
      memberA,
      expect.any(Date),
    );

    await settle();
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'attendance.marked_bulk',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta).toMatchObject({ recordCount: 2, marked: 1, skippedLocked: 1 });

    expect(postHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'attendance.marked_bulk',
        properties: expect.objectContaining({ marked: 1, skippedLocked: 1 }),
      }),
    );
  });

  it('markBulk: empty record set produces zero side effects but still returns counts', async () => {
    const result = await svc.markBulk(workspaceId, userId, { records: [] });

    expect(result).toMatchObject({ marked: 0, skippedLocked: 0 });
    expect(eventService.bulkInsertEvents).not.toHaveBeenCalled();
    expect(projectionService.recompute).not.toHaveBeenCalled();
  });

  // ── remove() ──────────────────────────────────────────────────────────

  it('remove: deletes record + emits status_set void event + fires audit + posthog with actor', async () => {
    const result = await svc.remove(workspaceId, memberId, '2026-05-11', userId);

    expect(result).toMatchObject({ message: 'Attendance record removed successfully' });
    expect(eventService.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        wsId: workspaceId,
        teamMemberId: memberId,
        punchType: 'STATUS_SET',
        statusValue: null,
        markedBy: userId,
      }),
    );
    expect(attendanceModel.deleteOne).toHaveBeenCalled();

    await settle();
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'attendance.removed_record',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0]).toMatchObject({
      workspaceId,
      module: AppModule.ATTENDANCE,
      action: 'attendance.removed_record',
    });
    expect(auditCall[0].actorId.toString()).toBe(userId);

    expect(postHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: userId,
        event: 'attendance.removed_record',
      }),
    );
  });

  it('remove: legacy callers without userId skip audit + posthog gracefully', async () => {
    const result = await svc.remove(workspaceId, memberId, '2026-05-11');

    expect(result).toMatchObject({ message: 'Attendance record removed successfully' });
    expect(attendanceModel.deleteOne).toHaveBeenCalled();

    await settle();
    expect(auditService.logEvent).not.toHaveBeenCalled();
    expect(postHog.capture).not.toHaveBeenCalled();
  });
});
