/**
 * TEST-05 — Regularization service integration test.
 *
 * Uses mongodb-memory-server for real Mongoose model operations.
 * Only AttendanceEventService, AttendanceProjectionService, MailService,
 * NotificationsService, and ConfigService are stubbed (spy objects).
 * All Mongoose models (RegularizationRequest, TeamMember, Salary,
 * Workspace, Attendance, User) use real in-memory MongoDB operations.
 *
 * Scenarios:
 * 1. Happy path: 1-level chain, L1 approver resolved correctly at create.
 * 2. Approve L1 (non-final) in 2-level chain → currentLevel advances, no event.
 * 3. Approve L2 (final) → status='approved', AttendanceEvent persisted, recompute triggered.
 * 4. Salary-invalidation: unlocked Salary for (member, year, month) → salaryInvalidated=true + invalidatedMonth.
 * 5. Salary-invalidation blocked: LOCKED Salary at create throws PAYROLL_LOCKED.
 * 6. Soft-deleted manager skipped → chain walks to fallback.
 * 7. Reject: no AttendanceEvent written; projection not triggered.
 * 8. Cancel by raiser: status=cancelled; no event, no recompute.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import mongoose, { Types, Schema } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  TestMongo,
} from '../../../test-utils/mongo-memory';

// vi.mock() calls are HOISTED by Vitest — they run before any imports are
// evaluated. We intercept the attendance service modules to prevent the
// NestJS @Prop() decorator from being triggered on attendance.schema.ts
// (which has `workspaceId: Workspace | Types.ObjectId` union types that the
// decorator cannot resolve at Vitest evaluation time).
// This matches the technique used in regularization.service.vitest.ts.
// The actual AttendanceEventService and AttendanceProjectionService instances
// are replaced by spy objects in beforeAll — these mocks just prevent the
// schema decorator error from firing during module resolution.
vi.mock('../../attendance/attendance-event.service', () => ({
  AttendanceEventService: class {},
}));
vi.mock('../../attendance/attendance-projection.service', () => ({
  AttendanceProjectionService: class {},
}));

import {
  RegularizationRequest,
  RegularizationRequestSchema,
} from '../schemas/regularization-request.schema';

// Imported after vi.mock() hoists — attendance modules are already intercepted.
import { RegularizationService } from '../regularization.service';
import { RegularizationResolverService } from '../regularization-resolver.service';

// ── Inline schemas ────────────────────────────────────────────────────────────
//
// Several production schemas (Attendance, Salary, TeamMember) use union types
// on their TypeScript properties (e.g. `workspaceId: Workspace | Types.ObjectId`)
// which cause the NestJS @Prop() decorator to throw "Cannot determine a type"
// when evaluated in Vitest's ESM context. This is a pre-existing incompatibility
// with the NestJS schema metadata system documented in H4-01-SUMMARY.md.
//
// Solution: define narrow inline schemas containing only the fields that
// RegularizationService and RegularizationResolverService actually query.
// These are NOT mocks — each model still operates against real mongodb-memory-server
// with real Mongoose inserts/queries. Only the TypeScript schema class definition
// is replaced with plain Schema objects to avoid the decorator error.

/** TeamMember: fields read by RegularizationResolverService.resolveApprovers */
const TeamMemberSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    linkedUserId: { type: Schema.Types.ObjectId, default: null },
    reportsTo: { type: Schema.Types.ObjectId, default: null },
    isDeleted: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { strict: false, timestamps: true },
);

/** Attendance: fields read by RegularizationService to snapshot currentStatus */
const AttendanceSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    teamMemberId: { type: Schema.Types.ObjectId, required: true },
    date: { type: Date, required: true },
    status: { type: String, required: true },
  },
  { strict: false, timestamps: true },
);
// Unique index mirrors the production schema so concurrent insert conflicts work
AttendanceSchema.index({ workspaceId: 1, teamMemberId: 1, date: 1 }, { unique: true });

