import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdSet` collection.
 *
 * Holds the targeting specification and frequency cap for a campaign.
 * One campaign typically has one AdSet in Phase 1; the schema supports
 * multiple sets per campaign for future A/B splits.
 *
 * `TargetingSpec` is an embedded sub-document (no own `_id`), following
 * the same `@Schema({ _id: false })` pattern used by `PostMedia` and
 * `PostAudio` in `post.schema.ts`.
 */

// ─── TargetingSpec sub-schema ─────────────────────────────────────────────────

/**
 * Audience-targeting dimensions for an ad set.
 * All arrays default to empty -- an empty array means "no filter on that
 * dimension" (i.e., target all values).
 */
@Schema({ _id: false })
export class TargetingSpec {
  /** Target specific Connect profile roles (e.g. 'karigar', 'supervisor'). */
  @Prop({ type: [String], default: [] })
  roles: string[];

  /** Target specific industry sectors (e.g. 'textile', 'construction'). */
  @Prop({ type: [String], default: [] })
  sectors: string[];

  /** Target specific Gujarat districts (e.g. 'Surat', 'Ahmedabad'). */
  @Prop({ type: [String], default: [] })
  districts: string[];

  /** Target workspaces by headcount band (e.g. '1-10', '11-50'). */
  @Prop({ type: [String], default: [] })
  companySizes: string[];

  /**
   * Max social-graph distance from the advertiser workspace.
   * `1` = direct connections only; `2` = connections-of-connections; etc.
   * `undefined` means no graph-distance filter.
   */
  @Prop({ type: Number })
  maxConnectionDegree?: number;
}
export const TargetingSpecSchema = SchemaFactory.createForClass(TargetingSpec);

// ─── AdSet document ───────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'ad_sets' })
export class AdSet extends Document {
  /** The parent campaign this set belongs to. */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', required: true })
  campaignId: Types.ObjectId;

  /**
   * Audience targeting specification. Defaults to an empty spec object so
   * each array inside also defaults to `[]` (no dimension filtered).
   */
  @Prop({ type: TargetingSpecSchema, default: {} })
  targeting: TargetingSpec;

  /**
   * Ad placement keys this set is eligible for
   * (e.g. `['feed_promoted_post']`). Empty = all enabled placements.
   */
  @Prop({ type: [String], default: [] })
  placements: string[];

  /**
   * Frequency cap: max number of impressions served to one user
   * within `freqCapWindowSec` seconds.
   */
  @Prop({ type: Number, required: true, default: 3 })
  freqCapCount: number;

  /** Rolling window for the frequency cap in seconds. Default: 86400 (24 h). */
  @Prop({ type: Number, required: true, default: 86400 })
  freqCapWindowSec: number;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdSetDocument = AdSet & Document;

export const AdSetSchema = SchemaFactory.createForClass(AdSet);

// Look up all sets for a campaign (standard parent-child list query).
AdSetSchema.index({ campaignId: 1 });
// Candidate fetch (ad-repos CandidateRepoMongo.top): find every ad set eligible
// for a placement key. `placements` is an array, so this is a multikey index --
// without it the hot-path auction query was a full collection scan.
AdSetSchema.index({ placements: 1 });
