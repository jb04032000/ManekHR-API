import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdPlacement } from '../modules/connect/ads/schemas/ad-placement.schema';
import {
  ConnectPricingConfig,
  CONNECT_PRICING_DEFAULTS,
} from '../modules/connect/ads/schemas/connect-pricing-config.schema';

/**
 * Seeds the canonical Connect ad-placement slots + the singleton pricing config
 * (ADR-0001, Slice 1). This logic previously lived in `AdsModule.onModuleInit`
 * and ran on EVERY boot; it now runs once via the migration runner (registered
 * as a `convergent` unit so adding a new slot — bump the registry checksum —
 * re-applies and inserts it).
 *
 * `$setOnInsert` means an existing row is never modified, so admin re-pricing /
 * floor / enabled edits made via the admin panel are always preserved.
 */
@Injectable()
export class SeedConnectAdPlacementsService {
  private readonly logger = new Logger(SeedConnectAdPlacementsService.name);

  constructor(
    @InjectModel(AdPlacement.name)
    private readonly placementModel: Model<AdPlacement>,
    @InjectModel(ConnectPricingConfig.name)
    private readonly pricingConfigModel: Model<ConnectPricingConfig>,
  ) {}

  async runSeed(): Promise<{ placementsInserted: number; pricingInserted: boolean }> {
    // Named placement slots. `surface` is constrained to ['feed','rail'] by the
    // AdPlacement schema, so every non-feed in-content slot reuses 'rail'.
    const seeds: Array<{ key: string; surface: string; floorCpm: number; enabled: boolean }> = [
      { key: 'feed_promoted_post', surface: 'feed', floorCpm: 0, enabled: true },
      // In-feed promoted profile slot for the open-to-work + hiring boosts
      // (boost_open_to_work / boost_hiring). One slot; AdSet targeting routes
      // worker profiles to employers and hirer profiles to workers.
      { key: 'feed_promoted_profile', surface: 'feed', floorCpm: 0, enabled: true },
      // Unified in-feed sponsored slot (Phase 1 "boosts in the feed"). EVERY boost
      // kind (post / profile / listing / job / rfq) is eligible here, so one auction
      // picks the single best-matching item per viewer. Supersedes the two feed_*
      // slots above for new boosts (kept seeded but no longer bound). Cross-module:
      // web feed page resolves up to 2 cards from this key per page render.
      { key: 'feed_sponsored', surface: 'feed', floorCpm: 0, enabled: true },
      // Premium right-rail "Spotlight" slot (Phase 2). ONLY boosts that opted into
      // the Spotlight upgrade are eligible (placements include this key); they bill
      // at the premium bid. Rendered in the feed right rail; one auction across all
      // Spotlight kinds.
      { key: 'spotlight_rail', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'jobs_rail', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'marketplace_rail', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'marketplace_grid', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'company_page', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'storefront_page', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'rfq_board', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'rfq_detail', surface: 'rail', floorCpm: 0, enabled: true },
      // Promoted-RFQ slot pinned atop the RFQ board for boost_rfq campaigns
      // (distinct from rfq_board, which carries the cross-sell promoted listing).
      { key: 'rfq_promoted', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'search_results', surface: 'rail', floorCpm: 0, enabled: true },
      // Wave 2 platform-wide cross-sell rails. Each mirrors company_page defaults
      // (surface 'rail', floorCpm 0, enabled). The web Wave 2 page resolvers call
      // resolvePromotedRailListing(<key>) on the matching page; the backend serves
      // ANY active listing-objective boost on these keys (no exact-key bind needed
      // — see ads/services/ad-repos.ts CROSS_SELL_RAIL_PLACEMENTS). Keep this list
      // in sync with that set.
      { key: 'jobs_detail', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'listing_detail', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'post_detail', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'profile_view', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'activity_feed', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'stores_hub', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'storefront_manage', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'pages_hub', surface: 'rail', floorCpm: 0, enabled: true },
      { key: 'company_manage', surface: 'rail', floorCpm: 0, enabled: true },
    ];

    let placementsInserted = 0;
    for (const seed of seeds) {
      const res = await this.placementModel.updateOne(
        { key: seed.key },
        { $setOnInsert: seed },
        { upsert: true },
      );
      if (res.upsertedCount) placementsInserted += res.upsertedCount;
    }

    // Singleton pricing config — shipped defaults (== the previous hardcoded
    // bid/min/durations/top-up presets). $setOnInsert preserves later admin edits.
    const pricingRes = await this.pricingConfigModel.updateOne(
      { key: 'default' },
      { $setOnInsert: { key: 'default', ...CONNECT_PRICING_DEFAULTS } },
      { upsert: true },
    );

    this.logger.log(
      `ad-placement seed: ${placementsInserted}/${seeds.length} inserted; pricing-config ${
        pricingRes.upsertedCount ? 'inserted' : 'present'
      }.`,
    );
    return { placementsInserted, pricingInserted: !!pricingRes.upsertedCount };
  }
}
