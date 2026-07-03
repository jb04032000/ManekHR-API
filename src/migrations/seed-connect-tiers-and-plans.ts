import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tier } from '../modules/subscriptions/schemas/tier.schema';
import { Plan } from '../modules/subscriptions/schemas/plan.schema';
import { AppModule } from '../common/enums/modules.enum';
import { FeatureAccessLevel } from '../common/enums/feature-access.enum';
import { PlatformAccess } from '../common/enums/platform-access.enum';

/**
 * Seed Connect (network / marketplace) Tiers + Plans - Phase M0.4.
 *
 * Connect plans are PERSON-CENTRIC (workspaceId: null, resolved by userId) and
 * carry `product: 'connect'`. They run on the same billing engine as ERP but
 * are normalized via the Connect-aware branch (M0.3), so their CONNECT module
 * access + `connect` allowance sub-block are never rebuilt from the ERP module
 * registry.
 *
 * Launch posture (foundation doc 4d): ship MOSTLY FREE. `connect_free` has
 * generous allowances and is the default; `connect_premium` exists but stays
 * dormant (no one is forced onto it). All numbers are admin-retunable later via
 * the plan/tier builder (M0.7), so monetizing = lowering the free numbers,
 * never a code change.
 *
 * Idempotent. Re-runnable. Looks up by tier.key / plan {name, product} and
 * SKIPS when a row already exists, so admin edits to seeded docs are preserved.
 * Mirrors SeedDefaultTiersAndPlansService (the ERP seeder) deliberately.
 */
@Injectable()
export class SeedConnectTiersAndPlansService {
  private readonly logger = new Logger(SeedConnectTiersAndPlansService.name);

  constructor(
    @InjectModel(Tier.name) private tierModel: Model<Tier>,
    @InjectModel(Plan.name) private planModel: Model<Plan>,
  ) {}

  /**
   * Connect module access for a tier. The numeric allowances on the `connect`
   * sub-block govern caps; these access levels gate feature visibility.
   * Shared by Tier.defaultModuleAccess and Plan.entitlements.moduleAccess
   * (structurally identical).
   */
  private connectModuleAccess(premium: boolean) {
    return [
      {
        module: AppModule.CONNECT,
        enabled: true,
        subFeatures: [
          { key: 'marketplace.listings', access: FeatureAccessLevel.FULL },
          { key: 'marketplace.leads', access: FeatureAccessLevel.FULL },
          {
            key: 'profile.verified_badge',
            access: premium ? FeatureAccessLevel.FULL : FeatureAccessLevel.LOCKED,
          },
          {
            key: 'search.priority',
            access: premium ? FeatureAccessLevel.FULL : FeatureAccessLevel.LIMITED,
          },
        ],
      },
    ];
  }

  // -- TIER DEFINITIONS ----------------------------------------------
  private readonly TIER_DEFINITIONS = [
    {
      key: 'connect_free',
      name: 'Connect Free',
      displayOrder: 0,
      color: 'default',
      description:
        'Get discovered on zari360 Connect. Generous free listings and buyer leads for every karigar and workshop.',
      premium: false,
    },
    {
      key: 'connect_premium',
      name: 'Connect Premium',
      displayOrder: 1,
      color: 'gold',
      description:
        'Unlimited listings, a verified marker, top search placement, and monthly boost credits.',
      premium: true,
    },
  ];