/** Salary: fields read by RegularizationService._assertPayrollNotLocked and D-06 check */
const SalarySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    teamMemberId: { type: Schema.Types.ObjectId, required: true },
    month: { type: Number, required: true },
    year: { type: Number, required: true },
    isLocked: { type: Boolean, default: false },
    // Required fields from the full schema needed to satisfy strict validation
    baseSalary: { type: Number, default: 0 },
    totalDays: { type: Number, default: 0 },
    presentDays: { type: Number, default: 0 },
    salaryType: { type: String, default: 'monthly' },
    salaryDayBasis: { type: String, default: 'fixed_month_days' },
    attendancePayModeApplied: { type: String, default: 'enabled' },
    deductions: { type: Number, default: 0 },
    additions: { type: Number, default: 0 },
    netSalary: { type: Number, default: 0 },
  },
  { strict: false, timestamps: true },
);
SalarySchema.index({ workspaceId: 1, teamMemberId: 1, month: 1, year: 1 }, { unique: true });

/** Workspace: regularizationConfig read at create + approve */
const WorkspaceSchema = new Schema(
  {
    name: { type: String, default: 'Test Workspace' },
    regularizationConfig: { type: Schema.Types.Mixed, default: null },
  },
  { strict: false },
);

/**
 * AttendanceEvent: fields written by eventServiceSpy.createEvent and used to
 * back-link resultingEventId on the request. The production AttendanceEventSchema
 * has a file-upload index combining both `sparse: true` and
 * `partialFilterExpression` which mongodb-memory-server (MongoDB 5+) rejects
 * with "cannot mix" error. We use a narrow inline schema without that
 * conflicting index — we only need the biometric-dedup unique index (wsId +
 * deviceSerial + deviceUserId + timestamp) for correct integration behaviour,
 * and even that index is not exercised in the regularization test scenarios
 * (all events here have deviceSerial=null, so the partial index is inactive).
 */
const AttendanceEventInlineSchema = new Schema(
  {
    wsId: { type: Schema.Types.ObjectId, required: true },
    teamMemberId: { type: Schema.Types.ObjectId, default: null },
    deviceSerial: { type: String, default: null },
    deviceUserId: { type: String, default: null },
    timestamp: { type: Date, required: true },
    punchType: { type: String, required: true },
    statusValue: { type: String, default: null },
    verifyMethod: { type: String, default: null },
    source: { type: String, required: true },
    sourceMeta: { type: Schema.Types.Mixed, default: null },
    markedBy: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, default: null },
    importHash: { type: String, default: null },
    correctsEventId: { type: Schema.Types.ObjectId, default: null },
  },
  { strict: false, timestamps: { createdAt: true, updatedAt: false } },
);
// Biometric dedup: unique partial index (deviceSerial must be non-null to activate).
// Compatible with mongodb-memory-server — no sparse+partialFilterExpression mix.
AttendanceEventInlineSchema.index(
  { wsId: 1, deviceSerial: 1, deviceUserId: 1, timestamp: 1 },
  { unique: true, partialFilterExpression: { deviceSerial: { $type: 'string' } } },
);

