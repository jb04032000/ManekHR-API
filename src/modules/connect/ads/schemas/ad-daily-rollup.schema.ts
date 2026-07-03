import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdDailyRollup` collection.
 *
 * Pre-aggregated daily performance metrics per campaign. Written by a nightly
 * cron job (or incremental upsert) so the analytics dashboard can read a
 * single document per (campaign, date) instead of scanning raw impression /
 * click rows.
 *
 * `date` is stored as a 'YYYY-MM-DD' string in IST (Indian Standard Time,
 * UTC+5:30). The cron job must convert UTC event timestamps to IST before
 * bucketing to ensure day boundaries align with the advertiser's local calendar.
 *
 * `ctr` and `viewabilityRate` are derived values (clicks / impressions and
 * viewableImpressions / impressions respectively) stored denormalized here so
 * the dashboard does not need to recompute them on every read.
 */
@Schema({ timestamps: true, collection: 'ad_daily_rollups' })
export class AdDailyRollup extends Document {
  /** The campaign these metrics belong to. */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', required: true })
  campaignId: Types.ObjectId;

  /**
   * Calendar date in IST, format 'YYYY-MM-DD' (e.g. '2026-05-26').
   * Stored as a string so it is timezone-unambiguous and sorts lexicographically.
   */
  @Prop({ type: String, required: true })
  date: string;

  /** Total ad impressions served on this day. */
  @Prop({ type: Number, required: true, default: 0 })
  impressions: number;

  /** Impressions that met the minimum in-viewport dwell time. */
  @Prop({ type: Number, required: true, default: 0 })
  viewableImpressions: number;

  /** Total click events recorded on this day. */
  @Prop({ type: Number, required: true, default: 0 })
  clicks: number;

  /** Clicks that passed fraud validation and may trigger a CPC charge. */
  @Prop({ type: Number, required: true, default: 0 })
  validClicks: number;

  /** Total credits spent (deducted from wallet) on this day. */
  @Prop({ type: Number, required: true, default: 0 })
  spend: number;

  /** Click-through rate: validClicks / impressions. Stored denormalized. */
  @Prop({ type: Number, required: true, default: 0 })
  ctr: number;

  /** Viewability rate: viewableImpressions / impressions. Stored denormalized. */
  @Prop({ type: Number, required: true, default: 0 })
  viewabilityRate: number;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdDailyRollupDocument = AdDailyRollup & Document;

export const AdDailyRollupSchema = SchemaFactory.createForClass(AdDailyRollup);

// Campaign analytics timeline, newest date first -- the primary dashboard query.
AdDailyRollupSchema.index({ campaignId: 1, date: -1 });