  // -- PLAN DEFINITIONS ----------------------------------------------
  // One default plan per Connect tier. Person-centric (no workspace dims).
  // The `connect` block holds the launch allowances (admin-retunable, M0.7).
  private readonly PLAN_DEFINITIONS = [
    {
      name: 'Connect Free',
      tierKey: 'connect_free',
      monthlyPrice: 0,
      yearlyPrice: 0,
      premium: false,
      connect: {
        maxListings: 25,
        leadsPerMonth: -1,
        includedBoostCredits: 0,
        verifiedBadge: false,
        searchPriority: 0,
        // Count caps a new/free Connect user starts with (admin-retunable on the
        // Plans page; this plan IS the live default via the getAllowances
        // fallback). 1 company page, 1 storefront, 10 open jobs.
        maxCompanyPages: 1,
        maxStorefronts: 1,
        maxJobs: 10,
        // Over-limit (grandfathering) policy. freeze = existing items stay live,
        // creation stays blocked (today's behavior). NEVER ship hide_newest by
        // default — that is an explicit per-plan admin choice.
        overLimitPolicy: 'freeze',
        overLimitGraceDays: 30,
      },
    },
    {
      name: 'Connect Premium',
      tierKey: 'connect_premium',
      monthlyPrice: 499, // illustrative; dormant at launch, admin-retunable (M0.7)
      yearlyPrice: 4999, // ~17% off
      premium: true,
      connect: {
        maxListings: -1,
        leadsPerMonth: -1,
        includedBoostCredits: 500,
        verifiedBadge: true,
        searchPriority: 10,
        // Premium is unlimited across the board.
        maxCompanyPages: -1,
        maxStorefronts: -1,
        maxJobs: -1,
        // Premium is unlimited, so over-limit never triggers; freeze by default.
        overLimitPolicy: 'freeze',
        overLimitGraceDays: 30,
      },
    },
  ];

  // -- SEED METHODS --------------------------------------------------

  async seedTiers(): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;

    for (const tierDef of this.TIER_DEFINITIONS) {
      const existing = await this.tierModel.findOne({ key: tierDef.key }).exec();
      if (existing) {
        this.logger.log(`Connect tier '${tierDef.key}' already exists, skipping.`);
        skipped++;
        continue;
      }

      await this.tierModel.create({
        key: tierDef.key,
        name: tierDef.name,
        displayOrder: tierDef.displayOrder,
        color: tierDef.color,
        description: tierDef.description,
        isActive: true,
        product: 'connect',
        // Connect is person-centric, so workspace dimensions do not apply.
        defaultEntitlements: {
          maxWorkspaces: 0,
          maxMembersPerWorkspace: 0,
          maxTotalMembers: 0,
        },
        defaultModuleAccess: this.connectModuleAccess(tierDef.premium),
      });

      this.logger.log(`Connect tier '${tierDef.key}' (${tierDef.name}) seeded.`);
      inserted++;
    }

    return { inserted, skipped };
  }

  async seedPlans(): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;

    for (const planDef of this.PLAN_DEFINITIONS) {
      const existing = await this.planModel
        .findOne({ name: planDef.name, product: 'connect' })
        .exec();
      if (existing) {
        this.logger.log(`Connect plan '${planDef.name}' already exists, skipping.`);
        skipped++;
        continue;
      }

      const tier = await this.tierModel.findOne({ key: planDef.tierKey }).exec();
      if (!tier) {
        this.logger.warn(
          `Connect tier '${planDef.tierKey}' not found, skipping plan '${planDef.name}'. Run seedTiers() first.`,
        );
        skipped++;
        continue;
      }

      await this.planModel.create({
        name: planDef.name,
        tier: planDef.tierKey,
        product: 'connect',
        isActive: true,
        monthlyPrice: planDef.monthlyPrice,
        yearlyPrice: planDef.yearlyPrice,
        entitlements: {
          // Person-centric, so no workspace member dimensions.
          maxWorkspaces: 0,
          maxMembersPerWorkspace: 0,
          maxTotalMembers: 0,
          modules: [AppModule.CONNECT],
          moduleAccess: this.connectModuleAccess(planDef.premium),
          platformAccess: PlatformAccess.BOTH,
          connect: planDef.connect,
        },
      });

      this.logger.log(
        `Connect plan '${planDef.name}' seeded (tier=${planDef.tierKey}, INR ${planDef.monthlyPrice}/mo).`,
      );
      inserted++;
    }

    return { inserted, skipped };
  }

  async runSeed(): Promise<{
    tiers: { inserted: number; skipped: number };
    plans: { inserted: number; skipped: number };
  }> {
    this.logger.log('Starting Connect Tiers + Plans seed...');
    const tiers = await this.seedTiers();
    this.logger.log(`Connect tier seed: ${tiers.inserted} inserted, ${tiers.skipped} skipped.`);

    const plans = await this.seedPlans();
    this.logger.log(`Connect plan seed: ${plans.inserted} inserted, ${plans.skipped} skipped.`);

    return { tiers, plans };
  }
}
