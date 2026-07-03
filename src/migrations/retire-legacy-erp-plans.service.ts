import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from '../modules/subscriptions/schemas/plan.schema';
import { Tier } from '../modules/subscriptions/schemas/tier.schema';
import { Subscription } from '../modules/subscriptions/schemas/subscription.schema';

/**
 * Phase-1 ERP pricing rework (2026-06-23) — retire legacy ERP plans.
 *
 * Background. The owner-confirmed canonical ERP plan set is EXACTLY 5:
 *   Free / Starter / Growth / Business (public, self-serve) + Custom (NOT public,
 *   contact-us only). Enterprise is RETIRED as a public/purchasable offering.
 *   (The 'enterprise' tier STRING stays in the PlanTier enum + buildModuleAccess
 *   so legacy subscriptions keep resolving full access — we only stop OFFERING it.)
 *
 * Existing databases carry drift the fresh `seed-default-tiers-and-plans.ts` no
 * longer creates:
 *   - the public Enterprise plan (tier='enterprise')
 *   - a Custom plan left publicly visible / not flagged
 *   - legacy hand-seed plans from the old `src/seed.ts` ("Free Forever",
 *     "Starter" @499, "Pro Starter", "Enterprise Unlimited") and any tier='pro'
 *     plan predating the pro->growth rename.
 *
 * This migration cleans them, ERP-only (`product != 'connect'`), data-SAFELY:
 *   1. Enterprise plan(s)      -> isActive:false + isPubliclyVisible:false
 *                                 (NEVER delete — subscriptions may reference it).
 *                                 Also deactivate the `enterprise` Tier doc.
 *   2. Custom plan(s)          -> isPubliclyVisible:false + isCustom:true.
 *   3. Legacy obsolete plans   (tier='pro' OR a legacy hand-seed NAME):
 *        - 0 subscriptions     -> delete.
 *        - >=1 subscription    -> do NOT delete; deactivate + hide + WARN with the
 *                                 planId + sub count so the owner re-points the
 *                                 live subs manually (re-pointing is risky — left
 *                                 to the owner).
 *
 * Idempotent — a second run over an already-clean set deletes nothing, throws
 * nothing (Enterprise/Custom updates are convergent; legacy candidates are
 * already gone or already deactivated).
 *
 * NOT auto-run on boot. Wired into the ledgered migration runner
 * (MigrationsModule) as a `once` unit; runs via `npm run migrate`.
 *
 * Keep-in-sync: `seed-default-tiers-and-plans.ts` (the surviving canonical set),
 * `src/seed.ts` (the legacy names listed here must match what it used to seed).
 */
@Injectable()
export class RetireLegacyErpPlansService {
  private readonly logger = new Logger(RetireLegacyErpPlansService.name);

  /**
   * Legacy ERP plan NAMES from the old `src/seed.ts` hand-seed block. These are
   * obsolete and not in the canonical set, so they are removed (or deactivated
   * if a subscription still points at one). Keep this list in sync with the
   * names that `src/seed.ts` historically inserted.
   */
  private readonly LEGACY_PLAN_NAMES = [
    'Free Forever',
    'Starter', // the old ₹499 Starter (distinct from the canonical 'Starter Monthly')
    'Pro Starter',
    'Enterprise Unlimited',
  ];

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Tier.name) private readonly tierModel: Model<Tier>,
  ) {}

  async run(): Promise<{
    enterpriseRetired: number;
    customFlagged: number;
    legacyDeleted: number;
    legacyDeactivatedWithSubs: number;
  }> {
    let enterpriseRetired = 0;
    let customFlagged = 0;
    let legacyDeleted = 0;
    let legacyDeactivatedWithSubs = 0;

    // ERP-only guard reused on every query — Connect plans are out of scope.
    // Matches how SubscriptionsService distinguishes ERP from Connect.
    const erpScope = { product: { $ne: 'connect' } } as const;

    // ── 1. Retire the public Enterprise plan(s) ──────────────────────────
    const enterprisePlans = await this.planModel.find({ ...erpScope, tier: 'enterprise' }).exec();
    for (const plan of enterprisePlans) {
      // Preserve the doc (existing subs may reference it) — just deactivate +
      // hide so it stops appearing on the public pricing page or as buyable.
      await this.planModel
        .updateOne({ _id: plan._id }, { $set: { isActive: false, isPubliclyVisible: false } })
        .exec();
      enterpriseRetired++;
      this.logger.log(
        `Enterprise plan '${plan.name}' (${String(plan._id)}) retired — isActive:false, isPubliclyVisible:false (preserved for any existing subscriptions).`,
      );
    }
    // Deactivate the enterprise Tier doc too, so tier listings drop it.
    if (this.tierModel) {
      await this.tierModel.updateOne({ key: 'enterprise' }, { $set: { isActive: false } }).exec();
    }

    // ── 2. Hide/flag the Custom plan(s) ──────────────────────────────────
    const customPlans = await this.planModel.find({ ...erpScope, tier: 'custom' }).exec();
    for (const plan of customPlans) {
      await this.planModel
        .updateOne({ _id: plan._id }, { $set: { isPubliclyVisible: false, isCustom: true } })
        .exec();
      customFlagged++;
    }
    if (customFlagged > 0) {
      this.logger.log(
        `Custom plan(s) flagged: ${customFlagged} set to isPubliclyVisible:false + isCustom:true.`,
      );
    }

    // ── 3. Remove / deactivate legacy obsolete plans ─────────────────────
    // Candidates: any tier='pro' plan, plus the legacy hand-seed names. We
    // gather both sets, de-dup by _id (a doc could match both), then per-plan
    // decide delete-vs-deactivate based on its live subscription count.
    const proPlans = await this.planModel.find({ ...erpScope, tier: 'pro' }).exec();
    const namedLegacyPlans = await this.planModel
      .find({ ...erpScope, name: { $in: this.LEGACY_PLAN_NAMES } })
      .exec();

    const legacyById = new Map<string, Plan>();
    for (const plan of [...proPlans, ...namedLegacyPlans]) {
      legacyById.set(String(plan._id), plan);
    }

    for (const plan of legacyById.values()) {
      const subCount = await this.subscriptionModel.countDocuments({ planId: plan._id }).exec();

      if (subCount === 0) {
        // No subscription references it — safe to delete outright.
        await this.planModel.deleteOne({ _id: plan._id }).exec();
        legacyDeleted++;
        this.logger.log(
          `Legacy plan '${plan.name}' (${String(plan._id)}, tier='${plan.tier}') deleted — 0 subscriptions.`,
        );
      } else {
        // Live subs depend on it. DO NOT delete — re-pointing subscriptions is
        // risky and left to the owner. Deactivate + hide + warn with the count.
        await this.planModel
          .updateOne({ _id: plan._id }, { $set: { isActive: false, isPubliclyVisible: false } })
          .exec();
        legacyDeactivatedWithSubs++;
        this.logger.warn(
          `Legacy plan '${plan.name}' (planId=${String(plan._id)}, tier='${plan.tier}') has ${subCount} subscription(s) — NOT deleted. Deactivated + hidden. Owner must migrate these subscriptions to a canonical plan manually.`,
        );
      }
    }

    this.logger.log(
      `Legacy ERP plan retirement complete: enterprise retired=${enterpriseRetired}, custom flagged=${customFlagged}, legacy deleted=${legacyDeleted}, legacy deactivated-with-subs=${legacyDeactivatedWithSubs}.`,
    );

    return {
      enterpriseRetired,
      customFlagged,
      legacyDeleted,
      legacyDeactivatedWithSubs,
    };
  }
}
