import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Subscription } from '../modules/subscriptions/schemas/subscription.schema';
import { AppModule } from '../common/enums/modules.enum';
import { FeatureAccessLevel } from '../common/enums/feature-access.enum';

interface SubFeature {
  key: string;
  access: string;
}
interface ModuleAccessEntry {
  module: string;
  enabled: boolean;
  subFeatures: SubFeature[];
}
interface LeanSub {
  _id: Types.ObjectId;
  appliedEntitlements?: { moduleAccess?: ModuleAccessEntry[] };
}

interface MigrationResult {
  subscriptionsScanned: number;
  subscriptionsUpdated: number;
  errors: string[];
}

/**
 * Connect Marketplace RISK #3 (deferred from M0.8, runs with the first guarded
 * Connect endpoint in M1.2) - back-fill the Connect sub-feature keys onto active
 * subscriptions whose entitlement snapshot predates them.
 *
 * Why: the fail-closed entitlements guard treats an ABSENT `moduleAccess`
 * sub-feature key as denied. A `product: 'connect'` subscription created before
 * these keys existed would therefore read marketplace/badge/priority as LOCKED.
 * The M0.4 seed + the per-subscription snapshot already cover seeded + newly
 * created Connect subs, so in practice this targets only legacy Connect subs
 * (currently none) - it is a forward-safety net, idempotent + cheap, run on
 * every boot like the other migrations.
 *
 * Access baseline mirrors SeedConnectTiersAndPlansService.connectModuleAccess
 * for the FREE tier. It only ever ADDS a missing key; it never overwrites an
 * existing key's access, so a premium snapshot's richer grants survive untouched.
 */
const CONNECT_SUBFEATURE_BASELINE: SubFeature[] = [
  { key: 'marketplace.listings', access: FeatureAccessLevel.FULL },
  { key: 'marketplace.leads', access: FeatureAccessLevel.FULL },
  { key: 'profile.verified_badge', access: FeatureAccessLevel.LOCKED },
  { key: 'search.priority', access: FeatureAccessLevel.LIMITED },
];

@Injectable()
export class BackfillConnectSubFeatureKeysService {
  private readonly logger = new Logger(BackfillConnectSubFeatureKeysService.name);

  constructor(
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<Subscription>,
  ) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      subscriptionsScanned: 0,
      subscriptionsUpdated: 0,
      errors: [],
    };

    let subs: LeanSub[];
    try {
      subs = await this.subscriptionModel
        .find({ product: 'connect', status: { $in: ['active', 'trial'] } })
        .lean<LeanSub[]>()
        .exec();
    } catch (err) {
      const e = err as Error;
      result.errors.push(`find connect subs: ${e?.message ?? String(err)}`);
      this.logger.error(`find connect subs failed: ${e?.message ?? String(err)}`, e?.stack);
      return result;
    }

    result.subscriptionsScanned = subs.length;

    for (const sub of subs) {
      const current = sub.appliedEntitlements?.moduleAccess ?? [];
      const { changed, next } = this.ensureConnectKeys(current);
      if (!changed) {
        continue;
      }
      try {
        await this.subscriptionModel.updateOne(
          { _id: sub._id },
          { $set: { 'appliedEntitlements.moduleAccess': next } },
        );
        result.subscriptionsUpdated += 1;
      } catch (err) {
        const e = err as Error;
        result.errors.push(`update ${String(sub._id)}: ${e?.message ?? String(err)}`);
        this.logger.error(
          `update sub ${String(sub._id)} failed: ${e?.message ?? String(err)}`,
          e?.stack,
        );
      }
    }

    if (result.subscriptionsUpdated > 0 || result.errors.length > 0) {
      this.logger.log(`connect sub-feature-key backfill: ${JSON.stringify(result)}`);
    }
    return result;
  }

  /**
   * Ensure the CONNECT module entry carries all baseline sub-feature keys. Adds
   * the entry when absent; appends only MISSING keys (never overwrites an
   * existing key's access). Operates on copies so the input is not mutated.
   */
  private ensureConnectKeys(moduleAccess: ModuleAccessEntry[]): {
    changed: boolean;
    next: ModuleAccessEntry[];
  } {
    const next = moduleAccess.map((m) => ({ ...m, subFeatures: [...(m.subFeatures ?? [])] }));
    let entry = next.find((m) => m.module === (AppModule.CONNECT as string));
    let changed = false;

    if (!entry) {
      entry = { module: AppModule.CONNECT, enabled: true, subFeatures: [] };
      next.push(entry);
      changed = true;
    }

    const present = new Set(entry.subFeatures.map((s) => s.key));
    for (const baseline of CONNECT_SUBFEATURE_BASELINE) {
      if (!present.has(baseline.key)) {
        entry.subFeatures.push({ ...baseline });
        changed = true;
      }
    }

    return { changed, next };
  }
}
