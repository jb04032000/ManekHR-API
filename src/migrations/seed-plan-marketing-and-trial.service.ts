import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from '../modules/subscriptions/schemas/plan.schema';
import { AppModule } from '../common/enums/modules.enum';
import { FeatureAccessLevel } from '../common/enums/feature-access.enum';
import {
  buildModuleAccess,
  MODULE_FEATURES_REGISTRY,
} from '../common/constants/module-features.registry';

/**
 * Migration 0060 — backfill localized marketing copy onto the 4 canonical ERP
 * plans (free/starter/growth/business) AND seed a 45-day full-access opt-in
 * TRIAL plan when none exists.
 *
 * WHAT it does:
 *   1. For each ERP plan matched by tier (product != 'connect'), $set
 *      marketing.{tagline, featureHighlights, isHighlighted, displayOrder} with
 *      copy in all 4 locales (en / gu / gu-en / hi-en). Growth is highlighted.
 *   2. If no `{ isTrialPlan:true, product:'erp' }` plan exists, create the
 *      "45-Day Free Trial" plan: full-access entitlements, isPubliclyVisible
 *      false, trialDurationDays 45. NOT auto-assigned — users opt in via
 *      startTrial() (SubscriptionsService.getTrialPlanId reads this row).
 *
 * CROSS-LINKS:
 *   - Marketing copy source-of-truth on the FE lives in web/app/messages/*.json
 *     under `...plans.<tier>.*`; the tone here mirrors those files. This migration
 *     writes the DB-side marketing subdoc (plan.schema.ts PlanMarketing) the
 *     admin/pricing surfaces read.
 *   - The trial plan feeds SubscriptionsService.getTrialPlanId / startTrial /
 *     buildTrialSubscriptionDoc (its `entitlements` become the trial-window
 *     access; its `trialDurationDays` the length).
 *   - Full-access moduleAccess mirrors + extends buildModuleAccess('business')
 *     so the omitted machines/locations/resource_scopes modules are unlocked too.
 *
 * IDEMPOTENCY:
 *   - Marketing backfill re-applies the canonical copy on every run (convergent).
 *     WARNING: re-running OVERWRITES any admin-edited marketing tagline /
 *     featureHighlights / isHighlighted / displayOrder with the canonical copy
 *     below. Bump the checksum in migrations.module.ts to force a re-apply after
 *     editing this copy.
 *   - Trial plan is created only when absent (skip + log otherwise), so re-runs
 *     never duplicate it.
 *
 * GOTCHA: this migration assumes the 4 ERP plans already exist (seeded by
 * 0028_erp_seed_tiers_and_plans). It logs a warning per missing plan telling the
 * owner to run the base seed first — it does NOT create ERP plans itself.
 */

/** Per-tier canonical marketing copy in all 4 locales. `en` is canonical. */
interface PlanMarketingCopy {
  tier: string;
  displayOrder: number;
  isHighlighted: boolean;
  tagline: { en: string; gu: string; 'gu-en': string; 'hi-en': string };
  featureHighlights: Array<{ en: string; gu: string; 'gu-en': string; 'hi-en': string }>;
}

