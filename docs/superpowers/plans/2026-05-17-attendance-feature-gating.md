# Attendance Feature Gating Implementation Plan

> ✅ **STATUS: COMPLETE — verified 2026-05-18.** This plan was implemented in a prior session; the `- [ ]` checkboxes below were never ticked but the work is done. Verified by code-state audit: registry keys + tier defaults, `@RequireSubscription` on all 4 endpoints, the tier-aware backfill migration, `live_presence` dropped + `AttendanceLiveView` deleted, `<FeatureGate>` on the analytics surfaces (routes folded into the tabbed Reports page; gates in `OvertimePanel`/`CompliancePanel`/`PatternsPanel`), Register-toggle gating in `AttendanceOverviewClient`. 21 backend vitest pass (registry + migration); web `tsc` clean. No gaps.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tier-gate four existing attendance features (`attendance_muster`, `overtime_analytics`, `compliance_report`, `absence_patterns`) as enforced subscription sub-features, fixing the admin custom-plan-assign 400 caused by registry drift.

**Architecture:** Add the four keys to the backend feature registry + tier-default matrix; enforce via `@RequireSubscription` on their read endpoints and web `<FeatureGate>`; a tier-aware boot migration backfills existing plans/subscriptions. The dead `live_presence` key is dropped from the web registry.

**Tech Stack:** NestJS, Mongoose, `@nestjs/schedule`, Next.js 16, antd v6.

**Spec:** `crewroster-backend/docs/superpowers/specs/2026-05-17-attendance-feature-gating-design.md`

**Git note:** Per project policy the **owner performs all `git add` / `git commit`**. "Commit" steps are checkpoints — the executing agent must NOT run git; stop at each so the owner can stage and commit.

**Verification:**

- Backend typecheck: `npx tsc --noEmit -p tsconfig.json` from `crewroster-backend/` — NOTE: this OOMs on this machine; fall back to per-file transpile checks + vitest.
- Backend test: `npx vitest run <file>` from `crewroster-backend/`.
- Web: `npx tsc --noEmit -p tsconfig.json` and `npx eslint <file>` from `crewroster-web/` — both work fine for the web repo.

**Tier matrix** (used throughout):

| Feature              | free   | starter | pro / growth / business / enterprise / custom |
| -------------------- | ------ | ------- | --------------------------------------------- |
| `attendance_muster`  | LOCKED | FULL    | FULL                                          |
| `overtime_analytics` | LOCKED | LOCKED  | FULL                                          |
| `compliance_report`  | LOCKED | LOCKED  | FULL                                          |
| `absence_patterns`   | LOCKED | LOCKED  | FULL                                          |

---

## Task 1: Register the 4 keys + tier defaults

**Files:**

- Modify: `crewroster-backend/src/common/constants/module-features.registry.ts`
- Test: `crewroster-backend/src/common/constants/__tests__/attendance-gating-registry.vitest.ts`

- [ ] **Step 1: Write the failing test**

Create `src/common/constants/__tests__/attendance-gating-registry.vitest.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MODULE_FEATURES_REGISTRY, buildModuleAccess } from '../module-features.registry';
import { AppModule } from '../../enums/modules.enum';
import { FeatureAccessLevel } from '../../enums/feature-access.enum';

const KEYS = ['attendance_muster', 'overtime_analytics', 'compliance_report', 'absence_patterns'];

function attendanceSub(tier: string, key: string) {
  const access = buildModuleAccess(tier);
  const att = access.find((m) => m.module === AppModule.ATTENDANCE);
  return att?.subFeatures.find((s) => s.key === key)?.access;
}

describe('attendance feature-gating registry', () => {
  it('catalogues all 4 keys under the attendance module', () => {
    const att = MODULE_FEATURES_REGISTRY.find((m) => m.module === AppModule.ATTENDANCE);
    for (const key of KEYS) {
      const sub = att?.subFeatures.find((s) => s.key === key);
      expect(sub, key).toBeDefined();
      expect(sub?.supportsLimited, key).toBe(false);
    }
  });

  it('free tier: all 4 LOCKED', () => {
    for (const key of KEYS) {
      expect(attendanceSub('free', key), key).toBe(FeatureAccessLevel.LOCKED);
    }
  });

  it('starter tier: attendance_muster FULL, the 3 analytics LOCKED', () => {
    expect(attendanceSub('starter', 'attendance_muster')).toBe(FeatureAccessLevel.FULL);
    for (const key of ['overtime_analytics', 'compliance_report', 'absence_patterns']) {
      expect(attendanceSub('starter', key), key).toBe(FeatureAccessLevel.LOCKED);
    }
  });

  it('pro/growth/business/enterprise/custom: all 4 FULL', () => {
    for (const tier of ['pro', 'growth', 'business', 'enterprise', 'custom']) {
      for (const key of KEYS) {
        expect(attendanceSub(tier, key), `${tier}/${key}`).toBe(FeatureAccessLevel.FULL);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/common/constants/__tests__/attendance-gating-registry.vitest.ts`
