import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Subscription } from '../modules/subscriptions/schemas/subscription.schema';
import { Plan } from '../modules/subscriptions/schemas/plan.schema';
import { Tier } from '../modules/subscriptions/schemas/tier.schema';

interface MigrationResult {
  plansBackfilled: number;
  subscriptionsBackfilled: number;
  tiersBackfilled: number;
  droppedIndexes: string[];
  errors: string[];
}

/**
 * Connect Marketplace M0.8 (2026-05-27) - product back-fill + legacy
 * subscription index drop (risk #1).
 *
 * Two jobs, both idempotent and safe to re-run on every boot:
 *
 *   1. Back-fill `product: 'erp'` on every existing Plan / Subscription / Tier
 *      that predates the product axis (M0.1 plan / M0.2 subscription / M0.4
 *      tier). The schema default only applies to NEW docs; stored legacy docs
 *      have no `product` field, so a product-scoped query (e.g. the M0.7 admin
 *      `?product=erp` filter, or the ERP normalization repair) would miss them.
 *
 *   2. Drop the legacy single-product unique indexes on the subscriptions
 *      collection. M0.2 renamed `{userId}` -> `{userId, product}` and
 *      `{userId, status}` -> `{userId, product, status}`. Mongoose autoIndex
 *      ADDS the new compound indexes but NEVER drops the renamed-away ones, so
 *      the old `userId_1` unique-partial would keep enforcing "one active
 *      subscription per user" across ALL products - blocking a person from
 *      holding an active ERP sub AND an active Connect sub. We ensure the new
 *      indexes exist FIRST (never leave the collection without a uniqueness
 *      guard), then drop the legacy ones by name, guarded by an existence +
 *      uniqueness check so a fresh DB or an unrelated lookup index is untouched.
 *
 * Index names are Mongoose's deterministic key-derived names. The
 * `{userId, workspaceId}` workspace index (`userId_1_workspaceId_1`) is left in
 * place. Mirrors MigrateWorkspaceMemberPartialIndexService's online-swap shape.
 *
 * NOTE: the risk #3 Connect sub-feature-key back-fill is intentionally NOT done
 * here - no Connect endpoint reads those moduleAccess keys until M1, and the
 * M0.4 seed + per-subscription entitlement snapshot already cover seeded/new
 * Connect subs. It will run with the first guarded Connect endpoint in M1.
 */
@Injectable()
export class BackfillConnectProductAndIndexesService {
  private readonly logger = new Logger(BackfillConnectProductAndIndexesService.name);

  /** Legacy single-product unique indexes superseded by M0.2's product-scoped ones. */
  private static readonly LEGACY_INDEX_NAMES = ['userId_1', 'userId_1_status_1'];

  constructor(
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Tier.name) private readonly tierModel: Model<Tier>,
  ) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      plansBackfilled: 0,
      subscriptionsBackfilled: 0,
      tiersBackfilled: 0,
      droppedIndexes: [],
      errors: [],
    };

    // ── Step 1 — back-fill product:'erp' on docs predating the product axis ──
    const filter = { product: { $exists: false } };
    const update = { $set: { product: 'erp' } };
    try {
      const [plans, subscriptions, tiers] = await Promise.all([
        this.planModel.updateMany(filter, update),
        this.subscriptionModel.updateMany(filter, update),
        this.tierModel.updateMany(filter, update),
      ]);
      result.plansBackfilled = plans?.modifiedCount ?? 0;
      result.subscriptionsBackfilled = subscriptions?.modifiedCount ?? 0;
      result.tiersBackfilled = tiers?.modifiedCount ?? 0;
    } catch (err) {
      const e = err as Error;
      result.errors.push(`product back-fill: ${e?.message ?? String(err)}`);
      this.logger.error(`product back-fill failed: ${e?.message ?? String(err)}`, e?.stack);
    }

    // ── Step 2 — ensure the new product-scoped indexes BEFORE dropping legacy ─
    const collection = this.subscriptionModel.collection;
    try {
      await collection.createIndex(
        { userId: 1, product: 1 },
        {
          name: 'userId_1_product_1',
          unique: true,
          partialFilterExpression: { status: { $in: ['active', 'trial'] } },
        },
      );
      await collection.createIndex(
        { userId: 1, product: 1, status: 1 },
        {
          name: 'userId_1_product_1_status_1',
          unique: true,
          partialFilterExpression: { status: 'scheduled' },
        },
      );
    } catch (err) {
      const e = err as Error;
      result.errors.push(`ensure product-scoped indexes: ${e?.message ?? String(err)}`);
      this.logger.error(
        `ensure product-scoped indexes failed: ${e?.message ?? String(err)}`,
        e?.stack,
      );
      // Do NOT drop the legacy indexes if the replacements are not confirmed -
      // that would leave the collection without a uniqueness guard.
      return result;
    }

    // ── Step 3 — drop the legacy single-product unique indexes if present ─────
    let existing: Array<{ name?: string; unique?: boolean }>;
    try {
      existing = await collection.indexes();
    } catch (err) {
      const e = err as Error;
      result.errors.push(`list indexes: ${e?.message ?? String(err)}`);
      this.logger.error(`list subscription indexes failed: ${e?.message ?? String(err)}`, e?.stack);
      return result;
    }

    for (const name of BackfillConnectProductAndIndexesService.LEGACY_INDEX_NAMES) {
      const idx = existing.find((i) => i.name === name);
      // Only drop a legacy index that actually exists AND is unique - never a
      // fresh DB (absent) nor an unrelated non-unique lookup index of the same name.
      if (idx && idx.unique === true) {
        try {
          await collection.dropIndex(name);
          result.droppedIndexes.push(name);
          this.logger.log(
            `Dropped legacy subscription index ${name}; product-scoped uniqueness is now the sole guard.`,
          );
        } catch (err) {
          const e = err as Error;
          result.errors.push(`drop ${name}: ${e?.message ?? String(err)}`);
          this.logger.error(
            `drop legacy index ${name} failed: ${e?.message ?? String(err)}`,
            e?.stack,
          );
        }
      }
    }

    return result;
  }
}
