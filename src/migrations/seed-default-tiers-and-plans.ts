import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tier } from '../modules/subscriptions/schemas/tier.schema';
import { Plan } from '../modules/subscriptions/schemas/plan.schema';
import { PlatformAccess } from '../common/enums/platform-access.enum';
import { buildModuleAccess } from '../common/constants/module-features.registry';
// Single source of truth for the canonical capacity caps + prices (Phase-1 ERP
// pricing rework). The seed and the reconcile migration both import these so they
// can never drift apart. Names/descriptions/colors/overrides/flags stay defined
// inline below — only the numeric caps + prices come from the shared constants.
import {
  CANONICAL_ERP_TIER_CAPS,
  CANONICAL_ERP_PLAN_PRICES,
} from './canonical-erp-plans.constants';

/**
 * Seed default Tiers + Plans per audit decisions in MODULE_INVENTORY.md §2.1 + §3.5.
 *
 * Idempotent — re-runnable safely. Uses upsert by tier.key and plan.name.
 * Existing admin edits to seeded docs are preserved (uses $setOnInsert for
 * defaultEntitlements/defaultModuleAccess so seed only sets them at first insert).
 *
 * Pricing: realistic India SMB SaaS pricing (Apr-2026 benchmarks vs Keka /
 * greytHR / Zoho). Adjust per your sales-team feedback. Yearly = ~17% off
 * monthly × 12 (standard SaaS discount).
 *
 * To run: inject this service somewhere bootable (e.g. AppModule init hook)
 * or expose via /admin/maintenance/seed-defaults endpoint.
 */
@Injectable()
export class SeedDefaultTiersAndPlansService {
  private readonly logger = new Logger(SeedDefaultTiersAndPlansService.name);

  constructor(
    @InjectModel(Tier.name) private tierModel: Model<Tier>,
    @InjectModel(Plan.name) private planModel: Model<Plan>,
  ) {}

  // ── TIER DEFINITIONS ──────────────────────────────────────────────
  private readonly TIER_DEFINITIONS = [
    {
      key: 'free',
      name: 'Free',
      displayOrder: 0,
      color: 'default',
      description: 'Try ManekHR — for solo founders + tiny teams getting started.',
      defaultEntitlements: CANONICAL_ERP_TIER_CAPS.free,
    },
    {
      key: 'starter',
      name: 'Starter',
      displayOrder: 1,
      color: 'blue',
      description: 'Single GSTIN, basic GST + e-invoice + e-waybill, up to 25 employees.',
      defaultEntitlements: CANONICAL_ERP_TIER_CAPS.starter,
    },
    {
      key: 'growth',
      name: 'Growth',
      displayOrder: 2,
      color: 'gold',
      description:
        'Most popular — multi-feature payroll, full inventory, GST returns. Up to 100 employees, 2 workspaces.',
      defaultEntitlements: CANONICAL_ERP_TIER_CAPS.growth,
    },
    {
      key: 'business',
      name: 'Business',
      displayOrder: 3,
      color: 'purple',
      description:
        'Multi-state ops, full Form-16/FnF/Gratuity, manufacturing costing, all GST. Up to 500 employees, 5 workspaces.',
      defaultEntitlements: CANONICAL_ERP_TIER_CAPS.business,
    },
    // Enterprise RETIRED as a public/seedable tier (Phase-1 pricing rework,
    // 2026-06-23). The owner-confirmed canonical public set is Free/Starter/
    // Growth/Business + a non-public Custom. The 'enterprise' tier STRING stays
    // in PlanTier + buildModuleAccess (legacy subs may reference it) — we just
    // stop SEEDING it. Legacy Enterprise rows in existing DBs are deactivated by
    // the retire-legacy-erp-plans migration. Do NOT re-add an enterprise entry.
    {
      key: 'custom',
      name: 'Custom',
      displayOrder: 4, // moved up from 5 now that Enterprise (was 4) is retired
      color: 'volcano',
      description: 'Admin-defined entitlements for special arrangements. Not publicly listed.',
      defaultEntitlements: CANONICAL_ERP_TIER_CAPS.custom,
    },
  ];

