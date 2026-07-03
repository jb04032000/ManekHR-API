import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/node';
import { Plan, PlanEntitlements } from './schemas/plan.schema';
import { Subscription } from './schemas/subscription.schema';
import { AppSettings } from './schemas/app-settings.schema';
import { Tier } from './schemas/tier.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { WorkspaceMember } from '../workspaces/schemas/workspace-member.schema';
import { User } from '../users/schemas/user.schema';
import { MarketingService } from './billing/services/marketing.service';
import { UpdateSubscriptionDto } from './dto/subscription.dto';
import { PlanTier, getTierLevel } from '../../common/enums/plan-tier.enum';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import {
  buildModuleAccess,
  getModuleDefinition,
} from '../../common/constants/module-features.registry';
import { AddOnsService } from '../add-ons/add-ons.service';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { dayBucket } from '../../common/scheduler/period-key';

@Injectable()
export class SubscriptionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SubscriptionsService.name);
  private tierOrderCache: Map<string, number> = new Map();

  /**
   * Wave 6 cleanup. Pre-Wave-1 this method compressed the 6-tier ladder
   * to the legacy 4 tiers (free/starter/pro/enterprise) — the result was
   * silently downgrading growth → starter and business → pro at every
   * defaults lookup, which is exactly the drift the audit flagged.
   *
   * Now passes the tier through unchanged to `buildModuleAccess`, which
   * already understands the full ladder (free/starter/pro/growth/business/
   * enterprise/custom) and falls back to 'free' for unknown values.
   */
  private resolveTierKey(tier?: string): string {
    return (tier || 'free').toLowerCase();
  }

  constructor(
    @InjectModel(Plan.name) private planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
    @InjectModel(AppSettings.name) private appSettingsModel: Model<AppSettings>,
    @InjectModel(Tier.name) private tierModel: Model<Tier>,
    @InjectModel(Workspace.name) private workspaceModel: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private workspaceMemberModel: Model<WorkspaceMember>,
    @Inject(forwardRef(() => AddOnsService))
    private addOnsService: AddOnsService,
    private readonly singleFlight: SingleFlightService,
    // Appended (Phase-2 ERP pricing): the post-expiry "you're now on Free"
    // notice fired from downgradeToBasePlan needs the user's email + a way to
    // dispatch a deduped marketing email. MarketingService is in the @Global()
    // BillingModule (already forwardRef'd in both directions) so injecting it
    // here does not introduce a new cycle.
    @InjectModel(User.name) private userModel: Model<User>,
    @Inject(forwardRef(() => MarketingService))
    private readonly marketing: MarketingService,
  ) {}

  async onApplicationBootstrap() {
    try {
      const existingSettings = await this.appSettingsModel.findOne().exec();
      if (!existingSettings) {
        await this.appSettingsModel.create({ freeTierEnabled: true });
        this.logger.log('AppSettings created with freeTierEnabled=true');
      }

      const freePlan = await this.planModel.findOne({ tier: PlanTier.FREE, isActive: true }).exec();

      if (!freePlan) {
        await this.planModel.create({
          name: 'Free Forever',
          tier: PlanTier.FREE,
          monthlyPrice: 0,
          yearlyPrice: 0,
          isActive: true,
          entitlements: {
            maxWorkspaces: 1,
            maxMembersPerWorkspace: 5,
            maxTotalMembers: 5,
            modules: [AppModuleEnum.TEAM, AppModuleEnum.ATTENDANCE, AppModuleEnum.SALARY],
            features: {
              export: false,
              apiAccess: false,
              advancedRbac: false,
              customRoles: false,
              shifts: false,
              bills: false,
            },
            moduleAccess: buildModuleAccess('free'),
          },
        });
        this.logger.warn(
          'No active free plan found on startup — created a default "Free Forever" plan. ' +
            'Run "npm run seed" to populate full plan details.',
        );
      } else if (!freePlan.entitlements?.moduleAccess?.length) {
        // Fix existing free plan that was created with empty moduleAccess
        await this.planModel.updateOne(
          { _id: freePlan._id },
          { $set: { 'entitlements.moduleAccess': buildModuleAccess('free') } },
        );
        this.logger.warn('Fixed free plan with empty moduleAccess');
      }

      await this.repairEmptyModuleAccess();
      await this.repairMissingSubFeatures();
      await this.seedDefaultTiers();
      await this.refreshTierCache();
    } catch (err) {
      this.logger.error('Bootstrap seeding failed:', err);
    }
  }

  /**
   * Wave 6 cleanup. Legacy bootstrap-time tier seeder. Inserted the
   * pre-Wave-1 4-tier ladder (free/starter/pro/enterprise/custom) which
   * is now wrong on every dimension (missing growth + business, includes
   * the deprecated `pro` key). Tier seeding is owned by
   * `SeedDefaultTiersAndPlansService` (ledgered migration `0028_erp_seed_tiers_and_plans`,
   * ADR-0001) which uses the canonical 6-tier ladder.
   *
   * Kept as a no-op to avoid breaking the call site in `onApplicationBootstrap`.
   * Safe to delete the call entirely once we're sure no other path relies on it.
   */
  private seedDefaultTiers(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Repairs all plans and active/trial subscriptions that have an empty moduleAccess array.
   * Maps each plan's tier to the correct defaults from buildModuleAccess().
   * Called automatically on bootstrap and exposed via admin maintenance endpoint.
   */
  async repairEmptyModuleAccess(): Promise<{
    plansFixed: number;
    subscriptionsFixed: number;
  }> {
    // Wave 6 cleanup: pass tier through unchanged. `buildModuleAccess`
    // owns the canonical 6-tier ladder (free/starter/pro/growth/business/
    // enterprise/custom) and falls back to 'free' for unknown values.
    // Pre-Wave-6 this map silently downgraded growth → starter and
    // business → pro at every repair pass.
    const tierToKey: Record<string, string> = {
      free: 'free',
      starter: 'starter',
      pro: 'pro',
      growth: 'growth',
      business: 'business',
      enterprise: 'enterprise',
      custom: 'custom',
    };

    // Fix plans with empty moduleAccess
    // Skip Connect plans: they are not governed by the ERP module registry.
    const plans = await this.planModel
      .find({ 'entitlements.moduleAccess': { $size: 0 }, product: { $ne: 'connect' } })
      .lean();
    let plansFixed = 0;
    for (const plan of plans) {
      const tierKey = tierToKey[plan.tier?.toLowerCase()] || 'free';
      await this.planModel.updateOne(
        { _id: plan._id },
        { $set: { 'entitlements.moduleAccess': buildModuleAccess(tierKey) } },
      );
      plansFixed++;
      this.logger.log(
        `Repaired plan ${String(plan._id)} (${plan.name}, tier=${plan.tier}) moduleAccess`,
      );
    }

    // Fix active/trial subscriptions whose appliedEntitlements have empty moduleAccess
    const brokenSubs = await this.subscriptionModel
      .find({
        status: { $in: ['active', 'trial'] },
        'appliedEntitlements.moduleAccess': { $size: 0 },
        product: { $ne: 'connect' },
      })
      .populate<{ planId: Plan }>('planId')
      .lean();

    let subscriptionsFixed = 0;
    for (const sub of brokenSubs) {
      const plan = sub.planId;
      const tierKey = tierToKey[plan?.tier?.toLowerCase()] || 'free';
      const repairedAccess = buildModuleAccess(tierKey);
      await this.subscriptionModel.updateOne(
        { _id: sub._id },
        {
          $set: {
            'appliedEntitlements.moduleAccess': repairedAccess,
            'purchasedEntitlements.moduleAccess': repairedAccess,
          },
        },
      );
      subscriptionsFixed++;
      this.logger.log(
        `Repaired subscription ${String(sub._id)} (userId=${String(sub.userId)}) moduleAccess`,
      );
    }

    if (plansFixed > 0 || subscriptionsFixed > 0) {
      this.logger.warn(
        `repairEmptyModuleAccess: fixed ${plansFixed} plan(s) and ${subscriptionsFixed} subscription(s)`,
      );
    }

    return { plansFixed, subscriptionsFixed };
  }

  /**
   * Repairs plans and active subscriptions whose moduleAccess is non-empty but missing
   * sub-feature keys that exist in the current registry (e.g. keys added after initial seeding).
   * Missing keys are filled in using the tier-appropriate defaults from buildModuleAccess().
   * Existing sub-feature access levels are preserved — only new keys are added.
   */
  async repairMissingSubFeatures(): Promise<{
    plansFixed: number;
    subscriptionsFixed: number;
  }> {
    // Pass the tier through UNCHANGED. `buildModuleAccess` owns the full
    // ladder (free/starter/pro/growth/business/enterprise/custom) and falls
    // back to 'free' for unknown values. The old map here downgraded
    // growth -> 'starter' and business -> 'pro', which silently stripped paid
    // sub-features from Growth/Business subscriptions on every boot repair.
    // Keep in sync with repairEmptyModuleAccess's tierToKey above.
    const tierToKey: Record<string, string> = {
      free: 'free',
      starter: 'starter',
      pro: 'pro',
      growth: 'growth',
      business: 'business',
      enterprise: 'enterprise',
      custom: 'custom',
    };

    let plansFixed = 0;
    let subscriptionsFixed = 0;

    // Fix plans with non-empty moduleAccess that are missing sub-feature keys
    const plans = await this.planModel
      .find({ 'entitlements.moduleAccess.0': { $exists: true }, product: { $ne: 'connect' } })
      .lean();
    for (const plan of plans) {
      const tierKey = tierToKey[plan.tier?.toLowerCase()] || 'free';
      const expectedAccess = buildModuleAccess(tierKey);
      const currentAccess: any[] = (plan.entitlements as any)?.moduleAccess || [];

      let changed = false;
      const updatedAccess = currentAccess.map((moduleEntry: any) => {
        const expectedModule = expectedAccess.find((e) => e.module === moduleEntry.module);
        if (!expectedModule) return moduleEntry;

        const existingKeys = new Set((moduleEntry.subFeatures || []).map((sf: any) => sf.key));
        const missingSubFeatures = expectedModule.subFeatures.filter(
          (sf) => !existingKeys.has(sf.key),
        );

        if (missingSubFeatures.length > 0) {
          changed = true;
          return {
            ...moduleEntry,
            subFeatures: [...(moduleEntry.subFeatures || []), ...missingSubFeatures],
          };
        }
        return moduleEntry;
      });

      if (changed) {
        await this.planModel.updateOne(
          { _id: plan._id },
          { $set: { 'entitlements.moduleAccess': updatedAccess } },
        );
        plansFixed++;
        this.logger.log(
          `repairMissingSubFeatures: patched plan ${String(plan._id)} (${plan.name})`,
        );
      }
    }

    // Fix active/trial/cancelled subscriptions with non-empty moduleAccess missing sub-feature keys
    const subs = await this.subscriptionModel
      .find({
        status: { $in: ['active', 'trial', 'cancelled'] },
        'appliedEntitlements.moduleAccess.0': { $exists: true },
        product: { $ne: 'connect' },
      })
      .populate<{ planId: Plan }>('planId')
      .lean();

    for (const sub of subs) {
      const plan = sub.planId;
      const tierKey = tierToKey[plan?.tier?.toLowerCase()] || 'free';
      const expectedAccess = buildModuleAccess(tierKey);
      const currentAccess: any[] = (sub.appliedEntitlements as any)?.moduleAccess || [];

      let changed = false;
      const updatedAccess = currentAccess.map((moduleEntry: any) => {
        const expectedModule = expectedAccess.find((e) => e.module === moduleEntry.module);
        if (!expectedModule) return moduleEntry;

        const existingKeys = new Set((moduleEntry.subFeatures || []).map((sf: any) => sf.key));
        const missingSubFeatures = expectedModule.subFeatures.filter(
          (sf) => !existingKeys.has(sf.key),
        );

        if (missingSubFeatures.length > 0) {
          changed = true;
          return {
            ...moduleEntry,
            subFeatures: [...(moduleEntry.subFeatures || []), ...missingSubFeatures],
          };
        }
        return moduleEntry;
      });

      if (changed) {
        await this.subscriptionModel.updateOne(
          { _id: sub._id },
          {
            $set: {
              'appliedEntitlements.moduleAccess': updatedAccess,
              'purchasedEntitlements.moduleAccess': updatedAccess,
            },
          },
        );
        subscriptionsFixed++;
        this.logger.log(
          `repairMissingSubFeatures: patched subscription ${String(sub._id)} (userId=${String(sub.userId)})`,
        );
      }
    }

    if (plansFixed > 0 || subscriptionsFixed > 0) {
      this.logger.warn(
        `repairMissingSubFeatures: patched ${plansFixed} plan(s) and ${subscriptionsFixed} subscription(s)`,
      );
    }

    return { plansFixed, subscriptionsFixed };
  }

  async refreshTierCache() {
    const tiers = await this.tierModel.find({ isActive: true }).sort({ displayOrder: 1 }).lean();
    this.tierOrderCache.clear();
    tiers.forEach((tier) => {
      this.tierOrderCache.set(tier.key, tier.displayOrder);
    });
    this.logger.log('Tier cache refreshed');
  }

  getTierLevel(tierKey: string): number {
    if (this.tierOrderCache.size > 0) {
      return this.tierOrderCache.get(tierKey) ?? 0;
    }
    return getTierLevel(tierKey as PlanTier);
  }

  async getPublicTiers() {
    const tiers = await this.tierModel.find({ isActive: true }).sort({ displayOrder: 1 }).lean();
    return tiers;
  }

  async getPlans() {
    return this.planModel.find({ isActive: true }).exec();
  }

  normalizeEntitlementsForTier(
    entitlements: PlanEntitlements | null | undefined,
    tier?: string,
    product?: string,
  ): { entitlements: PlanEntitlements; changed: boolean } {
    const base = (entitlements || {}) as PlanEntitlements;
    // Connect subscriptions are NOT normalized against the ERP tier/module
    // registry (buildModuleAccess), which only knows ERP modules and would
    // strip the CONNECT module access on every read. Connect entitlements are
    // owned by the Connect plan/seed and returned unchanged.
    if (product === 'connect') {
      return { entitlements: base, changed: false };
    }
    const tierKey = this.resolveTierKey(tier);
    const expectedAccess = buildModuleAccess(tierKey);
    const currentAccess = Array.isArray(base.moduleAccess) ? base.moduleAccess : [];
    let changed = currentAccess.length === 0;

    // Modules the admin enabled that live in the ERP feature registry but are
    // intentionally omitted from buildModuleAccess's tier template (MACHINES /
    // LOCATIONS / RESOURCE_SCOPES — added by dedicated boot migration services,
    // see module-features.registry.ts). Mirror the module-level of the existing
    // extraSubFeatures logic: preserve these AS-IS instead of stripping them.
    // Gate on getModuleDefinition so genuinely-foreign modules (e.g. `connect`
    // on an ERP sub) are still dropped — the ERP path must not leak Connect.
    const extraModules =
      currentAccess.length === 0
        ? []
        : currentAccess.filter(
            (entry) =>
              !expectedAccess.some((expectedModule) => expectedModule.module === entry.module) &&
              !!getModuleDefinition(entry.module),
          );

    const mergedModuleAccess =
      currentAccess.length === 0
        ? expectedAccess
        : expectedAccess.map((expectedModule) => {
            const currentModule = currentAccess.find(
              (entry) => entry.module === expectedModule.module,
            );

            if (!currentModule) {
              changed = true;
              return expectedModule;
            }

            const currentSubFeatures = Array.isArray(currentModule.subFeatures)
              ? currentModule.subFeatures
              : [];

            const mergedSubFeatures = expectedModule.subFeatures.map((expectedSubFeature) => {
              const currentSubFeature = currentSubFeatures.find(
                (entry) => entry.key === expectedSubFeature.key,
              );

              if (!currentSubFeature) {
                changed = true;
                return expectedSubFeature;
              }

              return currentSubFeature;
            });

            const extraSubFeatures = currentSubFeatures.filter(
              (entry) =>
                !expectedModule.subFeatures.some(
                  (expectedSubFeature) => expectedSubFeature.key === entry.key,
                ),
            );

            return {
              ...currentModule,
              enabled:
                typeof currentModule.enabled === 'boolean'
                  ? currentModule.enabled
                  : expectedModule.enabled,
              subFeatures: [...mergedSubFeatures, ...extraSubFeatures],
            };
          });

    // Template modules first (deterministic order), then the preserved
    // admin-enabled extras (machines / locations / resource_scopes) AS-IS.
    const mergedWithExtras =
      extraModules.length > 0 ? [...mergedModuleAccess, ...extraModules] : mergedModuleAccess;

    const normalizedModules = mergedWithExtras
      .filter((entry) => entry.enabled)
      .map((entry) => entry.module);

    const previousModules = Array.isArray(base.modules) ? base.modules : [];
    if (
      previousModules.length !== normalizedModules.length ||
      previousModules.some((module, index) => module !== normalizedModules[index])
    ) {
      changed = true;
    }

    return {
      entitlements: {
        ...base,
        modules: normalizedModules,
        moduleAccess: mergedWithExtras,
      },
      changed,
    };
  }

  async getMySubscription(userId: string, workspaceId?: string) {
    const userObjectId = new Types.ObjectId(userId);

    const now = new Date();

    // Wave A Permission-Gated UI (2026-05-15) — subscription resolves
    // via the active workspace's owner when the caller is a non-owner
    // member of that workspace. Multi-tenant model: the workspace is the
    // billing entity; invited members inherit the workspace plan, they
    // don't carry their own subscription unless they're also a workspace
    // owner elsewhere. Without this, invitees on an owner's workspace
    // see `entitlements: null` and every module renders ProLockBadge.
    //
    // Resolution chain:
    //   1. caller is the workspace owner   → query by userId (unchanged)
    //   2. caller is a member of workspace → query by workspace.ownerId
    //   3. no workspaceId passed           → legacy: query by userId
    let effectiveUserId = userObjectId;
    if (workspaceId && Types.ObjectId.isValid(workspaceId)) {
      const workspace = await this.workspaceModel
        .findById(new Types.ObjectId(workspaceId), { ownerId: 1 })
        .lean()
        .exec();
      if (workspace?.ownerId) {
        const ownerObjectId = new Types.ObjectId(String(workspace.ownerId));
        if (!ownerObjectId.equals(userObjectId)) {
          // Cross-tenant guard: a non-owner may only resolve a workspace's
          // subscription if they are an active member of it. Without this
          // any authenticated user could enumerate workspace IDs and read
          // each workspace's plan tier / billing posture (audit gap G2).
          const membership = await this.workspaceMemberModel
            .findOne({
              workspaceId: new Types.ObjectId(workspaceId),
              userId: userObjectId,
              status: 'active',
            })
            .select('_id')
            .lean()
            .exec();
          if (!membership) {
            throw new ForbiddenException('You are not a member of this workspace');
          }
          effectiveUserId = ownerObjectId;
        }
      }
    }

    // First, try to find active/trial subscription that hasn't expired yet
    let subscription: any = await this.subscriptionModel
      .findOne({
        userId: effectiveUserId,
        // ERP resolver: only ERP (or a future ERP+Connect bundle) subscriptions —
        // never a standalone Connect sub, which has its own person-centric path
        // (ConnectAllowanceService). Without this, a Connect-only user's Connect
        // sub leaked into ERP entitlement resolution.
        product: { $in: ['erp', 'bundle'] },
        status: { $in: ['active', 'trial'] },
        currentPeriodEnd: { $gt: now },
      })
      .sort({ createdAt: -1 })
      .populate('planId')
      .exec();

    // If no active/trial, check for cancelled subscription that's still within period (graceful cancel)
    if (!subscription) {
      subscription = await this.subscriptionModel
        .findOne({
          userId: effectiveUserId,
          product: { $in: ['erp', 'bundle'] }, // ERP resolver scope (see above)
          status: 'cancelled',
          currentPeriodEnd: { $gt: now }, // Only if period hasn't ended yet
        })
        .sort({ createdAt: -1 })
        .populate('planId')
        .exec();
    }

    // Self-heal a missed/orphaned signup auto-assign. createFreeSubscription is
    // called at signup, but the linkage can fail (orphaned sub / userId
    // divergence in the signup flow), leaving the logged-in user with NO active
    // /trial ERP sub on first dashboard load (`hasSub=false`, SubscriptionGuard
    // "No subscription found"). When neither the active/trial lookup nor the
    // cancelled-grace fallback found a usable sub, re-run createFreeSubscription
    // (which is idempotent — returns the existing active/trial ERP sub if any,
    // else creates the default; guarded by the {userId,product} partial-unique
    // index, and itself returns null when freeTierEnabled is off) so a no-plan
    // user lands on the default plan. This is a single re-query (NOT a loop, NO
    // recursion) and only fires when nothing else resolved, so it never
    // double-heals or disturbs the found-sub / cancelled-grace paths. It must
    // never make getMySubscription throw — any error is swallowed and we fall
    // through to the existing no-sub result.
    if (!subscription) {
      try {
        const healed = await this.createFreeSubscription(String(effectiveUserId), 'self');
        if (healed) {
          // Re-query (not the create's return shape) so the populated planId and
          // the exact same filter/shape match the normal active/trial path.
          subscription = await this.subscriptionModel
            .findOne({
              userId: effectiveUserId,
              product: { $in: ['erp', 'bundle'] },
              status: { $in: ['active', 'trial'] },
              currentPeriodEnd: { $gt: now },
            })
            .sort({ createdAt: -1 })
            .populate('planId')
            .exec();
        }
      } catch (err) {
        this.logger.warn(
          `getMySubscription self-heal failed for userId=${String(effectiveUserId)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Scheduled subscription belongs to the actual purchaser. For an
    // invitee viewing an owner's workspace we surface the owner's
    // scheduled change too, so the inherited entitlements story is
    // consistent across active + scheduled rows.
    const scheduled = await this.subscriptionModel
      .findOne({
        userId: effectiveUserId,
        product: { $in: ['erp', 'bundle'] },
        status: 'scheduled',
      })
      .populate('planId')
      .lean();

    const usage = {
      currentWorkspaceCount: 0,
      currentTotalMembers: 0,
    };

    if (subscription) {
      const normalized = this.normalizeEntitlementsForTier(
        subscription.appliedEntitlements as PlanEntitlements,
        subscription.planId?.tier,
        subscription.product,
      );

      if (normalized.changed) {
        await this.subscriptionModel.updateOne(
          { _id: subscription._id },
          {
            $set: {
              appliedEntitlements: normalized.entitlements,
              purchasedEntitlements: normalized.entitlements,
            },
          },
        );
        subscription.appliedEntitlements = normalized.entitlements as any;
        this.logger.warn(
          `getMySubscription normalized entitlements for subscription=${subscription._id}`,
        );
      }
    }

    const result = {
      subscription: subscription ? subscription.toObject() : null,
      scheduled: scheduled,
      plan: subscription && subscription.planId ? subscription.planId : null,
      entitlements: subscription ? subscription.appliedEntitlements : null,
      usage,
    };

    return result;
  }

  /**
   * Phase 0.5 — request-independent module entitlement resolver.
   *
   * Answers "is module X enabled for this workspace/account?" OUTSIDE an HTTP
   * request, so crons and background services (e.g. the salary cron, the
   * absence-loss cron) can gate on module access without the SubscriptionGuard's
   * per-request cache (which only exists inside a controller call).
   *
   * Resolution mirrors `SubscriptionGuard.getEntitlements` exactly, minus the
   * HTTP cache:
   *   1. If `workspaceOrAccountId` is a valid workspace id, pivot to the
   *      workspace OWNER (the plan lives on the owner, members inherit it).
   *      If it isn't a workspace, treat it directly as the account/user id.
   *   2. Load the active/trial/cancelled/grace subscription for that user.
   *   3. No subscription, or expired period → false (fail-safe OFF).
   *   4. Read `appliedEntitlements.moduleAccess` and return
   *      `entry.enabled === true` for the requested module.
   *
   * Fail-safe: any "no active subscription" / not-found / unresolved state
   * returns false, never throws — callers (payroll) must default to OFF.
   *
   * Efficiency note (salary cron calls this per workspace): a single indexed
   * Workspace lookup + a single Subscription lookup, no populate of the full
   * plan. Callers that already hold the owner/account id can pass it directly
   * to skip the workspace hop.
   */
  async hasModule(workspaceOrAccountId: string, module: AppModuleEnum): Promise<boolean> {
    if (!workspaceOrAccountId || !Types.ObjectId.isValid(workspaceOrAccountId)) {
      return false;
    }

    // Step 1 — resolve to the owning account/user id. If the id resolves to a
    // workspace, the subscription lives on its owner; otherwise the id IS the
    // account/user id. We only need ownerId, so project it.
    let targetUserId = workspaceOrAccountId;
    try {
      const workspace = await this.workspaceModel
        .findById(new Types.ObjectId(workspaceOrAccountId), { ownerId: 1 })
        .lean()
        .exec();
      if (workspace?.ownerId) {
        targetUserId = String(workspace.ownerId);
      }
    } catch {
      // Non-fatal: fall back to treating the id as a direct account/user id.
    }

    // Step 2 — active subscription (mirrors SubscriptionGuard status set:
    // active/trial/cancelled within period + grace_period for read continuity).
    const now = new Date();
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(targetUserId),
        product: { $in: ['erp', 'bundle'] },
        status: { $in: ['active', 'trial', 'cancelled', 'grace_period'] },
      })
      .sort({ createdAt: -1 })
      .select('appliedEntitlements currentPeriodEnd')
      .lean()
      .exec();

    // Step 3 — no active subscription, or the period has elapsed → OFF.
    if (!subscription) return false;
    if (subscription.currentPeriodEnd && subscription.currentPeriodEnd < now) {
      return false;
    }

    // Step 4 — module-level enabled check against the applied entitlements
    // snapshot. Missing entry OR enabled:false → OFF (matches the guard).
    const moduleAccess = (subscription.appliedEntitlements as PlanEntitlements | undefined)
      ?.moduleAccess;
    if (!Array.isArray(moduleAccess)) return false;
    return moduleAccess.find((entry) => entry.module === module)?.enabled === true;
  }

  /**
   * Read-only gating for "can this user start a subscription on this plan?"
   * Surfaces the tier-comparison + currently-active-sub conflict checks that
   * `subscribe()` runs internally. Used by the billing-checkout service to
   * fail fast BEFORE creating a Razorpay order — saves the user a wasted
   * checkout sheet round-trip when the conflict is deterministic.
   *
   * Throws the same `BadRequestException` messages `subscribe()` emits, so
   * the surface caller doesn't need to translate.
   */
  async assertCanSubscribeTo(userId: string, plan: Plan): Promise<void> {
    if (!plan.isActive) {
      throw new BadRequestException('Plan is not active');
    }

    const current = await this.subscriptionModel
      .findOne({
        userId,
        status: { $in: ['active', 'trial', 'cancelled', 'scheduled'] },
      })
      .sort({ createdAt: -1 })
      .populate<{ planId: Plan }>('planId')
      .exec();

    if (!current) return;

    const currentPlan = current.planId;
    if (current.status === 'active' || current.status === 'trial') {
      const currentTierLevel = this.getTierLevel(currentPlan.tier);
      const newTierLevel = this.getTierLevel(plan.tier);

      if (newTierLevel < currentTierLevel) {
        const expiryDate = current.currentPeriodEnd?.toLocaleDateString() || 'unknown';
        throw new BadRequestException(
          `You have an active ${currentPlan.tier} plan until ${expiryDate}. To switch to a lower tier, cancel your current plan first. Note: cancelling forfeits your remaining access period.`,
        );
      }

      if (currentPlan._id.toString() === plan._id.toString()) {
        throw new BadRequestException(
          'Already subscribed to this plan. Early renewal is not supported yet.',
        );
      }
    } else if (current.status === 'scheduled') {
      throw new BadRequestException(
        'You already have a scheduled plan. Cancel it first before subscribing to a new one.',
      );
    }
  }

  async subscribe(userId: string, updateDto: UpdateSubscriptionDto) {
    const plan = await this.planModel.findById(updateDto.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');
    if (!plan.isActive) throw new BadRequestException('Plan is not active');

    const current = await this.subscriptionModel
      .findOne({
        userId,
        status: { $in: ['active', 'trial', 'cancelled', 'scheduled'] },
      })
      .sort({ createdAt: -1 })
      .populate<{ planId: Plan }>('planId')
      .exec();

    if (current) {
      const currentStatus = current.status;
      const currentPlan = current.planId;

      if (currentStatus === 'active' || currentStatus === 'trial') {
        const currentTierLevel = this.getTierLevel(currentPlan.tier);
        const newTierLevel = this.getTierLevel(plan.tier);

        if (newTierLevel < currentTierLevel) {
          const expiryDate = current.currentPeriodEnd?.toLocaleDateString() || 'unknown';
          throw new BadRequestException(
            `You have an active ${currentPlan.tier} plan until ${expiryDate}. To switch to a lower tier, cancel your current plan first. Note: cancelling forfeits your remaining access period.`,
          );
        }

        if (currentPlan._id.toString() === plan._id.toString()) {
          throw new BadRequestException(
            'Already subscribed to this plan. Early renewal is not supported yet.',
          );
        }

        await this.supersedeCurrent(userId);
      } else if (currentStatus === 'scheduled') {
        throw new BadRequestException(
          'You already have a scheduled plan. Cancel it first before subscribing to a new one.',
        );
      } else if (currentStatus === 'cancelled') {
        if (!updateDto.activateImmediately) {
          const existingScheduled = await this.subscriptionModel.findOne({
            userId,
            status: 'scheduled',
          });
          if (existingScheduled) {
            throw new BadRequestException(
              'You already have a scheduled plan. Cancel it first before scheduling another.',
            );
          }
          await this.supersedeCurrent(userId);
        }
        if (updateDto.activateImmediately) {
          await this.supersedeCurrent(userId);
        }
      }
    }

    const now = new Date();
    let periodEnd: Date;
    let status: string;

    if (updateDto.activateImmediately) {
      status = 'active';
      periodEnd = new Date(now);
      if (updateDto.billingCycle === 'monthly') {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      } else {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      }
    } else {
      if (!current || current.status === 'cancelled') {
        const currentPeriodEnd = current?.currentPeriodEnd || now;
        periodEnd = new Date(currentPeriodEnd);
        if (updateDto.billingCycle === 'monthly') {
          periodEnd.setMonth(periodEnd.getMonth() + 1);
        } else {
          periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        }
        status = 'scheduled';
      } else {
        periodEnd = new Date(now);
        if (updateDto.billingCycle === 'monthly') {
          periodEnd.setMonth(periodEnd.getMonth() + 1);
        } else {
          periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        }
        status = 'active';
      }
    }

    const subscription = new this.subscriptionModel({
      userId,
      planId: plan._id,
      status,
      billingCycle: updateDto.billingCycle || 'monthly',
      currentPeriodStart: status === 'scheduled' ? current?.currentPeriodEnd || now : now,
      currentPeriodEnd: periodEnd,
      product: plan.product,
      purchasedEntitlements: plan.entitlements,
      appliedEntitlements: plan.entitlements,
      source: 'self',
      previousSubscriptionId: current?._id,
    });

    const savedSubscription = await subscription.save();

    if (current?._id && (status === 'active' || status === 'trial')) {
      await this.addOnsService.handleSubscriptionChange(
        userId,
        current._id.toString(),
        savedSubscription._id.toString(),
        plan,
      );
    }

    return savedSubscription;
  }

  async forceActivate(userId: string, subscriptionId: string) {
    const subscription = await this.subscriptionModel.findById(subscriptionId).exec();
    if (!subscription) throw new NotFoundException('Subscription not found');
    if (subscription.userId.toString() !== userId) throw new ForbiddenException('Not authorized');
    if (subscription.status === 'active') return { message: 'Already active' };
    if (subscription.status !== 'scheduled')
      throw new BadRequestException('Subscription is not scheduled');

    await this.supersedeCurrent(userId);

    const now = new Date();
    const periodEnd = new Date(now);
    if (subscription.billingCycle === 'monthly') {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    } else {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    }

    subscription.status = 'active';
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    await subscription.save();

    return { message: 'Subscription activated successfully' };
  }

  async cancelScheduled(userId: string, subscriptionId: string) {
    const subscription = await this.subscriptionModel.findById(subscriptionId).exec();
    if (!subscription) throw new NotFoundException('Subscription not found');
    if (subscription.userId.toString() !== userId) throw new ForbiddenException('Not authorized');
    if (subscription.status !== 'scheduled')
      throw new BadRequestException('Subscription is not scheduled');

    subscription.status = 'cancelled';
    subscription.cancelledAt = new Date();
    await subscription.save();

    return { message: 'Scheduled subscription cancelled' };
  }

  /**
   * CRON CONTRACT - Process scheduled subscriptions
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily at midnight IST - promote due scheduled subs to active.
   * Idempotent:  YES (state-based) - promotes only status='scheduled' rows; once
   *              promoted to 'active' a re-run no longer selects them. supersedeCurrent
   *              is a predicate updateMany (re-run safe).
   * Reads:       subscriptions, plans
   * Writes:      subscription status/entitlements; supersedes prior active sub
   * Missed run:  Self-heals - due scheduled subs stay selectable next day.
   * Owner:       subscriptions
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT, { timeZone: CRON_TIMEZONES.IST })
  async processScheduledSubscriptions() {
    await this.singleFlight.runExclusive(CronJobKey.SCHEDULED_SUBSCRIPTIONS, dayBucket(), () =>
      this.runProcessScheduledSubscriptions(),
    );
  }

  private async runProcessScheduledSubscriptions() {
    this.logger.log('Processing scheduled subscriptions...');
    const now = new Date();

    const scheduled = await this.subscriptionModel
      .find({ status: 'scheduled', currentPeriodStart: { $lte: now } })
      .populate<{ planId: Plan }>('planId')
      .lean();

    for (const sub of scheduled) {
      try {
        const oldSub = await this.subscriptionModel.findOne({
          userId: sub.userId,
          status: { $in: ['active', 'trial'] },
        });

        await this.supersedeCurrent(sub.userId.toString());

        const periodEnd = new Date(now);
        if (sub.billingCycle === 'monthly') {
          periodEnd.setMonth(periodEnd.getMonth() + 1);
        } else {
          periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        }

        // Re-derive entitlements from the target plan's CURRENT entitlements
        // rather than trusting the snapshot frozen onto this scheduled row
        // at schedule time. A scheduled downgrade can sit for a full cycle;
        // if an admin edited the target plan's entitlements in the interim,
        // promoting on the stale snapshot would activate the customer on the
        // wrong limits. The pre-paid `communications` credit balances
        // (SMS / WhatsApp) are imperative state and MUST survive — carry
        // them over from the scheduled row's own `appliedEntitlements`.
        // The `addOnsService.handleSubscriptionChange` recompute below then
        // re-layers any active add-on deltas, exactly as before.
        const livePlan = sub.planId;
        const reDerivedEntitlements = livePlan?.entitlements
          ? this.cloneEntitlementsPreservingComms(livePlan.entitlements, sub.appliedEntitlements)
          : undefined;

        const updatedSub = await this.subscriptionModel.findByIdAndUpdate(
          sub._id,
          {
            $set: {
              status: 'active',
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
              // Only overwrite entitlements when the live plan resolved —
              // a dangling plan ref falls back to the existing snapshot.
              ...(reDerivedEntitlements
                ? {
                    purchasedEntitlements: reDerivedEntitlements,
                    appliedEntitlements: reDerivedEntitlements,
                  }
                : {}),
            },
          },
          { new: true },
        );

        if (oldSub && updatedSub) {
          const plan = sub.planId;
          await this.addOnsService.handleSubscriptionChange(
            sub.userId.toString(),
            oldSub._id.toString(),
            updatedSub._id.toString(),
            plan,
          );
        }

        this.logger.log(
          `Activated scheduled subscription ${String(sub._id)} for user ${String(sub.userId)}`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to activate scheduled subscription ${String(sub._id)} for user ${String(sub.userId)}:`,
          err,
        );
      }
    }

    this.logger.log(`Processed ${scheduled.length} scheduled subscriptions`);
  }

  /**
   * Deep-clone a plan's entitlements, then overlay the `communications`
   * sub-object (pre-paid SMS / WhatsApp credit balances + auto-recharge
   * config) from a source so those imperative balances survive a plan
   * swap. Mirrors `PlanChangeService.cloneEntitlementsPreservingComms` —
   * replicated here rather than injected because pulling `PlanChangeService`
   * into `SubscriptionsService` would close a DI cycle (Billing already
   * `forwardRef`s SubscriptionsModule).
   *
   * Inputs in the scheduled-promotion path come from a `.lean()` query, so
   * they are plain objects already; the `.toObject()`-aware guard keeps the
   * helper safe if ever handed a hydrated subdocument. `structuredClone`
   * preserves `Date` fields (e.g. `communications.lastLowBalanceAlertAt`),
   * unlike a JSON round-trip.
   */
  private cloneEntitlementsPreservingComms(
    planEntitlements: PlanEntitlements,
    sourceApplied: PlanEntitlements | undefined,
  ): PlanEntitlements {
    const toPlain = (value: unknown): unknown =>
      value && typeof (value as { toObject?: unknown }).toObject === 'function'
        ? (value as { toObject: () => unknown }).toObject()
        : value;
    const cloned = structuredClone(toPlain(planEntitlements)) as PlanEntitlements;
    const sourceComms = (sourceApplied as { communications?: unknown })?.communications;
    if (sourceComms) {
      (cloned as { communications?: unknown }).communications = structuredClone(
        toPlain(sourceComms),
      );
    }
    return cloned;
  }

  /**
   * CRON CONTRACT - Expire stale subscriptions
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily at midnight IST - mark past-period active/trial as expired.
   * Idempotent:  YES (naturally) - a single predicate updateMany; a re-run matches
   *              nothing already expired.
   * Reads/Writes: subscriptions (status -> expired)
   * Missed run:  Self-heals - the next day expires any newly-past subscriptions.
   * Owner:       subscriptions
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT, { timeZone: CRON_TIMEZONES.IST })
  async expireStaleSubscriptions() {
    await this.singleFlight.runExclusive(CronJobKey.SUBSCRIPTION_EXPIRE_STALE, dayBucket(), () =>
      this.runExpireStaleSubscriptions(),
    );
  }

  private async runExpireStaleSubscriptions(now: Date = new Date()) {
    // Phase-2 ERP pricing — split the lapsed set into TWO buckets:
    //
    //   1. Lapsed TRIALS (still carry a `trialEndsAt`) -> DOWNGRADE, never lock.
    //      A trial ending must drop the account to its plan's real limits (Free:
    //      5 staff, free modules) and keep it usable. downgradeToBasePlan is
    //      idempotent + entitlements-only (no data deleted).
    //   2. Genuinely-lapsed PAID subs (status 'active', no `trialEndsAt`, period
    //      past) -> keep the existing 'expired' behavior unchanged. We scope the
    //      legacy updateMany to `trialEndsAt: null` so it cannot touch trials
    //      that simply also have a past currentPeriodEnd.
    const lapsedTrials = await this.subscriptionModel
      .find({
        status: 'trial',
        $or: [{ trialEndsAt: { $lt: now } }, { currentPeriodEnd: { $lt: now } }],
      })
      .populate<{ planId: { entitlements?: PlanEntitlements } }>('planId', 'entitlements')
      .exec();

    let downgraded = 0;
    for (const sub of lapsedTrials) {
      const changed = await this.downgradeToBasePlan(sub as never, now);
      if (changed) downgraded += 1;
    }

    // Legacy paid-expiry path — only non-trial subs whose period truly lapsed.
    const result = await this.subscriptionModel.updateMany(
      {
        status: { $in: ['active', 'past_due'] },
        currentPeriodEnd: { $lt: now },
        trialEndsAt: null,
      },
      { $set: { status: 'expired' } },
    );
    this.logger.log(
      `expireStaleSubscriptions: downgraded ${downgraded} lapsed trials, marked ${result.modifiedCount} subscriptions as expired`,
    );
  }

  async cancel(userId: string) {
    const subscription = await this.subscriptionModel
      .findOne({ userId, status: { $in: ['active', 'trial'] } })
      .exec();

    if (!subscription) {
      throw new NotFoundException('No active subscription to cancel');
    }

    subscription.status = 'cancelled';
    subscription.cancelledAt = new Date();
    await subscription.save();

    return {
      subscription,
      message: `Plan cancelled. You retain access until ${subscription.currentPeriodEnd?.toLocaleDateString()}`,
    };
  }

  async supersedeCurrent(userId: string): Promise<Types.ObjectId | null> {
    // The `Subscription.userId` schema path resolves to `Mixed`, so Mongoose does
    // NOT cast a string filter to an ObjectId. userId has historically been stored
    // both as a raw string (legacy signups) and as an ObjectId (current signups +
    // admin-assign). A bare `{ userId: <string> }` therefore matches ONLY the
    // legacy string-stored docs and silently skips the ObjectId-stored ones — so
    // an active sub would survive supersede and then collide with the freshly
    // created sub on the `{userId, product}` partial-unique index (code 11000).
    // That collision is exactly what surfaced as the opt-in "Trial already used"
    // 400. Match BOTH stored representations so supersede works regardless of how
    // the existing sub was written. (Keep in sync with createFreeSubscription /
    // startTrial, which already query/store userId as an ObjectId.)
    const userIdForms: unknown[] = [userId];
    if (Types.ObjectId.isValid(userId)) {
      userIdForms.push(new Types.ObjectId(userId));
    }
    const userIdMatch = { $in: userIdForms };

    const result = await this.subscriptionModel.updateMany(
      { userId: userIdMatch, status: { $in: ['scheduled', 'cancelled', 'expired'] } },
      { $set: { status: 'superseded' } },
    );
    this.logger.log(
      `Superseded ${result.modifiedCount} non-active subscriptions for user ${userId}`,
    );

    const old = await this.subscriptionModel.findOneAndUpdate(
      {
        userId: userIdMatch,
        status: { $in: ['active', 'trial'] },
      },
      { $set: { status: 'superseded' } },
      { returnDocument: 'after' },
    );
    if (old) {
      this.logger.log(`Superseded active/trial subscription ${String(old._id)} for user ${userId}`);
    }
    return old?._id || null;
  }

  /**
   * Phase 2: resolve the plan id a new sign-up is auto-assigned for a product.
   * Fallback chain (registration must always resolve a plan):
   *   1. the active plan an admin flagged as the default (`isDefault:true`);
   *   2. FALLBACK — the active Free-tier plan (covers existing DBs with no
   *      default flagged yet, so registration keeps working pre-Phase-2);
   *   3. null if neither exists.
   * Registration wiring lands in a later phase — this is the helper only.
   */
  async getDefaultPlanId(product = 'erp'): Promise<unknown> {
    const def = await this.planModel.findOne({ isDefault: true, isActive: true, product }).exec();
    if (def) return def._id;

    const free = await this.planModel
      .findOne({ tier: PlanTier.FREE, isActive: true, product })
      .exec();
    return free ? free._id : null;
  }

  /**
   * Resolve the admin-configured TRIAL plan id for a product, or null when none
   * is configured. A trial plan (`isTrialPlan:true`) defines the entitlements a
   * new signup's trial runs on + the trial length (its own trialDurationDays).
   * Returns null when no active trial plan exists — callers MUST then preserve
   * today's hardcoded-fallback behavior so nothing breaks pre-configuration.
   */
  async getTrialPlanId(product = 'erp'): Promise<unknown> {
    const trial = await this.planModel
      .findOne({ isTrialPlan: true, isActive: true, product })
      .exec();
    return trial ? trial._id : null;
  }

  /**
   * PUBLIC-safe trial-banner config for the "45-day free trial" promo banner.
   *
   * Drives BOTH the in-app plans page (authenticated, non-admin user) and the
   * unauthenticated marketing pricing page. The existing GET /admin/settings
   * read is admin-only, so this returns ONLY three public-safe fields and
   * deliberately leaks nothing else from AppSettings:
   *   - enabled          appSettings.trialBanner.enabled    (default true)
   *   - headlineOverride appSettings.trialBanner.headlineOverride (default '')
   *   - days             the DEFAULT erp plan's trialDurationDays (default 0)
   *
   * `days` is resolved through getDefaultPlanId('erp') (isDefault -> free plan
   * fallback), then the plan's trialDurationDays; if no default/free plan
   * exists or it carries no trialDurationDays, days = 0 (never throws).
   */
  async getPublicTrialBannerConfig(): Promise<{
    enabled: boolean;
    headlineOverride: string;
    days: number;
  }> {
    const settings = await this.appSettingsModel.findOne().exec();
    const enabled = settings?.trialBanner?.enabled ?? true;
    const headlineOverride = settings?.trialBanner?.headlineOverride ?? '';

    // Resolve the trial length. Prefer the admin-configured TRIAL plan's
    // trialDurationDays when one exists; otherwise fall back to the DEFAULT
    // plan's (today's behavior). getTrialPlanId/getDefaultPlanId return null
    // when none exists, so days resolves to 0 and never throws.
    let days = 0;
    const trialPlanId = await this.getTrialPlanId('erp');
    if (trialPlanId) {
      const trialPlan = await this.planModel.findById(trialPlanId).exec();
      days = trialPlan?.trialDurationDays ?? 0;
    } else {
      const defaultPlanId = await this.getDefaultPlanId('erp');
      if (defaultPlanId) {
        const plan = await this.planModel.findById(defaultPlanId).exec();
        days = plan?.trialDurationDays ?? 0;
      }
    }

    return { enabled, headlineOverride, days };
  }

  /**
   * Phase-2 ERP pricing — build the FULL-ACCESS entitlements a trial runs on.
   *
   * During the trial window a new account gets everything the top concrete
   * tier ('business') unlocks plus unlimited members, so they can evaluate the
   * whole product. We spread the plan's own entitlements first (to keep
   * sessions / storage / communications / connect and any other dimensions the
   * real plan defines) and then override only the trial-specific knobs:
   *   - moduleAccess  -> buildModuleAccess('business') (all in-scope modules
   *                      enabled at their business-tier access; deliberately NOT
   *                      'custom'). Full access = every module EXCEPT anything
   *                      Bill & Accounts adds beyond business — Finance keeps
   *                      its normal sub-feature gating, which 'business' already
   *                      expresses, so nothing Bill-&-Accounts-specific leaks in.
   *   - maxMembersPerWorkspace / maxTotalMembers -> -1 (unlimited) for the trial.
   * Returns a fresh object; the source `planEntitlements` is never mutated.
   */
  private buildTrialEntitlements(planEntitlements: PlanEntitlements): PlanEntitlements {
    return {
      ...planEntitlements,
      moduleAccess: buildModuleAccess('business') as PlanEntitlements['moduleAccess'],
      maxMembersPerWorkspace: -1,
      maxTotalMembers: -1,
    };
  }

  /**
   * Build the trial-subscription document (status:'trial') for a user.
   *
   * Opt-in model (2026-06-24): this is the SINGLE source of trial-sub
   * construction, reused by startTrial(). It is no longer wired into
   * createFreeSubscription (auto-start is off).
   *
   * Construction (owner-confirmed):
   *   - status:'trial', trialEndsAt = now + trialDurationDays days,
   *     currentPeriodEnd === trialEndsAt so the expiry cron fires and the trial
   *     counts down.
   *   - appliedEntitlements = the CONFIGURED trial plan's entitlements when a
   *     trial plan exists, else the hardcoded full-access fallback
   *     (buildTrialEntitlements).
   *   - purchasedEntitlements = the DEFAULT plan's entitlements (what they
   *     downgrade to) and planId = the DEFAULT plan, so expiry lands on Free.
   *
   * `userObjectId` is passed in already wrapped so both callers store userId
   * identically (the ObjectId-typed reads must be able to match it).
   */
  private buildTrialSubscriptionDoc(opts: {
    userObjectId: Types.ObjectId;
    defaultPlanId: unknown;
    defaultPlanEntitlements: PlanEntitlements;
    defaultPlanProduct: string;
    trialPlan: (Plan & { _id: unknown }) | null;
    trialDurationDays: number;
    source: string;
    now: Date;
  }): Record<string, unknown> {
    const { now, trialDurationDays } = opts;
    const trialEndsAt = new Date(now.getTime() + trialDurationDays * 24 * 60 * 60 * 1000);
    const hasConfiguredTrial = !!opts.trialPlan && (opts.trialPlan.trialDurationDays || 0) > 0;
    return {
      userId: opts.userObjectId,
      // Point at the DEFAULT plan so the post-downgrade sub references the plan
      // it lands on (downgrade swaps applied -> purchased = default).
      planId: opts.defaultPlanId,
      status: 'trial',
      billingCycle: 'monthly',
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
      trialEndsAt,
      product: opts.defaultPlanProduct,
      // What they downgrade to when the trial lapses = the DEFAULT plan.
      purchasedEntitlements: opts.defaultPlanEntitlements,
      // Trial-window access: the CONFIGURED trial plan's entitlements when a
      // trial plan exists, else the hardcoded full-access fallback.
      appliedEntitlements: hasConfiguredTrial
        ? (opts.trialPlan as Plan).entitlements
        : this.buildTrialEntitlements(opts.defaultPlanEntitlements),
      source: opts.source,
    };
  }

  /**
   * Resolve the DEFAULT plan doc for a product (admin default -> Free fallback ->
   * safe auto-create), repairing legacy empty moduleAccess. Shared by
   * createFreeSubscription + startTrial so both resolve the same plan + the same
   * post-trial downgrade target.
   */
  private async resolveDefaultPlanDoc(product = 'erp'): Promise<Plan & { _id: unknown }> {
    const defaultPlanId = await this.getDefaultPlanId(product);
    let plan: (Plan & { _id: unknown }) | null = defaultPlanId
      ? ((await this.planModel.findById(defaultPlanId).exec()) as (Plan & { _id: unknown }) | null)
      : null;

    if (!plan) {
      // Safety net (preserved): no default + no free plan in DB — auto-create a
      // Free plan so registration keeps working pre-seed.
      this.logger.warn('[resolveDefaultPlanDoc] No default/free plan in DB — auto-creating Free');
      plan = (await this.planModel.create({
        name: 'Free Forever',
        tier: PlanTier.FREE,
        monthlyPrice: 0,
        yearlyPrice: 0,
        isActive: true,
        entitlements: {
          maxWorkspaces: 1,
          maxMembersPerWorkspace: 5,
          maxTotalMembers: 5,
          modules: [AppModuleEnum.TEAM, AppModuleEnum.ATTENDANCE, AppModuleEnum.SALARY],
          features: {
            export: false,
            apiAccess: false,
            advancedRbac: false,
            customRoles: false,
            shifts: false,
            bills: false,
          },
          moduleAccess: buildModuleAccess('free'),
        },
      })) as unknown as Plan & { _id: unknown };
    } else if (!plan.entitlements?.moduleAccess?.length) {
      // Repair an existing plan that has empty moduleAccess (legacy data).
      const repairedAccess = buildModuleAccess('free');
      await this.planModel.updateOne(
        { _id: plan._id },
        { $set: { 'entitlements.moduleAccess': repairedAccess } },
      );
      (plan.entitlements as any).moduleAccess = repairedAccess;
    }
    return plan;
  }

  /**
   * Opt-in trial model (owner directive, 2026-06-24).
   *
   * `now` is injectable purely so the period maths is unit-testable; it defaults
   * to the real wall clock in production.
   *
   * At signup this ALWAYS lands the user on the DEFAULT plan as status:'active'
   * (no trial, no trialEndsAt), regardless of whether a trial plan is configured
   * or the default plan carries trialDurationDays. The trial is now OPT-IN:
   * auto-start is intentionally OFF — the user starts it explicitly via
   * startTrial(). The trial-sub construction lives in buildTrialSubscriptionDoc.
   */
  async createFreeSubscription(
    userId: string,
    source: 'self' | 'admin' = 'self',
    now: Date = new Date(),
  ) {
    const settings = await this.appSettingsModel.findOne().exec();
    if (settings?.freeTierEnabled === false) {
      return null;
    }

    // Idempotency guard must be ERP-scoped + active/trial. A bare
    // findOne({ userId }) matched ANY sub — including the user's CONNECT sub
    // (created at signup) or a stale/expired/superseded ERP sub — and returned
    // it WITHOUT creating the active ERP default, so a new ERP user landed with
    // no active ERP plan (the signup bug). Only an already-ACTIVE/TRIAL ERP (or
    // bundle) sub should short-circuit. Kept in sync with getMySubscription's
    // ERP resolver scope (product ∈ erp|bundle, status ∈ active|trial).
    // Store + query userId as an ObjectId, matching the working admin-assign
    // path (admin.service.assignDefaultPlanInternal uses `new Types.ObjectId`).
    // Signup previously stored the raw string here; the ObjectId-typed reads
    // (getMySubscription / SubscriptionGuard / getWorkspaceLimit) then could not
    // match it, so signup-created subs were invisible even though they existed.
    const userObjectId = new Types.ObjectId(userId);
    const existing = await this.subscriptionModel
      .findOne({
        userId: userObjectId,
        product: { $in: ['erp', 'bundle'] },
        status: { $in: ['active', 'trial'] },
      })
      .exec();
    if (existing) {
      return existing;
    }

    // Resolve the DEFAULT plan (admin default -> Free fallback -> safe
    // auto-create). Shared helper keeps createFreeSubscription + startTrial on
    // the same plan + post-trial downgrade target.
    const plan = await this.resolveDefaultPlanDoc('erp');
    const planEntitlements = plan.entitlements;

    // OPT-IN trial model (2026-06-24): signup ALWAYS lands on the DEFAULT plan
    // as status:'active'. Auto-start is intentionally OFF — even when a trial
    // plan is configured or the default plan carries trialDurationDays, we do
    // NOT begin a trial here. The user starts the trial explicitly via
    // startTrial(); that is the only place buildTrialSubscriptionDoc runs.
    const periodEnd = new Date(now);
    periodEnd.setFullYear(periodEnd.getFullYear() + 100);
    const subDoc: Record<string, unknown> = {
      userId: userObjectId,
      planId: plan._id,
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      product: plan.product,
      purchasedEntitlements: planEntitlements,
      appliedEntitlements: planEntitlements,
      source,
    };

    const sub = await this.subscriptionModel.create(subDoc);
    // DIAGNOSTIC (temporary): print the userId + product the sub is saved
    // against, plus a POST-CREATE RE-FIND using the exact getMySubscription
    // read filter, so we can confirm the just-created sub is actually findable
    // by the read path. Remove once the signup auto-assign linkage is verified.
    const reFind = await this.subscriptionModel
      .findOne({
        userId: userObjectId,
        product: { $in: ['erp', 'bundle'] },
        status: { $in: ['active', 'trial'] },
        currentPeriodEnd: { $gt: now },
      })
      .exec();
    this.logger.log(
      `Created subscription id=${String(sub._id)} userId=${String(sub.userId)} product=${String(sub.product)} status=${String(subDoc.status)} optInTrial=auto-start-off reFind=${reFind ? 'FOUND' : 'NOT_FOUND'}`,
    );
    return sub;
  }

  /**
   * Opt-in trial: has this user EVER had a trial for this product line?
   *
   * One-time-forever rule: a trial counts as used if ANY subscription doc for
   * the user (product ∈ erp|bundle) is currently a trial OR carries a trial
   * marker (trialEndsAt set, or trialEndedAt set from a lapsed trial). Covers
   * the live-trial, never-expired, and already-downgraded cases in one query.
   * Returns the matching doc (so callers can read trialEndsAt) or null.
   */
  private async findEverTrialedSub(userObjectId: Types.ObjectId): Promise<{
    status?: string;
    trialEndsAt?: Date | null;
    trialEndedAt?: Date | null;
  } | null> {
    return this.subscriptionModel
      .findOne({
        userId: userObjectId,
        product: { $in: ['erp', 'bundle'] },
        $or: [{ status: 'trial' }, { trialEndsAt: { $ne: null } }, { trialEndedAt: { $ne: null } }],
      })
      .exec();
  }

  /**
   * Is the user CURRENTLY on a PAID plan for this product?
   *
   * "Paid" = an active subscription (product ∈ erp|bundle, status:'active') whose
   * planId is NOT the DEFAULT/Free plan and which is not itself a trial. A trial
   * sub (status:'trial') is excluded here on purpose — the one-time-trial guard
   * (findEverTrialedSub) already covers that case, and a trial is not a paid plan.
   * A sub on the default plan, or no active sub at all, is NOT paid (eligible).
   *
   * Used to block a paying user from starting a trial (which would supersede
   * their paid plan and downgrade them to Free on expiry — a net downgrade they
   * never intended).
   */
  private async isOnPaidPlan(userObjectId: Types.ObjectId, product = 'erp'): Promise<boolean> {
    // Resolve the default/Free plan the same way the rest of the service does, so
    // "paid vs default" stays consistent with createFreeSubscription/startTrial.
    const defaultPlanId = await this.getDefaultPlanId(product);

    const activeSub = await this.subscriptionModel
      .findOne({
        userId: userObjectId,
        product: { $in: ['erp', 'bundle'] },
        status: 'active',
      })
      .exec();
    if (!activeSub) return false;

    // Compare the active sub's planId to the default plan id. planId may be a
    // populated doc or a raw id — normalize both sides to a string for the test.
    const activePlanId = (activeSub.planId as { _id?: unknown } | null)?._id ?? activeSub.planId;
    if (activePlanId == null || defaultPlanId == null) return false;
    return String(activePlanId) !== String(defaultPlanId);
  }

  /**
   * Opt-in trial — explicitly START the trial for the calling user.
   *
   * Eligibility (all must hold, else a 4xx is thrown):
   *   - a trial plan must be configured (getTrialPlanId non-null), else
   *     BadRequest "No trial is available".
   *   - the user must NOT currently be on a PAID plan (isOnPaidPlan false), else
   *     BadRequest "You already have a paid plan" — starting a trial would
   *     supersede their paid plan and downgrade them to Free on expiry.
   *   - the user must NEVER have had a trial (findEverTrialedSub null). This also
   *     covers "not currently mid-trial", since a live trial matches the query.
   *     Else BadRequest "Trial already used".
   * Action: supersede the current active sub, then create the trial sub via the
   * shared buildTrialSubscriptionDoc (trialEndsAt = now + trial plan days,
   * applied = trial plan entitlements, purchased = DEFAULT plan, planId =
   * DEFAULT plan so expiry lands on Free). `now` is injectable for tests.
   */
  async startTrial(userId: string, product = 'erp', now: Date = new Date()) {
    const userObjectId = new Types.ObjectId(userId);

    // Must have a configured trial plan to start.
    const trialPlanId = await this.getTrialPlanId(product);
    if (!trialPlanId) {
      throw new BadRequestException('No trial is available');
    }
    const trialPlan = (await this.planModel.findById(trialPlanId).exec()) as
      | (Plan & { _id: unknown })
      | null;
    const trialDurationDays = trialPlan?.trialDurationDays || 0;
    if (!trialPlan || trialDurationDays <= 0) {
      throw new BadRequestException('No trial is available');
    }

    // A paying user must NOT be able to start a trial: it would supersede their
    // paid plan and downgrade them to Free on expiry — a net downgrade they
    // never intended. Free/default-plan users and no-plan users stay eligible.
    if (await this.isOnPaidPlan(userObjectId, product)) {
      throw new BadRequestException('You already have a paid plan');
    }

    // One-time-forever: never trialed before (also blocks an in-flight trial).
    const everTrialed = await this.findEverTrialedSub(userObjectId);
    if (everTrialed) {
      throw new BadRequestException('Trial already used');
    }

    // Downgrade target = the DEFAULT plan (where expiry lands).
    const defaultPlan = await this.resolveDefaultPlanDoc(product);

    // Supersede the user's current active/non-active subs before starting. NOTE:
    // supersedeCurrent matches userId in BOTH stored forms (string + ObjectId)
    // because the userId path is Mixed (no cast); if it ever fails to supersede
    // the active sub, the create() below collides on {userId,product} (11000) and
    // is mis-surfaced as "Trial already used" — the original opt-in-trial bug.
    await this.supersedeCurrent(userId);

    const subDoc = this.buildTrialSubscriptionDoc({
      userObjectId,
      defaultPlanId: defaultPlan._id,
      defaultPlanEntitlements: defaultPlan.entitlements,
      defaultPlanProduct: defaultPlan.product,
      trialPlan,
      trialDurationDays,
      source: 'trial',
      now,
    });

    let sub;
    try {
      sub = await this.subscriptionModel.create(subDoc);
    } catch (error) {
      // Race hardening: the partial-unique {userId,product} trial index makes a
      // second concurrent start-trial fail with a Mongo duplicate-key error
      // (code 11000). Surface the friendly one-time message instead of a raw 500.
      if ((error as { code?: number })?.code === 11000) {
        throw new BadRequestException('Trial already used');
      }
      throw error;
    }
    this.logger.log(
      `Started opt-in trial id=${String(sub._id)} userId=${String(userObjectId)} product=${String(defaultPlan.product)} trialDays=${trialDurationDays} trialPlan=${String(trialPlan._id)}`,
    );
    return sub;
  }

  /**
   * Opt-in trial — front-end state for the "Start free trial" button + banner.
   *
   * Returns the four facts the UI needs plus the derived `canStartTrial`:
   *   - trialPlanConfigured : a trial plan exists for the product.
   *   - hasUsedTrial        : the user has ever had a trial (live or lapsed).
   *   - isInTrial           : the user is currently mid-trial.
   *   - trialEndsAt         : the live trial's end date (null when not in trial).
   *   - trialDurationDays   : the trial plan's length (0 when none configured).
   *   - canStartTrial       : trialPlanConfigured && !hasUsedTrial && !isInTrial
   *                           && free tier not disabled && NOT on a paid plan
   *                           (consistent with createFreeSubscription/startTrial,
   *                           which no-op or throw under the same conditions; a
   *                           paying user starting a trial would be a downgrade).
   */
  async getTrialState(
    userId: string,
    product = 'erp',
  ): Promise<{
    trialPlanConfigured: boolean;
    hasUsedTrial: boolean;
    isInTrial: boolean;
    trialEndsAt: Date | null;
    trialDurationDays: number;
    canStartTrial: boolean;
  }> {
    const userObjectId = new Types.ObjectId(userId);

    const settings = await this.appSettingsModel.findOne().exec();
    const freeTierEnabled = settings?.freeTierEnabled !== false;

    const trialPlanId = await this.getTrialPlanId(product);
    let trialDurationDays = 0;
    if (trialPlanId) {
      const trialPlan = await this.planModel.findById(trialPlanId).exec();
      trialDurationDays = trialPlan?.trialDurationDays ?? 0;
    }
    const trialPlanConfigured = !!trialPlanId && trialDurationDays > 0;

    const everTrialed = await this.findEverTrialedSub(userObjectId);
    const hasUsedTrial = !!everTrialed;
    const isInTrial = everTrialed?.status === 'trial';
    const trialEndsAt = isInTrial ? (everTrialed?.trialEndsAt ?? null) : null;

    // A paying user can't start a trial (would downgrade them) — mirror the
    // startTrial guard so the button is disabled, not just the action blocked.
    const onPaidPlan = await this.isOnPaidPlan(userObjectId, product);

    const canStartTrial =
      trialPlanConfigured && !hasUsedTrial && !isInTrial && freeTierEnabled && !onPaidPlan;

    return {
      trialPlanConfigured,
      hasUsedTrial,
      isInTrial,
      trialEndsAt,
      trialDurationDays,
      canStartTrial,
    };
  }

  /**
   * Phase-2 ERP pricing — DOWNGRADE a lapsed trial to its plan's real limits
   * (Free: 5 staff, free modules) instead of locking the account out.
   *
   * `now` is injectable for testability (far-future period maths is otherwise
   * non-deterministic). Idempotent: a sub already downgraded — status 'active'
   * with no `trialEndsAt` — is a no-op (returns false, no write).
   *
   * NOTE: downgrade is entitlements-only; it never deletes payroll/period data,
   * so an in-progress payroll run is not corrupted (§10.7). The member-cap read
   * filter in a later phase is what hides over-limit members at read time, not
   * this method — here we only swap the applied limits and reopen the period.
   *
   * Returns true when a downgrade write was issued, false when left alone.
   */
  private async downgradeToBasePlan(
    subscription: {
      _id: unknown;
      status?: string;
      trialEndsAt?: Date | null;
      purchasedEntitlements?: PlanEntitlements;
      planId?: { entitlements?: PlanEntitlements };
    },
    now: Date = new Date(),
  ): Promise<boolean> {
    // Idempotency: already on the base plan (active + no pending trial) — skip.
    if (subscription.status === 'active' && !subscription.trialEndsAt) {
      return false;
    }

    // The plan's REAL limits — prefer the denormalized purchasedEntitlements,
    // fall back to a populated planId.entitlements.
    const baseEntitlements =
      subscription.purchasedEntitlements ||
      (subscription.planId as { entitlements?: PlanEntitlements } | undefined)?.entitlements ||
      null;

    if (!baseEntitlements) {
      // No entitlements to fall back to — leave the sub for the legacy path
      // rather than blanking its access.
      this.logger.warn(
        `[downgradeToBasePlan] sub ${String(subscription._id)} has no purchased/plan entitlements — skipping`,
      );
      return false;
    }

    // Free plan never expires again — push the period far out and clear the
    // trial marker so the cron / guard never re-process this row.
    const farFuture = new Date(now);
    farFuture.setFullYear(farFuture.getFullYear() + 100);

    await this.subscriptionModel
      .updateOne(
        { _id: subscription._id },
        {
          $set: {
            status: 'active',
            appliedEntitlements: baseEntitlements,
            currentPeriodEnd: farFuture,
            trialEndsAt: null,
            // Durable "this trial just lapsed to its base plan" marker. Set in
            // the SAME write as the downgrade so the front end can tell a
            // just-downgraded Free account from an always-Free one and show the
            // post-expiry banner. Stamped with the method's own `now`. NOT set
            // on the idempotent early-return above — an already-downgraded sub
            // keeps its original trialEndedAt. Cleared only on re-upgrade, which
            // creates a fresh subscription row (schema default null), so the
            // banner naturally stops without a clear write here.
            trialEndedAt: now,
          },
        },
      )
      .exec();

    this.logger.log(
      `[downgradeToBasePlan] downgraded sub ${String(subscription._id)} trial -> base plan (active)`,
    );

    // Post-expiry "you're now on Free" notice. Best-effort: fired here because
    // this is the single choke point for "a trial just became Free" (both the
    // expiry cron and the subscription guard call this). Deduped on
    // `trial-ended:<subId>` inside MarketingService so the two callers never
    // double-send. A dispatch failure must NEVER block the downgrade.
    await this.sendTrialEndedNotice(subscription);

    return true;
  }

  /**
   * Best-effort dispatch of the one-time post-expiry "you're now on Free"
   * notice. Wrapped in try/catch + Sentry so a notice failure never bubbles
   * out of the downgrade. Idempotency is handled downstream by the
   * `trial-ended:<subId>` dedup key in MarketingService.
   */
  private async sendTrialEndedNotice(subscription: {
    _id: unknown;
    userId?: unknown;
    // planId may be a populated plan doc (has `name`), a raw ObjectId, or
    // absent. We cast + read `name` defensively at the use site, so `unknown`
    // is the honest type here.
    planId?: unknown;
  }): Promise<void> {
    try {
      const userId = subscription.userId;
      if (!userId) return;

      const user = await this.userModel
        .findById(userId as never)
        .select('name email')
        .lean()
        .exec();
      if (!user?.email) return;

      const planName =
        (subscription.planId as { name?: string } | undefined)?.name ?? 'Your ManekHR';

      await this.marketing.sendTrialEndedNotice({
        userId: String(userId),
        subscriptionId: String(subscription._id),
        recipientName: (user as { name?: string }).name ?? 'there',
        recipientEmail: (user as { email: string }).email,
        planName,
        upgradeUrl: this.marketing.buildAppUrl('/dashboard/subscription/plans'),
      });
    } catch (e) {
      const err = e as { message?: string };
      this.logger.error(
        `[downgradeToBasePlan] post-expiry notice failed for sub ${String(subscription._id)}: ${err.message}`,
      );
      Sentry.captureException(e, {
        tags: { module: 'subscriptions', op: 'trial_ended_notice' },
        extra: { subscriptionId: String(subscription._id) },
      });
    }
  }

  async getMySubscriptionHistory(userId: string) {
    return this.subscriptionModel
      .find({ userId: new Types.ObjectId(userId) })
      .populate('planId', 'name tier monthlyPrice yearlyPrice')
      .populate('assignedBy', 'name email')
      .sort({ currentPeriodStart: -1 })
      .lean();
  }

  async getUserSubscription(userId: string) {
    return this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan }>('planId')
      .exec();
  }
}