// Copy authored to match the tone of the existing FE pricing copy in
// web/app/messages/{gu,gu-en,hi-en}.json (`...plans.<tier>.*`). Keep bullets
// short. NOTE: the gu / gu-en / hi-en strings should get a native-speaker review.
const PLAN_MARKETING_COPY: PlanMarketingCopy[] = [
  {
    tier: 'free',
    displayOrder: 0,
    isHighlighted: false,
    tagline: {
      en: 'Everything a small team needs to get organised, free forever.',
      gu: 'નાની ટીમને વ્યવસ્થિત થવા માટે જરૂરી બધું, કાયમ માટે મફત.',
      'gu-en': 'Nani team ne vyavasthit thava mate jaruri badhu, kayam mate free.',
      'hi-en': 'Choti team ko organised hone ke liye jaruri sab kuchh, hamesha ke liye free.',
    },
    featureHighlights: [
      {
        en: 'Staff records & profiles',
        gu: 'સ્ટાફ રેકોર્ડ અને પ્રોફાઇલ',
        'gu-en': 'Staff record ane profile',
        'hi-en': 'Staff record aur profile',
      },
      {
        en: 'Daily attendance & shift scheduling',
        gu: 'દૈનિક હાજરી અને શિફ્ટ સમયપત્રક',
        'gu-en': 'Dainik hajri ane shift samaypatrak',
        'hi-en': 'Daily hajri aur shift scheduling',
      },
      {
        en: 'Salary & payments tracking',
        gu: 'પગાર અને ચૂકવણી ટ્રેકિંગ',
        'gu-en': 'Pagar ane chukavni tracking',
        'hi-en': 'Salary aur payment tracking',
      },
      {
        en: 'Up to 5 team members',
        gu: '5 ટીમ સભ્યો સુધી',
        'gu-en': '5 team sabhyo sudhi',
        'hi-en': '5 team members tak',
      },
    ],
  },
  {
    tier: 'starter',
    displayOrder: 1,
    isHighlighted: false,
    tagline: {
      en: 'Payroll and payslips for a growing team.',
      gu: 'વધતી ટીમ માટે પગાર અને પે-સ્લિપ.',
      'gu-en': 'Vadhti team mate payroll ane pay-slip.',
      'hi-en': 'Badhti team ke liye payroll aur payslip.',
    },
    featureHighlights: [
      {
        en: 'Everything in Free',
        gu: 'મફતમાં બધું',
        'gu-en': 'Free ma badhu',
        'hi-en': 'Free ka sab kuchh',
      },
      {
        en: 'Payslips & payroll basics',
        gu: 'પે-સ્લિપ અને પગારની બેઝિક બાબતો',
        'gu-en': 'Pay-slip ane payroll ni basic babto',
        'hi-en': 'Payslip aur payroll basics',
      },
      {
        en: 'Leave & holiday management',
        gu: 'રજા વ્યવસ્થાપન અને રજાઓ',
        'gu-en': 'Leave management ane rajao',
        'hi-en': 'Leave management aur chhuttiyan',
      },
      {
        en: 'Up to 25 employees',
        gu: '25 કર્મચારી સુધી',
        'gu-en': '25 karmchari sudhi',
        'hi-en': '25 employees tak',
      },
    ],
  },
  {
    tier: 'growth',
    displayOrder: 2,
    isHighlighted: true, // "Most popular" card
    tagline: {
      en: 'Full payroll and workforce management for busy factories.',
      gu: 'વ્યસ્ત ફેક્ટરીઓ માટે સંપૂર્ણ પગાર અને કર્મચારી વ્યવસ્થાપન.',
      'gu-en': 'Vyast factory mate sampurna payroll ane workforce management.',
      'hi-en': 'Vyast factory ke liye poora payroll aur workforce management.',
    },
    featureHighlights: [
      {
        en: 'Everything in Starter',
        gu: 'સ્ટાર્ટરમાં બધું',
        'gu-en': 'Starter ma badhu',
        'hi-en': 'Starter ka sab kuchh',
      },
      {
        en: 'Full payroll: PF, ESI, PT & TDS',
        gu: 'સંપૂર્ણ પગાર: PF, ESI, PT અને TDS',
        'gu-en': 'Sampurna payroll: PF, ESI, PT ane TDS',
        'hi-en': 'Poora payroll: PF, ESI, PT aur TDS',
      },
      {
        en: 'Advanced roles & 2 workspaces',
        gu: 'એડવાન્સ્ડ રોલ અને 2 વર્કસ્પેસ',
        'gu-en': 'Advanced role ane 2 workspace',
        'hi-en': 'Advanced role aur 2 workspace',
      },
      {
        en: 'Up to 100 employees',
        gu: '100 કર્મચારી સુધી',
        'gu-en': '100 karmchari sudhi',
        'hi-en': '100 employees tak',
      },
    ],
  },
  {
    tier: 'business',
    displayOrder: 3,
    isHighlighted: false,
    tagline: {
      en: 'Multi-unit operations and manufacturing, fully covered.',
      gu: 'બહુ-એકમ કામગીરી અને ઉત્પાદન, બધું આવરી લેવાયું.',
      'gu-en': 'Bahu-sthan kamgiri ane utpadan, badhu cover thai jay.',
      'hi-en': 'Multi-location operations aur manufacturing, sab cover.',
    },
    featureHighlights: [
      {
        en: 'Everything in Growth',
        gu: 'ગ્રોથમાં બધું',
        'gu-en': 'Growth ma badhu',
        'hi-en': 'Growth ka sab kuchh',
      },
      {
        en: 'Multi-state & up to 5 workspaces',
        gu: 'બહુ-રાજ્ય અને 5 વર્કસ્પેસ સુધી',
        'gu-en': 'Bahu-rajya ane 5 workspace sudhi',
        'hi-en': 'Multi-state aur 5 workspace tak',
      },
      {
        en: 'Machines & production tracking',
        gu: 'મશીનો અને ઉત્પાદન ટ્રેકિંગ',
        'gu-en': 'Machine o ane utpadan tracking',
        'hi-en': 'Machine aur production tracking',
      },
      {
        en: 'Form-16, Full & Final & Gratuity',
        gu: 'Form-16, ફુલ એન્ડ ફાઇનલ અને ગ્રેચ્યુટી',
        'gu-en': 'Form-16, Full & Final ane Gratuity',
        'hi-en': 'Form-16, Full & Final aur Gratuity',
      },
      {
        en: 'API access',
        gu: 'API ઍક્સેસ',
        'gu-en': 'API access',
        'hi-en': 'API access',
      },
      {
        en: 'Up to 500 employees',
        gu: '500 કર્મચારી સુધી',
        'gu-en': '500 karmchari sudhi',
        'hi-en': '500 employees tak',
      },
    ],
  },
];

