import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from '../modules/subscriptions/schemas/plan.schema';
import { Tier } from '../modules/subscriptions/schemas/tier.schema';

/**
 * Wave 5 — rename legacy `pro` tier to `growth`.
 *
 * Background. Pre-Wave-1 the canonical 4-tier ladder was
 *   free / starter / pro / enterprise.
 * Wave 1 (audit drift #1) re-locked the product on the 6-tier ladder
 *   free / starter / growth / business / enterprise / custom
 * and dropped `pro` from the canonical PlanTier enum. Tier defaults in
 * `module-features.registry.ts` keep `pro` as a Growth-equivalent alias
 * so legacy lookups don't fall back to Free, but data still carries the
 * old key on Plan documents seeded before Wave 1 — and the legacy
 * `SubscriptionsService.seedDefaultTiers()` still inserts a Tier{key:'pro'}
 * row when bootstrapping a fresh DB without the new seed migration.
 *
 * This migration cleans both:
 *   • Every Plan with tier='pro' → tier='growth'
 *   • The Tier{key:'pro'} doc, if any: rename to 'growth' when no Growth
 *     tier exists, else delete the duplicate
 *
 * Subscriptions do not store tier directly — they hold `planId` and read
 * tier through the populated plan, so plan-level rename is sufficient.
 *
 * Idempotent — second run finds zero candidates and exits.
 */
@Injectable()
export class MigrateProToGrowthService {
  private readonly logger = new Logger(MigrateProToGrowthService.name);

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Tier.name) private readonly tierModel: Model<Tier>,
  ) {}

  async run(): Promise<{
    plansRenamed: number;
    tierRenamed: boolean;
    tierDeleted: boolean;
  }> {
    const planResult = await this.planModel.updateMany(
      { tier: 'pro' },
      { $set: { tier: 'growth' } },
    );
    const plansRenamed = planResult.modifiedCount;

    let tierRenamed = false;
    let tierDeleted = false;

    const proTier = await this.tierModel.findOne({ key: 'pro' }).exec();
    if (proTier) {
      const growthTier = await this.tierModel.findOne({ key: 'growth' }).exec();
      if (growthTier) {
        // Growth already exists — drop the redundant pro row.
        await this.tierModel.deleteOne({ _id: proTier._id }).exec();
        tierDeleted = true;
      } else {
        // Rename in place (preserves _id refs from any external system).
        await this.tierModel.updateOne(
          { _id: proTier._id },
          { $set: { key: 'growth', name: 'Growth' } },
        );
        tierRenamed = true;
      }
    }

    if (plansRenamed > 0 || tierRenamed || tierDeleted) {
      this.logger.log(
        `pro→growth migration: plans renamed=${plansRenamed}, tier renamed=${tierRenamed}, tier deleted=${tierDeleted}.`,
      );
    }

    return { plansRenamed, tierRenamed, tierDeleted };
  }
}
