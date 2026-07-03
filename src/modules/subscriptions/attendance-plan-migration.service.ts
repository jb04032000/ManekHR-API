import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from './schemas/plan.schema';
import { Subscription } from './schemas/subscription.schema';
import { AppModule } from '../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../common/enums/feature-access.enum';
import { TIER_SUBFEATURE_DEFAULTS } from '../../common/constants/module-features.registry';

/**
 * Boot-time migration that ensures the attendance sub-feature keys are present
 * and de-duplicated in every Plan and Subscription's ATTENDANCE module entry,
 * so `@RequireSubscription({ ATTENDANCE, ... })` gates do not 403 existing
 * tenants.
 *
 * Why a backfill is needed: the ATTENDANCE module entry already carries a
 * NON-EMPTY `subFeatures` array in every existing tenant. SubscriptionGuard
 * resolves a sub-feature key absent from a non-empty array to LOCKED → 403.
 *
 * `onModuleInit` runs TWO independent passes (each in its own try/catch —
 * a failure in one never blocks the other or crashes boot):
 *
 *  Pass A — dedupe (runs first):
 *    Scans every Plan `entitlements.moduleAccess` and every Subscription
 *    `appliedEntitlements.moduleAccess` + `adminEntitlementOverride.moduleAccess`
 *    for duplicate `key` values inside the ATTENDANCE `subFeatures` array.
 *    When duplicates are found, collapses the array to unique-by-key entries
 *    keeping the FIRST occurrence (the plan's own / admin-set value) and
 *    discarding later duplicates (which are migration artefacts). Only writes
 *    when a document actually has duplicates — idempotent, no needless writes.
 *
 *  Pass B — unified per-key-presence backfill:
 *    Backfills ALL SIX keys into every plan/subscription that is missing them:
 *      • `defaulter_alerts`    — always FULL (grandfathered for all tenants)
 *      • `attendance_muster`   — tier-resolved via TIER_SUBFEATURE_DEFAULTS
 *      • `overtime_analytics`  — tier-resolved
 *      • `compliance_report`   — tier-resolved
 *      • `absence_patterns`    — tier-resolved
 *      • `anomaly_detection`   — tier-resolved (LOCKED on free/starter, FULL on pro+)
 *    Per-key presence check (not $addToSet) makes this idempotent and prevents
 *    any duplicate — if a key already exists (any access), it is left untouched.
 *
 * Both passes run on every boot and are safe to re-run.
 */
@Injectable()
export class AttendancePlanMigrationService {
  private readonly logger = new Logger(AttendancePlanMigrationService.name);

  /** The 5 gating keys backfilled tier-aware. */
  private static readonly GATING_KEYS = [
    'attendance_muster',
    'overtime_analytics',
    'compliance_report',
    'absence_patterns',
    'anomaly_detection',
  ] as const;

  /** All 6 keys managed by this migration (defaulter_alerts is always FULL). */
  private static readonly ALL_KEYS = [
    'defaulter_alerts',
    ...AttendancePlanMigrationService.GATING_KEYS,
  ] as const;