Expected: FAIL — keys not catalogued.

- [ ] **Step 3: Add the 4 sub-feature entries to `MODULE_FEATURES_REGISTRY`**

In `module-features.registry.ts`, find the `ATTENDANCE` entry's `subFeatures` array (it currently ends with the `defaulter_alerts` entry, ~line 92-98). Append these four entries after `defaulter_alerts`:

```ts
      {
        key: 'attendance_muster',
        label: 'Attendance Muster',
        description: 'Month-at-a-glance member × day muster register grid',
        supportsLimited: false,
      },
      {
        key: 'overtime_analytics',
        label: 'Overtime Analytics',
        description: 'Overtime worked by member, shift, and day, with cost estimation',
        supportsLimited: false,
      },
      {
        key: 'compliance_report',
        label: 'Compliance & Leaderboards',
        description: 'Attendance defaulters and late / absent leaderboards',
        supportsLimited: false,
      },
      {
        key: 'absence_patterns',
        label: 'Absence Patterns',
        description: 'Bradford-style absence scoring and weekday-cluster detection',
        supportsLimited: false,
      },
```

- [ ] **Step 4: Add the tier-default seed block**

In the same file, immediately AFTER the `_DEFAULTER_ALERTS_TIER_DEFAULTS` merge loop (added by the prior feature; find `for (const [tier, modules] of Object.entries(_DEFAULTER_ALERTS_TIER_DEFAULTS))`), append:

