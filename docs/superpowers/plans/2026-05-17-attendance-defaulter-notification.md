# Attendance Defaulter Notification — Implementation Plan

> ✅ **STATUS: COMPLETE — verified 2026-05-18 by code-state audit.** All 14 tasks (Phases A–E) were implemented in a prior session; the `- [ ]` checkboxes below were never ticked but the work is done — feature registry + boot-time migration, `defaulterAlerts` workspace schema + DTO + `PATCH` endpoint, `DefaulterAlertDispatch` schema, notification category + email template, `DefaulterAlertService` + monthly cron, web config card on the Compliance panel. 6 plan test suites pass. No gaps.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When employees fall below a workspace's attendance compliance threshold for a completed month, automatically notify configured recipients (managers and/or owner-specified people) via in-app notification and email.

**Architecture:** A monthly NestJS cron evaluates the previous closed month for each opted-in workspace, finds members below the threshold, and a dispatch service resolves recipients and fans out one digest per recipient over in-app + email channels. The feature is gated behind a new `defaulter_alerts` sub-feature of the `attendance` module; a boot-time migration backfills existing plans and subscriptions so no current customer is locked out.

**Tech Stack:** NestJS, Mongoose, `@nestjs/schedule`, `@nestjs-modules/mailer` + Handlebars, Next.js 16, antd v6.

**Spec:** `crewroster-backend/docs/superpowers/specs/2026-05-17-attendance-defaulter-notification-design.md`

**Git note:** Per project policy the **owner performs all `git add` / `git commit`**. The "Commit" steps below are checkpoints — the executing agent must NOT run git; it stops at each checkpoint so the owner can stage and commit.

**Verification commands** (run from `crewroster-backend/`):

- Typecheck: `npx tsc --noEmit -p tsconfig.json`
- Single test file: `npx vitest run src/path/to/file.vitest.ts`
- Lint: `npx eslint src/path/to/file.ts`

Tests are colocated as `src/**/__tests__/*.vitest.ts`. When a Mongoose schema's transitive decorators trip vitest's reflect-metadata pipeline, use the `@nestjs/mongoose` decorator-mock pattern from `src/modules/auth/__tests__/auth.service.audit.vitest.ts`.

---

## Phase A — Subscription feature gate

### Task 1: Register `defaulter_alerts` in the feature registry

**Files:**

- Modify: `src/common/constants/module-features.registry.ts`
- Test: `src/common/constants/__tests__/defaulter-alerts-registry.vitest.ts`

- [ ] **Step 1: Write the failing test**

Create `src/common/constants/__tests__/defaulter-alerts-registry.vitest.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MODULE_FEATURES_REGISTRY, buildModuleAccess } from '../module-features.registry';
import { AppModule } from '../../enums/modules.enum';
import { FeatureAccessLevel } from '../../enums/feature-access.enum';

describe('defaulter_alerts feature registry', () => {
  it('is catalogued under the attendance module', () => {
    const attendance = MODULE_FEATURES_REGISTRY.find((m) => m.module === AppModule.ATTENDANCE);
    const sub = attendance?.subFeatures.find((s) => s.key === 'defaulter_alerts');
    expect(sub).toBeDefined();
    expect(sub?.supportsLimited).toBe(false);
  });

  it('seeds LOCKED for new free-tier subscriptions', () => {
    const access = buildModuleAccess('free');
    const attendance = access.find((m) => m.module === AppModule.ATTENDANCE);
    const sub = attendance?.subFeatures.find((s) => s.key === 'defaulter_alerts');
    expect(sub?.access).toBe(FeatureAccessLevel.LOCKED);
  });

  it('seeds FULL for new paid-tier subscriptions', () => {
    for (const tier of ['starter', 'pro', 'growth', 'business', 'enterprise']) {
      const access = buildModuleAccess(tier);
      const attendance = access.find((m) => m.module === AppModule.ATTENDANCE);
      const sub = attendance?.subFeatures.find((s) => s.key === 'defaulter_alerts');
      expect(sub?.access, `tier=${tier}`).toBe(FeatureAccessLevel.FULL);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/common/constants/__tests__/defaulter-alerts-registry.vitest.ts`
Expected: FAIL — `sub` is `undefined` (key not catalogued yet).

- [ ] **Step 3: Add the sub-feature to `MODULE_FEATURES_REGISTRY`**

In `module-features.registry.ts`, find the `ATTENDANCE` entry in `MODULE_FEATURES_REGISTRY` (near the top of the file, ~line 19-92). Append to its `subFeatures` array:

```ts
{
  key: 'defaulter_alerts',
  label: 'Defaulter Alerts',
  description:
    'Monthly automated alerts when employees fall below the attendance compliance threshold',
  supportsLimited: false,
},
```

- [ ] **Step 4: Add the tier-default seed block**

In the same file, immediately AFTER the existing `_WAVE4_FINANCE_REMINDERS_TIER_DEFAULTS` merge loop (the `for (const [tier, modules] of Object.entries(_WAVE4_FINANCE_REMINDERS_TIER_DEFAULTS))` block, ~line 2947-2957), append:

```ts
/**
 * Attendance defaulter-alerts sub-feature tier defaults (2026-05-17).
 * Seeds NEW subscriptions only; existing tenants are backfilled to FULL by
 * AttendancePlanMigrationService. free => LOCKED, all paid tiers => FULL.
 * Runtime-merged to avoid editing the 7 large tier blocks above.
 */
const _DEFAULTER_ALERTS_TIER_DEFAULTS: Record<
  string,
  Partial<Record<AppModule, Record<string, FeatureAccessLevel>>>
> = {
  free: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.LOCKED } },
  starter: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  pro: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  growth: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  business: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  enterprise: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  custom: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
};
for (const [tier, modules] of Object.entries(_DEFAULTER_ALERTS_TIER_DEFAULTS)) {
  if (!TIER_SUBFEATURE_DEFAULTS[tier]) TIER_SUBFEATURE_DEFAULTS[tier] = {};
  for (const [moduleKey, subFeatures] of Object.entries(modules ?? {})) {
    if (!TIER_SUBFEATURE_DEFAULTS[tier][moduleKey]) {
      TIER_SUBFEATURE_DEFAULTS[tier][moduleKey] = {};
    }
    Object.assign(TIER_SUBFEATURE_DEFAULTS[tier][moduleKey], subFeatures);
  }
}
```

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run: `npx vitest run src/common/constants/__tests__/defaulter-alerts-registry.vitest.ts`
Expected: PASS (3 tests).
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit checkpoint**

Stage `src/common/constants/module-features.registry.ts` and the new test file.
Suggested message: `feat(subscriptions): catalogue attendance defaulter_alerts sub-feature`

---

### Task 2: Boot-time backfill migration — `AttendancePlanMigrationService`

Without this, the new `defaulter_alerts` key is absent from every existing subscription's frozen `appliedEntitlements`; the `SubscriptionGuard` then resolves it to `LOCKED` and 403s every current customer. This service grandfathers existing tenants to `FULL`, exactly as `FinancePlanMigrationService` does.

**Files:**

- Create: `src/modules/subscriptions/attendance-plan-migration.service.ts`
- Modify: `src/modules/subscriptions/subscriptions.module.ts`
- Test: `src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`

- [ ] **Step 1: Write the failing test**

