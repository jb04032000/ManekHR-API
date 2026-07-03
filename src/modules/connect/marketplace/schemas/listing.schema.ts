import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/**
 * ManekHR Connect Marketplace -- `Listing` collection (Phase M1).
 *
 * A seller's marketplace listing in the Road A (mediator) marketplace: sellers
 * list, buyers discover + contact, the two parties transact OFF platform. We
 * never hold or move their money, so a listing carries trade terms (price, MOQ,
 * lead time, unit) for discovery + negotiation, not a checkout.
 *
 * PERSON-CENTRIC: a listing is owned by a Connect `User` (`ownerUserId`), never
 * a workspace -- Connect has no workspace concept. Mirrors the ads
 * `AdvertiserWallet.ownerUserId` pattern. Resolve + authorize by userId only;
 * never inherit the ERP workspace-owner branch.
 *
 * Two orthogonal state axes:
 *  - `status` -- the seller-facing lifecycle (`draft` -> `pending_review` ->
 *    `active` <-> `paused`, plus terminal `rejected` / `expired`). Owner- and
 *    system-driven.
 *  - `moderationStatus` -- the admin review verdict (`pending` -> `approved` |
 *    `rejected`, with `rejectionReason`). The canonical gate the boost-
 *    eligibility predicate reads (`moderationStatus === 'approved'`, owner-locked
 *    2026-05-27) and the public discovery query requires.
 *
 * Search lives in Meilisearch (M1.4, `connect_listings` index), so this schema
 * carries NO Mongo text index -- only the lookup / browse / moderation compound
 * indexes below. `boostCampaignId` links to the ads `AdCampaign` when the
 * listing is boosted (M2.1); `null` otherwise.
 *
 * Every `@Prop` carries an explicit `{ type }` -- required by `@nestjs/mongoose`
 * and the repo's Vitest SWC transform so `SchemaFactory.createForClass` resolves
 * without `emitDecoratorMetadata`.
 */

/**
 * `Listing.category` -- the textile trade taxonomy (Gujarat textile-SMB), plus
 * `course` for a training-institute course listing (Institutes Phase 1). A
 * course listing reuses the whole listing pipeline (discovery, inquiry / lead,
 * unified inbox, moderation, boost, Meilisearch); only `category === 'course'`
 * carries the optional `courseDetails` sub-object below. `category` is an open
 * string on the schema (custom terms self-register via TagService), so adding
 * `course` here is additive: it documents the known slug + powers the
 * "require course fields when category is course" DTO rule.
 */
export const LISTING_CATEGORIES = [
  'weaving',
  'dyeing',
  'printing',
  'embroidery-zari',
  'job-work',
  'raw-material',
  'machinery',
  'finished-goods',
  'course',
  // Service categories (Slice B1). The marketplace listing engine is already
  // service-aware; these slugs mirror how `course` was added — additive, open
  // string, no data migration. A listing in one of these 8 carries the optional
  // `serviceDetails` sub-object below (the DTO requires its core fields then).
  'consulting',
  'maintenance',
  'machine-repair',
  'testing',
  'installation',
  'transport',
  'logistics',
  'contractor',
] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

/**
 * The 8 NEW service-listing categories added in Slice B1. These are the ONLY
 * categories that REQUIRE `serviceDetails` at the DTO layer (mirrors how
 * `course` requires `courseDetails`). Kept separate from the broader
 * `SERVICE_CATEGORIES` browse set below so the "require service fields when the
 * category is a service" rule never accidentally fires on a pre-existing
 * service-ish category (which would change existing behavior).
 */
export const NEW_SERVICE_CATEGORIES = [
  'consulting',
  'maintenance',
  'machine-repair',
  'testing',
  'installation',
  'transport',
  'logistics',
  'contractor',
] as const;
export type NewServiceCategory = (typeof NEW_SERVICE_CATEGORIES)[number];

/**
 * The full service-listing browse / classification set: the 8 NEW_SERVICE_CATEGORIES
 * PLUS the pre-existing service-ish trade categories. This is the broader
 * "is this listing a service?" set the web browse filters + the Service JSON-LD
 * use; it does NOT drive the DTO require-rule (only NEW_SERVICE_CATEGORIES does,
 * so the pre-existing categories keep their current optional-serviceDetails
 * behavior — no behavior change).
 */
