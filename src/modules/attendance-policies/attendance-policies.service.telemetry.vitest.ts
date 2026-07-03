/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion */
/**
 * Vitest unit tests for AttendancePoliciesService W4 telemetry —
 * PostHog capture + AuditService.logEvent on create / update / remove.
 *
 * Strategy: Mock all NestJS/Mongoose decorator packages so @Prop / @Schema /
 * @Injectable decorators are no-ops during test collection, then directly
 * instantiate the service with plain vi.fn() mock objects.
 *
 * Covers: W4 task-3 — three write methods emit the right PostHog event AND
 * an AuditService.logEvent call when a userId is supplied.
 */
import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

// ---------------------------------------------------------------------------
// Mock NestJS + Mongoose decorator packages before any service import so
// @Prop / @Schema / @Injectable / @Inject / forwardRef decorators are no-ops.
// Mirrors the workspace W5/W6 pattern (team.service.audit.vitest.ts).
// ---------------------------------------------------------------------------
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
    constructor(msg: string) {
      super(msg);
      this.name = 'NotFoundException';
    }
  },
  BadRequestException: class BadRequestException extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'BadRequestException';
    }
  },
}));

// Mock schema files to plain objects — prevents Mongoose decorator errors
vi.mock('./schemas/attendance-policy.schema', () => ({
  AttendancePolicy: class {},
  AttendancePolicySchema: {},
}));

vi.mock('../attendance/schemas/attendance.schema', () => ({
  Attendance: class {},
  AttendanceSchema: {},
}));

vi.mock('../attendance/attendance-event.service', () => ({
  AttendanceEventService: class {
    findByMemberDateRange = vi.fn().mockResolvedValue([]);
  },
}));

// Mock the compute module — pure functions, not needed for write-path tests
vi.mock('../attendance/projection/compute', () => ({
  computeDailySummary: vi.fn(),
  DEFAULT_SHIFT_SNAPSHOT: {},
  DEFAULT_POLICY_SNAPSHOT: {},
}));

// Mock DTOs — shapes not needed for write-path unit tests
vi.mock('./dto/attendance-policy.dto', () => ({
  CreateAttendancePolicyDto: class {},
  UpdateAttendancePolicyDto: class {},
  DryRunDto: class {},
}));

// Now import service — all decorators are no-ops
import { AttendancePoliciesService } from './attendance-policies.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a query-chain mock that mirrors .findOne(filter).lean().exec() */
const makeQuery = <T>(result: T) => ({
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(result),
});

const WS_ID = '507f1f77bcf86cd799439011';
const POLICY_ID = '507f1f77bcf86cd799439021';
const USER_ID = '507f1f77bcf86cd799439031';

const mkPolicy = (overrides: Partial<Record<string, any>> = {}) => ({
  _id: new Types.ObjectId(POLICY_ID),
  name: 'TestPolicy',
  isDefault: false,
  wsId: new Types.ObjectId(WS_ID),
  lateArrival: { countAsLop: false, lopAfterNLateDays: null },
  earlyDeparture: { enabled: false, thresholdMinutes: 30, countAsHalfDay: false },
  ot: { enabled: false, thresholdMinutes: 30, capMinutes: null },
  compOff: { enabled: false },
  ...overrides,
});