Reference precedent: `src/modules/subscriptions/finance-plan-migration.service.ts`. Create `src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { AttendancePlanMigrationService } from '../attendance-plan-migration.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';

function makeService() {
  const planModel = { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }) };
  const subscriptionModel = {
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 5 }),
  };
  const service = new AttendancePlanMigrationService(
    planModel as never,
    subscriptionModel as never,
  );
  return { service, planModel, subscriptionModel };
}

describe('AttendancePlanMigrationService', () => {
  it('adds defaulter_alerts (FULL) to the attendance entry of plans and subscriptions', async () => {
    const { service, planModel, subscriptionModel } = makeService();
    await service.onModuleInit();

    expect(planModel.updateMany).toHaveBeenCalledWith(
      { 'entitlements.moduleAccess.module': AppModule.ATTENDANCE },
      {
        $addToSet: {
          'entitlements.moduleAccess.$[elem].subFeatures': {
            key: 'defaulter_alerts',
            access: FeatureAccessLevel.FULL,
          },
        },
      },
      { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
    );
    expect(subscriptionModel.updateMany).toHaveBeenCalledWith(
      { 'appliedEntitlements.moduleAccess.module': AppModule.ATTENDANCE },
      {
        $addToSet: {
          'appliedEntitlements.moduleAccess.$[elem].subFeatures': {
            key: 'defaulter_alerts',
            access: FeatureAccessLevel.FULL,
          },
        },
      },
      { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
    );
  });

  it('never throws on a DB error (boot must not crash)', async () => {
    const { service, planModel } = makeService();
    planModel.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service.onModuleInit()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`
Expected: FAIL — module `attendance-plan-migration.service` not found.

- [ ] **Step 3: Create the migration service**

Create `src/modules/subscriptions/attendance-plan-migration.service.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from './schemas/plan.schema';
import { Subscription } from './schemas/subscription.schema';
import { AppModule } from '../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../common/enums/feature-access.enum';

/**
 * Backfills the `defaulter_alerts` sub-feature into the ATTENDANCE module
 * entry of every existing Plan and Subscription.
 *
 * Why: the ATTENDANCE module entry already carries a NON-EMPTY subFeatures
 * array in every existing tenant. SubscriptionGuard resolves a sub-feature
 * key absent from a non-empty array to LOCKED -> 403. Without this backfill
 * the new @RequireSubscription({ ATTENDANCE, 'defaulter_alerts' }) gate would
 * lock out every current customer.
 *
 * Access = FULL for existing tenants (grandfathered) — matches the convention
 * in FinancePlanMigrationService. Tier locking applies only to fresh
 * subscriptions via buildModuleAccess; admins re-tighten per plan afterward.
 *
 * Idempotent: $addToSet with the full { key, access } object is a no-op on
 * re-run (MongoDB compares by object equality). Runs on every boot.
 */
@Injectable()
export class AttendancePlanMigrationService implements OnModuleInit {
  private readonly logger = new Logger(AttendancePlanMigrationService.name);

  private static readonly ENTRY = {
    key: 'defaulter_alerts',
    access: FeatureAccessLevel.FULL,
  };

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const planResult = await this.planModel.updateMany(
        { 'entitlements.moduleAccess.module': AppModule.ATTENDANCE },
        {
          $addToSet: {
            'entitlements.moduleAccess.$[elem].subFeatures': AttendancePlanMigrationService.ENTRY,
          },
        },
        { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
      );

      const subResult = await this.subscriptionModel.updateMany(
        { 'appliedEntitlements.moduleAccess.module': AppModule.ATTENDANCE },
        {
          $addToSet: {
            'appliedEntitlements.moduleAccess.$[elem].subFeatures':
              AttendancePlanMigrationService.ENTRY,
          },
        },
        { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
      );

      if (planResult.modifiedCount > 0 || subResult.modifiedCount > 0) {
        this.logger.log(
          `Attendance migration: seeded defaulter_alerts into ` +
            `${planResult.modifiedCount} plan(s), ` +
            `${subResult.modifiedCount} subscription(s).`,
        );
      }
    } catch (err) {
      // Never crash boot on a migration hiccup.
      this.logger.warn(`AttendancePlanMigrationService failed: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Register the service as a provider**

Open `src/modules/subscriptions/subscriptions.module.ts`. Find where `FinancePlanMigrationService` and `MachinesPlanMigrationService` are listed in the `providers` array, add an import at the top:

```ts
import { AttendancePlanMigrationService } from './attendance-plan-migration.service';
```

and add `AttendancePlanMigrationService` to the `providers` array alongside the other two migration services.

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run: `npx vitest run src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`
Expected: PASS (2 tests).
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit checkpoint**

Stage the new service, the test, and `subscriptions.module.ts`.
Suggested message: `feat(subscriptions): backfill defaulter_alerts into existing plans + subscriptions`

---

## Phase B — Workspace config

### Task 3: `defaulterAlerts` sub-document on the workspace schema

**Files:**

- Modify: `src/modules/workspaces/schemas/workspace.schema.ts`

- [ ] **Step 1: Add the sub-document**

In `workspace.schema.ts`, find the existing `attendanceSettings` `@Prop` (the block defining `complianceThresholdPct`, ~line 178-192). Replace its `type` object and the TS type so it also carries `defaulterAlerts`:

```ts
@Prop({
  type: {
    complianceThresholdPct: { type: Number, default: 90, min: 50, max: 100 },
    defaulterAlerts: {
      type: {
        enabled: { type: Boolean, default: false },
        channels: {
          type: {
            inApp: { type: Boolean, default: true },
            email: { type: Boolean, default: false },
          },
          default: () => ({ inApp: true, email: false }),
          _id: false,
        },
        recipients: {
          type: {
            mode: {
              type: String,
              enum: ['managers', 'specificPeople', 'both'],
              default: 'managers',
            },
            specificPeople: {
              type: [{ type: Types.ObjectId, ref: 'User' }],
              default: [],
            },
          },
          default: () => ({ mode: 'managers', specificPeople: [] }),
          _id: false,
        },
      },
      default: () => ({
        enabled: false,
        channels: { inApp: true, email: false },
        recipients: { mode: 'managers', specificPeople: [] },
      }),
      _id: false,
    },
  },
  default: () => ({
    complianceThresholdPct: 90,
    defaulterAlerts: {
      enabled: false,
      channels: { inApp: true, email: false },
      recipients: { mode: 'managers', specificPeople: [] },
    },
  }),
  _id: false,
})
attendanceSettings?: {
  complianceThresholdPct: number;
  defaulterAlerts: {
    enabled: boolean;
    channels: { inApp: boolean; email: boolean };
    recipients: {
      mode: 'managers' | 'specificPeople' | 'both';
      specificPeople: Types.ObjectId[];
    };
  };
};
```

Confirm `Types` is already imported from `mongoose` at the top of the file (it is used elsewhere in this schema). If not, add it.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 3: Commit checkpoint**

Stage `workspace.schema.ts`.
Suggested message: `feat(workspaces): add attendanceSettings.defaulterAlerts config sub-document`

---

### Task 4: `DefaulterAlertsConfigDto`

**Files:**