export const SERVICE_CATEGORIES = [
  ...NEW_SERVICE_CATEGORIES,
  'job-work',
  'dyeing',
  'printing',
  'embroidery-zari',
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** `serviceDetails.deliveryMode` — where a service is delivered. */
export const LISTING_SERVICE_DELIVERY_MODES = ['on-site', 'remote', 'both'] as const;
export type ListingServiceDeliveryMode = (typeof LISTING_SERVICE_DELIVERY_MODES)[number];

/**
 * `serviceDetails.pricingModel` — how the service fee is expressed. Like the
 * course `feeType`, the fee itself reuses the listing's `priceMin` / `priceMax`
 * (driven by this model); `negotiable` leaves the price fields null.
 */
export const LISTING_SERVICE_PRICING_MODELS = [
  'fixed',
  'hourly',
  'daily',
  'per-visit',
  'negotiable',
] as const;
export type ListingServicePricingModel = (typeof LISTING_SERVICE_PRICING_MODELS)[number];

/** `courseDetails.mode` -- how a course is delivered (institute course listing). */
export const LISTING_COURSE_MODES = ['online', 'offline', 'hybrid'] as const;
export type ListingCourseMode = (typeof LISTING_COURSE_MODES)[number];

/**
 * `courseDetails.feeType` -- how the course fee is expressed. `fixed` / `range`
 * reuse the listing's `priceMin` / `priceMax`; `free` is a no-fee course (the
 * price fields stay null). Parallel to the listing `priceType` but course-scoped.
 */
export const LISTING_COURSE_FEE_TYPES = ['fixed', 'range', 'free'] as const;
export type ListingCourseFeeType = (typeof LISTING_COURSE_FEE_TYPES)[number];

/** `Listing.priceType` -- how the asking price is expressed. */
export const LISTING_PRICE_TYPES = ['fixed', 'range', 'negotiable'] as const;
export type ListingPriceType = (typeof LISTING_PRICE_TYPES)[number];

/** `Listing.unit` -- the pricing / order unit (textile-relevant). */
export const LISTING_UNITS = [
  'per-meter',
  'per-piece',
  'per-kg',
  'per-set',
  'per-dozen',
  'per-order',
] as const;
export type ListingUnit = (typeof LISTING_UNITS)[number];

/** `Listing.status` -- the seller-facing lifecycle state. */
export const LISTING_STATUSES = [
  'draft',
  'pending_review',
  'active',
  'paused',
  'rejected',
  'expired',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** `Listing.moderationStatus` -- the admin review verdict. */
export const LISTING_MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ListingModerationStatus = (typeof LISTING_MODERATION_STATUSES)[number];

// --- Sub-schemas (embedded; no own _id) -------------------------------------

/**
 * One seller-entered specification row (e.g. Fabric -> "Micro velvet"). Free
 * label/value pairs so any trade (fabric, machinery, raw material) can describe
 * itself -- rendered as the spec grid on the product detail page. Max 12 rows
 * enforced at the DTO layer.
 */
@Schema({ _id: false })
export class ListingSpec {
  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  label: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  value: string;
}
export const ListingSpecSchema = SchemaFactory.createForClass(ListingSpec);

/**
 * Seller-entered trade terms shown on the detail page rail. Prose, optional --
 * the platform never processes payment (Road A mediator), these are the
 * off-platform terms the two parties negotiate against. MOQ + lead time stay
 * first-class fields (they power filters); these three are display-only.
 */
@Schema({ _id: false })
export class ListingTradeTerms {
  /** How / how fast the goods ship (e.g. "2-4 days, pan-India courier"). */
  @Prop({ type: String, trim: true, maxlength: 300, default: '' })
  dispatch: string;

  /** Payment expectation (e.g. "advance or against delivery, agreed on call"). */
  @Prop({ type: String, trim: true, maxlength: 300, default: '' })
  payment: string;

  /** Return / defect policy (e.g. "manufacturing defects only, within 3 days"). */
  @Prop({ type: String, trim: true, maxlength: 300, default: '' })
  returns: string;
}
export const ListingTradeTermsSchema = SchemaFactory.createForClass(ListingTradeTerms);

/**
 * Where the seller / work is based. `district` is the primary geo filter
 * (mirrors the feed's `authorDistrict` GeoLocal signal); `city` + `state` refine
 * it. All optional -- a service listing may be location-agnostic.
 */
@Schema({ _id: false })
export class ListingLocation {
  @Prop({ type: String, trim: true, maxlength: 120, default: '' })
  district: string;

  @Prop({ type: String, trim: true, maxlength: 120, default: '' })
  city: string;

  @Prop({ type: String, trim: true, maxlength: 120, default: '' })
  state: string;
}
export const ListingLocationSchema = SchemaFactory.createForClass(ListingLocation);

/**
 * One product video on a listing. Mirrors the feed `PostMedia` video shape
 * (url + posterUrl + durationSec) so the SAME upload pipeline drives both:
 *  - `url`        the uploaded clip (uploads `connect-product-video` category).
 *  - `posterUrl`  an optional client-captured poster frame, uploaded as a normal
 *                 image; lets the detail page paint a still with
 *                 `preload="metadata"` instead of a black box. Passes the SAME
 *                 media-ownership check as `url` (see ListingService).
 *  - `durationSec` the SERVER-parsed clip length (uploads probes it at upload
 *                 time); copied here at write time, never a client claim.
 *
 * The listing carries at most ONE video (DTO `@ArrayMaxSize(1)`); the field is an
 * array purely so a future "multiple videos" change needs no schema migration.
 */
@Schema({ _id: false })
export class ListingVideo {
  @Prop({ type: String, required: true, trim: true })
  url: string;

  @Prop({ type: String, trim: true })
  posterUrl?: string;

  @Prop({ type: Number, min: 0 })
  durationSec?: number;
}
export const ListingVideoSchema = SchemaFactory.createForClass(ListingVideo);

/**
 * Course-specific detail for a `category === 'course'` listing (Institutes
 * Phase 1). Optional on the schema (a non-course listing leaves it unset); the
 * DTO REQUIRES the core fields when the category is `course`. The fee uses the
 * listing's existing `priceMin` / `priceMax` (driven by `feeType`):
 *  - `fixed` -> single fee in `priceMin`.
 *  - `range` -> `priceMin`..`priceMax`.
 *  - `free`  -> no fee (price fields null).
 * `certificate` flags whether the course awards one; `skillsTaught` is a free-tag
 * list of skills covered (display-only, not a search facet this phase).
 */
@Schema({ _id: false })
export class CourseDetails {
  /** Human duration label, e.g. "6 weeks", "3 months (weekends)". */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  durationLabel: string;

  /** Next batch start date. `null`/unset when rolling-admission or not scheduled. */
  @Prop({ type: Date, default: null })
  batchStart?: Date | null;

  /** Delivery mode. */
  @Prop({ type: String, enum: LISTING_COURSE_MODES, required: true })
  mode: ListingCourseMode;

  /** How the fee is expressed (drives use of priceMin / priceMax). */
  @Prop({ type: String, enum: LISTING_COURSE_FEE_TYPES, required: true })
  feeType: ListingCourseFeeType;

  /** Seats per batch. `null`/unset when not capped / not specified. */
  @Prop({ type: Number, min: 0, default: null })
  seats?: number | null;

  /** Whether the course awards a certificate. */
  @Prop({ type: Boolean, default: false })
  certificate: boolean;

  /** Free-tag skills the course teaches (display-only). */
  @Prop({ type: [String], default: [] })
  skillsTaught: string[];
}
export const CourseDetailsSchema = SchemaFactory.createForClass(CourseDetails);

/**
 * Service-specific detail for a service listing (Slice B1 — consultants,
 * maintenance, technical, transport, contractors). Mirrors `CourseDetails`:
 * optional on the schema (a non-service listing leaves it unset), but the DTO
 * REQUIRES the core fields (`deliveryMode`, `pricingModel`) when the category is
 * one of the 8 NEW_SERVICE_CATEGORIES. The fee reuses the listing's existing
 * `priceMin` / `priceMax` (driven by `pricingModel`), exactly like CourseDetails
 * reuses them — so no fee fields live here:
 *  - `fixed`      -> single fee in `priceMin`.
 *  - `hourly` / `daily` / `per-visit` -> rate in `priceMin` per the unit implied.
 *  - `negotiable` -> no fee (price fields null).
 * `coverageArea` / `yearsExperience` / `availability` are display-only context.
 */
@Schema({ _id: false })
export class ServiceDetails {
  /** Where the service is delivered (on-site / remote / both). */
  @Prop({ type: String, enum: LISTING_SERVICE_DELIVERY_MODES, required: true })
  deliveryMode: ListingServiceDeliveryMode;

  /** How the fee is expressed (drives use of priceMin / priceMax). */
  @Prop({ type: String, enum: LISTING_SERVICE_PRICING_MODELS, required: true })
  pricingModel: ListingServicePricingModel;

  /** Free-text geographic coverage, e.g. "Surat + Ahmedabad". Optional. */
  @Prop({ type: String, trim: true, maxlength: 160 })
  coverageArea?: string;

  /** Years of experience the provider has. `null`/unset when not specified. */
  @Prop({ type: Number, min: 0, default: null })
  yearsExperience?: number | null;

  /** Free-text availability, e.g. "Mon–Sat, 9am–7pm". Empty by default. */
  @Prop({ type: String, trim: true, maxlength: 160, default: '' })
  availability?: string;
}
export const ServiceDetailsSchema = SchemaFactory.createForClass(ServiceDetails);

// --- Listing document --------------------------------------------------------

@Schema({ timestamps: true, collection: 'connect_listings' })
export class Listing extends Document {
  /** The `User` who owns this listing. Person-centric -- never a workspace. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerUserId: User | Types.ObjectId;

  /**
   * The Storefront this listing belongs to (Phase 4/6 reconciliation). Products
   * live in a storefront; the shared marketplace still aggregates ALL listings
   * across storefronts for discovery. Logically required going forward
   * (ListingService.create resolves/creates the owner's default storefront when
   * none is given) + the W3 migration backfills legacy rows; kept OPTIONAL at the
   * schema level so a legacy row save mid-migration does not fail validation.
   * `ownerUserId` stays the source of truth for ownership / caps / verified /
   * boost / search; `storefrontId` is an additive branding / grouping axis.
   */
  @Prop({ type: Types.ObjectId, ref: 'Storefront', default: null })
  storefrontId?: Types.ObjectId | null;

  /** Short listing title shown in browse + detail. */
  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  title: string;

  /** Full description / trade terms in prose. */
  @Prop({ type: String, trim: true, maxlength: 5000, default: '' })
  description: string;

  /**
   * The textile trade category -- a primary discovery filter. Open string:
   * the seller may use one of the known 8 LISTING_CATEGORIES slugs or any
   * custom term. The service normalises the value through TagService so custom
   * categories self-register and stay canonical (same as `tags`).
   */
  @Prop({ type: String, required: true, trim: true, lowercase: true })
  category: string;

  /** How the asking price is expressed. */
  @Prop({ type: String, enum: LISTING_PRICE_TYPES, default: 'negotiable' })
  priceType: ListingPriceType;

  /**
   * Lower bound of the asking price in rupees (the single price when
   * `priceType === 'fixed'`). `null` when negotiable / unpriced. Min 0.
   */
  @Prop({ type: Number, min: 0, default: null })
  priceMin?: number | null;

  /** Upper bound in rupees when `priceType === 'range'`. `null` otherwise. Min 0. */
  @Prop({ type: Number, min: 0, default: null })
  priceMax?: number | null;

  /** The pricing / order unit. Absent for unit-less / service listings. */
  @Prop({ type: String, enum: LISTING_UNITS, required: false })
  unit?: ListingUnit;

  /** Minimum order quantity (in `unit`s). `null` when not specified. Min 0. */
  @Prop({ type: Number, min: 0, default: null })
  moq?: number | null;

  /** Typical lead / turnaround time in days. `null` when not specified. Min 0. */
  @Prop({ type: Number, min: 0, default: null })
  leadTimeDays?: number | null;

  /** Where the seller / work is based -- powers geo discovery + filters. */
  @Prop({ type: ListingLocationSchema, default: () => ({}) })
  location: ListingLocation;

  /** Uploaded listing photo URLs (uploads `connect-*` categories). */
  @Prop({ type: [String], default: [] })
  images: string[];

  /**
   * Product video (at most one - the DTO caps the array at 1). ADDITIVE to
   * `images`: the cover + search still come from `images`; the video is a bonus
   * teaser shown on the detail page + flagged with a play badge on cards. Each
   * entry's `durationSec` is server-derived (see ListingService). Empty by
   * default, so every pre-video listing is unchanged.
   */
  @Prop({ type: [ListingVideoSchema], default: [] })
  videos: ListingVideo[];

  /** Seller-applied product tags (canonical ConnectTag slugs). The flexible,
   *  searchable layer over the coarse `category`. */
  @Prop({ type: [String], default: [] })
  tags: string[];

  /** Seller-entered specification rows (label/value) -- the detail-page spec
   *  grid. Display-only (not indexed / filterable); empty by default. */
  @Prop({ type: [ListingSpecSchema], default: [] })
  specs: ListingSpec[];

  /** Seller-entered off-platform trade terms (dispatch / payment / returns)
   *  for the detail-page rail. Display-only; all parts optional. */
  @Prop({ type: ListingTradeTermsSchema, default: () => ({}) })
  tradeTerms: ListingTradeTerms;

  /**
   * Course detail for a `category === 'course'` listing (Institutes Phase 1).
   * `null` for every non-course listing (additive, no migration). When present
   * it carries the duration / mode / fee-type / seats / certificate / skills the
   * course detail page renders; the fee itself reuses `priceMin` / `priceMax`.
   */
  @Prop({ type: CourseDetailsSchema, default: null })
  courseDetails?: CourseDetails | null;

  /**
   * Service detail for a service listing (Slice B1). `null` for every
   * non-service listing (additive, no migration — mirrors `courseDetails`).
   * When present it carries the delivery mode / pricing model / coverage /
   * experience / availability the service detail page renders; the fee itself
   * reuses `priceMin` / `priceMax`.
   */
  @Prop({ type: ServiceDetailsSchema, default: null })
  serviceDetails?: ServiceDetails | null;

  /**
   * Shop Collections this product belongs to (`Collection` ids, same storefront).
   * SINGLE SOURCE OF TRUTH for collection membership - the per-collection
   * `productOrder` array is only an advisory display order. A product may be in
   * many of its shop's collections; empty by default.
   */
  @Prop({ type: [Types.ObjectId], ref: 'Collection', default: [] })
  collectionIds: Types.ObjectId[];

  /** Seller-facing lifecycle state. Created as `draft`; the service drives transitions. */
  @Prop({ type: String, enum: LISTING_STATUSES, default: 'draft' })
  status: ListingStatus;

  /**
   * Admin review verdict. The boost-eligibility gate + public discovery require
   * `approved`. New listings start `pending`.
   */
  @Prop({ type: String, enum: LISTING_MODERATION_STATUSES, default: 'pending' })
  moderationStatus: ListingModerationStatus;

  /** Why moderation rejected the listing -- shown to the owner. `null` otherwise. */
  @Prop({ type: String, trim: true, maxlength: 500, default: null })
  rejectionReason?: string | null;

  /**
   * The ads `AdCampaign` boosting this listing (M2.1), or `null`. A listing boost
   * reuses the shipped ad engine; this back-links the campaign so the marketplace
   * can show + manage the boost.
   */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', default: null })
  boostCampaignId?: Types.ObjectId | null;

  /**
   * Denormalized "this is seeded sample/demo content" marker (Demo Content scope).
   * STAMPED AT CREATE from the owner's `User.isDemo` (mirrors how `Post.authorErpLinked`
   * is denormalized at create in feed.service.ts) — one source the "Sample" badge
   * (web) and the search down-rank (search unit, demo-rank.ts) both read. A real
   * user's listing is `false`. Cross-module link: the search module's `toListingRef`
   * reads `listing.isDemo`; `applyDemoPenalty` down-ranks it. Watch: legacy rows
   * predate this field — a backfill migration stamps them from their owner.
   */
  @Prop({ type: Boolean, default: false })
  isDemo: boolean;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type ListingDocument = Listing & Document;

export const ListingSchema = SchemaFactory.createForClass(Listing);

// --- Indexes -----------------------------------------------------------------

// An owner's own listings by lifecycle state -- the my-listings view + the
// per-owner active-count the listing cap (ConnectAllowanceService, M0.5) reads.
ListingSchema.index({ ownerUserId: 1, status: 1 });
// The admin moderation queue (moderationStatus: 'pending') + recency ordering.
ListingSchema.index({ moderationStatus: 1, status: 1, createdAt: -1 });
// Public category browse: active + approved listings within a category.
ListingSchema.index({ category: 1, status: 1, moderationStatus: 1 });
// A storefront's own products (its public page + admin Products list).
ListingSchema.index({ storefrontId: 1, status: 1, moderationStatus: 1 });
// Public "active products in collection C of shop S" + the membership lookups
// the collection service runs (which collections a product is in, pull-on-delete).
ListingSchema.index({ storefrontId: 1, collectionIds: 1, status: 1 });
