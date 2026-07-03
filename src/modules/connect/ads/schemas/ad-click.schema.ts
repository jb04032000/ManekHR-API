import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdClick` collection.
 *
 * One row per validated click on an ad. `impressionToken` links this back to
 * the originating `AdImpression` row and enforces one-click-per-impression
 * (unique at prop level). The `valid` flag is set to `false` by fraud
 * detection logic (e.g. duplicate IP within window, bot signal) BEFORE the
 * charge is applied; only valid clicks incur a CPC charge.
 *
 * `impressionToken` is unique at the prop level -- no separate `.index()`.
 */
@Schema({ timestamps: true, collection: 'ad_clicks' })
export class AdClick extends Document {
  /**
   * The impression token from the originating `AdImpression`. Unique --
   * enforces one recorded click per impression.
   */
  @Prop({ type: String, required: true, unique: true })
  impressionToken: string;

  /** The campaign that produced the click. Denormalized for fast aggregation. */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', required: true })
  campaignId: Types.ObjectId;

  /** The user who clicked. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** Time of the click event. Defaults to insertion time. */
  @Prop({ type: Date, required: true, default: Date.now })
  clickedAt: Date;

  /**
   * `false` when IVT (invalid-traffic) heuristics invalidate the click. Only
   * valid clicks trigger a CPC charge. See ads/lib/ivt.ts (classifyClick).
   */
  @Prop({ type: Boolean, required: true, default: true })
  valid: boolean;

  /**
   * Why the click was invalidated (audit trail + future IVT tuning). Set only
   * when `valid` is false; one of the `IvtReason` values from ads/lib/ivt.ts
   * (self_click | bot_ua | rapid_duplicate | daily_cap).
   */
  @Prop({ type: String, default: null })
  invalidReason?: string | null;

  /** Credits charged for this click (0 until billing engine processes it). */
  @Prop({ type: Number, required: true, default: 0 })
  chargeAmount: number;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdClickDocument = AdClick & Document;

export const AdClickSchema = SchemaFactory.createForClass(AdClick);

// `unique: true` on `impressionToken` @Prop already creates the unique index.
// No duplicate declaration here -- the prop-level flag is the single source of truth.

// IVT count queries (ad-events.service recordClick): count prior clicks by one
// user on one campaign inside the dedupe / daily windows. clickedAt descending so
// the recent-window count scans the newest rows first.
AdClickSchema.index({ userId: 1, campaignId: 1, clickedAt: -1 });