- Modify: `src/modules/workspaces/dto/workspace.dto.ts`
- Test: `src/modules/workspaces/__tests__/defaulter-alerts-config.dto.vitest.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/workspaces/__tests__/defaulter-alerts-config.dto.vitest.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DefaulterAlertsConfigDto } from '../dto/workspace.dto';

async function errorsFor(payload: unknown): Promise<string[]> {
  const dto = plainToInstance(DefaulterAlertsConfigDto, payload);
  const errors = await validate(dto, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('DefaulterAlertsConfigDto', () => {
  it('accepts a valid payload', async () => {
    expect(
      await errorsFor({
        enabled: true,
        channels: { inApp: true, email: false },
        recipients: { mode: 'managers', specificPeople: [] },
      }),
    ).toEqual([]);
  });

  it('rejects an invalid recipients.mode', async () => {
    const errors = await errorsFor({
      enabled: true,
      channels: { inApp: true, email: true },
      recipients: { mode: 'everyone', specificPeople: [] },
    });
    expect(errors).toContain('recipients');
  });

  it('rejects a non-ObjectId in specificPeople', async () => {
    const errors = await errorsFor({
      enabled: true,
      channels: { inApp: true, email: true },
      recipients: { mode: 'specificPeople', specificPeople: ['not-an-id'] },
    });
    expect(errors).toContain('recipients');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/workspaces/__tests__/defaulter-alerts-config.dto.vitest.ts`
Expected: FAIL — `DefaulterAlertsConfigDto` is not exported.

- [ ] **Step 3: Add the DTO classes**

In `src/modules/workspaces/dto/workspace.dto.ts`, add near the existing `AttendanceSettingsDto` class. Confirm these imports exist at the top (`IsBoolean`, `IsEnum`, `IsArray`, `IsMongoId`, `ValidateNested`, `IsOptional`, `Type`); add any that are missing.

```ts
class DefaulterAlertsChannelsDto {
  @IsBoolean()
  inApp: boolean;

  @IsBoolean()
  email: boolean;
}

class DefaulterAlertsRecipientsDto {
  @IsEnum(['managers', 'specificPeople', 'both'])
  mode: 'managers' | 'specificPeople' | 'both';

  @IsArray()
  @IsMongoId({ each: true })
  specificPeople: string[];
}

export class DefaulterAlertsConfigDto {
  @IsBoolean()
  enabled: boolean;

  @ValidateNested()
  @Type(() => DefaulterAlertsChannelsDto)
  channels: DefaulterAlertsChannelsDto;

  @ValidateNested()
  @Type(() => DefaulterAlertsRecipientsDto)
  recipients: DefaulterAlertsRecipientsDto;
}
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `npx vitest run src/modules/workspaces/__tests__/defaulter-alerts-config.dto.vitest.ts`
Expected: PASS (3 tests).
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit checkpoint**

Stage `workspace.dto.ts` and the test.
Suggested message: `feat(workspaces): add DefaulterAlertsConfigDto`

---

### Task 5: `PATCH /workspaces/:id/defaulter-alerts` endpoint + service method

**Files:**

- Modify: `src/modules/workspaces/workspaces.service.ts`
- Modify: `src/modules/workspaces/workspaces.controller.ts`
- Test: `src/modules/workspaces/__tests__/update-defaulter-alerts.service.vitest.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/workspaces/__tests__/update-defaulter-alerts.service.vitest.ts`. Mirror the existing service-test setup pattern in this folder for constructing `WorkspacesService` with mocked models — open an existing `*.service.vitest.ts` in `src/modules/workspaces/__tests__/` first and copy its constructor-mocking shape. The behaviour to assert:

```ts
import { describe, it, expect, vi } from 'vitest';

describe('WorkspacesService.updateDefaulterAlertsConfig', () => {
  it('persists attendanceSettings.defaulterAlerts via $set and returns the updated workspace', async () => {
    const updated = { _id: 'ws1', attendanceSettings: { defaulterAlerts: { enabled: true } } };
    const workspaceModel = {
      findByIdAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(updated),
      }),
    };
    // Construct WorkspacesService with workspaceModel mocked (copy the
    // constructor shape from a sibling *.service.vitest.ts; pass harmless
    // stubs for the other injected deps).
    const service = /* new WorkspacesService(...) */ null as never;

    const dto = {
      enabled: true,
      channels: { inApp: true, email: true },
      recipients: { mode: 'managers' as const, specificPeople: [] },
    };
    const result = await (service as any).updateDefaulterAlertsConfig('ws1', dto);

    expect(workspaceModel.findByIdAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { 'attendanceSettings.defaulterAlerts': dto } },
      { new: true },
    );
    expect(result).toBe(updated);
  });
});
```

> Note for the engineer: replace the `service` placeholder with a real `WorkspacesService` instance using the exact constructor-mock pattern from a sibling test file in the same folder. The asserted contract (`findByIdAndUpdate` args, return value) is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/workspaces/__tests__/update-defaulter-alerts.service.vitest.ts`
Expected: FAIL — `updateDefaulterAlertsConfig` is not a function.

- [ ] **Step 3: Add the service method**

In `workspaces.service.ts`, add a method modelled on the existing `update` / `updateKioskSettings` methods (use `withWorkspaceSpan` if the surrounding methods do). Add `DefaulterAlertsConfigDto` to the DTO import from `./dto/workspace.dto`:

```ts
async updateDefaulterAlertsConfig(
  workspaceId: string,
  dto: DefaulterAlertsConfigDto,
): Promise<Workspace> {
  return this.withWorkspaceSpan(
    'workspace.updateDefaulterAlerts',
    { workspaceId },
    async () => {
      const workspace = await this.workspaceModel
        .findByIdAndUpdate(
          new Types.ObjectId(workspaceId),
          { $set: { 'attendanceSettings.defaulterAlerts': dto } },
          { new: true },
        )
        .exec();
      if (!workspace) throw new NotFoundException('Workspace not found');

      this.auditWorkspaceEvent({
        action: 'workspace.defaulter_alerts_config_updated',
        workspaceId,
        actorId: workspace.ownerId,
        entityId: workspaceId,
        meta: { enabled: dto.enabled },
      });

      return workspace;
    },
  );
}
```

> If `withWorkspaceSpan` / `auditWorkspaceEvent` signatures differ in this file, match the exact shape used by the neighbouring `update` method. If `auditWorkspaceEvent` requires a registered action enum value, add `'workspace.defaulter_alerts_config_updated'` wherever the workspace audit actions are declared (see Task 9 for the attendance audit actions; the workspace-config update action lives with the other `workspace.*` actions).

- [ ] **Step 4: Add the controller endpoint**

In `workspaces.controller.ts`, add — modelled on the existing `@Patch(':id/kiosk')` handler. Add imports for `RequireSubscription`, `AppModule`, and `DefaulterAlertsConfigDto` if not present:

