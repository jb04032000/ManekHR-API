import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Listing } from '../modules/connect/marketplace/schemas/listing.schema';
import { StorefrontService } from '../modules/connect/entities/services/storefront.service';

interface MigrationResult {
  ownersProcessed: number;
  listingsUpdated: number;
  errors: string[];
}

/**
 * W3 reconciliation - backfill `Listing.storefrontId` (Phase 4/6).
 *
 * Products now belong to a storefront. This moves every legacy listing (created
 * before `storefrontId` existed) into its owner's DEFAULT storefront, creating
 * that storefront if the owner has none (via the shared
 * StorefrontService.getOrCreateDefaultStorefront, which bypasses the cap because
 * this is a system reconciliation, not a user create).
 *
 * Idempotent + safe to run on every boot: it only touches listings where
 * `storefrontId` is null/absent, and getOrCreateDefaultStorefront reuses an
 * owner's existing default. `dryRun` reports what WOULD change without writing
 * (for the W3 regression gate's before/after check). `ownerUserId` is untouched,
 * so ownership / caps / verified / boost / search behaviour is unchanged.
 */
@Injectable()
export class BackfillListingStorefrontService {
  private readonly logger = new Logger(BackfillListingStorefrontService.name);

  constructor(
    @InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
    private readonly storefronts: StorefrontService,
  ) {}

  async run(dryRun = false): Promise<MigrationResult> {
    const result: MigrationResult = { ownersProcessed: 0, listingsUpdated: 0, errors: [] };

    let owners: Types.ObjectId[];
    try {
      // `{ storefrontId: null }` matches both null and absent (legacy) fields.
      owners = (await this.listingModel.distinct('ownerUserId', {
        storefrontId: null,
      })) as Types.ObjectId[];
    } catch (err) {
      const e = err as Error;
      result.errors.push(`distinct owners: ${e?.message ?? String(err)}`);
      this.logger.error(`backfill-listing-storefront distinct failed: ${e?.message}`, e?.stack);
      return result;
    }

    if (owners.length === 0) {
      return result;
    }

    for (const ownerId of owners) {
      try {
        const ownerIdStr = String(ownerId);
        const sf = await this.storefronts.getOrCreateDefaultStorefront(ownerIdStr);
        if (dryRun) {
          const count = await this.listingModel.countDocuments({
            ownerUserId: ownerId,
            storefrontId: null,
          });
          result.listingsUpdated += count;
        } else {
          const res = await this.listingModel.updateMany(
            { ownerUserId: ownerId, storefrontId: null },
            { $set: { storefrontId: sf._id } },
          );
          result.listingsUpdated += res.modifiedCount ?? 0;
        }
        result.ownersProcessed += 1;
      } catch (err) {
        const e = err as Error;
        result.errors.push(`owner ${String(ownerId)}: ${e?.message ?? String(err)}`);
        this.logger.error(`backfill-listing-storefront owner failed: ${e?.message}`, e?.stack);
      }
    }

    this.logger.log(
      `listing->storefront backfill${dryRun ? ' (dry-run)' : ''}: ${JSON.stringify(result)}`,
    );
    return result;
  }
}
