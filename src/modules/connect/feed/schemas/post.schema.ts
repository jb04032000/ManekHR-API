import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Mention, MentionSchema } from './mention.subschema';

/**
 * ManekHR Connect — `Post` collection (Phase 3 — Feed).
 *
 * A feed post. Five kinds — `text`, `photo`, `video`, `document`, `voice` —
 * cover the composer modes; the `voice` kind carries an `audio` sub-doc for the
 * low-literacy posting path (design-decisions doc §7). `media` holds the
 * photo / video / document attachments.
 *
 * `authorErpLinked` + `authorSkills` are DENORMALIZED copies of author signals,
 * snapshotted at post-creation time. They let the read-time feed ranker score a
 * post (recency + ERP-linked-author boost + persona match) without a join back
 * to the author's `User` / `ConnectProfile` (`phase-3-feed.md` B2 / B3). They
 * are a ranking snapshot, not a source of truth, and are never displayed.
 *
 * Every `@Prop` carries an explicit `{ type }` — required by `@nestjs/mongoose`
 * and the repo's Vitest SWC transform so `SchemaFactory.createForClass`
 * resolves without `emitDecoratorMetadata`.
 */

/** `Post.kind` — the post type, set by the composer mode that created it. */
export const POST_KINDS = ['text', 'photo', 'video', 'document', 'voice'] as const;
export type PostKind = (typeof POST_KINDS)[number];

/** `PostMedia.type` — the attachment kind. */
export const POST_MEDIA_TYPES = ['image', 'video', 'document'] as const;
export type PostMediaType = (typeof POST_MEDIA_TYPES)[number];

/** `Post.visibility` — who may see the post in a feed or at its shareable URL. */
export const POST_VISIBILITIES = ['public', 'connections'] as const;
export type PostVisibility = (typeof POST_VISIBILITIES)[number];

/** `Post.mediaLayout` — how a multi-photo `photo` post renders in the feed. */
export const POST_MEDIA_LAYOUTS = ['grid', 'carousel'] as const;
export type PostMediaLayout = (typeof POST_MEDIA_LAYOUTS)[number];

// ─── Sub-schemas (embedded; no own _id) ──────────────────────────────────────

/** One uploaded attachment on a post — a photo, video, or document. */
@Schema({ _id: false })
export class PostMedia {
  /** Uploaded asset URL (uploads `connect-*` categories — Phase 3 B7). */
  @Prop({ type: String, required: true, trim: true })
  url: string;

  @Prop({ type: String, enum: POST_MEDIA_TYPES, required: true })
  type: PostMediaType;

  @Prop({ type: String, trim: true, maxlength: 280 })
  caption?: string;

  /**
   * Poster (thumbnail) for a `video` item — a client-captured frame uploaded as
   * a normal post image (uploads `connect-posts`). Optional: a video may be
   * posted without one (mobile codec quirks), and pre-existing video posts have
   * none. Lets the feed paint a still instantly with `preload="metadata"`
   * instead of a black box. Passes the SAME media-ownership check as `url`.
   */
  @Prop({ type: String, trim: true })
  posterUrl?: string;

  /**
   * Clip length in seconds for a `video` item — the SERVER-parsed duration
   * (uploads probes it from the container at upload time), copied here at create
   * time, never a client claim. Mirrors `PostAudio.durationSec`. Absent on
   * images/docs and on pre-existing video posts.
   */
  @Prop({ type: Number, min: 0 })
  durationSec?: number;
}
export const PostMediaSchema = SchemaFactory.createForClass(PostMedia);

/**
 * The recording on a `voice`-kind post. `transcript` is filled only when a
 * transcription provider is configured (build-plan PAID item 3); the audio
 * always plays without it.
 */
@Schema({ _id: false })
export class PostAudio {
  /** Uploaded audio URL (uploads `connect-audio` category — Phase 3 B7). */
  @Prop({ type: String, required: true, trim: true })
  url: string;

