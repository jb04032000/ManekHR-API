import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AttendancePlanMigrationService
// so that transitive schema imports (Plan, Subscription, etc.) don't trip the
// "Cannot determine type" reflection error under vitest's esbuild transform.
// All Models are injected as plain mocks — Mongoose is never actually used here.
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

import { AttendancePlanMigrationService } from '../attendance-plan-migration.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function attendanceEntry(subFeatures: Array<{ key: string; access: string }>) {
  return { module: AppModule.ATTENDANCE, enabled: true, subFeatures };
}

/**
 * Build a minimal service backed by mock models. `planDocs` and `subDocs` are
 * the docs returned by `find()`. `find()` is called by BOTH passes so we
 * configure it to return the same docs on every call (idempotency scenario
 * tests override per-test).
 */
function makeService(planDocs: any[] = [], subDocs: any[] = []) {
  const planModel: any = {
    find: vi.fn().mockReturnValue({ exec: () => Promise.resolve(planDocs) }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const subscriptionModel: any = {
    find: vi.fn().mockImplementation(() => {
      // populate chain used by backfill pass
      const result = { exec: () => Promise.resolve(subDocs) };
      return { ...result, populate: () => result };
    }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const service = new AttendancePlanMigrationService(planModel, subscriptionModel);
  return { service, planModel, subscriptionModel };
}

// ---------------------------------------------------------------------------
// Pass A — Dedupe
// ---------------------------------------------------------------------------

describe('AttendancePlanMigrationService — Pass A dedupe', () => {
  it('collapses duplicate defaulter_alerts to the first (locked), removes the second (full)', async () => {
    const plan: any = {
      _id: 'p-dup',
      tier: 'free',
      entitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'locked' },
            { key: 'mark', access: 'full' },
            { key: 'defaulter_alerts', access: 'full' }, // ← duplicate injected by old migration
          ]),
        ],
      },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    // The dedupe pass must have called updateOne with $set on this plan
    const dedupeCall = planModel.updateOne.mock.calls.find(
      (c: any[]) => c[1]?.$set?.['entitlements.moduleAccess.$[elem].subFeatures'] !== undefined,
    );
    expect(dedupeCall).toBeDefined();

    const deduped: Array<{ key: string; access: string }> =
      dedupeCall[1].$set['entitlements.moduleAccess.$[elem].subFeatures'];

    // Only one defaulter_alerts entry should remain
    const daEntries = deduped.filter((s) => s.key === 'defaulter_alerts');
    expect(daEntries).toHaveLength(1);

    // It must keep the FIRST occurrence (locked)
    expect(daEntries[0].access).toBe('locked');

    // mark should be preserved as-is
    expect(deduped.some((s) => s.key === 'mark')).toBe(true);
  });

  it('does NOT update a plan with no duplicate keys (idempotent)', async () => {
    const plan: any = {
      _id: 'p-clean',
      tier: 'free',
      entitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'mark', access: 'full' },
            { key: 'attendance_muster', access: 'locked' },
          ]),
        ],
      },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    // No $set call should exist (no dedupe needed)
    const dedupeCall = planModel.updateOne.mock.calls.find(
      (c: any[]) => c[1]?.$set?.['entitlements.moduleAccess.$[elem].subFeatures'] !== undefined,
    );
    expect(dedupeCall).toBeUndefined();
  });

  it('dedupes in subscription appliedEntitlements', async () => {
    const sub: any = {
      _id: 's-dup',
      planId: { tier: 'starter' },
      appliedEntitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'locked' },
            { key: 'defaulter_alerts', access: 'full' }, // ← duplicate
          ]),
        ],
      },
      adminEntitlementOverride: undefined,
    };
    const { service, subscriptionModel } = makeService([], [sub]);
    await service.onModuleInit();

    const dedupeCall = subscriptionModel.updateOne.mock.calls.find(
      (c: any[]) =>
        c[1]?.$set?.['appliedEntitlements.moduleAccess.$[elem].subFeatures'] !== undefined,
    );
    expect(dedupeCall).toBeDefined();

    const deduped: Array<{ key: string; access: string }> =
      dedupeCall[1].$set['appliedEntitlements.moduleAccess.$[elem].subFeatures'];
    const daEntries = deduped.filter((s) => s.key === 'defaulter_alerts');
    expect(daEntries).toHaveLength(1);
    expect(daEntries[0].access).toBe('locked');
  });

  it('dedupes in subscription adminEntitlementOverride', async () => {
    const sub: any = {
      _id: 's-dup-override',
      planId: { tier: 'starter' },
      appliedEntitlements: {
        moduleAccess: [attendanceEntry([])],
      },
      adminEntitlementOverride: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'locked' },
            { key: 'defaulter_alerts', access: 'full' }, // ← duplicate
          ]),
        ],
      },
    };
    const { service, subscriptionModel } = makeService([], [sub]);
    await service.onModuleInit();

    const overrideCall = subscriptionModel.updateOne.mock.calls.find(
      (c: any[]) =>
        c[1]?.$set?.['adminEntitlementOverride.moduleAccess.$[elem].subFeatures'] !== undefined,
    );
    expect(overrideCall).toBeDefined();

    const deduped: Array<{ key: string; access: string }> =
      overrideCall[1].$set['adminEntitlementOverride.moduleAccess.$[elem].subFeatures'];
    expect(deduped.filter((s) => s.key === 'defaulter_alerts')).toHaveLength(1);
    expect(deduped.find((s) => s.key === 'defaulter_alerts')?.access).toBe('locked');
  });
});

