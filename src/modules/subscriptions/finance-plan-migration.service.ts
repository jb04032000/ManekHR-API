import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from './schemas/plan.schema';
import { Subscription } from './schemas/subscription.schema';
import { AppModule } from '../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../common/enums/feature-access.enum';

/**
 * Adds the Finance/FinanceAdmin/FinanceAccountant module entries to every
 * existing Plan and every active Subscription so that the new
 * @RequireSubscription decorators on finance-aware routes do not lock
 * out existing tenants on deploy.
 *
 * Idempotent — runs on every boot but only patches documents that are
 * missing one of the new module entries.
 *
 * Why both Plan and Subscription? SubscriptionGuard prefers
 * `subscription.appliedEntitlements` (snapshot captured at subscribe
 * time) over the live plan's entitlements. Patching only the Plan
 * would leave tenants whose subscriptions predate the new modules
 * permanently locked until they re-subscribe.
 *
 * New entries are inserted with { enabled: true, subFeatures: [] } so
 * that the SubscriptionGuard fallback (empty subFeatures -> FULL)
 * preserves existing behaviour until an admin explicitly locks a
 * sub-feature per plan tier or per user override.
 */
@Injectable()
export class FinancePlanMigrationService {
  private readonly logger = new Logger(FinancePlanMigrationService.name);