/** Localized tagline for the 45-day opt-in trial plan (all 4 locales). */
const TRIAL_TAGLINE = {
  en: 'Explore the entire platform free for 45 days, no card needed.',
  gu: 'આખું પ્લેટફોર્મ 45 દિવસ મફતમાં અજમાવો, કાર્ડની જરૂર નથી.',
  'gu-en': 'Aakhu platform 45 divas free ma ajmavo, card ni jarur nathi.',
  'hi-en': 'Poora platform 45 din free me try karo, card ki zarurat nahi.',
};

@Injectable()
export class SeedPlanMarketingAndTrialService {
  private readonly logger = new Logger(SeedPlanMarketingAndTrialService.name);

  constructor(@InjectModel(Plan.name) private readonly planModel: Model<Plan>) {}

  /**
   * Build a FULL-access moduleAccess array: buildModuleAccess('business') PLUS
   * the modules that template omits (MACHINES / LOCATIONS / RESOURCE_SCOPES),
   * each enabled with EVERY sub-feature (from the registry) at FULL. Guarantees
   * the trial truly unlocks everything, including machines_production /
   * machines_maintenance / machines_downtime / piece_rate_payroll.
   */
  private buildFullAccessModuleAccess(): Array<{
    module: AppModule;
    enabled: boolean;
    subFeatures: Array<{ key: string; access: FeatureAccessLevel }>;
  }> {
    const base = buildModuleAccess('business');
    const covered = new Set(base.map((m) => m.module));

    // The 3 modules buildModuleAccess intentionally omits — add them enabled,
    // all sub-features FULL, so the trial has zero locked corners.
    const extraModules = [AppModule.MACHINES, AppModule.LOCATIONS, AppModule.RESOURCE_SCOPES];
    const extras = extraModules
      .filter((mod) => !covered.has(mod))
      .map((mod) => {
        const def = MODULE_FEATURES_REGISTRY.find((m) => m.module === mod);
        const subFeatures = (def?.subFeatures ?? []).map((sf) => ({
          key: sf.key,
          access: FeatureAccessLevel.FULL,
        }));
        return { module: mod, enabled: true, subFeatures };
      });

    return [...base, ...extras];
  }

