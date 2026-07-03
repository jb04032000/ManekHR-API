import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdCreative` collection.
 *
 * The rendered ad unit. Kinds:
 *  - `promoted_post`         -- the boosted Connect post itself (`postRef`).
 *  - `promoted_listing`      -- a boosted marketplace listing (`listingRef`, M2.1).
 *  - `promoted_job`          -- a boosted job (`jobRef`, Phase 5).
 *  - `promoted_open_to_work` -- the advertiser's profile, "open to work" framing (`profileRef`).
 *  - `promoted_hiring`       -- the advertiser's profile, "hiring" framing (`profileRef`).
 *  - `promoted_rfq`          -- a boosted request-for-quote (`rfqRef`).
 * Exactly one target ref is set, selected by `kind`. A human-review gate
 * (`reviewStatus`) sits between campaign submission and delivery; only
 * `approved` creatives are eligible for serving.
 */
@Schema({ timestamps: true, collection: 'ad_creatives' })
export class AdCreative extends Document {
  /** The campaign this creative belongs to. */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', required: true })
  campaignId: Types.ObjectId;

  /** Creative kind. Selects which target ref renders. */
  @Prop({
    type: String,
    enum: [
      'promoted_post',
      'promoted_listing',
      'promoted_job',
      'promoted_open_to_work',
      'promoted_hiring',
      'promoted_rfq',
    ],
    required: true,
    default: 'promoted_post',
  })
  kind: string;

  /** The Connect feed post rendered as the ad unit (`promoted_post`). `null` otherwise. */
  @Prop({ type: Types.ObjectId, ref: 'Post', default: null })
  postRef?: Types.ObjectId | null;

  /** The marketplace listing rendered as the ad unit (`promoted_listing`). `null` otherwise. */
  @Prop({ type: Types.ObjectId, ref: 'Listing', default: null })
  listingRef?: Types.ObjectId | null;

  /** The job rendered as the ad unit (`promoted_job`). `null` otherwise. */
  @Prop({ type: Types.ObjectId, ref: 'Job', default: null })
  jobRef?: Types.ObjectId | null;

  /**
   * The advertiser's profile rendered as the ad unit (`promoted_open_to_work` /
   * `promoted_hiring`). Always equals the campaign owner. `null` otherwise.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  profileRef?: Types.ObjectId | null;

  /** The request-for-quote rendered as the ad unit (`promoted_rfq`). `null` otherwise. */
  @Prop({ type: Types.ObjectId, ref: 'Rfq', default: null })
  rfqRef?: Types.ObjectId | null;

  /** Moderation status. Only `approved` creatives are eligible for delivery. */
  @Prop({
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    required: true,
    default: 'pending',
  })
  reviewStatus: string;

  /** The admin user who performed the review action. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  reviewedBy?: Types.ObjectId;

  /** Rejection reason shown to the advertiser when `reviewStatus` is `rejected`. */
  @Prop({ type: String })
  rejectionReason?: string;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdCreativeDocument = AdCreative & Document;

export const AdCreativeSchema = SchemaFactory.createForClass(AdCreative);

// All creatives for a campaign -- admin review panel query.
AdCreativeSchema.index({ campaignId: 1 });
// Moderation queue: filter all pending / rejected creatives across campaigns.
AdCreativeSchema.index({ reviewStatus: 1 });
// Candidate fetch (ad-repos CandidateRepoMongo.top) loads the approved creative
// for a campaign with findOne({ campaignId, reviewStatus: 'approved' }). The
// compound index lets that hot-path lookup hit the index instead of scanning the
// per-campaign creative set.
AdCreativeSchema.index({ campaignId: 1, reviewStatus: 1 });