  private readonly NEW_MODULES: AppModule[] = [
    AppModule.FINANCE,
    AppModule.FINANCE_ADMIN,
    AppModule.FINANCE_ACCOUNTANT,
    // Wave 4: REMINDERS gets a bare module entry (empty subFeatures => FULL
    // fallback in SubscriptionGuard) for any existing tenant, so the new
    // @RequireSubscription({ REMINDERS, ... }) decorators on reminder
    // controllers don't 403 existing customers.
    AppModule.REMINDERS,
  ];

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
  ) {}

  // Run by the ledgered migration runner (ADR-0001 Slice 5) — was an onModuleInit
  // hook that ran on EVERY boot. Body unchanged. Do NOT re-add a boot hook on merge.
  async run(): Promise<void> {
    try {
      const plansPatched = await this.patchPlans();
      const { applied, override } = await this.patchSubscriptions();
      if (plansPatched > 0 || applied > 0 || override > 0) {
        this.logger.log(
          `Finance migration: patched ${plansPatched} plan(s), ${applied} subscription appliedEntitlements, ${override} subscription adminEntitlementOverride.`,
        );
      }
    } catch (err) {
      // Never crash the app boot on a migration hiccup. Surface a warning.
      this.logger.warn(`FinancePlanMigrationService failed: ${(err as Error).message}`);
    }

    // Wave 7 — bare legacy patches (`patchJobWorkSubFeature` /
    // `patchFinanceAdvancedSubFeature`) skipped at boot. Wave 6 re-keyed all
    // controllers off these keys; new tenants do not need them seeded. Method
    // bodies retained in this file as a historical record of the migration
    // shape — safe to drop in a future cleanup pass.

    // F-16 (Phase 17) D-33: Seed five party_intelligence_* sub-features into
    // existing FINANCE module entitlements. All five gate Wave-1 controllers
    // via @RequireSubscription({ FINANCE, 'party_intelligence_*' }) — no new
    // SKU. Same idempotent $addToSet pattern as F-15.
    try {
      const { plans, subs } = await this.patchPartyIntelligenceSubFeatures();
      if (plans > 0 || subs > 0) {
        this.logger.log(
          `Finance migration (party_intelligence_*): seeded five sub-features into ${plans} plan(s) and ${subs} subscription(s).`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `FinancePlanMigrationService party_intelligence sub-features patch failed: ${(err as Error).message}`,
      );
    }

    // Wave 4: Seed canonical FINANCE sub-feature taxonomy (sales_*, purchases_*,
    // banking_*, accounting_*, fixed_assets_*, payments_*, reports_financial,
    // parties_master, party_portal_access) into existing FINANCE module
    // entitlements with FULL access. Existing tenants grandfather to FULL on
    // every new key — tier locking only applies to fresh subscriptions via
    // buildModuleAccess. Same idempotent $addToSet pattern as the other patches.
    try {
      const { plans, subs } = await this.patchFinanceWave4SubFeatures();
      if (plans > 0 || subs > 0) {
        this.logger.log(
          `Finance migration (wave4 finance keys): seeded ${FinancePlanMigrationService.WAVE4_FINANCE_KEYS.length} sub-features into ${plans} plan-rows and ${subs} subscription-rows.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `FinancePlanMigrationService wave4 finance sub-features patch failed: ${(err as Error).message}`,
      );
    }

    // Wave 4: Seed canonical REMINDERS sub-feature taxonomy (channel_*,
    // rules_*, settings, templates, call_todo_*, audit_log, dispatcher,
    // auto_escalation) into existing REMINDERS module entitlements with FULL
    // access. Same pattern.
    try {
      const { plans, subs } = await this.patchRemindersWave4SubFeatures();
      if (plans > 0 || subs > 0) {
        this.logger.log(
          `Finance migration (wave4 reminder keys): seeded ${FinancePlanMigrationService.WAVE4_REMINDER_KEYS.length} sub-features into ${plans} plan-rows and ${subs} subscription-rows.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `FinancePlanMigrationService wave4 reminder sub-features patch failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Wave 4: Canonical FINANCE sub-feature keys gating the 32 newly-decorated
   * finance controllers (sales/purchases/banking/accounting/fixed-assets/
   * reports/payments). Mirrors the FINANCE keys defined in
   * `_WAVE4_FINANCE_REMINDERS_TIER_DEFAULTS` of module-features.registry.ts.
   *
   * Why FULL for everyone: existing tenants must NOT lose access on deploy.
   * Tier-policy locks only apply to fresh subscriptions created via
   * buildModuleAccess. Admins re-tighten per-plan via the plan-editor UI.
   */
  static readonly WAVE4_FINANCE_KEYS = [
    'sales_invoicing',
    'sales_orders',
    'sales_quotations',
    'sales_proforma',
    'sales_delivery_challans',
    'sales_recurring_billing',
    'sales_credit_debit_notes',
    'purchases_invoicing',
    'purchases_orders',
    'purchases_grn',
    'purchases_grn_returns',
    'purchases_expenses',
    'purchases_ocr',
    'purchases_payment_outward',
    'purchases_capital_goods_itc',
    'purchases_payables',
    'payments_payment_in',
    'payments_party_ledger',
    'banking_bank_accounts',
    'banking_cheques',
    'banking_loan_accounts',
    'accounting_journal_entries',
    'accounting_contra_entries',
    'accounting_coa',
    'accounting_fiscal_years',
    'accounting_voucher_series',
    'accounting_items_master',
    'accounting_setup_checklist',
    'accounting_recycle_bin',
    'accounting_tally_export',
    'accounting_cash_registers',
    'fixed_assets_categories',
    'fixed_assets_register',
    'fixed_assets_depreciation',
    'fixed_assets_disposal',
    'fixed_assets_linking',
    'fixed_assets_reports',
    'reports_financial',
    'parties_master',
    'party_portal_access',
  ] as const;

  static readonly WAVE4_REMINDER_KEYS = [
    'reminder_rules_view',
    'reminder_rules_manage',
    'reminder_settings_manage',
    'reminder_templates_customize',
    'reminder_channel_in_app',
    'reminder_channel_email',
    'reminder_channel_sms',
    'reminder_channel_whatsapp',
    'reminder_channel_push',
    'reminder_call_todo_view',
    'reminder_call_todo_manage',
    'reminder_auto_escalation',
    'reminder_audit_log',
    'reminder_dispatcher_run',
  ] as const;

  private async patchFinanceWave4SubFeatures(): Promise<{
    plans: number;
    subs: number;
  }> {
    const entries = FinancePlanMigrationService.WAVE4_FINANCE_KEYS.map((key) => ({
      key,
      access: FeatureAccessLevel.FULL,
    }));

    let totalPlans = 0;
    let totalSubs = 0;

    for (const entry of entries) {
      const planResult = await this.planModel.updateMany(
        { 'entitlements.moduleAccess.module': AppModule.FINANCE },
        {
          $addToSet: {
            'entitlements.moduleAccess.$[elem].subFeatures': entry,
          },
        },
        {
          arrayFilters: [{ 'elem.module': AppModule.FINANCE }],
        },
      );

      const subResult = await this.subscriptionModel.updateMany(
        { 'appliedEntitlements.moduleAccess.module': AppModule.FINANCE },
        {
          $addToSet: {
            'appliedEntitlements.moduleAccess.$[elem].subFeatures': entry,
          },
        },
        {
          arrayFilters: [{ 'elem.module': AppModule.FINANCE }],
        },
      );

      totalPlans += planResult.modifiedCount;
      totalSubs += subResult.modifiedCount;
    }

    return { plans: totalPlans, subs: totalSubs };
  }

  private async patchRemindersWave4SubFeatures(): Promise<{
    plans: number;
    subs: number;
  }> {
    const entries = FinancePlanMigrationService.WAVE4_REMINDER_KEYS.map((key) => ({
      key,
      access: FeatureAccessLevel.FULL,
    }));

    let totalPlans = 0;
    let totalSubs = 0;

    for (const entry of entries) {
      const planResult = await this.planModel.updateMany(
        { 'entitlements.moduleAccess.module': AppModule.REMINDERS },
        {
          $addToSet: {
            'entitlements.moduleAccess.$[elem].subFeatures': entry,
          },
        },
        {
          arrayFilters: [{ 'elem.module': AppModule.REMINDERS }],
        },
      );

      const subResult = await this.subscriptionModel.updateMany(
        { 'appliedEntitlements.moduleAccess.module': AppModule.REMINDERS },
        {
          $addToSet: {
            'appliedEntitlements.moduleAccess.$[elem].subFeatures': entry,
          },
        },
        {
          arrayFilters: [{ 'elem.module': AppModule.REMINDERS }],
        },
      );

      totalPlans += planResult.modifiedCount;
      totalSubs += subResult.modifiedCount;
    }

    return { plans: totalPlans, subs: totalSubs };
  }

  /**
   * Phase 17 / F-16 D-33: Seed five party_intelligence_* sub-features
   * (access: full) into the FINANCE module entry of every existing Plan and
   * Subscription that already has FINANCE access.
   *
   * Keys registered (D-33):
   *   - party_intelligence_rfm
   *   - party_intelligence_gstin_monitor
   *   - party_intelligence_timeline
   *   - party_intelligence_pnl
   *   - party_intelligence_greetings
   *
   * Same idempotent pattern as patchFinanceAdvancedSubFeature — $addToSet with
   * full { key, access } object compares by object equality so duplicate
   * inserts are no-ops.
   */
  static readonly PARTY_INTELLIGENCE_KEYS = [
    'party_intelligence_rfm',
    'party_intelligence_gstin_monitor',
    'party_intelligence_timeline',
    'party_intelligence_pnl',
    'party_intelligence_greetings',
  ] as const;

  private async patchPartyIntelligenceSubFeatures(): Promise<{
    plans: number;
    subs: number;
  }> {
    const entries = FinancePlanMigrationService.PARTY_INTELLIGENCE_KEYS.map((key) => ({
      key,
      access: FeatureAccessLevel.FULL,
    }));

    let totalPlans = 0;
    let totalSubs = 0;

    for (const entry of entries) {
      const planResult = await this.planModel.updateMany(
        { 'entitlements.moduleAccess.module': AppModule.FINANCE },
        {
          $addToSet: {
            'entitlements.moduleAccess.$[elem].subFeatures': entry,
          },
        },
        {
          arrayFilters: [{ 'elem.module': AppModule.FINANCE }],
        },
      );

      const subResult = await this.subscriptionModel.updateMany(
        { 'appliedEntitlements.moduleAccess.module': AppModule.FINANCE },
        {
          $addToSet: {
            'appliedEntitlements.moduleAccess.$[elem].subFeatures': entry,
          },
        },
        {
          arrayFilters: [{ 'elem.module': AppModule.FINANCE }],
        },
      );

      totalPlans += planResult.modifiedCount;
      totalSubs += subResult.modifiedCount;
    }

    return { plans: totalPlans, subs: totalSubs };
  }

  /** Adds missing module entries directly to Plan docs. Returns count patched. */
  private async patchPlans(): Promise<number> {
    const plans = await this.planModel.find({}).exec();
    let patched = 0;

    for (const plan of plans) {
      const moduleAccess = plan.entitlements?.moduleAccess ?? [];
      const missing = this.missingModules(moduleAccess);
      if (missing.length === 0) continue;

      await this.planModel
        .updateOne(
          { _id: plan._id },
          {
            $push: {
              'entitlements.moduleAccess': {
                $each: this.buildAdditions(missing),
              },
            },
          },
        )
        .exec();
      patched += 1;
    }

    return patched;
  }

  /**
   * Patches Subscription.appliedEntitlements and adminEntitlementOverride
   * for any active/trial/cancelled subscription whose moduleAccess snapshot
   * is missing one of the new module entries. Returns counts per field.
   */
  private async patchSubscriptions(): Promise<{
    applied: number;
    override: number;
  }> {
    const subs = await this.subscriptionModel
      .find({ status: { $in: ['active', 'trial', 'cancelled', 'scheduled'] } })
      .exec();

    let applied = 0;
    let override = 0;

    for (const sub of subs) {
      const appliedMissing = this.missingModules(
        (sub as any).appliedEntitlements?.moduleAccess ?? [],
      );
      const overrideMissing = this.missingModules(
        (sub as any).adminEntitlementOverride?.moduleAccess ?? [],
      );

      if (appliedMissing.length === 0 && overrideMissing.length === 0) continue;

      const update: Record<string, unknown> = {};

      if (appliedMissing.length > 0 && (sub as any).appliedEntitlements) {
        update['appliedEntitlements.moduleAccess'] = {
          $each: this.buildAdditions(appliedMissing),
        };
      }
      if (overrideMissing.length > 0 && (sub as any).adminEntitlementOverride) {
        update['adminEntitlementOverride.moduleAccess'] = {
          $each: this.buildAdditions(overrideMissing),
        };
      }

      if (Object.keys(update).length === 0) continue;

      const pushOps: Record<string, unknown> = {};
      for (const [path, value] of Object.entries(update)) {
        pushOps[path] = value;
      }

      await this.subscriptionModel.updateOne({ _id: sub._id }, { $push: pushOps }).exec();

      if (appliedMissing.length > 0 && (sub as any).appliedEntitlements) applied += 1;
      if (overrideMissing.length > 0 && (sub as any).adminEntitlementOverride) override += 1;
    }

    return { applied, override };
  }

  private missingModules(moduleAccess: any[]): AppModule[] {
    const present = new Set(moduleAccess.map((m: any) => m.module as AppModule));
    return this.NEW_MODULES.filter((m) => !present.has(m));
  }

  private buildAdditions(missing: AppModule[]) {
    return missing.map((module) => ({
      module,
      enabled: true,
      subFeatures: [],
    }));
  }

  /**
   * F-11 D-15: Seed 'job_work' sub-feature (access: full) into the FINANCE module
   * entry of every existing Plan and Subscription that already has FINANCE access.
   *
   * Uses arrayFilters + $addToSet with the full { key, access } object to be
   * idempotent — MongoDB $addToSet compares by object equality so duplicate
   * inserts are no-ops (T-F11-W2-05).
   *
   * CORRECT pattern: arrayFilters with $[elem] placeholder — do NOT use bare
   * $ positional operator which is unreliable in updateMany with $elemMatch filters.
   *
   * After this runs, SubscriptionGuard will allow
   * @RequireSubscription({ module: FINANCE, subFeature: 'job_work' })
   * for any plan/subscription that already has FINANCE access enabled.
   */
  private async patchJobWorkSubFeature(): Promise<{
    plans: number;
    subs: number;
  }> {
    const jobWorkEntry = {
      key: 'job_work',
      access: FeatureAccessLevel.FULL,
    };

    const planResult = await this.planModel.updateMany(
      { 'entitlements.moduleAccess.module': AppModule.FINANCE },
      {
        $addToSet: {
          'entitlements.moduleAccess.$[elem].subFeatures': jobWorkEntry,
        },
      },
      {
        arrayFilters: [{ 'elem.module': AppModule.FINANCE }],
      },
    );

    const subResult = await this.subscriptionModel.updateMany(
      { 'appliedEntitlements.moduleAccess.module': AppModule.FINANCE },
      {
        $addToSet: {
          'appliedEntitlements.moduleAccess.$[elem].subFeatures': jobWorkEntry,
        },
      },
      {
        arrayFilters: [{ 'elem.module': AppModule.FINANCE }],
      },
    );

    return {
      plans: planResult.modifiedCount,
      subs: subResult.modifiedCount,
    };
  }

  /**
   * F-15 (Phase 16) D-43: Seed 'finance_advanced' sub-feature (access: full)
   * into the FINANCE module entry of every existing Plan and Subscription that
   * already has FINANCE access.
   *
   * The 'finance_advanced' sub-feature gates the four Phase 16 endpoint groups:
   * tally-export, fy-close, party-portal, and print-i18n (D-43).
   *
   * Same pattern as patchJobWorkSubFeature — $addToSet with full
   * { key, access } object is idempotent (MongoDB compares by object equality
   * so duplicate inserts are no-ops).
   */
  private async patchFinanceAdvancedSubFeature(): Promise<{
    plans: number;
    subs: number;
  }> {
    const financeAdvancedEntry = {
      key: 'finance_advanced',
      access: FeatureAccessLevel.FULL,
    };

    const planResult = await this.planModel.updateMany(
      { 'entitlements.moduleAccess.module': AppModule.FINANCE },
      {
        $addToSet: {
          'entitlements.moduleAccess.$[elem].subFeatures': financeAdvancedEntry,
        },
      },
      {
        arrayFilters: [{ 'elem.module': AppModule.FINANCE }],
      },
    );

    const subResult = await this.subscriptionModel.updateMany(
      { 'appliedEntitlements.moduleAccess.module': AppModule.FINANCE },
      {
        $addToSet: {
          'appliedEntitlements.moduleAccess.$[elem].subFeatures': financeAdvancedEntry,
        },
      },
      {
        arrayFilters: [{ 'elem.module': AppModule.FINANCE }],
      },
    );

    return {
      plans: planResult.modifiedCount,
      subs: subResult.modifiedCount,
    };
  }
}