/** Build service with fresh mocks. Returns service + mock handles. */
function buildService() {
  const policyModel = {
    create: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findByIdAndDelete: vi.fn(),
    updateMany: vi.fn(),
  };
  const attendanceModel = { find: vi.fn() };
  const eventService = { findByMemberDateRange: vi.fn().mockResolvedValue([]) };
  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn() };

  const svc = new AttendancePoliciesService(
    policyModel as any,
    attendanceModel as any,
    eventService as any,
    auditService as any,
    postHog as any,
  );

  return { svc, policyModel, auditService, postHog };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AttendancePoliciesService — W4 telemetry (PostHog + Audit)', () => {
  describe('create', () => {
    it('fires attendance.created_policy PostHog event when userId is supplied', async () => {
      const { svc, policyModel, postHog } = buildService();

      const createdDoc = mkPolicy({ isDefault: false });
      // policyModel.create returns a mongoose Document-like with toObject()
      policyModel.create.mockResolvedValue({
        ...createdDoc,
        toObject: () => createdDoc,
      });
      // unsetOtherDefaults path — updateMany (only called when isDefault=true, not here)
      policyModel.updateMany.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.create(WS_ID, { name: 'TestPolicy', isDefault: false } as any, USER_ID);

      const call = postHog.capture.mock.calls.find(
        (c: any[]) => c[0].event === 'attendance.created_policy',
      );
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        distinctId: USER_ID,
        event: 'attendance.created_policy',
        properties: expect.objectContaining({
          workspaceId: WS_ID,
          policyId: String(createdDoc._id),
        }),
      });
    });

    it('fires audit logEvent with action attendance.policy_created when userId is supplied', async () => {
      const { svc, policyModel, auditService } = buildService();

      const createdDoc = mkPolicy({ isDefault: false });
      policyModel.create.mockResolvedValue({
        ...createdDoc,
        toObject: () => createdDoc,
      });
      policyModel.updateMany.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.create(WS_ID, { name: 'TestPolicy', isDefault: false } as any, USER_ID);

      // auditPolicyEvent is fire-and-forget (void + .catch); await microtask flush
      await Promise.resolve();

      const call = auditService.logEvent.mock.calls.find(
        (c: any[]) => c[0].action === 'attendance.policy_created',
      );
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.ATTENDANCE,
        action: 'attendance.policy_created',
        workspaceId: WS_ID,
        actorId: USER_ID,
        entityType: 'attendance_policy',
      });
    });

    it('does NOT fire PostHog or audit when userId is omitted', async () => {
      const { svc, policyModel, postHog, auditService } = buildService();

      const createdDoc = mkPolicy();
      policyModel.create.mockResolvedValue({
        ...createdDoc,
        toObject: () => createdDoc,
      });
      policyModel.updateMany.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.create(WS_ID, { name: 'TestPolicy' } as any /* no userId */);

      expect(postHog.capture).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(auditService.logEvent).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('fires attendance.updated_policy PostHog event when userId is supplied', async () => {
      const { svc, policyModel, postHog } = buildService();

      const existing = mkPolicy();
      policyModel.findOne.mockReturnValue(makeQuery(existing));
      const updated = mkPolicy({ name: 'Updated' });
      policyModel.findByIdAndUpdate.mockReturnValue(makeQuery(updated));
      policyModel.updateMany.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.update(WS_ID, POLICY_ID, { name: 'Updated' } as any, USER_ID);

      const call = postHog.capture.mock.calls.find(
        (c: any[]) => c[0].event === 'attendance.updated_policy',
      );
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        distinctId: USER_ID,
        event: 'attendance.updated_policy',
        properties: expect.objectContaining({
          workspaceId: WS_ID,
          policyId: POLICY_ID,
        }),
      });
    });

    it('fires audit logEvent with action attendance.policy_updated when userId is supplied', async () => {
      const { svc, policyModel, auditService } = buildService();

      const existing = mkPolicy();
      policyModel.findOne.mockReturnValue(makeQuery(existing));
      policyModel.findByIdAndUpdate.mockReturnValue(makeQuery(mkPolicy({ name: 'Updated' })));
      policyModel.updateMany.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.update(WS_ID, POLICY_ID, { name: 'Updated' } as any, USER_ID);

      await Promise.resolve();

      const call = auditService.logEvent.mock.calls.find(
        (c: any[]) => c[0].action === 'attendance.policy_updated',
      );
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.ATTENDANCE,
        action: 'attendance.policy_updated',
        workspaceId: WS_ID,
        actorId: USER_ID,
        entityType: 'attendance_policy',
        entityId: POLICY_ID,
      });
    });

    it('does NOT fire PostHog or audit when userId is omitted', async () => {
      const { svc, policyModel, postHog, auditService } = buildService();

      policyModel.findOne.mockReturnValue(makeQuery(mkPolicy()));
      policyModel.findByIdAndUpdate.mockReturnValue(makeQuery(mkPolicy()));
      policyModel.updateMany.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.update(WS_ID, POLICY_ID, {} as any /* no userId */);

      expect(postHog.capture).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(auditService.logEvent).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('fires attendance.deleted_policy PostHog event when userId is supplied', async () => {
      const { svc, policyModel, postHog } = buildService();

      policyModel.findOne.mockReturnValue(makeQuery(mkPolicy({ isDefault: false })));
      policyModel.findByIdAndDelete.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.remove(WS_ID, POLICY_ID, USER_ID);

      const call = postHog.capture.mock.calls.find(
        (c: any[]) => c[0].event === 'attendance.deleted_policy',
      );
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        distinctId: USER_ID,
        event: 'attendance.deleted_policy',
        properties: expect.objectContaining({
          workspaceId: WS_ID,
          policyId: POLICY_ID,
        }),
      });
    });

    it('fires audit logEvent with action attendance.policy_deleted when userId is supplied', async () => {
      const { svc, policyModel, auditService } = buildService();

      policyModel.findOne.mockReturnValue(makeQuery(mkPolicy({ isDefault: false })));
      policyModel.findByIdAndDelete.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.remove(WS_ID, POLICY_ID, USER_ID);

      await Promise.resolve();

      const call = auditService.logEvent.mock.calls.find(
        (c: any[]) => c[0].action === 'attendance.policy_deleted',
      );
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.ATTENDANCE,
        action: 'attendance.policy_deleted',
        workspaceId: WS_ID,
        actorId: USER_ID,
        entityType: 'attendance_policy',
        entityId: POLICY_ID,
      });
    });

    it('does NOT fire PostHog or audit when userId is omitted', async () => {
      const { svc, policyModel, postHog, auditService } = buildService();

      policyModel.findOne.mockReturnValue(makeQuery(mkPolicy({ isDefault: false })));
      policyModel.findByIdAndDelete.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });

      await svc.remove(WS_ID, POLICY_ID /* no userId */);

      expect(postHog.capture).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(auditService.logEvent).not.toHaveBeenCalled();
    });

    it('throws BadRequestException and does NOT fire telemetry when removing the default policy', async () => {
      const { svc, policyModel, postHog, auditService } = buildService();

      policyModel.findOne.mockReturnValue(makeQuery(mkPolicy({ isDefault: true })));

      await expect(svc.remove(WS_ID, POLICY_ID, USER_ID)).rejects.toMatchObject({
        name: 'BadRequestException',
      });
      expect(postHog.capture).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(auditService.logEvent).not.toHaveBeenCalled();
    });

    it('audit failure is swallowed and does NOT break caller', async () => {
      const { svc, policyModel, auditService } = buildService();

      policyModel.findOne.mockReturnValue(makeQuery(mkPolicy({ isDefault: false })));
      policyModel.findByIdAndDelete.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });
      auditService.logEvent.mockRejectedValueOnce(new Error('audit DB down'));

      await expect(svc.remove(WS_ID, POLICY_ID, USER_ID)).resolves.toBeUndefined();

      await Promise.resolve();
      expect(auditService.logEvent).toHaveBeenCalled();
    });
  });
});
