/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE any schema import so that transitive
// schema imports (Workspace, DefaulterAlertDispatch, etc.) don't trip vitest's
// esbuild reflect-metadata pipeline.
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
import { DefaulterAlertCron } from '../crons/defaulter-alert.cron';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const wsId = new Types.ObjectId();
const ownerId = new Types.ObjectId();

/** A minimal lean workspace document */
function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    _id: wsId,
    ownerId,
    isActive: true,
    attendanceSettings: {
      complianceThresholdPct: 75,
      defaulterAlerts: {
        enabled: true,
        channels: { inApp: true, email: false },
        recipients: { mode: 'managers' as const, specificPeople: [] },
      },
    },
    ...overrides,
  };
}

/** Members with varying attendanceRate for compliance report */
const membersWithDefaulters = [
  {
    memberId: new Types.ObjectId().toString(),
    name: 'Alice',
    designation: 'Weaver',
    shiftName: 'Morning',
    scheduledDays: 20,
    present: 12,
    late: 2,
    absent: 6,
    halfDay: 0,
    onLeave: 0,
    lateMinutes: 15,
    attendanceRate: 70,
  },
  {
    memberId: new Types.ObjectId().toString(),
    name: 'Bob',
    designation: 'Spinner',
    shiftName: 'Morning',
    scheduledDays: 20,
    present: 19,
    late: 1,
    absent: 0,
    halfDay: 0,
    onLeave: 0,
    lateMinutes: 5,
    attendanceRate: 100,
  },
  {
    memberId: new Types.ObjectId().toString(),
    name: 'Carol',
    designation: 'Helper',
    shiftName: 'Morning',
    scheduledDays: 20,
    present: 10,
    late: 1,
    absent: 9,
    halfDay: 0,
    onLeave: 0,
    lateMinutes: 10,
    attendanceRate: 55,
  },
];

/** Member whose attendanceRate is null (no scheduled days) */
const membersWithNullRate = [
  {
    memberId: new Types.ObjectId().toString(),
    name: 'Dave',
    designation: 'Trainee',
    shiftName: '',
    scheduledDays: 0,
    present: 0,
    late: 0,
    absent: 0,
    halfDay: 0,
    onLeave: 0,
    lateMinutes: 0,
    attendanceRate: null,
  },
];

/** A compliance report with defaulters (below 75%) */
const complianceWithDefaulters = {
  success: true,
  data: {
    month: 4,
    year: 2026,
    summary: {
      totalMembers: 3,
      membersWithRate: 3,
      avgAttendanceRate: 75,
      perfectCount: 1,
      totalLateDays: 3,
      totalAbsentDays: 6,
      totalLateMinutes: 30,
    },
    members: membersWithDefaulters,
  },
};

/** A compliance report with no defaulters (all above 75%) */
const complianceNoDefaulters = {
  success: true,
  data: {
    month: 4,
    year: 2026,
    summary: {
      totalMembers: 2,
      membersWithRate: 2,
      avgAttendanceRate: 95,
      perfectCount: 1,
      totalLateDays: 1,
      totalAbsentDays: 0,
      totalLateMinutes: 5,
    },
    members: [
      {
        memberId: new Types.ObjectId().toString(),
        name: 'Eve',
        designation: 'Weaver',
        shiftName: 'Morning',
        scheduledDays: 20,
        present: 19,
        late: 1,
        absent: 0,
        halfDay: 0,
        onLeave: 0,
        lateMinutes: 5,
        attendanceRate: 100,
      },
      {
        memberId: new Types.ObjectId().toString(),
        name: 'Frank',
        designation: 'Spinner',
        shiftName: 'Morning',
        scheduledDays: 20,
        present: 17,
        late: 2,
        absent: 1,
        halfDay: 0,
        onLeave: 0,
        lateMinutes: 10,
        attendanceRate: 95,
      },
    ],
  },
};

/** A compliance report where all members have null attendanceRate */
const complianceNullRates = {
  success: true,
  data: {
    month: 4,
    year: 2026,
    summary: {
      totalMembers: 1,
      membersWithRate: 0,
      avgAttendanceRate: 0,
      perfectCount: 0,
      totalLateDays: 0,
      totalAbsentDays: 0,
      totalLateMinutes: 0,
    },
    members: membersWithNullRate,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Chain returned by workspaceModel.find() */
function makeFindChain(result: unknown) {
  return {
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(result),
  };
}

/** Chain returned by dispatchModel.findOne() — has select/lean/exec */
function makeFindOneLeanExec(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(result),
  };
}

/**
 * Chain returned by subscriptionModel.find() — the batched query used by
 * run() after Fix 3.  The chain is: find(...).select(...).sort(...).lean().exec()
 */
function makeSubFindChain(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(result),
  };
}