  /**
   * Backfill localized marketing copy onto each canonical ERP plan by tier.
   * Convergent: re-applies the canonical copy (overwrites admin edits). Missing
   * plans are warned + skipped (owner must run the base tiers+plans seed first).
   */
  async backfillMarketing(): Promise<{ updated: number; missing: number }> {
    let updated = 0;
    let missing = 0;

    for (const copy of PLAN_MARKETING_COPY) {
      // Match the canonical ERP plan by TIER (non-connect), mirroring the base
      // seed's probe so a renamed plan is still found.
      const plan = await this.planModel
        .findOne({ tier: copy.tier, product: { $ne: 'connect' } })
        .exec();
      if (!plan) {
        this.logger.warn(
          `ERP plan for tier '${copy.tier}' not found — run the base tiers+plans seed (0028) first. Skipping marketing backfill for this tier.`,
        );
        missing++;
        continue;
      }

      await this.planModel
        .updateOne(
          { _id: plan._id },
          {
            $set: {
              'marketing.tagline': copy.tagline,
              'marketing.featureHighlights': copy.featureHighlights,
              'marketing.isHighlighted': copy.isHighlighted,
              'marketing.displayOrder': copy.displayOrder,
            },
          },
        )
        .exec();

      this.logger.log(
        `Marketing copy applied to '${plan.name}' (tier=${copy.tier}, displayOrder=${copy.displayOrder}, highlighted=${copy.isHighlighted}).`,
      );
      updated++;
    }

    return { updated, missing };
  }

  /**
   * Seed the 45-day full-access opt-in trial plan when none exists. Skips + logs
   * when an ERP trial plan is already present (idempotent — never duplicates).
   */
  async seedTrialPlan(): Promise<{ created: number; skipped: number }> {
    const existing = await this.planModel.findOne({ isTrialPlan: true, product: 'erp' }).exec();
    if (existing) {
      this.logger.log(
        `ERP trial plan already exists ('${existing.name}') — skipping trial-plan seed.`,
      );
      return { created: 0, skipped: 1 };
    }

    const moduleAccess = this.buildFullAccessModuleAccess();

    // Opt-in TRIAL plan (NOT auto-assigned to new signups). Users start it via
    // startTrial(); getTrialPlanId() resolves this row. isPubliclyVisible false
    // + isDefault false so it never shows on the public pricing page and is
    // never the default plan. entitlements = full access (unlimited members +
    // every module/sub-feature at FULL) so the 45-day window unlocks everything.
    await this.planModel.create({
      name: '45-Day Free Trial',
      tier: 'business', // highest tier; caps below are unlimited anyway
      product: 'erp',
      isActive: true,
      isPubliclyVisible: false,
      isCustom: false,
      isDefault: false,
      isTrialPlan: true,
      trialDurationDays: 45,
      monthlyPrice: 0,
      yearlyPrice: 0,
      entitlements: {
        // Unlimited capacity for the trial window.
        maxWorkspaces: -1,
        maxMembersPerWorkspace: -1,
        maxTotalMembers: -1,
        modules: [], // legacy field — moduleAccess is the source of truth
        features: {
          export: true,
          apiAccess: true,
          advancedRbac: true,
          customRoles: true,
          shifts: true,
          bills: false, // BILLS module deprecated
        },
        moduleAccess,
        maxSessionsPerPlatform: -1,
        maxSessionsTotal: -1,
        emailsPerMonth: -1,
        storage: { totalGbPerWorkspace: -1, perFileMaxMb: 100 },
      },
      marketing: {
        tagline: TRIAL_TAGLINE,
      },
    });

    this.logger.log(
      `Trial plan '45-Day Free Trial' created (isTrialPlan, trialDurationDays=45, full access, not public).`,
    );
    return { created: 1, skipped: 0 };
  }

  /** Runner entrypoint — backfill marketing then seed the trial plan. */
  async run(): Promise<{
    marketing: { updated: number; missing: number };
    trial: { created: number; skipped: number };
  }> {
    this.logger.log('Starting plan-marketing backfill + trial-plan seed...');
    const marketing = await this.backfillMarketing();
    this.logger.log(
      `Marketing backfill: ${marketing.updated} updated, ${marketing.missing} missing.`,
    );

    const trial = await this.seedTrialPlan();
    this.logger.log(`Trial-plan seed: ${trial.created} created, ${trial.skipped} skipped.`);

    return { marketing, trial };
  }
}
