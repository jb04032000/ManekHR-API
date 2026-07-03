/**
 * Vitest unit tests for AttendanceProjectionService.resolveContext() and recompute().
 *
 * Strategy: Mock all NestJS/Mongoose decorator packages so @InjectModel / @Injectable
 * decorators are no-ops during test collection, then directly instantiate the service
 * with plain vi.fn() mock objects.
 *
 * Covers: GAP-1.3-A soft-delete short-circuit — resolveContext returns null for
 * soft-deleted/missing members; recompute and recomputeRange write nothing.
 * Closes: BUG-02
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock NestJS + Mongoose decorator packages before any service import so
// @InjectModel / @Injectable / @Prop / @Schema decorators are no-ops.
// ---------------------------------------------------------------------------
vi.mock('@nestjs/mongoose', () => ({
  InjectModel: () => () => undefined,
  Prop: () => () => undefined,
  Schema: () => (t: any) => t,
  SchemaFactory: { createForClass: () => ({}) },
}));

vi.mock('@nestjs/common', () => ({
  Injectable: () => () => {},
  Inject: () => () => {},
  forwardRef: (fn: any) => fn,
  Logger: class {
    log() {}
    warn() {}
    error() {}
    debug() {}
  },
  NotFoundException: class NotFoundException extends Error {
    constructor(msg: string) { super(msg); this.name = 'NotFoundException'; }
  },
  BadRequestException: class BadRequestException extends Error {
    constructor(msg: string) { super(msg); this.name = 'BadRequestException'; }
  },
}));

// Mock schema files to plain objects — prevents Mongoose decorator errors
vi.mock('./schemas/attendance.schema', () => ({
  Attendance: class {},
  AttendanceSchema: {},
}));

vi.mock('./schemas/attendance-event.schema', () => ({
  AttendanceEvent: class {},
  AttendanceEventSchema: {},
}));

vi.mock('../shifts/schemas/shift.schema', () => ({
  Shift: class {},
  ShiftSchema: {},
}));

vi.mock('../team/schemas/team-member.schema', () => ({
  TeamMember: class {},
  TeamMemberSchema: {},
}));

vi.mock('../attendance-policies/attendance-policies.service', () => ({
  AttendancePoliciesService: class {
    findEffective = vi.fn().mockResolvedValue(null);
    toPolicySnapshot = vi.fn().mockReturnValue({});
  },
}));

vi.mock('./attendance-event.service', () => ({
  AttendanceEventService: class {
    findByMemberDate = vi.fn().mockResolvedValue([]);
    findDistinctMemberDatePairs = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('../salary/schemas/salary.schema', () => ({
  Salary: class {},
  SalarySchema: { index: () => {} },
}));

import { AttendanceProjectionService } from './attendance-projection.service';
import { DEFAULT_POLICY_SNAPSHOT } from './projection/compute';

// ---------------------------------------------------------------------------
// Helper: build a Mongoose lean query chain mock that resolves to returnValue.
// Supports both .select().lean().exec() and .lean().exec() chains.
// ---------------------------------------------------------------------------
function makeLeanChain(returnValue: any) {
  return {
    select: () => ({ lean: () => ({ exec: () => Promise.resolve(returnValue) }) }),
    lean: () => ({ exec: () => Promise.resolve(returnValue) }),
    exec: () => Promise.resolve(returnValue),
  };
}

// ---------------------------------------------------------------------------
// Suite 1: resolveContext — soft-delete guard
// ---------------------------------------------------------------------------
describe('AttendanceProjectionService.resolveContext — soft-delete guard (GAP-1.3-A)', () => {
  let service: AttendanceProjectionService;
  let memberModel: any;
  let shiftModel: any;
  let attendanceModel: any;
  let eventService: any;
  let policiesService: any;

  beforeEach(() => {
    memberModel = { findOne: vi.fn() };
    shiftModel = { findById: vi.fn(() => makeLeanChain(null)) };
    attendanceModel = { findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({}) })) };
    const salaryModel = {
      findOne: vi.fn(() => ({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
      })),
    };
    eventService = {
      findByMemberDate: vi.fn(() => Promise.resolve([])),
      findDistinctMemberDatePairs: vi.fn(() => Promise.resolve([])),
    };
    policiesService = {
      findEffective: vi.fn(() => Promise.resolve(null)),
      toPolicySnapshot: vi.fn(() => DEFAULT_POLICY_SNAPSHOT),
    };
    service = new AttendanceProjectionService(
      attendanceModel as any,
      shiftModel as any,
      memberModel as any,
      salaryModel as any,
      eventService as any,
      policiesService as any,
    );
  });

  it('returns null when member is soft-deleted (Mongo query filtered by isDeleted:false yields null)', async () => {
    memberModel.findOne.mockReturnValueOnce(makeLeanChain(null));
    const ctx = await service.resolveContext(
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
    );
    expect(ctx).toBeNull();
    expect(memberModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ isDeleted: false }),
    );
  });

  it('returns null when member does not exist', async () => {
    memberModel.findOne.mockReturnValueOnce(makeLeanChain(null));
    const ctx = await service.resolveContext(
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439013',
    );
    expect(ctx).toBeNull();
  });

  it('returns a full context for a live member with a shift', async () => {
    memberModel.findOne.mockReturnValueOnce(
      makeLeanChain({ _id: 'm1', shiftId: 's1' }),
    );
    shiftModel.findById = vi.fn(() =>
      makeLeanChain({
        startTime: '09:00',
        endTime: '18:00',
        gracePeriodMinutes: 10,
        halfDayAfterLateMinutes: 60,
        shiftType: 'fixed',
        requiredHoursPerDay: null,
        policyId: null,
      }),
    );
    const ctx = await service.resolveContext(
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439014',
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.shiftSnapshot.startTime).toBe('09:00');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: recompute / recomputeRange — short-circuit on soft-deleted member
// ---------------------------------------------------------------------------
describe('AttendanceProjectionService.recompute — short-circuit on soft-deleted member', () => {
  let service: AttendanceProjectionService;
  let memberModel: any;
  let attendanceModel: any;
  let eventService: any;

  beforeEach(() => {
    memberModel = { findOne: vi.fn(() => makeLeanChain(null)) };
    const shiftModel = { findById: vi.fn(() => makeLeanChain(null)) };
    attendanceModel = { findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({}) })) };
    const salaryModel = {
      findOne: vi.fn(() => ({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
      })),
    };
    eventService = {
      findByMemberDate: vi.fn(() =>
        Promise.resolve([
          {
            timestamp: new Date('2026-04-15T09:00:00Z'),
            punchType: 'check_in',
            statusValue: null,
            source: 'device_push',
          },
        ]),
      ),
      findDistinctMemberDatePairs: vi.fn(() => Promise.resolve([])),
    };
    const policiesService = {
      findEffective: vi.fn(() => Promise.resolve(null)),
      toPolicySnapshot: vi.fn(() => DEFAULT_POLICY_SNAPSHOT),
    };
    service = new AttendanceProjectionService(
      attendanceModel as any,
      shiftModel as any,
      memberModel as any,
      salaryModel as any,
      eventService as any,
      policiesService as any,
    );
  });

  it('recompute returns {updated:false,status:null} and does not write when member is soft-deleted', async () => {
    const res = await service.recompute(
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
      new Date('2026-04-15T00:00:00Z'),
    );
    expect(res).toEqual({ updated: false, status: null });
    expect(attendanceModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('recomputeRange returns {recomputed:0} and does not write when the single memberId is soft-deleted', async () => {
    const res = await service.recomputeRange(
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-04-30T00:00:00Z'),
    );
    expect(res).toEqual({ recomputed: 0 });
    expect(attendanceModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('recompute returns {updated:false,status:null} when salary is locked (H3-05 isSalaryLocked guard)', async () => {
    // Arrange: member exists (non-null) but salary is locked
    const liveMember = { _id: '507f1f77bcf86cd799439012', isDeleted: false };
    const lockedSalaryModel = {
      findOne: vi.fn(() => ({
        select: () => ({
          lean: () => ({ exec: () => Promise.resolve({ isLocked: true }) }),
        }),
      })),
    };
    const liveMemberModel = {
      findOne: vi.fn(() => makeLeanChain(liveMember)),
    };
    const localAttendanceModel = {
      findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
    };
    const localShiftModel = { findById: vi.fn(() => makeLeanChain(null)) };
    const localEventService = {
      findByMemberDate: vi.fn(() => Promise.resolve([])),
      findDistinctMemberDatePairs: vi.fn(() => Promise.resolve([])),
    };
    const localPoliciesService = {
      findEffective: vi.fn(() => Promise.resolve(null)),
      toPolicySnapshot: vi.fn(() => DEFAULT_POLICY_SNAPSHOT),
    };
    const lockedService = new AttendanceProjectionService(
      localAttendanceModel as any,
      localShiftModel as any,
      liveMemberModel as any,
      lockedSalaryModel as any,
      localEventService as any,
      localPoliciesService as any,
    );

    const res = await lockedService.recompute(
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
      new Date('2026-04-15T00:00:00Z'),
    );

    expect(res).toEqual({ updated: false, status: null });
    expect(localAttendanceModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