```ts
/**
 * Attendance feature-gating tier defaults (2026-05-17).
 * Seeds NEW subscriptions; existing tenants are backfilled tier-aware by
 * AttendancePlanMigrationService. attendance_muster unlocks at starter;
 * the 3 analytics pages unlock at pro+. Runtime-merged to avoid editing the
 * 7 large tier blocks above.
 */
const _ATTENDANCE_GATING_TIER_DEFAULTS: Record<
  string,
  Partial<Record<AppModule, Record<string, FeatureAccessLevel>>>
> = {
  free: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.LOCKED,
      overtime_analytics: FeatureAccessLevel.LOCKED,
      compliance_report: FeatureAccessLevel.LOCKED,
      absence_patterns: FeatureAccessLevel.LOCKED,
    },
  },
  starter: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.LOCKED,
      compliance_report: FeatureAccessLevel.LOCKED,
      absence_patterns: FeatureAccessLevel.LOCKED,
    },
  },
  pro: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
    },
  },
  growth: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
    },
  },
  business: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
    },
  },
  enterprise: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
    },
  },
  custom: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
    },
  },
};
for (const [tier, modules] of Object.entries(_ATTENDANCE_GATING_TIER_DEFAULTS)) {
  if (!TIER_SUBFEATURE_DEFAULTS[tier]) {
    TIER_SUBFEATURE_DEFAULTS[tier] = {};
  }
  for (const [moduleKey, subFeatures] of Object.entries(modules ?? {})) {
    if (!TIER_SUBFEATURE_DEFAULTS[tier][moduleKey]) {
      TIER_SUBFEATURE_DEFAULTS[tier][moduleKey] = {};
    }
    Object.assign(TIER_SUBFEATURE_DEFAULTS[tier][moduleKey], subFeatures);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/common/constants/__tests__/attendance-gating-registry.vitest.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit checkpoint** — SKIP (no git). Suggested message: `feat(subscriptions): catalogue 4 gated attendance sub-features + tier defaults`

---

## Task 2: Enforce — `@RequireSubscription` on the 4 read endpoints

**Files:**

- Modify: `crewroster-backend/src/modules/attendance/attendance.controller.ts`

- [ ] **Step 1: Read the controller**

Open `attendance.controller.ts`. Confirm the four handlers and their decorators: `getAttendanceGrid` (`GET .../attendance/grid`), `getOvertimeAnalytics` (`GET .../attendance/overtime`), `getComplianceReport` (`GET .../attendance/compliance`), `getAbsencePatterns` (`GET .../attendance/absence-patterns`). Confirm `RequireSubscription` and `AppModule` are already imported (they are — the controller uses `@RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'mark' })` on `mark`/`bulk`/etc.).

- [ ] **Step 2: Add the decorator to each of the 4 handlers**

On `getAttendanceGrid`, add above its other decorators:

```ts
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'attendance_muster' })
```

On `getOvertimeAnalytics`:

```ts
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'overtime_analytics' })
```

On `getComplianceReport`:

```ts
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'compliance_report' })
```

On `getAbsencePatterns`:

```ts
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'absence_patterns' })
```

Place each decorator consistently with how `@RequireSubscription` is positioned on the existing `mark`/`bulk` handlers in this file (same decorator-stack order).

- [ ] **Step 3: Verify**

Transpile-check `attendance.controller.ts` (full `tsc` OOMs — per-file transpile is fine). Confirm no syntax error, the 4 decorators are on the 4 correct handlers, and `SubscriptionGuard` is applied to the controller (class-level guard — confirm it is; the existing `mark` gate relies on it).

- [ ] **Step 4: Commit checkpoint** — SKIP (no git). Suggested message: `feat(attendance): gate 4 read endpoints behind subscription sub-features`

---

## Task 3: Tier-aware backfill migration

Extends the existing `AttendancePlanMigrationService` (added by the defaulter-alerts feature) with a second pass that backfills the 4 gating keys into existing plans + subscriptions using each document's tier.

**Files:**

- Modify: `crewroster-backend/src/modules/subscriptions/attendance-plan-migration.service.ts`
- Modify: `crewroster-backend/src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`

- [ ] **Step 1: Write the failing test**

Open the existing test file and ADD a new `describe` block (keep the existing `defaulter_alerts` tests intact). Append:

```ts
describe('AttendancePlanMigrationService — gating sub-feature backfill', () => {
  function attendanceEntry(subFeatures: Array<{ key: string; access: string }>) {
    return { module: AppModule.ATTENDANCE, enabled: true, subFeatures };
  }

  it('backfills the 4 gating keys into a plan with tier-appropriate access (free → all LOCKED)', async () => {
    const plan: any = {
      _id: 'p1',
      tier: 'free',
      entitlements: { moduleAccess: [attendanceEntry([{ key: 'mark', access: 'full' }])] },
    };
    const planModel: any = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: vi.fn().mockReturnValue({ exec: () => Promise.resolve([plan]) }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const subscriptionModel: any = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: vi.fn().mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve([]) }),
      }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const service = new AttendancePlanMigrationService(planModel, subscriptionModel);
    await service.onModuleInit();

    const call = planModel.updateOne.mock.calls.find((c: any[]) =>
      JSON.stringify(c).includes('attendance_muster'),
    );
    expect(call).toBeDefined();
    const pushed = call[1].$push['entitlements.moduleAccess.$[elem].subFeatures'].$each;
    const byKey = Object.fromEntries(pushed.map((e: any) => [e.key, e.access]));
    expect(byKey).toEqual({
      attendance_muster: 'locked',
      overtime_analytics: 'locked',
      compliance_report: 'locked',
      absence_patterns: 'locked',
    });
  });

  it('starter plan → attendance_muster full, 3 analytics locked', async () => {
    const plan: any = {
      _id: 'p2',
      tier: 'starter',
      entitlements: { moduleAccess: [attendanceEntry([])] },
    };
    const planModel: any = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: vi.fn().mockReturnValue({ exec: () => Promise.resolve([plan]) }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const subscriptionModel: any = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: vi.fn().mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve([]) }),
      }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const service = new AttendancePlanMigrationService(planModel, subscriptionModel);
    await service.onModuleInit();
    const call = planModel.updateOne.mock.calls.find((c: any[]) =>
      JSON.stringify(c).includes('attendance_muster'),
    );
    const pushed = call[1].$push['entitlements.moduleAccess.$[elem].subFeatures'].$each;
    const byKey = Object.fromEntries(pushed.map((e: any) => [e.key, e.access]));
    expect(byKey.attendance_muster).toBe('full');
    expect(byKey.overtime_analytics).toBe('locked');
    expect(byKey.compliance_report).toBe('locked');
    expect(byKey.absence_patterns).toBe('locked');
  });

  it('is idempotent — a plan that already has all 4 keys is not updated', async () => {
    const plan: any = {
      _id: 'p3',
      tier: 'pro',
      entitlements: {
        moduleAccess: [
          attendanceEntry([
            { key: 'attendance_muster', access: 'full' },
            { key: 'overtime_analytics', access: 'full' },
            { key: 'compliance_report', access: 'full' },
            { key: 'absence_patterns', access: 'full' },
          ]),
        ],
      },
    };
    const planModel: any = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: vi.fn().mockReturnValue({ exec: () => Promise.resolve([plan]) }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const subscriptionModel: any = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: vi.fn().mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve([]) }),
      }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const service = new AttendancePlanMigrationService(planModel, subscriptionModel);
    await service.onModuleInit();
    const gatingCall = planModel.updateOne.mock.calls.find((c: any[]) =>
      JSON.stringify(c).includes('attendance_muster'),
    );
    expect(gatingCall).toBeUndefined();
  });
});
```

> The existing test file already has the `vi.mock('@nestjs/mongoose', ...)` stub and imports `AppModule` / `FeatureAccessLevel` / `vi` — reuse them. If `AppModule` is not imported there, add it.

- [ ] **Step 2: Run test to verify the new block fails**

Run: `npx vitest run src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`
Expected: the new 3 tests FAIL (gating backfill not implemented); the prior `defaulter_alerts` tests still pass.

- [ ] **Step 3: Implement the tier-aware backfill pass**

In `attendance-plan-migration.service.ts`: add the import for `TIER_SUBFEATURE_DEFAULTS`:

```ts
import { TIER_SUBFEATURE_DEFAULTS } from '../../common/constants/module-features.registry';
```

Add a constant and methods to the class, and call the new pass at the end of `onModuleInit` (after the existing `defaulter_alerts` backfill, inside its own try/catch):

```ts
  /** The 4 sub-feature keys backfilled tier-aware by the gating pass. */
  private static readonly GATING_KEYS = [
    'attendance_muster',
    'overtime_analytics',
    'compliance_report',
    'absence_patterns',
  ] as const;

  private static readonly VALID_TIERS = [
    'free', 'starter', 'pro', 'growth', 'business', 'enterprise', 'custom',
  ];

  /** Resolve the tier-default access for a gating key; unknown tier → free. */
  private resolveTierAccess(tier: string | undefined, key: string): FeatureAccessLevel {
    const t = AttendancePlanMigrationService.VALID_TIERS.includes(tier ?? '')
      ? (tier as string)
      : 'free';
    const access = TIER_SUBFEATURE_DEFAULTS[t]?.[AppModule.ATTENDANCE]?.[key];
    return (access as FeatureAccessLevel) ?? FeatureAccessLevel.LOCKED;
  }

  /**
   * Compute the { key, access } entries missing from an attendance
   * moduleAccess entry, using the document's tier.
   */
  private missingGatingEntries(
    moduleAccess: Array<{ module: string; subFeatures?: Array<{ key: string }> }> | undefined,
    tier: string | undefined,
  ): Array<{ key: string; access: FeatureAccessLevel }> {
    const att = (moduleAccess ?? []).find((m) => m.module === AppModule.ATTENDANCE);
    if (!att) return [];
    const have = new Set((att.subFeatures ?? []).map((s) => s.key));
    return AttendancePlanMigrationService.GATING_KEYS.filter((k) => !have.has(k)).map(
      (k) => ({ key: k, access: this.resolveTierAccess(tier, k) }),
    );
  }

  /** Second migration pass — tier-aware backfill of the 4 gating keys. */
  private async backfillGatingSubFeatures(): Promise<void> {
    let plansPatched = 0;
    let subsPatched = 0;

    const plans = await this.planModel
      .find({ 'entitlements.moduleAccess.module': AppModule.ATTENDANCE })
      .exec();
    for (const plan of plans) {
      const toAdd = this.missingGatingEntries(
        (plan as any).entitlements?.moduleAccess,
        (plan as any).tier,
      );
      if (toAdd.length === 0) continue;
      await this.planModel.updateOne(
        { _id: plan._id },
        { $push: { 'entitlements.moduleAccess.$[elem].subFeatures': { $each: toAdd } } },
        { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
      );
      plansPatched += 1;
    }

    const subs = await this.subscriptionModel
      .find({ 'appliedEntitlements.moduleAccess.module': AppModule.ATTENDANCE })
      .populate('planId')
      .exec();
    for (const sub of subs) {
      const tier = ((sub as any).planId?.tier as string | undefined);
      let patched = false;

      const appliedToAdd = this.missingGatingEntries(
        (sub as any).appliedEntitlements?.moduleAccess,
        tier,
      );
      if (appliedToAdd.length > 0) {
        await this.subscriptionModel.updateOne(
          { _id: sub._id },
          {
            $push: {
              'appliedEntitlements.moduleAccess.$[elem].subFeatures': { $each: appliedToAdd },
            },
          },
          { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
        );
        patched = true;
      }

      const overrideToAdd = (sub as any).adminEntitlementOverride
        ? this.missingGatingEntries(
            (sub as any).adminEntitlementOverride?.moduleAccess,
            tier,
          )
        : [];
      if (overrideToAdd.length > 0) {
        await this.subscriptionModel.updateOne(
          { _id: sub._id },
          {
            $push: {
              'adminEntitlementOverride.moduleAccess.$[elem].subFeatures': {
                $each: overrideToAdd,
              },
            },
          },
          { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
        );
        patched = true;
      }

      if (patched) subsPatched += 1;
    }

    if (plansPatched > 0 || subsPatched > 0) {
      this.logger.log(
        `Attendance gating migration: tier-aware backfill patched ` +
          `${plansPatched} plan(s), ${subsPatched} subscription(s).`,
      );
    }
  }
```

Then, at the end of `onModuleInit()`, after the existing `defaulter_alerts` work, add:

```ts
try {
  await this.backfillGatingSubFeatures();
} catch (err) {
  this.logger.warn(
    `AttendancePlanMigrationService gating backfill failed: ${(err as Error).message}`,
  );
}
```

Confirm `FeatureAccessLevel` and `AppModule` are already imported in this file (they are — the `defaulter_alerts` code uses them).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`
Expected: PASS — both the prior `defaulter_alerts` tests AND the 3 new gating tests.

- [ ] **Step 5: Commit checkpoint** — SKIP (no git). Suggested message: `feat(subscriptions): tier-aware backfill of gated attendance sub-features`

---

## Task 4: Web — drop `live_presence` + delete dead code

All commands run from `crewroster-web/`.

**Files:**

- Modify: `lib/constants/feature-access.registry.ts`
- Delete: `components/dashboard/attendance/AttendanceLiveView.tsx`
- Delete: `app/dashboard/attendance/live/loading.tsx`

- [ ] **Step 1: Confirm `AttendanceLiveView` is dead**

Run: `grep -rn "AttendanceLiveView" app components lib` — expect matches ONLY inside `components/dashboard/attendance/AttendanceLiveView.tsx` itself (its definition + default export). If anything else imports it, STOP and report — the deletion premise is wrong.

- [ ] **Step 2: Remove the `live_presence` entry**

In `lib/constants/feature-access.registry.ts`, find the `attendance` module's `subFeatures` array and delete the `{ key: 'live_presence', ... }` object entirely. Leave the other attendance keys (`attendance_muster`, `overtime_analytics`, `compliance_report`, `absence_patterns`, `defaulter_alerts`, etc.) intact.

- [ ] **Step 3: Delete the dead files**

Delete `components/dashboard/attendance/AttendanceLiveView.tsx`.
Delete `app/dashboard/attendance/live/loading.tsx` (a `loading.tsx` for a route whose `page.tsx` only calls `redirect()` never renders). Keep `app/dashboard/attendance/live/page.tsx` (the redirect stub for old bookmarks).

- [ ] **Step 4: Verify**

Run: `grep -rn "live_presence" app components lib` — expect NO matches in code (it may still appear in `app/messages/*.json` — leave message strings alone; only code references must be gone).
Run: `npx tsc --noEmit -p tsconfig.json` — expect clean (no output).

- [ ] **Step 5: Commit checkpoint** — SKIP (no git). Suggested message: `chore(web): drop dead live_presence feature + AttendanceLiveView`

---

## Task 5: Web — `<FeatureGate>` on overtime, compliance, patterns pages

All commands run from `crewroster-web/`.

**Files:**

- Modify: `app/dashboard/attendance/overtime/page.tsx`
- Modify: `app/dashboard/attendance/compliance/page.tsx`
- Modify: `app/dashboard/attendance/patterns/page.tsx`

- [ ] **Step 1: Inspect the FeatureGate component + an existing usage**

Open `components/subscription/FeatureGate.tsx` — confirm props `module`, `subFeature`, and the `as` heading prop. Open `compliance/page.tsx` and note the existing `<FeatureGate module="attendance" subFeature="defaulter_alerts">` usage (added by the prior feature) as the reference pattern.

- [ ] **Step 2: Wrap the overtime page**

In `app/dashboard/attendance/overtime/page.tsx`, wrap the component's entire returned JSX tree in:

```tsx
<FeatureGate module="attendance" subFeature="overtime_analytics">
  {/* existing page JSX */}
</FeatureGate>
```

Add the import: `import { FeatureGate } from '@/components/subscription/FeatureGate';` (match the exact import path/style used by `compliance/page.tsx`). The page is a client component — the gate wraps the rendered output; locked tiers get `<UpgradePrompt>` automatically.

- [ ] **Step 3: Wrap the patterns page**

Same as Step 2 for `app/dashboard/attendance/patterns/page.tsx`, with `subFeature="absence_patterns"`.

- [ ] **Step 4: Wrap the compliance page**

In `app/dashboard/attendance/compliance/page.tsx`, wrap the entire returned JSX tree in `<FeatureGate module="attendance" subFeature="compliance_report">`. The page already contains an inner `<FeatureGate subFeature="defaulter_alerts">` around the defaulter-alerts card — leave that inner gate as-is (nested gates are fine; when `compliance_report` is locked the whole page is replaced by the upgrade prompt and the inner gate never renders).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` — expect clean.
Run: `npx eslint app/dashboard/attendance/overtime/page.tsx app/dashboard/attendance/patterns/page.tsx app/dashboard/attendance/compliance/page.tsx` — expect no new errors.

- [ ] **Step 6: Commit checkpoint** — SKIP (no git). Suggested message: `feat(web): gate overtime/compliance/patterns pages behind subscription`

---

## Task 6: Web — gate the Register toggle in Overview's Member Breakdown

All commands run from `crewroster-web/`.

**Files:**

- Modify: `app/dashboard/attendance/overview/AttendanceOverviewClient.tsx`

- [ ] **Step 1: Read the Member Breakdown region**

Open `AttendanceOverviewClient.tsx`. Locate: the `breakdownView` state (`'summary' | 'register'`), the Summary/Register toggle (`role="tablist"` with two `<button role="tab">`s, ~lines 914-957), and where `<AttendanceMusterView>` is mounted (~line 1013) when `breakdownView === 'register'`.

- [ ] **Step 2: Add the feature-access hook**

Add the import for the hook (confirm the exact path/name — `grep -rn "useFeatureAccess" components hooks lib`; it is the hook `FeatureGate` itself uses):

```ts
import { useFeatureAccess } from '@/hooks/useFeatureAccess';
```

Inside the component, near the other hooks:

```ts
const musterAccess = useFeatureAccess('attendance', 'attendance_muster');
const musterLocked = musterAccess.isLocked;
```

- [ ] **Step 3: Disable the Register toggle when locked**

In the toggle's `.map(...)` over the two options, for the `register` option's `<button>`:

- add `disabled={opt.value === 'register' && musterLocked}`,
- when `opt.value === 'register' && musterLocked`, render a small lock icon (`<LockOutlined />` from `@ant-design/icons` — add the import) next to the label,
- add `title={opt.value === 'register' && musterLocked ? t('overview.registerLockedHint') : undefined}` (or reuse an existing "upgrade to unlock" string; if no suitable i18n key exists, add `overview.registerLockedHint` = "Upgrade your plan to unlock the Register view" to all 4 message files' `attendance.overview` block, identical keys, translated values).
- Keep the `onClick` a no-op when locked: `onClick={() => { if (opt.value === 'register' && musterLocked) return; setBreakdownView(opt.value); }}`.

- [ ] **Step 4: Guard the Register render**

Where `breakdownView === 'register'` renders `<AttendanceMusterView ... />`, change the condition so that when `musterLocked` is true it renders the gate fallback instead. Wrap that branch:

```tsx
{
  breakdownView === 'register' &&
    (musterLocked ? (
      <FeatureGate module="attendance" subFeature="attendance_muster">
        {null}
      </FeatureGate>
    ) : (
      <AttendanceMusterView /* existing props */ />
    ));
}
```

`<FeatureGate>` with locked access renders `<UpgradePrompt>`; passing `{null}` children is fine since the locked branch never shows children. Add the `FeatureGate` import. (This is a defensive guard — Step 3 already prevents selecting Register while locked, but state could be stale.)

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` — expect clean.
Run: `npx eslint app/dashboard/attendance/overview/AttendanceOverviewClient.tsx` — expect no new errors.
If `overview.registerLockedHint` was added: `node -e "['en','gu-en','hi-en','gu'].forEach(f=>JSON.parse(require('fs').readFileSync('app/messages/'+f+'.json','utf8')));console.log('json ok')"`.

- [ ] **Step 6: Manual check**

On a workspace whose plan has `attendance_muster` LOCKED: open `/dashboard/attendance/overview` — the Register toggle is disabled with a lock icon; Summary works; the page defaults to Summary. On a plan with `attendance_muster` FULL: Register works normally.

- [ ] **Step 7: Commit checkpoint** — SKIP (no git). Suggested message: `feat(web): gate the Member Breakdown Register toggle behind attendance_muster`

---

## Final verification

- [ ] Backend: `npx vitest run src/common/constants/__tests__/attendance-gating-registry.vitest.ts src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts` — all pass.
- [ ] Web: `npx tsc --noEmit -p tsconfig.json` clean; `npx eslint` clean on all touched files.
- [ ] Boot the backend once; confirm the log line `Attendance gating migration: tier-aware backfill patched N plan(s), M subscription(s).` on first boot; a second boot logs nothing for the gating pass (idempotent).
- [ ] In the admin panel, assign a custom plan touching the attendance module — the previous `400 Invalid sub-feature key` no longer occurs.
- [ ] Smoke: a free/starter workspace sees upgrade prompts on the gated pages; a pro+ workspace sees them normally.

## Spec coverage map

| Spec section                                    | Task(s)                                                   |
| ----------------------------------------------- | --------------------------------------------------------- |
| §5.1 Registry catalogue                         | Task 1                                                    |
| §5.2 Tier defaults                              | Task 1                                                    |
| §5.3 `@RequireSubscription` enforcement         | Task 2                                                    |
| §5.4 Tier-aware backfill migration              | Task 3                                                    |
| §6.1 Drop `live_presence` + dead code           | Task 4                                                    |
| §6.2 Page gating (overtime/compliance/patterns) | Task 5                                                    |
| §6.3 Register-toggle gating                     | Task 6                                                    |
| §7 Edge cases                                   | Task 3 (tier fallback, idempotency), Task 5 (nested gate) |
| §8 Testing                                      | Tasks 1, 3 (vitest); Tasks 4-6 (tsc/eslint/manual)        |