/** User: name + email fetched for notification helpers */
const UserSchema = new Schema(
  {
    name: { type: String, default: 'Test User' },
    email: { type: String, default: 'test@example.com' },
  },
  { strict: false },
);

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Regularization service integration (TEST-05)', () => {
  let mongo: TestMongo;
  let models: {
    request: mongoose.Model<any>;
    member: mongoose.Model<any>;
    attendance: mongoose.Model<any>;
    event: mongoose.Model<any>;
    salary: mongoose.Model<any>;
    workspace: mongoose.Model<any>;
    user: mongoose.Model<any>;
  };

  let service: RegularizationService;
  let resolver: RegularizationResolverService;

  let eventServiceSpy: { createEvent: ReturnType<typeof vi.fn> };
  let projectionServiceSpy: { recompute: ReturnType<typeof vi.fn> };
  let notifySpy: { createNotification: ReturnType<typeof vi.fn> };
  let mailSpy: {
    sendRegularizationPendingApprover: ReturnType<typeof vi.fn>;
    sendRegularizationNextApprover: ReturnType<typeof vi.fn>;
    sendRegularizationApproved: ReturnType<typeof vi.fn>;
    sendRegularizationRejected: ReturnType<typeof vi.fn>;
  };

  beforeAll(async () => {
    mongo = await createTestMongoose();

    // Register models on the in-memory connection.
    // Use try/catch because multiple integration suites running in the same
    // process share the mongoose model registry.
    function getOrDefine<T>(name: string, schema: Schema): mongoose.Model<T> {
      try {
        return mongoose.model<T>(name);
      } catch {
        return mongoose.model<T>(name, schema);
      }
    }

    // Model names must match the string tokens used by RegularizationService
    // (@InjectModel('TeamMember'), @InjectModel('Workspace'), etc.) and the
    // service's internal findOne/findById calls that pass the model name.
    models = {
      request: getOrDefine(RegularizationRequest.name, RegularizationRequestSchema),
      member: getOrDefine('TeamMember', TeamMemberSchema),
      attendance: getOrDefine('Attendance', AttendanceSchema),
      // 'AttendanceEvent' is the model name expected by the service's eventService spy
      // (it is not injected by the service directly — the spy handles writes).
      // Use the inline schema to avoid the sparse+partialFilterExpression conflict.
      event: getOrDefine('AttendanceEvent', AttendanceEventInlineSchema),
      salary: getOrDefine('Salary', SalarySchema),
      workspace: getOrDefine('Workspace', WorkspaceSchema),
      user: getOrDefine('User', UserSchema),
    };

    await models.request.syncIndexes();
    await models.member.syncIndexes();
    await models.attendance.syncIndexes();
    await models.event.syncIndexes();
    await models.salary.syncIndexes();

    // Construct resolver with the real TeamMember model.
    resolver = new RegularizationResolverService(models.member as any);

    // Spy stubs: AttendanceEventService actually writes a real AttendanceEvent
    // document (threat-model T-H4-04-02 mitigation — resultingEventId path is
    // exercised end-to-end).
    eventServiceSpy = {
      createEvent: vi.fn().mockImplementation(async (input: any) => {
        const created = await models.event.create({
          wsId: input.wsId,
          teamMemberId: input.teamMemberId,
          timestamp: input.timestamp,
          punchType: input.punchType,
          source: input.source,
          statusValue: input.statusValue ?? null,
          markedBy: input.markedBy ?? null,
          sourceMeta: input.sourceMeta ?? {},
          deviceSerial: null,
          deviceUserId: null,
          verifyMethod: null,
          note: null,
          importHash: null,
          correctsEventId: null,
        });
        return created;
      }),
    };

    projectionServiceSpy = {
      recompute: vi.fn().mockResolvedValue({ updated: true, status: 'present' }),
    };

    notifySpy = {
      createNotification: vi.fn().mockResolvedValue(null),
    };

    mailSpy = {
      sendRegularizationPendingApprover: vi.fn().mockResolvedValue(null),
      sendRegularizationNextApprover: vi.fn().mockResolvedValue(null),
      sendRegularizationApproved: vi.fn().mockResolvedValue(null),
      sendRegularizationRejected: vi.fn().mockResolvedValue(null),
    };

    const configSpy = {
      get: vi.fn().mockReturnValue('https://test.zari360.example'),
    };

    service = new RegularizationService(
      models.request as any,
      models.workspace as any,
      models.member as any,
      models.salary as any,
      models.attendance as any,
      models.user as any,
      resolver,
      eventServiceSpy as any,
      projectionServiceSpy as any,
      mailSpy as any,
      notifySpy as any,
      configSpy as any,
      { logEvent: vi.fn().mockResolvedValue(undefined) } as any, // auditService
      { capture: vi.fn() } as any, // postHog
    );
  });

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
    // Rebuild indexes after collection clear (partial/unique indexes are dropped with the collection).
    await models.request.syncIndexes();
    await models.member.syncIndexes();
    await models.event.syncIndexes();
    await models.salary.syncIndexes();
    vi.clearAllMocks();
  });

  // ── Seed helpers ─────────────────────────────────────────────────────────

  /**
   * Seed a minimal workspace and a 3-tier TeamMember chain:
   *   raiser → L1 manager → L2 manager (optional deleted) → fallback user
   *
   * Returns IDs needed by test bodies.
   */
  async function seedWorkspaceAndChain(
    opts: {
      approvalLevels?: number;
      fallbackApprover?: string | null;
      l2Deleted?: boolean;
    } = {},
  ): Promise<{
    wsId: string;
    wsObjId: Types.ObjectId;
    raiserUserId: string;
    raiserMemberId: string;
    l1UserId: string;
    l2UserId: string;
    fallbackUserId: string;
    regDate: Date;
  }> {
    const { approvalLevels = 1, fallbackApprover = null, l2Deleted = false } = opts;

    // Users
    const raiserUser = await models.user.create({ name: 'Alice', email: 'alice@test.com' });
    const l1User = await models.user.create({ name: 'L1 Manager', email: 'l1@test.com' });
    const l2User = await models.user.create({ name: 'L2 Manager', email: 'l2@test.com' });
    const fallbackUser = await models.user.create({ name: 'Fallback', email: 'fallback@test.com' });

    // Workspace
    const fbId = fallbackApprover === 'auto' ? fallbackUser._id.toString() : fallbackApprover;
    const ws = await models.workspace.create({
      name: 'Test Workspace',
      regularizationConfig: {
        approvalLevels,
        fallbackApprover: fbId,
        maxDaysBack: 90,
        maxAttachmentsPerRequest: 5,
      },
    });
    const wsObjId = ws._id as Types.ObjectId;

    // TeamMembers: L2 manager (top), L1 manager (reports to L2), raiser (reports to L1).
    // When l2Deleted=true, seed the L2 manager with isDeleted: true to verify
    // D-04 (resolveApprovers must skip isDeleted: true managers in the chain).
    const l2Member = await models.member.create({
      workspaceId: wsObjId,
      name: 'L2 Manager',
      linkedUserId: l2User._id,
      reportsTo: null,
      isDeleted: l2Deleted ? true : false, // isDeleted: true when testing soft-delete skip
      isActive: true,
    });
    const l1Member = await models.member.create({
      workspaceId: wsObjId,
      name: 'L1 Manager',
      linkedUserId: l1User._id,
      reportsTo: l2Member._id,
      isDeleted: false,
      isActive: true,
    });
    const raiserMember = await models.member.create({
      workspaceId: wsObjId,
      name: 'Alice',
      linkedUserId: raiserUser._id,
      reportsTo: l1Member._id,
      isDeleted: false,
      isActive: true,
    });

    // A date in the past within maxDaysBack=90
    const regDate = new Date(Date.UTC(2026, 3, 15)); // 2026-04-15 UTC midnight

    return {
      wsId: wsObjId.toString(),
      wsObjId,
      raiserUserId: raiserUser._id.toString(),
      raiserMemberId: raiserMember._id.toString(),
      l1UserId: l1User._id.toString(),
      l2UserId: l2User._id.toString(),
      fallbackUserId: fallbackUser._id.toString(),
      regDate,
    };
  }

  // ── Scenario 1: 1-level chain happy path ────────────────────────────────

  it('happy path: 1-level chain creates pending request with L1 approver snapshot', async () => {
    const { wsId, raiserUserId, raiserMemberId, l1UserId } = await seedWorkspaceAndChain({
      approvalLevels: 1,
    });

    const doc = await service.create({
      wsId,
      raisedBy: raiserUserId,
      memberId: raiserMemberId,
      date: '2026-04-15',
      requestedStatus: 'PRESENT',
      reason: 'Was present but machine missed the punch',
    });

    expect(doc.status).toBe('pending');
    expect(doc.approvalChain).toHaveLength(1);
    expect(doc.approvalChain[0].level).toBe(1);
    expect(doc.approvalChain[0].approverUserId.toString()).toBe(l1UserId);
    expect(doc.currentLevel).toBe(1);
    expect(doc.salaryInvalidated).toBe(false);
  });

  // ── Scenario 2: 2-level chain — L1 non-final approve ────────────────────

  it('2-level chain: L1 approve (non-final) advances currentLevel; no event written', async () => {
    const { wsId, raiserUserId, raiserMemberId, l1UserId } = await seedWorkspaceAndChain({
      approvalLevels: 2,
      fallbackApprover: 'auto',
    });

    const created = await service.create({
      wsId,
      raisedBy: raiserUserId,
      memberId: raiserMemberId,
      date: '2026-04-15',
      requestedStatus: 'PRESENT',
      reason: 'Was present but machine missed the punch',
    });

    expect(created.status).toBe('pending');
    expect(created.approvalChain).toHaveLength(2);

    const updated = await service.approveStep(
      wsId,
      (created._id as Types.ObjectId).toString(),
      l1UserId,
    );

    expect(updated.status).toBe('pending');
    expect(updated.currentLevel).toBe(2);
    expect(eventServiceSpy.createEvent).not.toHaveBeenCalled();
    expect(projectionServiceSpy.recompute).not.toHaveBeenCalled();
  });

  // ── Scenario 3: 2-level chain — L2 final approve ────────────────────────

  it('2-level chain: L2 approve (final) writes AttendanceEvent, triggers projection recompute, back-links resultingEventId', async () => {
    const { wsId, raiserUserId, raiserMemberId, l1UserId, l2UserId, fallbackUserId } =
      await seedWorkspaceAndChain({ approvalLevels: 2, fallbackApprover: 'auto' });

    const created = await service.create({
      wsId,
      raisedBy: raiserUserId,
      memberId: raiserMemberId,
      date: '2026-04-15',
      requestedStatus: 'PRESENT',
      reason: 'Was present but machine missed the punch',
    });

    // L1 approves
    const afterL1 = await service.approveStep(
      wsId,
      (created._id as Types.ObjectId).toString(),
      l1UserId,
    );
    expect(afterL1.status).toBe('pending');

    // Determine L2 approver from chain
    const l2ApproverUserId = afterL1.approvalChain[1].approverUserId.toString();

    // L2 approves (final)
    const finalUpdated = await service.approveStep(
      wsId,
      (created._id as Types.ObjectId).toString(),
      l2ApproverUserId,
    );

    expect(finalUpdated.status).toBe('approved');
    expect(finalUpdated.resultingEventId).not.toBeNull();
    expect(eventServiceSpy.createEvent).toHaveBeenCalledTimes(1);
    expect(projectionServiceSpy.recompute).toHaveBeenCalledTimes(1);
    expect(projectionServiceSpy.recompute).toHaveBeenCalledWith(
      wsId,
      raiserMemberId,
      expect.any(Date),
    );

    // Verify the event was actually written to the collection
    const eventCount = await models.event.countDocuments({ wsId: new Types.ObjectId(wsId) });
    expect(eventCount).toBe(1);
  });

  // ── Scenario 4: Salary invalidation with UNLOCKED salary ────────────────

  it('salary-invalidation: approving a month with an UNLOCKED Salary sets salaryInvalidated=true and returns invalidatedMonth', async () => {
    const { wsId, wsObjId, raiserUserId, raiserMemberId, l1UserId } = await seedWorkspaceAndChain({
      approvalLevels: 1,
    });

    // Seed an UNLOCKED Salary doc for April 2026 (month=4, year=2026)
    await models.salary.create({
      workspaceId: wsObjId,
      teamMemberId: new Types.ObjectId(raiserMemberId),
      month: 4,
      year: 2026,
      baseSalary: 30000,
      totalDays: 30,
      presentDays: 29,
      salaryType: 'monthly',
      salaryDayBasis: 'fixed_month_days',
      attendancePayModeApplied: 'enabled',
      deductions: 0,
      additions: 0,
      netSalary: 30000,
      isLocked: false,
    });

    const created = await service.create({
      wsId,
      raisedBy: raiserUserId,
      memberId: raiserMemberId,
      date: '2026-04-15',
      requestedStatus: 'PRESENT',
      reason: 'Was present but machine missed the punch',
    });

    // Approve (final — 1-level chain)
    const finalUpdated = (await service.approveStep(
      wsId,
      (created._id as Types.ObjectId).toString(),
      l1UserId,
    )) as any;

    // Verify salaryInvalidated=true returned in response (assertion 1)
    expect(finalUpdated.salaryInvalidated).toBe(true);

    // Verify invalidatedMonth string in response envelope (assertion 2 — T-H4-04-03 mitigation)
    expect(finalUpdated.invalidatedMonth).toBe('2026-04');

    // Persistence check — field must be persisted on the document (assertion 3)
    const persisted = await models.request.findById(created._id).lean();
    expect(persisted?.salaryInvalidated).toBe(true);
  });

  // ── Scenario 5: Salary locked at create → PAYROLL_LOCKED thrown ─────────

  it('salary-invalidation: LOCKED Salary at create throws PAYROLL_LOCKED — no invalidation path reached', async () => {
    const { wsId, wsObjId, raiserUserId, raiserMemberId } = await seedWorkspaceAndChain({
      approvalLevels: 1,
    });

    // Seed a LOCKED Salary doc for April 2026
    await models.salary.create({
      workspaceId: wsObjId,
      teamMemberId: new Types.ObjectId(raiserMemberId),
      month: 4,
      year: 2026,
      baseSalary: 30000,
      totalDays: 30,
      presentDays: 29,
      salaryType: 'monthly',
      salaryDayBasis: 'fixed_month_days',
      attendancePayModeApplied: 'enabled',
      deductions: 0,
      additions: 0,
      netSalary: 30000,
      isLocked: true,
    });

    // Expect create to throw PAYROLL_LOCKED
    await expect(
      service.create({
        wsId,
        raisedBy: raiserUserId,
        memberId: raiserMemberId,
        date: '2026-04-15',
        requestedStatus: 'PRESENT',
        reason: 'Was present but machine missed the punch',
      }),
    ).rejects.toThrow('PAYROLL_LOCKED');

    // No request should have been created
    const count = await models.request.countDocuments({});
    expect(count).toBe(0);
  });

  // ── Scenario 6: Soft-deleted manager skipped → fallback fills chain ──────

  it('soft-deleted manager (isDeleted:true) in chain is skipped — chain walks to fallback', async () => {
    // l2Deleted=true: L2 manager has isDeleted:true, so chain walk stops at L1.
    // With fallbackApprover='auto', the fallback fills the remaining L2 slot.
    const { wsId, raiserUserId, raiserMemberId, l1UserId, fallbackUserId } =
      await seedWorkspaceAndChain({
        approvalLevels: 2,
        fallbackApprover: 'auto',
        l2Deleted: true,
      });

    const doc = await service.create({
      wsId,
      raisedBy: raiserUserId,
      memberId: raiserMemberId,
      date: '2026-04-15',
      requestedStatus: 'PRESENT',
      reason: 'Was present but machine missed the punch',
    });

    // Chain must have 2 levels (approvalLevels=2)
    expect(doc.approvalChain).toHaveLength(2);

    // L1 must be the live L1 manager
    expect(doc.approvalChain[0].approverUserId.toString()).toBe(l1UserId);

    // L2 must be the fallback (not the deleted L2 manager)
    expect(doc.approvalChain[1].approverUserId.toString()).toBe(fallbackUserId);

    // The deleted L2 user must NOT appear anywhere in the chain
    const deletedL2InChain = doc.approvalChain.find((s: any) => {
      // If l2UserId ended up in chain despite isDeleted:true — test fails
      return (
        s.approverUserId.toString() !== l1UserId && s.approverUserId.toString() !== fallbackUserId
      );
    });
    expect(deletedL2InChain).toBeUndefined();
  });

  // ── Scenario 7: Reject path — no AttendanceEvent written ────────────────

  it('reject: no AttendanceEvent written; projection recompute not triggered', async () => {
    const { wsId, raiserUserId, raiserMemberId, l1UserId } = await seedWorkspaceAndChain({
      approvalLevels: 1,
    });

    const created = await service.create({
      wsId,
      raisedBy: raiserUserId,
      memberId: raiserMemberId,
      date: '2026-04-15',
      requestedStatus: 'PRESENT',
      reason: 'Was present but machine missed the punch',
    });

    const rejected = await service.reject(
      wsId,
      (created._id as Types.ObjectId).toString(),
      l1UserId,
      'Does not match records',
    );

    expect(rejected.status).toBe('rejected');
    expect(eventServiceSpy.createEvent).not.toHaveBeenCalled();
    expect(projectionServiceSpy.recompute).not.toHaveBeenCalled();

    // Confirm the request document persists with status=rejected
    const persisted = await models.request.findById(created._id).lean();
    expect(persisted?.status).toBe('rejected');
  });

  // ── Scenario 8: Cancel by raiser ────────────────────────────────────────

  it('cancel by raiser: transitions to cancelled; no event, no recompute', async () => {
    const { wsId, raiserUserId, raiserMemberId } = await seedWorkspaceAndChain({
      approvalLevels: 1,
    });

    const created = await service.create({
      wsId,
      raisedBy: raiserUserId,
      memberId: raiserMemberId,
      date: '2026-04-15',
      requestedStatus: 'PRESENT',
      reason: 'Was present but machine missed the punch',
    });

    const cancelled = await service.cancel(
      wsId,
      (created._id as Types.ObjectId).toString(),
      raiserUserId,
    );

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finalDecisionAt).toBeInstanceOf(Date);
    expect(eventServiceSpy.createEvent).not.toHaveBeenCalled();
    expect(projectionServiceSpy.recompute).not.toHaveBeenCalled();

    // Verify persistence
    const persisted = await models.request.findById(created._id).lean();
    expect(persisted?.status).toBe('cancelled');
  });
});