```ts
@Patch(':id/defaulter-alerts')
@RequirePermissions(AppModule.WORKSPACES, ModuleAction.EDIT)
@RequireSubscription({
  module: AppModule.ATTENDANCE,
  subFeature: 'defaulter_alerts',
})
updateDefaulterAlerts(
  @Param('id') id: string,
  @Body() dto: DefaulterAlertsConfigDto,
) {
  return this.workspacesService.updateDefaulterAlertsConfig(id, dto);
}
```

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run: `npx vitest run src/modules/workspaces/__tests__/update-defaulter-alerts.service.vitest.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit checkpoint**

Stage `workspaces.service.ts`, `workspaces.controller.ts`, the test.
Suggested message: `feat(workspaces): add PATCH /workspaces/:id/defaulter-alerts endpoint`

---

## Phase C — Dispatch infrastructure

### Task 6: `DefaulterAlertDispatch` idempotency schema

**Files:**

- Create: `src/modules/attendance/schemas/defaulter-alert-dispatch.schema.ts`
- Modify: `src/modules/attendance/attendance.module.ts`

- [ ] **Step 1: Create the schema**

Create `src/modules/attendance/schemas/defaulter-alert-dispatch.schema.ts`. Model the file shape on an existing small schema in `src/modules/attendance/schemas/`:

```ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One row per (workspace, evaluated month) the monthly defaulter-alert cron
 * has processed. Existence of a row makes the cron idempotent — a re-run for
 * the same period is skipped.
 */
@Schema({ timestamps: true, collection: 'defaulteralertdispatches' })
export class DefaulterAlertDispatch extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  /** Evaluated period, 'YYYY-MM' (the closed month the cron evaluated). */
  @Prop({ type: String, required: true })
  periodKey: string;

  @Prop({ type: Date, required: true })
  dispatchedAt: Date;

  @Prop({ type: Number, default: 0 })
  defaulterCount: number;

  @Prop({ type: Number, default: 0 })
  recipientCount: number;
}

export const DefaulterAlertDispatchSchema = SchemaFactory.createForClass(DefaulterAlertDispatch);

// One dispatch per workspace per evaluated month.
DefaulterAlertDispatchSchema.index({ workspaceId: 1, periodKey: 1 }, { unique: true });
```

- [ ] **Step 2: Register the schema in the attendance module**

In `src/modules/attendance/attendance.module.ts`, add to the `MongooseModule.forFeature([...])` array:

```ts
{ name: DefaulterAlertDispatch.name, schema: DefaulterAlertDispatchSchema },
```

and import both names from `./schemas/defaulter-alert-dispatch.schema`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 4: Commit checkpoint**

Stage the schema and `attendance.module.ts`.
Suggested message: `feat(attendance): add DefaulterAlertDispatch idempotency schema`

---

### Task 7: `ATTENDANCE_DEFAULTER` notification category

**Files:**

- Modify: the notification category definition (locate with `grep -rn "INVITE_RECEIVED" src/modules/notifications`)

- [ ] **Step 1: Locate the category enum/union**

Run: `grep -rn "INVITE_RECEIVED" src/modules/notifications` to find where notification categories are declared (an enum or string-union type used by the `me-notifications` filter).

- [ ] **Step 2: Add the new category**

Add `ATTENDANCE_DEFAULTER` (matching the casing/style of the existing entries — e.g. `ATTENDANCE_DEFAULTER = 'ATTENDANCE_DEFAULTER'` for an enum, or `'ATTENDANCE_DEFAULTER'` for a union). If a category label/display map exists alongside, add a human label `'Attendance defaulter'`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 4: Commit checkpoint**

Suggested message: `feat(notifications): add ATTENDANCE_DEFAULTER category`

---

### Task 8: `defaulter-alert.hbs` email template

**Files:**

- Create: `src/modules/mail/templates/defaulter-alert.hbs`

- [ ] **Step 1: Inspect an existing template**

Open `src/modules/mail/templates/anomaly-alert.hbs` to copy the brand-context layout conventions (`{{brand.emailHeader}}`, `{{brand.name}}`, `{{brand.emailSignature}}`, button styles).

- [ ] **Step 2: Create the template**

Create `src/modules/mail/templates/defaulter-alert.hbs` with the same outer brand wrapper as `anomaly-alert.hbs`, and this body content. It expects context: `monthLabel` (e.g. "April 2026"), `thresholdPct`, `defaulters` (array of `{ name, designation, ratePct }`), `complianceUrl`:

```handlebars
<h2 style='margin:0 0 12px;font-size:18px;color:#1a2a6c;'>
  Attendance defaulters —
  {{monthLabel}}
</h2>
<p style='margin:0 0 16px;font-size:14px;color:#444;'>
  {{defaulters.length}}
  member(s) finished
  {{monthLabel}}
  below the
  {{thresholdPct}}% attendance threshold.
