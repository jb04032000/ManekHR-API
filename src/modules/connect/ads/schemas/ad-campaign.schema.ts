import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdCampaign` collection.
 *
 * Top-level container for a boost campaign. A campaign holds the budget
 * envelope and schedule; its targeting lives in `AdSet`, its creative in
 * `AdCreative`. Kinds:
 *  - `boost_post`         -- promotes a Connect feed post (`sourcePostId` set).
 *  - `boost_listing`      -- promotes a marketplace listing (`sourceListingId` set, M2.1).
 *  - `boost_job`          -- promotes a job (`sourceJobId` set, Phase 5).
 *  - `boost_open_to_work` -- promotes the advertiser's own profile as a job-seeker
 *                            (`sourceProfileUserId` = owner). Reaches employers.
 *  - `boost_hiring`       -- promotes the advertiser's own profile as a hirer
 *                            (`sourceProfileUserId` = owner). Reaches workers.
 *  - `boost_rfq`          -- promotes a request-for-quote (`sourceRfqId` set).
 *                            Reaches suppliers.
 * Exactly one source ref is set, selected by `kind`. The two profile boosts share
 * the `feed_promoted_profile` placement; their AdSet targeting (employer vs worker
 * roles) routes each to the correct audience.
 */
@Schema({ timestamps: true, collection: 'ad_campaigns' })
export class AdCampaign extends Document {
  /** The advertiser user who owns this campaign. Connect has no workspace concept. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerUserId: Types.ObjectId;

  /** Campaign kind. Selects which source ref is set and where the ad serves. */
  @Prop({
    type: String,
    enum: [
      'boost_post',
      'boost_listing',
      'boost_job',
      'boost_open_to_work',
      'boost_hiring',
      'boost_rfq',
    ],
    required: true,
    default: 'boost_post',
  })
  kind: string;

  /** The Connect feed post being promoted (`boost_post`). `null` otherwise. */
  @Prop({ type: Types.ObjectId, ref: 'Post', default: null })
  sourcePostId?: Types.ObjectId | null;

  /** The marketplace listing being promoted (`boost_listing`). `null` otherwise. */
  @Prop({ type: Types.ObjectId, ref: 'Listing', default: null })
  sourceListingId?: Types.ObjectId | null;

  /** The job being promoted (`boost_job`). `null` otherwise. */
  @Prop({ type: Types.ObjectId, ref: 'Job', default: null })
  sourceJobId?: Types.ObjectId | null;

  /**
   * The advertiser's own profile being promoted (`boost_open_to_work` /
   * `boost_hiring`). Always equals `ownerUserId`. `null` otherwise. Cross-module:
   * the web feed hydrates the public ConnectProfile of this user to render the card.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  sourceProfileUserId?: Types.ObjectId | null;

  /** The request-for-quote being promoted (`boost_rfq`). `null` otherwise. */
  @Prop({ type: Types.ObjectId, ref: 'Rfq', default: null })
  sourceRfqId?: Types.ObjectId | null;

  /**
   * What the advertiser wants to achieve. `quotes` (rfq boost) is the supplier
   * analogue of `applications` (job) / `inquiries` (listing) -- a CPC outcome.
   */
  @Prop({
    type: String,
    enum: ['reach', 'inquiries', 'profile_visits', 'applications', 'quotes'],
    required: true,
  })
  objective: string;

  /** Lifecycle state of the campaign. */
  @Prop({
    type: String,
    enum: ['draft', 'pending_review', 'active', 'paused', 'completed', 'rejected'],
    required: true,
    default: 'draft',
  })
  status: string;

  /** Total credits allocated to this campaign. */
  @Prop({ type: Number, required: true, min: 0 })
  totalBudget: number;

  /** Credits consumed so far. Incremented by the billing engine on each charge. */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  budgetSpent: number;

  /**
   * Cumulative amount reserved from the EXPIRING grant bucket across every
   * `wallet.reserve()` for this campaign (create + any resume). Consumed by the
   * split-aware `release()` to restore the correct bucket (grant vs purchased),
   * and read (not credited) by the account-purge forfeit handler to compute the
   * amount to decrement from `wallet.reserved`. CN-ADS-1 (Bucket 3): before this
   * field, release() always credited 100% back to purchased `balance`, silently
   * converting expiring grant credits into permanent balance. Min 0. Cross-module:
   * written in boost.service (buildBundleAndReserve/resume), read in wallet.service
   * (release) + connect-content-purge.service (forfeit). Keep in sync with
   * `reservedFromBalance` — their sum SHOULD equal `totalBudget - budgetSpent`.
   */
  @Prop({ type: Number, default: 0, min: 0 })
  reservedFromGrant: number;

  /** Cumulative amount reserved from PURCHASED balance (the grant-first split's
   *  remainder). See `reservedFromGrant`. Min 0. */
  @Prop({ type: Number, default: 0, min: 0 })
  reservedFromBalance: number;

  /** Scheduled start time (UTC). */
  @Prop({ type: Date, required: true })
  startAt: Date;

  /** Scheduled end time (UTC). Campaign auto-completes when `endAt` passes. */
  @Prop({ type: Date, required: true })
  endAt: Date;

  /** Budget delivery pacing strategy. `even` spreads spend uniformly over the flight. */
  @Prop({ type: String, enum: ['even'], required: true, default: 'even' })
  pacing: string;

  /** What event triggers a charge -- CPM (per thousand impressions) or CPC (per click). */
  @Prop({ type: String, enum: ['cpm', 'cpc'], required: true })
  billingEvent: string;

  /** Max bid per billing event in credits. */
  @Prop({ type: Number, required: true, min: 0 })
  bid: number;

  // Shown to the advertiser on a taken-down boost: the reason an admin gave
  // when they took the live boost down. null while the boost is live / never
  // moderated.
  @Prop({ type: String, default: null })
  moderationReason?: string | null;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdCampaignDocument = AdCampaign & Document;

export const AdCampaignSchema = SchemaFactory.createForClass(AdCampaign);

// List campaigns for a user filtered by status -- the most common query.
AdCampaignSchema.index({ ownerUserId: 1, status: 1 });
// Expiry sweeper: find active campaigns past their `endAt`.
AdCampaignSchema.index({ status: 1, endAt: 1 });