/** Build a minimal entitled-subscription row for a given userId. */
function makeEntitledSub(userId: Types.ObjectId) {
  return {
    _id: new Types.ObjectId(),
    userId,
    status: 'active',
    appliedEntitlements: {
      moduleAccess: [
        {
          module: 'attendance',
          enabled: true,
          subFeatures: [{ key: 'defaulter_alerts', access: 'full' }],
        },
      ],
    },
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('DefaulterAlertCron', () => {
  let workspaceModel: any;
  let dispatchModel: any;
  let subscriptionModel: any;
  let attendanceService: any;
  let defaulterAlertService: any;
  let cron: DefaulterAlertCron;

  // The period being evaluated: previous month from the cron's perspective.
  // We compute this in tests matching the cron's own logic.
  const now = new Date(2026, 4, 1, 6, 0, 0); // 2026-05-01 06:00 IST (cron fire time)
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = prevMonth.getMonth() + 1; // 4 (April)
  const year = prevMonth.getFullYear(); // 2026
  const periodKey = `${year}-${String(month).padStart(2, '0')}`; // '2026-04'

  beforeEach(() => {
    // Pin the clock to `now` (2026-05-01) so the cron's own `new Date()` derives
    // the SAME prior month (April) the test expects. Without this the test was
    // latently date-fragile — it only passed when the real run date happened to
    // land in a month where the prev-month arithmetic matched the hardcoded
    // expectation.
    vi.useFakeTimers();
    vi.setSystemTime(now);

    workspaceModel = {
      find: vi.fn(),
    };

    dispatchModel = {
      findOne: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    };

    // subscriptionModel.find() is now used for the batched lookup in run().
    subscriptionModel = {
      find: vi.fn(),
    };

    attendanceService = {
      getComplianceReport: vi.fn(),
    };

    defaulterAlertService = {
      dispatch: vi.fn().mockResolvedValue({
        recipientCount: 1,
        channelsSent: { inApp: 1, email: 0 },
        failures: 0,
      }),
    };

    // SingleFlightService stub — the cron wraps process() in runExclusive. The
    // constructor's 6th arg was previously omitted here, leaving this.singleFlight
    // undefined and throwing on run(); pass a pass-through stub that just invokes fn.
    const singleFlight: any = {
      runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
    };

    cron = new DefaulterAlertCron(
      workspaceModel,
      dispatchModel,
      subscriptionModel,
      attendanceService,
      defaulterAlertService,
      singleFlight,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Case 1: Dispatch row already exists → idempotent skip ────────────────

  it('skips workspace when a DefaulterAlertDispatch row already exists for the period', async () => {
    const ws = makeWorkspace();

    workspaceModel.find.mockReturnValueOnce(makeFindChain([ws])); // workspace query
    subscriptionModel.find.mockReturnValueOnce(makeSubFindChain([makeEntitledSub(ownerId)]));

    // Dispatch row exists for this period
    dispatchModel.findOne.mockReturnValue(
      makeFindOneLeanExec({ _id: new Types.ObjectId(), workspaceId: wsId, periodKey }),
    );

    await cron.run();

    expect(attendanceService.getComplianceReport).not.toHaveBeenCalled();
    expect(defaulterAlertService.dispatch).not.toHaveBeenCalled();
    expect(dispatchModel.create).not.toHaveBeenCalled();
  });

  // ── Case 2: Workspace subscription doesn't entitle defaulter_alerts ──────

  it('skips workspace when subscription does not entitle defaulter_alerts', async () => {
    const ws = makeWorkspace();

    workspaceModel.find.mockReturnValueOnce(makeFindChain([ws]));
    dispatchModel.findOne.mockReturnValue(makeFindOneLeanExec(null)); // no existing row

    // Subscription found but defaulter_alerts is LOCKED (present with access='locked')
    subscriptionModel.find.mockReturnValueOnce(
      makeSubFindChain([
        {
          _id: new Types.ObjectId(),
          userId: ownerId,
          status: 'active',
          appliedEntitlements: {
            moduleAccess: [
              {
                module: 'attendance',
                enabled: true,
                subFeatures: [{ key: 'defaulter_alerts', access: 'locked' }],
              },
            ],
          },
        },
      ]),
    );

    await cron.run();

    expect(attendanceService.getComplianceReport).not.toHaveBeenCalled();
    expect(defaulterAlertService.dispatch).not.toHaveBeenCalled();
    expect(dispatchModel.create).not.toHaveBeenCalled();
  });

  // ── Case 3: Zero defaulters → record dispatch row, no dispatch call ───────

  it('records a DefaulterAlertDispatch row but does not call dispatch when no members are below threshold', async () => {
    const ws = makeWorkspace();

    workspaceModel.find.mockReturnValueOnce(makeFindChain([ws]));
    dispatchModel.findOne.mockReturnValue(makeFindOneLeanExec(null));

    // Entitled subscription — subFeatures present with access='full'
    subscriptionModel.find.mockReturnValueOnce(makeSubFindChain([makeEntitledSub(ownerId)]));

    attendanceService.getComplianceReport.mockResolvedValue(complianceNoDefaulters);

    await cron.run();

    expect(defaulterAlertService.dispatch).not.toHaveBeenCalled();
    expect(dispatchModel.create).toHaveBeenCalledOnce();
    expect(dispatchModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: wsId,
        periodKey,
        defaulterCount: 0,
        recipientCount: 0,
      }),
    );
  });

  // ── Case 4: Null-rate members excluded; defaulters below threshold dispatched

  it('dispatches only members with non-null attendanceRate below threshold and records dispatch row', async () => {
    const ws = makeWorkspace();

    workspaceModel.find.mockReturnValueOnce(makeFindChain([ws]));
    dispatchModel.findOne.mockReturnValue(makeFindOneLeanExec(null));

    // Entitled subscription — subFeatures non-empty with access='full'
    subscriptionModel.find.mockReturnValueOnce(makeSubFindChain([makeEntitledSub(ownerId)]));

    attendanceService.getComplianceReport.mockResolvedValue(complianceWithDefaulters);

    await cron.run();

    // Alice (70%) and Carol (55%) are below threshold=75%; Bob (100%) is not.
    expect(defaulterAlertService.dispatch).toHaveBeenCalledOnce();
    const dispatchArg = defaulterAlertService.dispatch.mock.calls[0][0];
    expect(dispatchArg.defaulters).toHaveLength(2);
    expect(dispatchArg.defaulters.map((d: any) => d.name)).toEqual(
      expect.arrayContaining(['Alice', 'Carol']),
    );
    expect(dispatchArg.defaulters.map((d: any) => d.name)).not.toContain('Bob');
    expect(dispatchArg.month).toBe(month);
    expect(dispatchArg.year).toBe(year);
    expect(dispatchArg.thresholdPct).toBe(75);
    expect(dispatchArg.workspace._id).toBe(wsId.toString());
    expect(dispatchArg.workspace.ownerId).toBe(ownerId.toString());

    expect(dispatchModel.create).toHaveBeenCalledOnce();
    expect(dispatchModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: wsId,
        periodKey,
        defaulterCount: 2,
        recipientCount: 1, // mocked dispatch returns recipientCount=1
      }),
    );
  });

  // ── Case 5: Members with null attendanceRate excluded from dispatch ────────

  it('excludes members with null attendanceRate from defaulters list', async () => {
    const ws = makeWorkspace();

    workspaceModel.find.mockReturnValueOnce(makeFindChain([ws]));
    dispatchModel.findOne.mockReturnValue(makeFindOneLeanExec(null));

    subscriptionModel.find.mockReturnValueOnce(makeSubFindChain([makeEntitledSub(ownerId)]));

    // All members have null rate — Dave has no scheduled days
    attendanceService.getComplianceReport.mockResolvedValue(complianceNullRates);

    await cron.run();

    // null-rate members should not be dispatched even though they "might" be defaulters
    expect(defaulterAlertService.dispatch).not.toHaveBeenCalled();
    // But dispatch row is still recorded
    expect(dispatchModel.create).toHaveBeenCalledOnce();
    expect(dispatchModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ defaulterCount: 0 }),
    );
  });

  // ── Case 6: No subscription found → treated as not entitled ──────────────

  it('skips workspace when no subscription row is found (treated as not entitled)', async () => {
    const ws = makeWorkspace();

    workspaceModel.find.mockReturnValueOnce(makeFindChain([ws]));
    dispatchModel.findOne.mockReturnValue(makeFindOneLeanExec(null));

    // Batched query returns empty list — no subscription for this owner
    subscriptionModel.find.mockReturnValueOnce(makeSubFindChain([]));

    await cron.run();

    expect(attendanceService.getComplianceReport).not.toHaveBeenCalled();
    expect(defaulterAlertService.dispatch).not.toHaveBeenCalled();
    expect(dispatchModel.create).not.toHaveBeenCalled();
  });

  // ── Case 7: One workspace throws → others still processed ─────────────────

  it('continues processing remaining workspaces when one throws', async () => {
    const ws1 = makeWorkspace({ _id: wsId });
    const ws2Id = new Types.ObjectId();
    const owner2Id = new Types.ObjectId();
    const ws2 = makeWorkspace({ _id: ws2Id, ownerId: owner2Id });

    workspaceModel.find.mockReturnValueOnce(makeFindChain([ws1, ws2]));

    // Both owners have entitled subscriptions — returned in one batched query
    subscriptionModel.find.mockReturnValueOnce(
      makeSubFindChain([makeEntitledSub(ownerId), makeEntitledSub(owner2Id)]),
    );

    // ws1: no existing dispatch row; ws2: no existing dispatch row
    dispatchModel.findOne
      .mockReturnValueOnce(makeFindOneLeanExec(null)) // ws1 — no row
      .mockReturnValueOnce(makeFindOneLeanExec(null)); // ws2 — no row

    attendanceService.getComplianceReport
      .mockRejectedValueOnce(new Error('DB timeout')) // ws1 throws
      .mockResolvedValueOnce(complianceNoDefaulters); // ws2 succeeds

    await cron.run();

    // ws1 error must not prevent ws2 processing
    expect(attendanceService.getComplianceReport).toHaveBeenCalledTimes(2);
    // ws2 creates its dispatch row
    expect(dispatchModel.create).toHaveBeenCalledOnce();
  });
});
