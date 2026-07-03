import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdImpression` collection.
 *
 * One row per ad served to a user. The `impressionToken` is a short-lived
 * signed token issued by the serving layer; it is echoed back by the client
 * on click (linking `AdClick` to this row) and on viewability confirmation.
 *
 * `charged` / `chargeAmount` are written by the billing engine after the
 * impression qualifies for a CPM charge (or left as defaults for CPC
 * campaigns where the charge fires on click instead).
 *
 * `impressionToken` is unique at the prop level -- no separate `.index()`
 * declaration needed.
 */
@Schema({ timestamps: true, collection: 'ad_impressions' })
export class AdImpression extends Document {
  /** The campaign that produced this impression. */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', required: true })
  campaignId: Types.ObjectId;

  /** The ad set whose targeting matched this user. */
  @Prop({ type: Types.ObjectId, ref: 'AdSet', required: true })
  adSetId: Types.ObjectId;

  /** The creative that was rendered. */
  @Prop({ type: Types.ObjectId, ref: 'AdCreative', required: true })
  creativeId: Types.ObjectId;

  /** The user who received the impression. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** The placement slot key where the ad appeared (e.g. 'feed_promoted_post'). */
  @Prop({ type: String, required: true })
  placementKey: string;

  /**
   * Short-lived opaque token issued at serve time. Echoed back on click and
   * viewability events to tie them back to this row without exposing internal IDs.
   */
  @Prop({ type: String, required: true, unique: true })
  impressionToken: string;

  /** Time the ad was dispatched to the client. Defaults to insertion time. */
  @Prop({ type: Date, required: true, default: Date.now })
  servedAt: Date;

  /**
   * Set to `true` by the client viewability ping once the creative has been
   * in-viewport for the minimum dwell time. Used for viewable-CPM reporting.
   */
  @Prop({ type: Boolean, required: true, default: false })
  viewable: boolean;

  /** Whether a CPM charge has been applied for this impression. */
  @Prop({ type: Boolean, required: true, default: false })
  charged: boolean;

  /** Credits charged for this impression (0 until billing engine processes it). */
  @Prop({ type: Number, required: true, default: 0 })
  chargeAmount: number;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdImpressionDocument = AdImpression & Document;

export const AdImpressionSchema = SchemaFactory.createForClass(AdImpression);

// Campaign delivery log, newest first -- standard campaign analytics query.
AdImpressionSchema.index({ campaignId: 1, servedAt: -1 });

// `unique: true` on `impressionToken` @Prop already creates the unique index.
// No duplicate declaration here -- the prop-level flag is the single source of truth.