  /** Clip length in seconds — shown on the player without loading the audio. */
  @Prop({ type: Number, required: true, min: 0 })
  durationSec: number;

  /** Auto / edited transcript. `null` until a provider transcribes it. */
  @Prop({ type: String, trim: true, maxlength: 5000, default: null })
  transcript?: string | null;

  /** Detected transcript language (e.g. `hi`, `gu`, `en`). */
  @Prop({ type: String, trim: true, maxlength: 16, default: null })
  transcriptLang?: string | null;
}
export const PostAudioSchema = SchemaFactory.createForClass(PostAudio);

// ─── Post document ───────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'connectposts' })
export class Post extends Document {
  /** The `User` who wrote the post (always the human; the audit + permission owner). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  authorId: User | Types.ObjectId;

  /**
   * OPTIONAL: the `CompanyPage` this post is published AS. When set, the post is
   * attributed to the page (its name/logo) and fans out to the PAGE's followers
   * instead of the author's personal followers. `null` = a normal personal post.
   * `authorId` stays the owning user either way (person-centric).
   */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', default: null })
  companyPageId?: Types.ObjectId | null;

  /** Post type — drives rendering + which payload fields are expected. */
  @Prop({ type: String, enum: POST_KINDS, required: true })
  kind: PostKind;

  /** The written body / caption. Optional for a pure photo / voice post. */
  @Prop({ type: String, trim: true, maxlength: 3000, default: '' })
  body: string;

  /** Photo / video / document attachments (empty for `text` / `voice`). */
  @Prop({ type: [PostMediaSchema], default: [] })
  media: PostMedia[];

  /**
   * How a multi-photo `photo` post renders: `grid` (the default tiled layout) or
   * `carousel` (one photo per slide, the author's choice in the composer). Only
   * meaningful for a `photo` post with 2+ photos; every other post stores the
   * default `grid`. Display-only — never affects ranking or fan-out.
   */
  @Prop({ type: String, enum: POST_MEDIA_LAYOUTS, default: 'grid' })
  mediaLayout: PostMediaLayout;

  /** The recording — present only on a `voice` post. */
  @Prop({ type: PostAudioSchema, default: null })
  audio?: PostAudio | null;

  /** `#`-style topic tags parsed from the body — search signals only (§14). */
  @Prop({ type: [String], default: [] })
  hashtags: string[];

  /** @mentions (tags) parsed from the body via the composer picker - link-ready
   *  refs to a User / CompanyPage / Storefront. See mention.subschema. */
  @Prop({ type: [MentionSchema], default: [] })
  mentions: Mention[];

  /** "Open to …"-style intent tags chosen in the composer. */
  @Prop({ type: [String], default: [] })
  tags: string[];

  /** Who can see this post. */
  @Prop({ type: String, enum: POST_VISIBILITIES, default: 'public' })
  visibility: PostVisibility;

  /** Running reaction tally — kept on the doc so a feed read needs no count. */
  @Prop({ type: Number, min: 0, default: 0 })
  reactionCount: number;

  /** Running comment tally. */
  @Prop({ type: Number, min: 0, default: 0 })
  commentCount: number;

  /**
   * Running unique-viewer tally — bumped once per (viewer, post) the first time
   * the post enters that viewer's viewport (self-views excluded). Denormalized
   * off the `view` `EngagementEdge` so a feed read shows "N views" without a
   * count query. Also the impression base for boosted-post measurement (Wave M).
   */
  @Prop({ type: Number, min: 0, default: 0 })
  viewCount: number;

  /** Denormalized author ERP-linked flag — a read-time ranking signal. */
  @Prop({ type: Boolean, default: false })
  authorErpLinked: boolean;

