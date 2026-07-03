import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Listing } from '../modules/connect/marketplace/schemas/listing.schema';
import { env } from '../config/env';

/**
 * Listing moderation backfill (ADR-0001, Slice 1). Previously ran on EVERY boot
 * in `ListingService.onModuleInit`; now runs via the migration runner as a
 * `convergent` unit keyed on the moderation flag (see the registry checksum) so
 * it re-evaluates whenever CONNECT_LISTING_MODERATION_ENABLED is toggled —
 * matching the old every-boot re-check, without the per-boot DB writes.
 *
 * When moderation is OFF (the product default), listings publish live, so any
 * legacy rows left in `pending_review` / `pending` are released to
 * active / approved. When moderation is ON this is a no-op (we never auto-approve).
 */
@Injectable()
export class BackfillListingModerationService {
  private readonly logger = new Logger(BackfillListingModerationService.name);

  constructor(
    @InjectModel(Listing.name)
    private readonly listingModel: Model<Listing>,
  ) {}

  async run(): Promise<{
    moderationEnabled: boolean;
    statusReleased: number;
    moderationReleased: number;
  }> {
    if (env.connectMarketplace.moderationEnabled) {
      this.logger.log('listing moderation ENABLED — backfill is a no-op (no auto-approve).');
      return { moderationEnabled: true, statusReleased: 0, moderationReleased: 0 };
    }

    const statusRes = await this.listingModel.updateMany(
      { status: 'pending_review' },
      { $set: { status: 'active' } },
    );
    const moderationRes = await this.listingModel.updateMany(
      { moderationStatus: 'pending' },
      { $set: { moderationStatus: 'approved' } },
    );

    const statusReleased = statusRes.modifiedCount ?? 0;
    const moderationReleased = moderationRes.modifiedCount ?? 0;
    this.logger.log(
      `listing moderation backfill: released ${statusReleased} status + ${moderationReleased} moderationStatus.`,
    );
    return { moderationEnabled: false, statusReleased, moderationReleased };
  }
}