  private static readonly VALID_TIERS = [
    'free',
    'starter',
    'pro',
    'growth',
    'business',
    'enterprise',
    'custom',
  ];

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
  ) {}

  // Run by the ledgered migration runner (ADR-0001 Slice 5) — was an onModuleInit
  // hook that ran on EVERY boot. Body unchanged, incl. the per-pass try/catch
  // (Pass A failing must not block Pass B). Do NOT re-add a boot hook on merge.
  async run(): Promise<void> {
    // Pass A — dedupe: clean any duplicate subFeature keys that prior
    // $addToSet-based migrations may have introduced.
    try {
      await this.dedupeAttendanceSubFeatures();
    } catch (err) {
      this.logger.warn(
        `AttendancePlanMigrationService dedupe pass failed: ${(err as Error).message}`,
      );
    }

    // Pass B — unified backfill: ensure all 6 keys exist in every document.
    try {
      await this.backfillAllSubFeatures();
    } catch (err) {
      this.logger.warn(
        `AttendancePlanMigrationService backfill pass failed: ${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Pass A — Dedupe
  // ---------------------------------------------------------------------------

  /**
   * For each Plan and Subscription, inspect the attendance subFeatures arrays
   * in all three entitlement locations. If any key appears more than once,
   * collapse to the first occurrence and write back via $set + arrayFilters.
   */
  private async dedupeAttendanceSubFeatures(): Promise<void> {
    let plansFixed = 0;
    let subsFixed = 0;

    // --- Plans ---
    const plans = await this.planModel
      .find({ 'entitlements.moduleAccess.module': AppModule.ATTENDANCE })
      .exec();
    for (const plan of plans) {
      const moduleAccess = (plan as any).entitlements?.moduleAccess as
        | Array<{ module: string; subFeatures?: Array<{ key: string }> }>
        | undefined;
      const deduped = this.dedupeSubFeatures(moduleAccess);
      if (deduped !== null) {
        await this.planModel.updateOne(
          { _id: plan._id },
          { $set: { 'entitlements.moduleAccess.$[elem].subFeatures': deduped } },
          { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
        );
        plansFixed += 1;
      }
    }

    // --- Subscriptions ---
    const subs = await this.subscriptionModel
      .find({
        $or: [
          { 'appliedEntitlements.moduleAccess.module': AppModule.ATTENDANCE },
          { 'adminEntitlementOverride.moduleAccess.module': AppModule.ATTENDANCE },
        ],
      })
      .exec();
    for (const sub of subs) {
      let patched = false;

      const appliedMA = (sub as any).appliedEntitlements?.moduleAccess as
        | Array<{ module: string; subFeatures?: Array<{ key: string }> }>
        | undefined;
      const dedupedApplied = this.dedupeSubFeatures(appliedMA);
      if (dedupedApplied !== null) {
        await this.subscriptionModel.updateOne(
          { _id: sub._id },
          {
            $set: {
              'appliedEntitlements.moduleAccess.$[elem].subFeatures': dedupedApplied,
            },
          },
          { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
        );
        patched = true;
      }

      if ((sub as any).adminEntitlementOverride) {
        const overrideMA = (sub as any).adminEntitlementOverride?.moduleAccess as
          | Array<{ module: string; subFeatures?: Array<{ key: string }> }>
          | undefined;
        const dedupedOverride = this.dedupeSubFeatures(overrideMA);
        if (dedupedOverride !== null) {
          await this.subscriptionModel.updateOne(
            { _id: sub._id },
            {
              $set: {
                'adminEntitlementOverride.moduleAccess.$[elem].subFeatures': dedupedOverride,
              },
            },
            { arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }] },
          );
          patched = true;
        }
      }

      if (patched) subsFixed += 1;
    }

    if (plansFixed > 0 || subsFixed > 0) {
      this.logger.log(
        `Attendance dedupe pass: fixed ${plansFixed} plan(s), ${subsFixed} subscription(s).`,
      );
    }
  }

  /**
   * Given the moduleAccess array for a document, find the ATTENDANCE entry and
   * check for duplicate keys in its subFeatures. Returns the de-duped array
   * (keeping first occurrence of each key) if duplicates were found, or null
   * if there were no duplicates (so the caller can skip the write).
   */
  private dedupeSubFeatures(
    moduleAccess: Array<{ module: string; subFeatures?: Array<{ key: string }> }> | undefined,
  ): Array<{ key: string }> | null {
    const att = (moduleAccess ?? []).find((m) => m.module === (AppModule.ATTENDANCE as string));
    if (!att?.subFeatures || att.subFeatures.length === 0) return null;

    const seen = new Set<string>();
    const deduped: Array<{ key: string }> = [];
    let hadDuplicate = false;

    for (const sf of att.subFeatures) {
      if (seen.has(sf.key)) {
        hadDuplicate = true;
      } else {
        seen.add(sf.key);
        deduped.push(sf);
      }
    }

    return hadDuplicate ? deduped : null;
  }

  // ---------------------------------------------------------------------------
  // Pass B — Unified per-key-presence backfill
  // ---------------------------------------------------------------------------

  /** Resolve the tier-default access for a key; unknown tier → free. */
  private resolveTierAccess(tier: string | undefined, key: string): FeatureAccessLevel {
    const t = AttendancePlanMigrationService.VALID_TIERS.includes(tier ?? '') ? tier : 'free';
    const access = TIER_SUBFEATURE_DEFAULTS[t]?.[AppModule.ATTENDANCE]?.[key];
    return access ?? FeatureAccessLevel.LOCKED;
  }

  /**
   * Compute the { key, access } entries missing from an attendance
   * moduleAccess entry, using the document's tier.
   * `defaulter_alerts` is always resolved to FULL regardless of tier.
   */
  private missingEntries(
    moduleAccess: Array<{ module: string; subFeatures?: Array<{ key: string }> }> | undefined,
    tier: string | undefined,
  ): Array<{ key: string; access: FeatureAccessLevel }> {
    const att = (moduleAccess ?? []).find((m) => m.module === (AppModule.ATTENDANCE as string));
    if (!att) return [];
    const have = new Set((att.subFeatures ?? []).map((s) => s.key));
    return (AttendancePlanMigrationService.ALL_KEYS as readonly string[])
      .filter((k) => !have.has(k))
      .map((k) => ({
        key: k,
        access:
          k === 'defaulter_alerts' ? FeatureAccessLevel.FULL : this.resolveTierAccess(tier, k),
      }));
  }

  /** Second migration pass — backfill all 6 keys with per-key presence check. */
  private async backfillAllSubFeatures(): Promise<void> {
    let plansPatched = 0;
    let subsPatched = 0;

    const plans = await this.planModel
      .find({ 'entitlements.moduleAccess.module': AppModule.ATTENDANCE })
      .exec();
    for (const plan of plans) {
      const toAdd = this.missingEntries(
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
      const tier = (sub as any).planId?.tier as string | undefined;
      let patched = false;

      const appliedToAdd = this.missingEntries(
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
        ? this.missingEntries((sub as any).adminEntitlementOverride?.moduleAccess, tier)
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
        `Attendance backfill pass: patched ${plansPatched} plan(s), ${subsPatched} subscription(s).`,
      );
    }
  }
}