</p>
<table style='width:100%;border-collapse:collapse;font-size:13px;'>
  <thead>
    <tr style='text-align:left;border-bottom:2px solid #eee;'>
      <th style='padding:6px 8px;'>Member</th>
      <th style='padding:6px 8px;'>Designation</th>
      <th style='padding:6px 8px;text-align:right;'>Attendance</th>
    </tr>
  </thead>
  <tbody>
    {{#each defaulters}}
      <tr style='border-bottom:1px solid #f0f0f0;'>
        <td style='padding:6px 8px;'>{{this.name}}</td>
        <td style='padding:6px 8px;color:#777;'>{{this.designation}}</td>
        <td style='padding:6px 8px;text-align:right;font-weight:600;color:#d4380d;'>
          {{this.ratePct}}%
        </td>
      </tr>
    {{/each}}
  </tbody>
</table>
<p style='margin:20px 0;'>
  <a
    href='{{complianceUrl}}'
    style='background:#1a2a6c;color:#fff;padding:10px 18px;border-radius:8px;
            text-decoration:none;font-size:14px;font-weight:600;'
  >
    Open the Compliance report
  </a>
</p>
```

- [ ] **Step 3: Commit checkpoint**

Suggested message: `feat(mail): add defaulter-alert email template`

---

### Task 9: Attendance audit actions

**Files:**

- Modify: the attendance audit-action declaration (locate with `grep -rn "attendance\." src/modules/audit src/modules/attendance | grep -i action`)

- [ ] **Step 1: Locate where attendance audit action strings are declared**

Audit actions are plain strings passed to `AuditService.logEvent({ action })`. Find where existing `attendance.*` actions are declared (an `AuditAction` const map, or used inline). If a central const map exists, add entries; if actions are inline strings, no declaration file change is needed — they will be used directly in Task 10.

- [ ] **Step 2: Register the actions (if a central map exists)**

Add: `attendance.defaulter_alert_sent`, `attendance.defaulter_alert_failed`. (The config-update action `workspace.defaulter_alerts_config_updated` from Task 5 lives with the `workspace.*` actions.)

- [ ] **Step 3: Typecheck + commit checkpoint**

Run: `npx tsc --noEmit -p tsconfig.json` — expected no output.
Suggested message: `feat(audit): register attendance defaulter-alert actions`

---

### Task 10: `DefaulterAlertService`

**Files:**

- Create: `src/modules/attendance/defaulter-alert.service.ts`
- Modify: `src/modules/attendance/attendance.module.ts`
- Test: `src/modules/attendance/__tests__/defaulter-alert.service.vitest.ts`

This service is pure orchestration over already-existing services. Confirm the exact signatures of these collaborators before wiring (they were mapped during design but verify against source):

- `NotificationsService.createNotification(workspaceId, { recipientId, title, message, type, metadata })`
- `MailService.checkEmailQuota(workspaceId)` → `{ allowed: boolean }`, and the mailer send call used by sibling code (`anomaly-alert.hbs` is sent somewhere — `grep -rn "anomaly-alert" src/modules` to find the exact send call and copy it).
- `AuditService.logEvent({ workspaceId, module, entityType, entityId, action, actorId, meta })`
- `TeamMember` schema field `reportsTo` (ObjectId ref TeamMember) and `userId`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/attendance/__tests__/defaulter-alert.service.vitest.ts`. Test the recipient-resolution logic, which is the part with real branching. Construct `DefaulterAlertService` with all collaborators mocked:

```ts
import { describe, it, expect, vi } from 'vitest';
import { DefaulterAlertService } from '../defaulter-alert.service';

function makeDeps() {
  return {
    notifications: { createNotification: vi.fn().mockResolvedValue(undefined) },
    mail: {
      checkEmailQuota: vi.fn().mockResolvedValue({ allowed: true }),
      sendDefaulterAlert: vi.fn().mockResolvedValue(undefined),
    },
    audit: { logEvent: vi.fn().mockResolvedValue(undefined) },
    teamMemberModel: { find: vi.fn(), findById: vi.fn() },
    userModel: { find: vi.fn() },
  };
}

describe('DefaulterAlertService.resolveRecipientUserIds', () => {
  it('mode=specificPeople returns exactly the configured users', async () => {
    const d = makeDeps();
    const svc = new DefaulterAlertService(
      d.notifications as never,
      d.mail as never,
      d.audit as never,
      d.teamMemberModel as never,
      d.userModel as never,
    );
    const ids = await (svc as any).resolveRecipientUserIds({
      workspace: { _id: 'ws1', ownerId: 'owner1' },
      defaulters: [{ memberId: 'm1' }],
      config: { recipients: { mode: 'specificPeople', specificPeople: ['u1', 'u2'] } },
    });
    expect([...ids].sort()).toEqual(['u1', 'u2']);
  });

  it('falls back to the workspace owner when no recipient resolves', async () => {
    const d = makeDeps();
    d.teamMemberModel.find.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve([]) }),
    });
    const svc = new DefaulterAlertService(
      d.notifications as never,
      d.mail as never,
      d.audit as never,
      d.teamMemberModel as never,
      d.userModel as never,
    );
    const ids = await (svc as any).resolveRecipientUserIds({
      workspace: { _id: 'ws1', ownerId: 'owner1' },
      defaulters: [{ memberId: 'm1' }],
      config: { recipients: { mode: 'managers', specificPeople: [] } },
    });
    expect([...ids]).toEqual(['owner1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/attendance/__tests__/defaulter-alert.service.vitest.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the service**

Create `src/modules/attendance/defaulter-alert.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { TeamMember } from '../team/schemas/team-member.schema';
import { User } from '../users/schemas/user.schema';

export interface DefaulterRow {
  memberId: string;
  name: string;
  designation: string;
  attendanceRate: number;
}

export interface DispatchInput {
  workspace: { _id: any; ownerId: any };
  month: number; // 1-12
  year: number;
  thresholdPct: number;
  defaulters: DefaulterRow[];
  config: {
    channels: { inApp: boolean; email: boolean };
    recipients: {
      mode: 'managers' | 'specificPeople' | 'both';
      specificPeople: (string | Types.ObjectId)[];
    };
  };
}

export interface DispatchResult {
  recipientCount: number;
  channelsSent: { inApp: number; email: number };
  failures: number;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

@Injectable()
export class DefaulterAlertService {
  private readonly logger = new Logger(DefaulterAlertService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @InjectModel(TeamMember.name)
    private readonly teamMemberModel: Model<TeamMember>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const recipientIds = await this.resolveRecipientUserIds(input);
    const result: DispatchResult = {
      recipientCount: recipientIds.size,
      channelsSent: { inApp: 0, email: 0 },
      failures: 0,
    };
    if (recipientIds.size === 0) {
      this.logger.warn(
        `DefaulterAlert: no recipients resolved for workspace ${input.workspace._id} — skipping`,
      );
      return result;
    }

    const monthLabel = `${MONTHS[input.month - 1]} ${input.year}`;
    const title = `${input.defaulters.length} member(s) below the ${input.thresholdPct}% attendance threshold — ${monthLabel}`;
    const message = input.defaulters.map((d) => `${d.name} — ${d.attendanceRate}%`).join('\n');
    const link = `/dashboard/attendance/compliance?month=${input.month}&year=${input.year}`;

    for (const userId of recipientIds) {
      try {
        if (input.config.channels.inApp) {
          await this.notifications.createNotification(String(input.workspace._id), {
            recipientId: userId,
            title,
            message,
            type: 'warning',
            metadata: {
              category: 'ATTENDANCE_DEFAULTER',
              month: input.month,
              year: input.year,
              link,
            },
          } as never);
          result.channelsSent.inApp += 1;
        }

        if (input.config.channels.email) {
          const quota = await this.mail.checkEmailQuota(String(input.workspace._id));
          if (quota.allowed) {
            await this.sendEmail(userId, input, monthLabel, link);
            result.channelsSent.email += 1;
          } else {
            this.logger.warn(
              `DefaulterAlert: email quota exceeded for workspace ${input.workspace._id} — email skipped`,
            );
          }
        }

        await this.audit.logEvent({
          workspaceId: String(input.workspace._id),
          module: AppModule.ATTENDANCE,
          entityType: 'defaulter_alert',
          entityId: userId,
          action: 'attendance.defaulter_alert_sent',
          actorId: String(input.workspace.ownerId),
          meta: {
            month: input.month,
            year: input.year,
            defaulterCount: input.defaulters.length,
          },
        } as never);
      } catch (err) {
        result.failures += 1;
        this.logger.error(
          `DefaulterAlert: dispatch to ${userId} failed: ${(err as Error).message}`,
        );
        await this.audit
          .logEvent({
            workspaceId: String(input.workspace._id),
            module: AppModule.ATTENDANCE,
            entityType: 'defaulter_alert',
            entityId: userId,
            action: 'attendance.defaulter_alert_failed',
            actorId: String(input.workspace.ownerId),
            meta: { error: (err as Error).message },
          } as never)
          .catch(() => undefined);
      }
    }
    return result;
  }

  /** Resolve the deduplicated set of recipient userIds for a dispatch. */
  private async resolveRecipientUserIds(
    input: Pick<DispatchInput, 'workspace' | 'defaulters' | 'config'>,
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    const { mode, specificPeople } = input.config.recipients;

    if (mode === 'specificPeople' || mode === 'both') {
      for (const uid of specificPeople) ids.add(String(uid));
    }

    if (mode === 'managers' || mode === 'both') {
      const defaulterMemberIds = input.defaulters.map((d) => new Types.ObjectId(d.memberId));
      const members = await this.teamMemberModel
        .find({ _id: { $in: defaulterMemberIds } })
        .lean()
        .exec();
      const managerMemberIds = members
        .map((m: any) => m.reportsTo)
        .filter((x: any): x is Types.ObjectId => !!x);

      if (managerMemberIds.length > 0) {
        const managers = await this.teamMemberModel
          .find({ _id: { $in: managerMemberIds } })
          .lean()
          .exec();
        for (const mgr of managers as any[]) {
          if (mgr.userId) ids.add(String(mgr.userId));
        }
      }
      // Any defaulter without a manager -> fall back to the workspace owner.
      const someoneHasNoManager = members.some((m: any) => !m.reportsTo);
      if (someoneHasNoManager || members.length === 0) {
        ids.add(String(input.workspace.ownerId));
      }
    }

    if (ids.size === 0) ids.add(String(input.workspace.ownerId));
    return ids;
  }

  private async sendEmail(
    userId: string,
    input: DispatchInput,
    monthLabel: string,
    link: string,
  ): Promise<void> {
    const user = await this.userModel.findById(new Types.ObjectId(userId)).lean().exec();
    const email = (user as any)?.email;
    if (!email) return;

    // Use the same mailer send call sibling code uses for anomaly-alert.hbs.
    // `grep -rn "anomaly-alert" src/modules` to find it, and copy the
    // template/context invocation shape. Template: 'defaulter-alert'.
    await this.mail.sendDefaulterAlert({
      to: email,
      monthLabel,
      thresholdPct: input.thresholdPct,
      defaulters: input.defaulters.map((d) => ({
        name: d.name,
        designation: d.designation,
        ratePct: d.attendanceRate,
      })),
      complianceUrl: link,
    });
  }
}
```

> Engineer notes:
>
> - The `MailService` may not yet expose a `sendDefaulterAlert` method. If `MailService` is the right home, add a thin method there that renders the `defaulter-alert` template — copy the existing method that renders `anomaly-alert.hbs`. If sibling code renders templates inline via `MailerService.sendMail`, inline that call here instead and drop `sendDefaulterAlert`. Keep the implementation consistent with how `anomaly-alert.hbs` is sent.
> - Confirm `NotificationsService.createNotification`'s exact DTO shape and adjust the object (the `as never` casts are placeholders to be removed once the real types are imported).
> - Confirm `AuditService.logEvent`'s exact input type and remove the `as never` cast.

- [ ] **Step 4: Register the service in the attendance module**

In `attendance.module.ts`: add `DefaulterAlertService` to `providers` and to `exports` (the cron in Task 12 needs it). Ensure `NotificationsModule`, `MailModule`, `AuditModule` (or however those services are exposed) are imported, and that `TeamMember` and `User` schemas are available via `MongooseModule.forFeature` — add them if missing.

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run: `npx vitest run src/modules/attendance/__tests__/defaulter-alert.service.vitest.ts`
Expected: PASS (2 tests).
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(attendance): add DefaulterAlertService dispatch engine`

---

## Phase D — Monthly cron

### Task 11: Cron schedule + key constants

**Files:**

- Modify: `src/common/constants/cron.constants.ts`

- [ ] **Step 1: Add the schedule, timezone usage, and job key**

Open `cron.constants.ts`. Add a schedule constant for "1st of each month at 06:00" to `CRON_SCHEDULES` if no equivalent exists:

```ts
MONTHLY_1ST_AT_6AM: '0 6 1 * *',
```

Add a `CronJobKey` enum entry `DEFAULTER_ALERT = 'defaulter_alert'` (match the existing casing), and a corresponding entry in the `CRON_JOBS` metadata array following the shape of existing entries (key, schedule, timezone `IST`, description "Monthly attendance defaulter alerts").

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 3: Commit checkpoint**

Suggested message: `feat(attendance): register monthly defaulter-alert cron schedule`

---

### Task 12: `DefaulterAlertCron`

**Files:**

- Create: `src/modules/attendance/crons/defaulter-alert.cron.ts`
- Modify: `src/modules/attendance/attendance.module.ts`
- Test: `src/modules/attendance/__tests__/defaulter-alert.cron.vitest.ts`

Confirm before wiring: `AttendanceService.getComplianceReport(wsId, month, year)` returns `{ data: { summary, members } }` where each member has `{ memberId, name, designation, attendanceRate }` (`attendanceRate` is `number | null`). Verify against `attendance.service.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/attendance/__tests__/defaulter-alert.cron.vitest.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { DefaulterAlertCron } from '../crons/defaulter-alert.cron';

function makeCron(overrides: Record<string, any> = {}) {
  const deps = {
    workspaceModel: {
      find: vi.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(overrides.workspaces ?? []) }),
      }),
    },
    dispatchModel: {
      findOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve(overrides.existingDispatch ?? null),
      }),
      create: vi.fn().mockResolvedValue(undefined),
    },
    attendanceService: {
      getComplianceReport: vi.fn().mockResolvedValue(overrides.report ?? { data: { members: [] } }),
    },
    defaulterAlertService: {
      dispatch: vi.fn().mockResolvedValue({
        recipientCount: 1,
        channelsSent: { inApp: 1, email: 0 },
        failures: 0,
      }),
    },
    subscriptionEntitlement: {
      hasAccess: vi.fn().mockResolvedValue(overrides.hasAccess ?? true),
    },
  };
  const cron = new DefaulterAlertCron(
    deps.workspaceModel as never,
    deps.dispatchModel as never,
    deps.attendanceService as never,
    deps.defaulterAlertService as never,
    deps.subscriptionEntitlement as never,
  );
  return { cron, deps };
}

describe('DefaulterAlertCron', () => {
  it('skips a workspace that already has a dispatch row for the period', async () => {
    const { cron, deps } = makeCron({
      workspaces: [
        {
          _id: 'ws1',
          ownerId: 'o1',
          attendanceSettings: {
            complianceThresholdPct: 90,
            defaulterAlerts: { enabled: true, channels: {}, recipients: {} },
          },
        },
      ],
      existingDispatch: { _id: 'd1' },
    });
    await cron.run();
    expect(deps.attendanceService.getComplianceReport).not.toHaveBeenCalled();
    expect(deps.defaulterAlertService.dispatch).not.toHaveBeenCalled();
  });

  it('skips dispatch when the workspace has zero defaulters but still records the period', async () => {
    const { cron, deps } = makeCron({
      workspaces: [
        {
          _id: 'ws1',
          ownerId: 'o1',
          attendanceSettings: {
            complianceThresholdPct: 90,
            defaulterAlerts: { enabled: true, channels: {}, recipients: {} },
          },
        },
      ],
      report: {
        data: { members: [{ memberId: 'm1', name: 'A', designation: 'X', attendanceRate: 100 }] },
      },
    });
    await cron.run();
    expect(deps.defaulterAlertService.dispatch).not.toHaveBeenCalled();
    expect(deps.dispatchModel.create).toHaveBeenCalled();
  });

  it('dispatches for a workspace with a defaulter below threshold', async () => {
    const { cron, deps } = makeCron({
      workspaces: [
        {
          _id: 'ws1',
          ownerId: 'o1',
          attendanceSettings: {
            complianceThresholdPct: 90,
            defaulterAlerts: {
              enabled: true,
              channels: { inApp: true },
              recipients: { mode: 'managers', specificPeople: [] },
            },
          },
        },
      ],
      report: {
        data: {
          members: [
            { memberId: 'm1', name: 'A', designation: 'X', attendanceRate: 70 },
            { memberId: 'm2', name: 'B', designation: 'Y', attendanceRate: null },
          ],
        },
      },
    });
    await cron.run();
    expect(deps.defaulterAlertService.dispatch).toHaveBeenCalledTimes(1);
    const arg = deps.defaulterAlertService.dispatch.mock.calls[0][0];
    expect(arg.defaulters.map((d: any) => d.memberId)).toEqual(['m1']);
  });

  it('skips a workspace whose subscription no longer entitles defaulter_alerts', async () => {
    const { cron, deps } = makeCron({
      workspaces: [
        {
          _id: 'ws1',
          ownerId: 'o1',
          attendanceSettings: {
            complianceThresholdPct: 90,
            defaulterAlerts: { enabled: true, channels: {}, recipients: {} },
          },
        },
      ],
      hasAccess: false,
    });
    await cron.run();
    expect(deps.attendanceService.getComplianceReport).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/attendance/__tests__/defaulter-alert.cron.vitest.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the cron**

Create `src/modules/attendance/crons/defaulter-alert.cron.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CRON_SCHEDULES, CRON_TIMEZONES } from '../../../common/constants/cron.constants';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { DefaulterAlertDispatch } from '../schemas/defaulter-alert-dispatch.schema';
import { AttendanceService } from '../attendance.service';
import { DefaulterAlertService, DefaulterRow } from '../defaulter-alert.service';
import { SubscriptionEntitlementService } from '../../subscriptions/subscription-entitlement.service';

/**
 * Monthly attendance defaulter-alert cron. Runs on the 1st of each month and
 * evaluates the previous (now closed) calendar month. Only opted-in workspaces
 * are processed; the run is idempotent via the DefaulterAlertDispatch row.
 */
@Injectable()
export class DefaulterAlertCron {
  private readonly logger = new Logger(DefaulterAlertCron.name);

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(DefaulterAlertDispatch.name)
    private readonly dispatchModel: Model<DefaulterAlertDispatch>,
    private readonly attendanceService: AttendanceService,
    private readonly defaulterAlertService: DefaulterAlertService,
    private readonly subscriptionEntitlement: SubscriptionEntitlementService,
  ) {}

  @Cron(CRON_SCHEDULES.MONTHLY_1ST_AT_6AM, { timeZone: CRON_TIMEZONES.IST })
  async run(): Promise<void> {
    const now = new Date();
    // Previous calendar month.
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const month = prev.getMonth() + 1;
    const year = prev.getFullYear();
    const periodKey = `${year}-${String(month).padStart(2, '0')}`;

    const workspaces = await this.workspaceModel
      .find({ 'attendanceSettings.defaulterAlerts.enabled': true })
      .lean()
      .exec();

    let processed = 0;
    for (const ws of workspaces as any[]) {
      try {
        await this.processWorkspace(ws, month, year, periodKey);
        processed += 1;
      } catch (err) {
        this.logger.error(
          `DefaulterAlertCron: workspace ${ws._id} failed: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `DefaulterAlertCron: evaluated ${periodKey} for ${processed}/${workspaces.length} workspace(s).`,
    );
  }

  private async processWorkspace(
    ws: any,
    month: number,
    year: number,
    periodKey: string,
  ): Promise<void> {
    // Idempotency — skip if already dispatched for this period.
    const existing = await this.dispatchModel.findOne({ workspaceId: ws._id, periodKey }).exec();
    if (existing) return;

    // Re-check the subscription still entitles the feature.
    const hasAccess = await this.subscriptionEntitlement.hasAccess(
      String(ws._id),
      'attendance',
      'defaulter_alerts',
    );
    if (!hasAccess) {
      this.logger.warn(`DefaulterAlertCron: workspace ${ws._id} no longer entitled — skipping`);
      return;
    }

    const thresholdPct = ws.attendanceSettings?.complianceThresholdPct ?? 90;
    const report = await this.attendanceService.getComplianceReport(String(ws._id), month, year);
    const members = report?.data?.members ?? [];
    const defaulters: DefaulterRow[] = members
      .filter((m: any) => m.attendanceRate !== null && m.attendanceRate < thresholdPct)
      .map((m: any) => ({
        memberId: String(m.memberId),
        name: m.name,
        designation: m.designation,
        attendanceRate: m.attendanceRate,
      }));

    let recipientCount = 0;
    if (defaulters.length > 0) {
      const result = await this.defaulterAlertService.dispatch({
        workspace: { _id: ws._id, ownerId: ws.ownerId },
        month,
        year,
        thresholdPct,
        defaulters,
        config: ws.attendanceSettings.defaulterAlerts,
      });
      recipientCount = result.recipientCount;
    }

    // Record the period so a re-run is a no-op (even for 0 defaulters).
    await this.dispatchModel.create({
      workspaceId: ws._id,
      periodKey,
      dispatchedAt: new Date(),
      defaulterCount: defaulters.length,
      recipientCount,
    });
  }
}
```

> Engineer notes:
>
> - `SubscriptionEntitlementService` — there may already be a service that resolves a workspace's entitlement for a `(module, subFeature)`. Search: `grep -rn "appliedEntitlements" src/modules/subscriptions`. If a suitable method exists, inject that service and call it. If none exists, add a small `hasAccess(workspaceId, module, subFeature)` helper to the subscriptions service that loads the workspace owner's subscription and checks `appliedEntitlements.moduleAccess` (mirror the resolution logic in `subscription.guard.ts:178-217`, treating `LOCKED` as no access). Adjust the constructor injection accordingly.
> - `CRON_TIMEZONES.IST` — confirm the exact export name in `cron.constants.ts`; adjust if different.

- [ ] **Step 4: Register the cron in the attendance module**

In `attendance.module.ts`: add `DefaulterAlertCron` to `providers`. Ensure `ScheduleModule` is available (it is — other attendance crons like `AutoPresentCron` use it). Ensure the `SubscriptionEntitlementService` (or whichever entitlement service is used) is importable — import its module if needed.

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run: `npx vitest run src/modules/attendance/__tests__/defaulter-alert.cron.vitest.ts`
Expected: PASS (4 tests).
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit checkpoint**

Suggested message: `feat(attendance): add monthly defaulter-alert cron`

---

## Phase E — Web config UI

### Task 13: Web feature-registry mirror, `Workspace` type, API client

**Files:**

- Modify: `crewroster-web/lib/constants/feature-access.registry.ts`
- Modify: `crewroster-web/types/index.ts`
- Modify: `crewroster-web/lib/api/modules/workspaces.api.ts`

All commands in this task run from `crewroster-web/`.

- [ ] **Step 1: Mirror the feature key**

Open `crewroster-web/lib/constants/feature-access.registry.ts`. Find the `attendance` module's sub-feature list and add `'defaulter_alerts'` following the exact shape of the sibling keys (a string entry or `{ key, label }` object — match what's there).

- [ ] **Step 2: Extend the `Workspace` type**

In `crewroster-web/types/index.ts`, find the `Workspace` interface's `attendanceSettings` field. Add `defaulterAlerts`:

```ts
attendanceSettings?: {
  complianceThresholdPct?: number;
  defaulterAlerts?: {
    enabled: boolean;
    channels: { inApp: boolean; email: boolean };
    recipients: {
      mode: 'managers' | 'specificPeople' | 'both';
      specificPeople: string[];
    };
  };
};
```

If `DefaulterAlertsConfig` deserves its own exported interface, extract it — match how neighbouring config types are declared.

- [ ] **Step 3: Add the API client method**

In `crewroster-web/lib/api/modules/workspaces.api.ts`, find the endpoint map (`E`) and the existing `update` method. Add an endpoint and method:

```ts
// in the endpoint map E:
defaulterAlerts: (id: string) => `workspaces/${id}/defaulter-alerts`,

// in the api object:
updateDefaulterAlerts: (id: string, data: DefaulterAlertsConfig) =>
  http.patch(E.defaulterAlerts(id), data).then(unwrap<Workspace>),
```

Import `DefaulterAlertsConfig` (or the inline type) from `@/types`. Match the exact `http`/`unwrap` usage of the sibling `update` method.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit checkpoint**

Suggested message: `feat(web): wire defaulter-alerts type, feature key, and API client`

---

### Task 14: "Defaulter alerts" config card on the Compliance page

**Files:**

- Modify: `crewroster-web/app/dashboard/attendance/compliance/page.tsx`
- Modify: `crewroster-web/app/messages/en.json`
- Modify: `crewroster-web/app/messages/gu-en.json`
- Modify: `crewroster-web/app/messages/hi-en.json`
- Modify: `crewroster-web/app/messages/gu.json`

All commands run from `crewroster-web/`.

- [ ] **Step 1: Add i18n keys**

In each of the four message files, find the `attendance.compliance` block and add a `defaulterAlerts` sub-block. English (`en.json`):

```json
"defaulterAlerts": {
  "title": "Defaulter alerts",
  "subtitle": "Email a monthly summary of members who fell below the threshold.",
  "enable": "Send monthly defaulter alerts",
  "channels": "Channels",
  "channelInApp": "In-app notification",
  "channelEmail": "Email",
  "recipients": "Send to",
  "recipientManagers": "Each member's manager",
  "recipientSpecific": "Specific people",
  "recipientBoth": "Both",
  "pickPeople": "Select people",
  "saved": "Defaulter alert settings saved",
  "saveError": "Could not save. Please try again.",
  "readOnlyHint": "Only the workspace owner or admins can change this."
}
```

Translate the values for `gu-en.json` (Gujlish), `hi-en.json` (Hinglish), and `gu.json` (Gujarati script) — match the translation style already used in the surrounding `attendance.compliance` keys in each file. Keep the JSON keys identical across all four files.

- [ ] **Step 2: Build the config card**

In `compliance/page.tsx`, add a new card below the existing threshold card (the `<Card style={{ marginBottom: 24 }}>` block) and above the StatTile grid. Requirements:

- Wrap the card in the project's feature gate so locked plans see an upgrade prompt:
  `<FeatureGate module="attendance" subFeature="defaulter_alerts"> … </FeatureGate>`
  (confirm the import path and prop names from `crewroster-web/components/subscription/FeatureGate.tsx`).
- Card body: an enable `Switch`; two channel `Checkbox`es (In-app, Email); a `Radio.Group` for recipient mode (Managers / Specific people / Both); and, when mode is `specificPeople` or `both`, a member multi-`Select`.
- Editing requires owner or `workspaces.edit` — reuse the existing `canEditThreshold` value already computed on this page to disable the controls and show `defaulterAlerts.readOnlyHint` when false.
- Local state seeded from `currentWorkspace.attendanceSettings.defaulterAlerts` (fall back to `{ enabled: false, channels: { inApp: true, email: false }, recipients: { mode: 'managers', specificPeople: [] } }`).
- A "Save" `Button` calls `workspacesApi.updateDefaulterAlerts(wsId, config)`; on success call `setCurrentWorkspace(updated)` and `msgApi.success(t('defaulterAlerts.saved'))`; on failure `msgApi.error(t('defaulterAlerts.saveError'))`. Mirror the save/persist pattern already used by the threshold slider's `persistThreshold` on this same page.
- The member multi-select options come from the workspace members already available to this page (reuse whatever member list the page/threshold logic uses; if none is loaded, fetch via the existing members API the page already imports).
- Apply spacing per the antd-v6 caveat already documented on this page — put margins on a plain `<div>` wrapper or inline `style`, not a Tailwind class on the antd `<Card>`.

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit -p tsconfig.json` — expected no output.
Run: `npx eslint app/dashboard/attendance/compliance/page.tsx` — expected no new errors.

- [ ] **Step 4: Manual verification**

Start the web app. Open `/dashboard/attendance/compliance`:

- The "Defaulter alerts" card renders below the threshold card.
- Toggling enable, channels, and recipient mode works; the member multi-select appears only for Specific people / Both.
- Save shows the success toast; reload — the settings persist.
- As a non-owner without `workspaces.edit`, controls are read-only with the hint shown.
- On a plan where `attendance.defaulter_alerts` is locked, the card shows the upgrade prompt instead.

- [ ] **Step 5: Commit checkpoint**

Suggested message: `feat(web): add defaulter-alerts config card to the Compliance page`

---

## Final verification

- [ ] Backend: `npx tsc --noEmit -p tsconfig.json` clean from `crewroster-backend/`.
- [ ] Backend: `npx vitest run src/modules/attendance/__tests__/defaulter-alert.service.vitest.ts src/modules/attendance/__tests__/defaulter-alert.cron.vitest.ts src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts src/modules/workspaces/__tests__/defaulter-alerts-config.dto.vitest.ts src/modules/workspaces/__tests__/update-defaulter-alerts.service.vitest.ts src/common/constants/__tests__/defaulter-alerts-registry.vitest.ts` — all pass.
- [ ] Web: `npx tsc --noEmit -p tsconfig.json` clean from `crewroster-web/`.
- [ ] Boot the backend once; confirm the log line `Attendance migration: seeded defaulter_alerts into N plan(s), M subscription(s).` appears (first boot) and does NOT re-patch on a second boot (idempotent — counts 0, no log line).
- [ ] End-to-end smoke: enable defaulter alerts on a workspace with a known sub-threshold member for the previous month; manually invoke `DefaulterAlertCron.run()` (or wait for the schedule); confirm the recipient receives an in-app notification and, if email is enabled, an email; confirm a `DefaulterAlertDispatch` row exists; confirm a second `run()` is a no-op.

## Spec coverage map

| Spec section                                   | Task(s)                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| §4 Feature gate — registry + tier seed         | Task 1                                                                                |
| §4 Feature gate — boot-time backfill migration | Task 2                                                                                |
| §4 Feature gate — endpoint guard               | Task 5                                                                                |
| §4 Feature gate — cron entitlement re-check    | Task 12                                                                               |
| §4 Feature gate — web `<FeatureGate>`          | Task 13, 14                                                                           |
| §5 Config schema                               | Task 3                                                                                |
| §6 API — DTO + endpoint + service              | Task 4, 5                                                                             |
| §7 Monthly cron + idempotency schema           | Task 6, 11, 12                                                                        |
| §8 DefaulterAlertService dispatch              | Task 10                                                                               |
| §9 Email template                              | Task 8                                                                                |
| §10 In-app notification category               | Task 7                                                                                |
| §11 Config UI                                  | Task 14                                                                               |
| §12 Audit actions                              | Task 5, 9, 10                                                                         |
| §13 Edge cases                                 | Task 10 (recipients/quota/0-recipient), Task 12 (0-defaulter/idempotency/entitlement) |
| §14 Testing                                    | Tasks 1, 2, 4, 5, 10, 12                                                              |
| §15 Files                                      | all tasks                                                                             |