// ---------------------------------------------------------------------------
// Pass B — Unified backfill
// ---------------------------------------------------------------------------

describe('AttendancePlanMigrationService — Pass B unified backfill', () => {
  it('backfills all 6 keys into a plan that has none (free → 5 gating keys LOCKED, defaulter_alerts FULL)', async () => {
    const plan: any = {
      _id: 'p-empty',
      tier: 'free',
      entitlements: {
        moduleAccess: [attendanceEntry([{ key: 'mark', access: 'full' }])],
      },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    const backfillCall = planModel.updateOne.mock.calls.find((c: any[]) =>
      JSON.stringify(c).includes('attendance_muster'),
    );
    expect(backfillCall).toBeDefined();

    const pushed: Array<{ key: string; access: string }> =
      backfillCall[1].$push['entitlements.moduleAccess.$[elem].subFeatures'].$each;
    const byKey = Object.fromEntries(pushed.map((e) => [e.key, e.access]));

    expect(byKey['defaulter_alerts']).toBe(FeatureAccessLevel.FULL);
    expect(byKey['attendance_muster']).toBe(FeatureAccessLevel.LOCKED);
    expect(byKey['overtime_analytics']).toBe(FeatureAccessLevel.LOCKED);
    expect(byKey['compliance_report']).toBe(FeatureAccessLevel.LOCKED);
    expect(byKey['absence_patterns']).toBe(FeatureAccessLevel.LOCKED);
    expect(byKey['anomaly_detection']).toBe(FeatureAccessLevel.LOCKED);
  });

  it('starter tier → attendance_muster FULL, 4 gating keys LOCKED, defaulter_alerts FULL', async () => {
    const plan: any = {
      _id: 'p-starter',
      tier: 'starter',
      entitlements: { moduleAccess: [attendanceEntry([])] },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    const backfillCall = planModel.updateOne.mock.calls.find((c: any[]) =>
      JSON.stringify(c).includes('attendance_muster'),
    );
    expect(backfillCall).toBeDefined();

    const pushed: Array<{ key: string; access: string }> =
      backfillCall[1].$push['entitlements.moduleAccess.$[elem].subFeatures'].$each;
    const byKey = Object.fromEntries(pushed.map((e) => [e.key, e.access]));

    expect(byKey['defaulter_alerts']).toBe(FeatureAccessLevel.FULL);
    expect(byKey['attendance_muster']).toBe(FeatureAccessLevel.FULL);
    expect(byKey['overtime_analytics']).toBe(FeatureAccessLevel.LOCKED);
    expect(byKey['compliance_report']).toBe(FeatureAccessLevel.LOCKED);
    expect(byKey['absence_patterns']).toBe(FeatureAccessLevel.LOCKED);
    expect(byKey['anomaly_detection']).toBe(FeatureAccessLevel.LOCKED);
  });

  it('does NOT add another defaulter_alerts if it already exists (any access) — no-duplicate guarantee', async () => {
    // Plan already has defaulter_alerts (locked from admin override) — backfill must skip it
    const plan: any = {
      _id: 'p-da-exists',
      tier: 'free',
      entitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'locked' },
            { key: 'mark', access: 'full' },
          ]),
        ],
      },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    // All updateOne $push calls should NOT include defaulter_alerts in $each
    const pushCalls = planModel.updateOne.mock.calls.filter(
      (c: any[]) => c[1]?.$push !== undefined,
    );
    for (const call of pushCalls) {
      const each = call[1].$push['entitlements.moduleAccess.$[elem].subFeatures']?.$each ?? [];
      const daInPush = (each as Array<{ key: string }>).filter((e) => e.key === 'defaulter_alerts');
      expect(daInPush).toHaveLength(0);
    }
  });

  it('is idempotent — a plan with all 6 keys already present is not updated by the backfill pass', async () => {
    const plan: any = {
      _id: 'p-all-present',
      tier: 'pro',
      entitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'attendance_muster', access: 'full' },
            { key: 'overtime_analytics', access: 'full' },
            { key: 'compliance_report', access: 'full' },
            { key: 'absence_patterns', access: 'full' },
            { key: 'anomaly_detection', access: 'full' },
          ]),
        ],
      },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    // No $push updateOne call for attendance_muster should exist
    const backfillCall = planModel.updateOne.mock.calls.find((c: any[]) =>
      JSON.stringify(c).includes('attendance_muster'),
    );
    expect(backfillCall).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // anomaly_detection — targeted tests
  // ---------------------------------------------------------------------------

  it('anomaly_detection: missing from a free-tier plan → backfilled as LOCKED', async () => {
    const plan: any = {
      _id: 'p-anomaly-free',
      tier: 'free',
      entitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'attendance_muster', access: 'locked' },
            { key: 'overtime_analytics', access: 'locked' },
            { key: 'compliance_report', access: 'locked' },
            { key: 'absence_patterns', access: 'locked' },
            // anomaly_detection intentionally absent
          ]),
        ],
      },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    const backfillCall = planModel.updateOne.mock.calls.find((c: any[]) => {
      const each = c[1]?.$push?.['entitlements.moduleAccess.$[elem].subFeatures']?.$each ?? [];
      return (each as Array<{ key: string }>).some((e) => e.key === 'anomaly_detection');
    });
    expect(backfillCall).toBeDefined();

    const pushed: Array<{ key: string; access: string }> =
      backfillCall[1].$push['entitlements.moduleAccess.$[elem].subFeatures'].$each;
    const entry = pushed.find((e) => e.key === 'anomaly_detection');
    expect(entry?.access).toBe(FeatureAccessLevel.LOCKED);
  });

  it('anomaly_detection: missing from a pro-tier plan → backfilled as FULL', async () => {
    const plan: any = {
      _id: 'p-anomaly-pro',
      tier: 'pro',
      entitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'attendance_muster', access: 'full' },
            { key: 'overtime_analytics', access: 'full' },
            { key: 'compliance_report', access: 'full' },
            { key: 'absence_patterns', access: 'full' },
            // anomaly_detection intentionally absent
          ]),
        ],
      },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    const backfillCall = planModel.updateOne.mock.calls.find((c: any[]) => {
      const each = c[1]?.$push?.['entitlements.moduleAccess.$[elem].subFeatures']?.$each ?? [];
      return (each as Array<{ key: string }>).some((e) => e.key === 'anomaly_detection');
    });
    expect(backfillCall).toBeDefined();

    const pushed: Array<{ key: string; access: string }> =
      backfillCall[1].$push['entitlements.moduleAccess.$[elem].subFeatures'].$each;
    const entry = pushed.find((e) => e.key === 'anomaly_detection');
    expect(entry?.access).toBe(FeatureAccessLevel.FULL);
  });

  it('anomaly_detection: already present in a plan → NOT touched (idempotent)', async () => {
    const plan: any = {
      _id: 'p-anomaly-exists',
      tier: 'pro',
      entitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'attendance_muster', access: 'full' },
            { key: 'overtime_analytics', access: 'full' },
            { key: 'compliance_report', access: 'full' },
            { key: 'absence_patterns', access: 'full' },
            { key: 'anomaly_detection', access: 'locked' }, // present with non-default value
          ]),
        ],
      },
    };
    const { service, planModel } = makeService([plan]);
    await service.onModuleInit();

    // No $push call should include anomaly_detection
    const badCall = planModel.updateOne.mock.calls.find((c: any[]) => {
      const each = c[1]?.$push?.['entitlements.moduleAccess.$[elem].subFeatures']?.$each ?? [];
      return (each as Array<{ key: string }>).some((e) => e.key === 'anomaly_detection');
    });
    expect(badCall).toBeUndefined();
  });

  it('anomaly_detection: missing from a subscription → backfilled at tier-correct level', async () => {
    const sub: any = {
      _id: 's-anomaly-missing',
      planId: { tier: 'pro' },
      appliedEntitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'attendance_muster', access: 'full' },
            { key: 'overtime_analytics', access: 'full' },
            { key: 'compliance_report', access: 'full' },
            { key: 'absence_patterns', access: 'full' },
            // anomaly_detection absent
          ]),
        ],
      },
      adminEntitlementOverride: undefined,
    };
    const { service, subscriptionModel } = makeService([], [sub]);
    await service.onModuleInit();

    const backfillCall = subscriptionModel.updateOne.mock.calls.find((c: any[]) => {
      const each =
        c[1]?.$push?.['appliedEntitlements.moduleAccess.$[elem].subFeatures']?.$each ?? [];
      return (each as Array<{ key: string }>).some((e) => e.key === 'anomaly_detection');
    });
    expect(backfillCall).toBeDefined();

    const pushed: Array<{ key: string; access: string }> =
      backfillCall[1].$push['appliedEntitlements.moduleAccess.$[elem].subFeatures'].$each;
    const entry = pushed.find((e) => e.key === 'anomaly_detection');
    expect(entry?.access).toBe(FeatureAccessLevel.FULL);
  });

  it('anomaly_detection: already present in a subscription → NOT touched (idempotent)', async () => {
    const sub: any = {
      _id: 's-anomaly-present',
      planId: { tier: 'pro' },
      appliedEntitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'attendance_muster', access: 'full' },
            { key: 'overtime_analytics', access: 'full' },
            { key: 'compliance_report', access: 'full' },
            { key: 'absence_patterns', access: 'full' },
            { key: 'anomaly_detection', access: 'locked' }, // present with any value
          ]),
        ],
      },
      adminEntitlementOverride: undefined,
    };
    const { service, subscriptionModel } = makeService([], [sub]);
    await service.onModuleInit();

    const badCall = subscriptionModel.updateOne.mock.calls.find((c: any[]) => {
      const each =
        c[1]?.$push?.['appliedEntitlements.moduleAccess.$[elem].subFeatures']?.$each ?? [];
      return (each as Array<{ key: string }>).some((e) => e.key === 'anomaly_detection');
    });
    expect(badCall).toBeUndefined();
  });

  it('anomaly_detection: missing from a starter-tier subscription → backfilled as LOCKED', async () => {
    // Starter is the most nuanced tier: attendance_muster unlocks (FULL) but
    // anomaly_detection (an analytics/detection surface) stays LOCKED.
    const sub: any = {
      _id: 's-anomaly-starter',
      planId: { tier: 'starter' },
      appliedEntitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'attendance_muster', access: 'full' },
            { key: 'overtime_analytics', access: 'locked' },
            { key: 'compliance_report', access: 'locked' },
            { key: 'absence_patterns', access: 'locked' },
            // anomaly_detection absent
          ]),
        ],
      },
      adminEntitlementOverride: undefined,
    };
    const { service, subscriptionModel } = makeService([], [sub]);
    await service.onModuleInit();

    const backfillCall = subscriptionModel.updateOne.mock.calls.find((c: any[]) => {
      const each =
        c[1]?.$push?.['appliedEntitlements.moduleAccess.$[elem].subFeatures']?.$each ?? [];
      return (each as Array<{ key: string }>).some((e) => e.key === 'anomaly_detection');
    });
    expect(backfillCall).toBeDefined();

    const pushed: Array<{ key: string; access: string }> =
      backfillCall[1].$push['appliedEntitlements.moduleAccess.$[elem].subFeatures'].$each;
    const entry = pushed.find((e) => e.key === 'anomaly_detection');
    expect(entry?.access).toBe(FeatureAccessLevel.LOCKED);
  });

  it('anomaly_detection: unknown tier on a subscription → falls back to LOCKED', async () => {
    // Data-integrity safety net: a subscription whose planId tier is unknown
    // (or its planId failed to populate) must resolve to the safe 'free'
    // default — anomaly_detection LOCKED — never an accidental unlock.
    const sub: any = {
      _id: 's-anomaly-unknown-tier',
      planId: { tier: 'mystery_tier' },
      appliedEntitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'defaulter_alerts', access: 'full' },
            { key: 'attendance_muster', access: 'locked' },
            { key: 'overtime_analytics', access: 'locked' },
            { key: 'compliance_report', access: 'locked' },
            { key: 'absence_patterns', access: 'locked' },
            // anomaly_detection absent
          ]),
        ],
      },
      adminEntitlementOverride: undefined,
    };
    const { service, subscriptionModel } = makeService([], [sub]);
    await service.onModuleInit();

    const backfillCall = subscriptionModel.updateOne.mock.calls.find((c: any[]) => {
      const each =
        c[1]?.$push?.['appliedEntitlements.moduleAccess.$[elem].subFeatures']?.$each ?? [];
      return (each as Array<{ key: string }>).some((e) => e.key === 'anomaly_detection');
    });
    expect(backfillCall).toBeDefined();

    const pushed: Array<{ key: string; access: string }> =
      backfillCall[1].$push['appliedEntitlements.moduleAccess.$[elem].subFeatures'].$each;
    const entry = pushed.find((e) => e.key === 'anomaly_detection');
    expect(entry?.access).toBe(FeatureAccessLevel.LOCKED);
  });
});