  // ── PLAN DEFINITIONS ──────────────────────────────────────────────
  // One default plan per tier. Admin can add monthly/yearly variants later.
  // Pricing in INR. Yearly = ~17% off (12 × monthly × 0.83 ≈ yearly).
  private readonly PLAN_DEFINITIONS = [
    {
      name: 'Free',
      tier: 'free',
      monthlyPrice: CANONICAL_ERP_PLAN_PRICES.free.monthlyPrice,
      yearlyPrice: CANONICAL_ERP_PLAN_PRICES.free.yearlyPrice,
      isPubliclyVisible: true, // self-serve catalogue plan (explicit for clarity)
      isCustom: false,
      entitlementsOverride: {
        maxSessionsPerPlatform: 1,
        maxSessionsTotal: 2,
        emailsPerMonth: 50,
        platformAccess: PlatformAccess.BOTH,
        // Wave-3 Drift #36 — storage quota per §3.5.3
        storage: { totalGbPerWorkspace: 0.1, perFileMaxMb: 1 },
      },
    },
    {
      name: 'Starter',
      tier: 'starter',
      monthlyPrice: CANONICAL_ERP_PLAN_PRICES.starter.monthlyPrice,
      yearlyPrice: CANONICAL_ERP_PLAN_PRICES.starter.yearlyPrice, // ~17% off
      isPubliclyVisible: true,
      isCustom: false,
      entitlementsOverride: {
        maxSessionsPerPlatform: 2,
        maxSessionsTotal: 4,
        emailsPerMonth: 200,
        platformAccess: PlatformAccess.BOTH,
        storage: { totalGbPerWorkspace: 0.5, perFileMaxMb: 5 },
      },
    },
    {
      name: 'Growth',
      tier: 'growth',
      monthlyPrice: CANONICAL_ERP_PLAN_PRICES.growth.monthlyPrice,
      yearlyPrice: CANONICAL_ERP_PLAN_PRICES.growth.yearlyPrice, // ~17% off
      isPubliclyVisible: true,
      isCustom: false,
      entitlementsOverride: {
        maxSessionsPerPlatform: 3,
        maxSessionsTotal: 6,
        emailsPerMonth: 1000,
        platformAccess: PlatformAccess.BOTH,
        storage: { totalGbPerWorkspace: 2, perFileMaxMb: 10 },
      },
    },
    {
      name: 'Business',
      tier: 'business',
      monthlyPrice: CANONICAL_ERP_PLAN_PRICES.business.monthlyPrice,
      yearlyPrice: CANONICAL_ERP_PLAN_PRICES.business.yearlyPrice, // ~17% off
      isPubliclyVisible: true,
      isCustom: false,
      entitlementsOverride: {
        maxSessionsPerPlatform: 5,
        maxSessionsTotal: 10,
        emailsPerMonth: 5000,
        platformAccess: PlatformAccess.BOTH,
        storage: { totalGbPerWorkspace: 10, perFileMaxMb: 25 },
      },
    },
    // Enterprise plan RETIRED (Phase-1 pricing rework, 2026-06-23) — no longer
    // a seedable/purchasable/public plan. See the matching note in
    // TIER_DEFINITIONS above. Do NOT re-add an enterprise plan here.
    {
      name: 'Custom',
      tier: 'custom',
      // admin-assign only — entitlements set per-customer via /admin/subscriptions/custom-assign
      monthlyPrice: CANONICAL_ERP_PLAN_PRICES.custom.monthlyPrice,
      yearlyPrice: CANONICAL_ERP_PLAN_PRICES.custom.yearlyPrice,
      // Custom is a bespoke / contact-us plan: NEVER shown on the public pricing
      // page and flagged custom so unrelated users can't subscribe. Overrides
      // the schema defaults (isPubliclyVisible defaults true, isCustom defaults
      // false) at create time below.
      isPubliclyVisible: false,
      isCustom: true,
      entitlementsOverride: {
        maxSessionsPerPlatform: -1,
        maxSessionsTotal: -1,
        emailsPerMonth: -1,
        platformAccess: PlatformAccess.BOTH,
        storage: { totalGbPerWorkspace: -1, perFileMaxMb: 100 },
      },
    },
  ];

  // ── SEED METHODS ──────────────────────────────────────────────────

  async seedTiers(): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;

    for (const tierDef of this.TIER_DEFINITIONS) {
      const existing = await this.tierModel.findOne({ key: tierDef.key }).exec();
      if (existing) {
        this.logger.log(`Tier '${tierDef.key}' already exists — skipping.`);
        skipped++;
        continue;
      }

      // Build moduleAccess from registry — uses tier-default templates per Wave-2 audit
      const moduleAccess = buildModuleAccess(tierDef.key);
      const defaultModuleAccess = moduleAccess.map((entry) => ({
        module: entry.module,
        enabled: entry.enabled,
        subFeatures: entry.subFeatures,
      }));

      await this.tierModel.create({
        key: tierDef.key,
        name: tierDef.name,
        displayOrder: tierDef.displayOrder,
        color: tierDef.color,
        description: tierDef.description,
        isActive: true,
        defaultEntitlements: tierDef.defaultEntitlements,
        defaultModuleAccess,
      });

      this.logger.log(`Tier '${tierDef.key}' (${tierDef.name}) seeded.`);
      inserted++;
    }

