import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from './schemas/plan.schema';
import { Subscription } from './schemas/subscription.schema';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * Phase 21+ (Machines Phase 2) subscription sub-feature keys (D-08).
 *
 * Single source of truth re-imported by controller @RequireSubscription
 * decorators and this migration service boot log. All three keys are
 * bundled into the existing MACHINES tier — no new SKU (D-08 / XC-03).
 *
 *   machines_production  — gates production log CRUD + bulk-entry (Phase 21)
 *   machines_maintenance — gates maintenance schedule + service log (Phase 24)
 *   piece_rate_payroll   — gates piece-rate salary type (Phase 23)
 *   machines_downtime    — gates downtime entry CRUD + reason catalogue (Phase 22)
 *   production_utilisation_dashboard — gates dashboard read endpoints + UI surface (Phase 25)
 *
 * Phase 21 wires only machines_production. The other three are declared here
 * to avoid separate churns of this file across Phases 22, 23 and 24.
 */
export const MACHINES_P2_SUBFEATURES = {
  MACHINES_PRODUCTION: 'machines_production',
  MACHINES_MAINTENANCE: 'machines_maintenance',
  PIECE_RATE_PAYROLL: 'piece_rate_payroll',
  MACHINES_DOWNTIME: 'machines_downtime',
  PRODUCTION_UTILISATION_DASHBOARD: 'production_utilisation_dashboard',
} as const;

/**
 * Adds the Machines/Locations/ResourceScopes module entries to every
 * existing Plan and every active Subscription so that the new
 * @RequireSubscription decorators on machine-aware routes do not lock
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
export class MachinesPlanMigrationService {
  private readonly logger = new Logger(MachinesPlanMigrationService.name);

  private readonly NEW_MODULES: AppModule[] = [
    AppModule.MACHINES,
    AppModule.LOCATIONS,
    AppModule.RESOURCE_SCOPES,
  ];

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
  ) {}

  // Run by the ledgered migration runner (ADR-0001 Slice 5) — was an onModuleInit
  // hook that ran on EVERY boot. Body unchanged (logs + patchPlans/patchSubscriptions).
  // Do NOT re-add a boot hook on merge.
  async run(): Promise<void> {
    // D-08: Log sub-feature key registration intent on every boot so that
    // operators can confirm the production sub-feature is wired correctly.
    this.logger.log(
      'Machines plan migration: production sub-feature key registered (machines_production)',
    );
    this.logger.log(
      'Machines plan migration: downtime sub-feature key registered (machines_downtime)',
    );
    // Coverage note (Phase 25 / Pitfall 10): Existing subscriptions with
    // MACHINES module entry shape `{ enabled: true, subFeatures: [] }` get
    // FULL access via SubscriptionGuard's empty-array fallback. No
    // backfill migration is needed for the new key.
    this.logger.log(
      'Machines plan migration: production-utilisation-dashboard sub-feature key registered (production_utilisation_dashboard)',
    );

    try {
      const plansPatched = await this.patchPlans();
      const { applied, override } = await this.patchSubscriptions();
      if (plansPatched > 0 || applied > 0 || override > 0) {
        this.logger.log(
          `Machines migration: patched ${plansPatched} plan(s), ${applied} subscription appliedEntitlements, ${override} subscription adminEntitlementOverride.`,
        );
      }
    } catch (err) {
      // Never crash the app boot on a migration hiccup. Surface a warning.
      this.logger.warn(`MachinesPlanMigrationService failed: ${(err as Error).message}`);
    }
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
}
