import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * ManekHR Connect Ads -- `ConnectPricingConfig` singleton collection.
 *
 * Holds the platform-wide BUSINESS pricing levers the owner may want to tune to
 * optimise revenue WITHOUT a code deploy: the boost bid prices (what a campaign
 * is charged per 1000 impressions / per click), the minimum boost budget, the
 * allowed campaign durations, and the wallet top-up minimum + quick-pick
 * suggested amounts.
 *
 * Single document, keyed by `key: 'default'` (unique). There is no `workspaceId`
 * -- this is platform-wide config managed by the zari360 admin team, mirroring
 * the AdPlacement model.
 *
 * Cross-module links:
 *   - Read by ConnectPricingConfigService (cached) -> BoostService (bid +
 *     min-budget + allowed-durations enforcement) and the public
 *     `GET /connect/ads/pricing` endpoint the web boost composer + wallet panel
 *     read for their min / presets / durations.
 *   - Written by the admin endpoints on AdsAdminController.
 *
 * Watch: existing campaigns SNAPSHOT `bid` at creation, so changing the bid here
 * never re-prices a live campaign -- only new boosts. Engineering constants
 * (frequency caps, pacing, cache TTLs) intentionally do NOT live here; this doc
 * is strictly business levers.
 */
@Schema({ timestamps: true, collection: 'connect_pricing_configs' })
export class ConnectPricingConfig extends Document {
  /** Singleton key. Always 'default'. Unique so there is exactly one config row. */
  @Prop({ type: String, required: true, unique: true, default: 'default' })
  key: string;

  /** Bid charged per 1000 impressions for a `reach` (cpm) boost objective. */
  @Prop({ type: Number, required: true, default: 40, min: 0 })
  boostBidCpm: number;

  /** Bid charged per click for a click (cpc) boost objective (inquiries / etc.). */
  @Prop({ type: Number, required: true, default: 4, min: 0 })
  boostBidCpc: number;

  /**
   * Premium multiplier applied to the bid when a boost adds the optional
   * "Spotlight" upgrade (Phase 2). A Spotlight boost also serves in the premium
   * right-rail (`spotlight_rail`) and is billed at `bid x spotlightMultiplier`,
   * so the prime placement costs more. Default 2 = double rate. Admin-tunable.
   */
  @Prop({ type: Number, required: true, default: 2, min: 1 })
  spotlightMultiplier: number;

  /** Minimum total boost budget in whole rupees. */
  @Prop({ type: Number, required: true, default: 99, min: 0 })
  boostMinBudget: number;

  /**
   * Flat admin review fee in whole rupees withheld from the refund when an admin
   * takes a live boost down (publish-then-moderate). The advertiser is refunded
   * the leftover budget minus this fee; the platform keeps the fee. Default 25.
   * Admin-tunable.
   */
  @Prop({ type: Number, default: 25, min: 0 })
  moderationReviewFee: number;

  /** Allowed campaign durations in days (budget spread evenly across the period). */
  @Prop({ type: [Number], required: true, default: [3, 7, 14, 30] })
  boostDurations: number[];

  /** Quick-pick suggested budgets surfaced in the boost composer (whole rupees). */
  @Prop({ type: [Number], required: true, default: [99, 299, 500, 1000] })
  boostBudgetPresets: number[];

  /** Minimum wallet top-up amount in whole rupees. */
  @Prop({ type: Number, required: true, default: 99, min: 0 })
  walletTopupMinAmount: number;

  /** Quick-pick suggested top-up amounts surfaced in the wallet panel (whole rupees). */
  @Prop({ type: [Number], required: true, default: [99, 299, 500, 1000] })
  walletTopupPresets: number[];

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectPricingConfigDocument = ConnectPricingConfig & Document;

export const ConnectPricingConfigSchema = SchemaFactory.createForClass(ConnectPricingConfig);

/**
 * The shipped default values, equal to the previous hardcoded constants. Used as
 * (a) the seeded document defaults, (b) the fallback in BoostService when the
 * config service is not injected (positional unit-test construction), and (c)
 * the snapshot asserted by tests to prove "moved, not changed". Keep in sync
 * with the @Prop defaults above.
 */
export const CONNECT_PRICING_DEFAULTS = {
  boostBidCpm: 40,
  boostBidCpc: 4,
  spotlightMultiplier: 2,
  boostMinBudget: 99,
  moderationReviewFee: 25,
  boostDurations: [3, 7, 14, 30],
  boostBudgetPresets: [99, 299, 500, 1000],
  walletTopupMinAmount: 99,
  walletTopupPresets: [99, 299, 500, 1000],
} as const;

/** The public-safe, read-model shape returned to the web (no Mongo metadata). */
export interface ConnectPricingView {
  boostBidCpm: number;
  boostBidCpc: number;
  spotlightMultiplier: number;
  boostMinBudget: number;
  moderationReviewFee: number;
  boostDurations: number[];
  boostBudgetPresets: number[];
  walletTopupMinAmount: number;
  walletTopupPresets: number[];
}