// ---------------------------------------------------------------------------
// Boot safety
// ---------------------------------------------------------------------------

describe('AttendancePlanMigrationService — boot safety', () => {
  it('resolves without throwing when the model throws (neither pass must propagate)', async () => {
    const planModel: any = {
      find: vi.fn().mockReturnValue({
        exec: () => Promise.reject(new Error('db down')),
      }),
      updateOne: vi.fn(),
    };
    const subscriptionModel: any = {
      find: vi.fn().mockImplementation(() => {
        const result = { exec: () => Promise.reject(new Error('db down')) };
        return { ...result, populate: () => result };
      }),
      updateOne: vi.fn(),
    };
    const service = new AttendancePlanMigrationService(
      planModel as never,
      subscriptionModel as never,
    );
    await expect(service.onModuleInit()).resolves.not.toThrow();
  });

  it('completes Pass B even if Pass A throws', async () => {
    // Pass A (dedupe) uses find without populate. Pass B (backfill) uses find + populate.
    // We simulate Pass A find throwing and Pass B find working (returns no docs).
    let callCount = 0;
    const planModel: any = {
      find: vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          // First call = dedupe pass → throw
          return { exec: () => Promise.reject(new Error('dedupe find failed')) };
        }
        // Second call = backfill pass → ok
        return { exec: () => Promise.resolve([]) };
      }),
      updateOne: vi.fn(),
    };
    const subscriptionModel: any = {
      find: vi.fn().mockImplementation(() => {
        const result = { exec: () => Promise.resolve([]) };
        return { ...result, populate: () => result };
      }),
      updateOne: vi.fn(),
    };
    const service = new AttendancePlanMigrationService(
      planModel as never,
      subscriptionModel as never,
    );
    await expect(service.onModuleInit()).resolves.not.toThrow();
    // Pass B's find should still have been called
    expect(planModel.find).toHaveBeenCalledTimes(2);
  });
});
