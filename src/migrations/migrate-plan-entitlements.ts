import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from '../modules/subscriptions/schemas/plan.schema';
import { Subscription } from '../modules/subscriptions/schemas/subscription.schema';
import { AppModule } from '../common/enums/modules.enum';
import { FeatureAccessLevel } from '../common/enums/feature-access.enum';
import {
  MODULE_FEATURES_MAP,
  TIER_SUBFEATURE_DEFAULTS,
} from '../common/constants/module-features.registry';

interface MigrationResult {
  plansMigrated: number;
  plansSkipped: number;
  subscriptionsMigrated: number;
  subscriptionsSkipped: number;
  errors: string[];
}

@Injectable()
export class MigratePlanEntitlementsService {
  constructor(
    @InjectModel(Plan.name) private planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
  ) {}

  async migratePlans(): Promise<MigrationResult> {
    const result: MigrationResult = {
      plansMigrated: 0,
      plansSkipped: 0,
      subscriptionsMigrated: 0,
      subscriptionsSkipped: 0,
      errors: [],
    };

    const plans = await this.planModel.find().exec();

    for (const plan of plans) {
      try {
        const entitlements = plan.entitlements as any;
        const tier = plan.tier?.toLowerCase() || 'free';

        if (entitlements.moduleAccess && entitlements.moduleAccess.length > 0) {
          console.log(
            `Plan '${plan.name}' already has moduleAccess, skipping.`,
          );
          result.plansSkipped++;
          continue;
        }

        const moduleAccess = this.generateModuleAccessFromLegacy(
          entitlements,
          tier,
        );

        entitlements.moduleAccess = moduleAccess;
        await plan.save();

        console.log(`Migrated plan '${plan.name}' to moduleAccess format.`);
        result.plansMigrated++;
      } catch (error: any) {
        console.error(`Error migrating plan '${plan.name}':`, error.message);
        result.errors.push(`Plan '${plan.name}': ${error.message}`);
      }
    }

    return result;
  }

  async migrateSubscriptions(): Promise<MigrationResult> {
    const result: MigrationResult = {
      plansMigrated: 0,
      plansSkipped: 0,
      subscriptionsMigrated: 0,
      subscriptionsSkipped: 0,
      errors: [],
    };

    const subscriptions = await this.subscriptionModel
      .find()
      .populate('planId')
      .exec();

    for (const subscription of subscriptions) {
      try {
        const appliedEntitlements = subscription.appliedEntitlements as any;
        const plan = subscription.planId as any;

        if (
          appliedEntitlements?.moduleAccess &&
          appliedEntitlements.moduleAccess.length > 0
        ) {
          console.log(
            `Subscription for user '${subscription.userId}' already has moduleAccess, skipping.`,
          );
          result.subscriptionsSkipped++;
          continue;
        }

        if (
          plan?.entitlements?.moduleAccess &&
          plan.entitlements.moduleAccess.length > 0
        ) {
          appliedEntitlements.moduleAccess = plan.entitlements.moduleAccess;
          await subscription.save();
          console.log(
            `Migrated subscription for user '${subscription.userId}' from plan.`,
          );
          result.subscriptionsMigrated++;
          continue;
        }

        const tier = plan?.tier?.toLowerCase() || 'free';
        const moduleAccess = this.generateModuleAccessFromLegacy(
          appliedEntitlements,
          tier,
        );
        appliedEntitlements.moduleAccess = moduleAccess;
        await subscription.save();

        console.log(
          `Migrated subscription for user '${subscription.userId}' with generated moduleAccess.`,
        );
        result.subscriptionsMigrated++;
      } catch (error: any) {
        console.error(
          `Error migrating subscription for user '${subscription.userId}':`,
          error.message,
        );
        result.errors.push(
          `Subscription '${subscription.userId}': ${error.message}`,
        );
      }
    }

    return result;
  }

  private generateModuleAccessFromLegacy(
    entitlements: any,
    tier: string,
  ): any[] {
    const moduleAccess: any[] = [];
    const tierDefaults =
      TIER_SUBFEATURE_DEFAULTS[tier] || TIER_SUBFEATURE_DEFAULTS['free'];
    const legacyModules: AppModule[] = entitlements?.modules || [];

    const moduleKeys = Object.values(AppModule).filter(
      (m) => m !== AppModule.BILLS,
    );

    for (const moduleKey of moduleKeys) {
      const moduleDef = MODULE_FEATURES_MAP[moduleKey];
      if (!moduleDef) continue;

      const isEnabledInLegacy = legacyModules.includes(moduleKey);
      const isEnabledByDefault =
        (tierDefaults[moduleKey] || FeatureAccessLevel.LOCKED) !==
        FeatureAccessLevel.LOCKED;
      const enabled = isEnabledInLegacy || isEnabledByDefault;

      const subFeatures = moduleDef.subFeatures.map((sf) => {
        const defaultAccess =
          tierDefaults[moduleKey]?.[sf.key] || FeatureAccessLevel.LOCKED;
        return {
          key: sf.key,
          access: enabled ? defaultAccess : FeatureAccessLevel.LOCKED,
        };
      });

      moduleAccess.push({
        module: moduleKey,
        enabled,
        subFeatures,
      });
    }

    return moduleAccess;
  }

  async verifyIntegrity(): Promise<{
    valid: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];

    const plans = await this.planModel.find().exec();
    for (const plan of plans) {
      const entitlements = plan.entitlements as any;
      if (
        !entitlements.moduleAccess ||
        entitlements.moduleAccess.length === 0
      ) {
        issues.push(`Plan '${plan.name}' is missing moduleAccess`);
      }
    }

    const subscriptions = await this.subscriptionModel.find().exec();
    for (const subscription of subscriptions) {
      const entitlements = subscription.appliedEntitlements as any;
      if (
        !entitlements?.moduleAccess ||
        entitlements.moduleAccess.length === 0
      ) {
        issues.push(
          `Subscription for user '${subscription.userId}' is missing moduleAccess in appliedEntitlements`,
        );
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  async runFullMigration(): Promise<{
    plans: MigrationResult;
    subscriptions: MigrationResult;
    integrity: { valid: boolean; issues: string[] };
  }> {
    console.log('Starting plan entitlements migration...');
    const plans = await this.migratePlans();
    console.log(
      `Plan migration complete: ${plans.plansMigrated} migrated, ${plans.plansSkipped} skipped`,
    );

    console.log('Starting subscription migration...');
    const subscriptions = await this.migrateSubscriptions();
    console.log(
      `Subscription migration complete: ${subscriptions.subscriptionsMigrated} migrated, ${subscriptions.subscriptionsSkipped} skipped`,
    );

    console.log('Verifying integrity...');
    const integrity = await this.verifyIntegrity();
    console.log(`Integrity check: ${integrity.valid ? 'PASSED' : 'FAILED'}`);
    if (!integrity.valid) {
      console.log('Issues found:', integrity.issues);
    }

    return { plans, subscriptions, integrity };
  }
}