    return { inserted, skipped };
  }

  async seedPlans(): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;

    for (const planDef of this.PLAN_DEFINITIONS) {
      // Match an existing ERP plan by TIER (one canonical ERP plan per tier),
      // NOT by name. Names are owner-editable in admin ("Free"/"Starter"/etc.
      // can be renamed), so a name-based probe would fail to find a renamed row
      // and RE-INSERT a duplicate on the next seed run. Scope the probe to
      // non-Connect plans so Connect plans (product:'connect') can share a tier
      // string without colliding with the ERP seed.
      const existing = await this.planModel
        .findOne({ tier: planDef.tier, product: { $ne: 'connect' } })
        .exec();
      if (existing) {
        this.logger.log(
          `ERP plan for tier '${planDef.tier}' already exists (e.g. '${planDef.name}') — skipping.`,
        );
        skipped++;
        continue;
      }

      // Pull tier defaults for this plan's tier
      const tier = await this.tierModel.findOne({ key: planDef.tier }).exec();
      if (!tier) {
        this.logger.warn(
          `Tier '${planDef.tier}' not found — skipping plan '${planDef.name}'. Run seedTiers() first.`,
        );
        skipped++;
        continue;
      }

      // Build moduleAccess from registry helper (tier-aware)
      const moduleAccess = buildModuleAccess(planDef.tier);

      await this.planModel.create({
        name: planDef.name,
        tier: planDef.tier,
        isActive: true,
        // Public-visibility + custom flags. Custom seeds NOT-public + custom;
        // the 4 self-serve plans seed public + non-custom. Defaults set
        // explicitly per plan in PLAN_DEFINITIONS for clarity (schema defaults
        // would otherwise leave isPubliclyVisible true / isCustom false).
        isPubliclyVisible: planDef.isPubliclyVisible,
        isCustom: planDef.isCustom,
        // Phase 2: Free seeds as the per-product default new sign-ups are
        // auto-assigned; every other plan seeds non-default. Existing DBs are
        // covered by SubscriptionsService.getDefaultPlanId's Free fallback.
        isDefault: planDef.tier === 'free',
        monthlyPrice: planDef.monthlyPrice,
        yearlyPrice: planDef.yearlyPrice,
        entitlements: {
          maxWorkspaces: tier.defaultEntitlements.maxWorkspaces,
          maxMembersPerWorkspace: tier.defaultEntitlements.maxMembersPerWorkspace,
          maxTotalMembers: tier.defaultEntitlements.maxTotalMembers,
          modules: [], // legacy field — not used; moduleAccess below is the source of truth
          features: {
            export: planDef.tier !== 'free',
            apiAccess: ['business', 'enterprise', 'custom'].includes(planDef.tier),
            advancedRbac: ['growth', 'business', 'enterprise', 'custom'].includes(planDef.tier),
            customRoles: planDef.tier !== 'free',
            // moduleAccess (above) is the REAL source of truth for module gating;
            // this legacy features.shifts flag is kept consistent with it. Free
            // now gets basic shifts, so shifts is true for ALL tiers — never let
            // this flag contradict moduleAccess (Phase-1 pricing rework).
            shifts: true,
            bills: false, // BILLS module deprecated (audit decision)
          },
          moduleAccess: moduleAccess.map((entry) => ({
            module: entry.module,
            enabled: entry.enabled,
            subFeatures: entry.subFeatures,
          })),
          ...planDef.entitlementsOverride,
        },
      });

      this.logger.log(
        `Plan '${planDef.name}' seeded — tier=${planDef.tier}, ₹${planDef.monthlyPrice}/mo.`,
      );
      inserted++;
    }

    return { inserted, skipped };
  }

  async runSeed(): Promise<{
    tiers: { inserted: number; skipped: number };
    plans: { inserted: number; skipped: number };
  }> {
    this.logger.log('Starting default Tiers + Plans seed...');
    const tiers = await this.seedTiers();
    this.logger.log(`Tier seed: ${tiers.inserted} inserted, ${tiers.skipped} skipped.`);

    const plans = await this.seedPlans();
    this.logger.log(`Plan seed: ${plans.inserted} inserted, ${plans.skipped} skipped.`);

    return { tiers, plans };
  }
}