  /**
   * Denormalized author demo/sample flag — stamped at create from the author's
   * `User.isDemo` (mirrors `authorErpLinked`). Drives BOTH the read-time demo
   * down-rank (`applyDemoPenalty`, the last ranking multiplier) AND the FE
   * "Sample" disclosure badge — one source of truth so the badge and the
   * down-rank never disagree. Cross-module: pairs with `common/demo-rank.ts`
   * + `crewroster-web/components/connect/SampleBadge.tsx`. Watch: real users
   * have `false`/absent; only seeded demo/sample accounts get `true`.
   */
  @Prop({ type: Boolean, default: false })
  isDemo: boolean;

  /** Denormalized author skill tags — a read-time persona-match signal. */
  @Prop({ type: [String], default: [] })
  authorSkills: string[];

  /** Denormalized author home district — powers GeoLocal feed discovery. */
  @Prop({ type: String, trim: true, default: '' })
  authorDistrict: string;

  /**
   * Set when this post is a REPOST — points at the ROOT original (a repost of
   * a repost re-targets the root, so `repostOf` is never itself a repost). The
   * repost carries its own `body` only when it is a quote-repost; otherwise the
   * original's content renders via the embed. `null` on an original post.
   */
  @Prop({ type: Types.ObjectId, ref: 'Post', default: null })
  repostOf?: Types.ObjectId | null;

  /** Running repost tally on an ORIGINAL post — bumped as it is reposted. */
  @Prop({ type: Number, min: 0, default: 0 })
  repostCount: number;

  /**
   * Set the first time the author edits the post after publishing; `null` until
   * then. Drives the "edited" label. The post keeps its original `createdAt`, so
   * an edit never reorders the feed (the materialized `FeedEntry.postedAt` is
   * untouched).
   */
  @Prop({ type: Date, default: null })
  editedAt?: Date | null;

  /** Soft-delete marker. `null` → live; set → hidden from every feed + read. */
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  /**
   * Set when the author boosts this post — the `AdCampaign` (`boost_post`) that
   * promotes it in the feed. Mirrors `Listing.boostCampaignId` / `Job.boostCampaignId`.
   * `null` = not boosted. Used by the ads boost flow to (a) block double-boosting
   * one post and (b) stop the campaign when the post is deleted or made
   * non-public (see `BoostService.stopForPost` + the `connect.post.changed`
   * listener). Display-only / lifecycle link — never affects feed ranking.
   */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', default: null })
  boostCampaignId?: Types.ObjectId | null;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const PostSchema = SchemaFactory.createForClass(Post);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// An author's own posts, newest-first — profile post lists + the fan-out source.
PostSchema.index({ authorId: 1, createdAt: -1 });
// Hashtag → posts, newest-first — search / topic lookups.
PostSchema.index({ hashtags: 1, createdAt: -1 });
// Author-skill → posts, newest-first — the TopicMatch discovery source matches
// `$or: [{ hashtags }, { authorSkills }]`; an $or is only fully index-backed when
// EVERY branch has an index. `hashtags` had one; this gives the `authorSkills`
// branch its own so the topic scan never collection-scans for the skills arm.
PostSchema.index({ authorSkills: 1, createdAt: -1 });
// District → posts, newest-first — GeoLocal feed discovery (Phase 7c).
PostSchema.index({ authorDistrict: 1, createdAt: -1 });
// Public posts, newest-first — the trending / cold-start discovery scan
// (`TrendingSource`) filters `visibility: 'public'` ordered by `createdAt`. Runs
// on every For-You page-1 load, so it needs its own index to stay off a
// collection scan as the post corpus grows.
PostSchema.index({ visibility: 1, createdAt: -1 });
// Reposts of an original (+ the per-user plain-repost dedup / un-repost lookup).
PostSchema.index({ repostOf: 1, authorId: 1 });
// A company page's own posts, newest-first — the page Posts tab + page fan-out source.
PostSchema.index({ companyPageId: 1, createdAt: -1 });
// "Posts that tag entity X" lookup (future "mentions of me" surface). Additive;
// legacy posts simply have an empty mentions array.
PostSchema.index({ 'mentions.refId': 1, createdAt: -1 });
