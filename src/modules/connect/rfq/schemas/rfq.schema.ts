import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  LISTING_UNITS,
  ListingLocation,
  ListingLocationSchema,
  type ListingUnit,
} from '../../marketplace/schemas/listing.schema';

/**
 * ManekHR Connect Marketplace -- Request for Quote (Phase 4, W4).
 *
 * A buyer posts what they need ("5000m cotton, zari border, Surat, 10 days,
 * budget ~X"); sellers browse the open-RFQ board and respond with a `Quote`.
 * Board-only (owner-locked 2026-05-30): no seller notifications, just the
 * browsable board. Person-centric (`buyerUserId`), mediator model (the deal is
 * closed off-platform after the buyer picks a quote -- we never hold money).
 */
export const RFQ_STATUSES = ['open', 'closed', 'awarded'] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

@Schema({ timestamps: true, collection: 'connect_rfqs' })
export class Rfq extends Document {
  /** The buyer who posted the request. Person-centric -- never a workspace. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  buyerUserId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  title: string;

  @Prop({ type: String, trim: true, maxlength: 5000, default: '' })
  description: string;

  /**
   * Textile trade category -- the board's primary filter. Open string: one of
   * the known LISTING_CATEGORIES slugs OR a custom term. RfqService normalises
   * it through TagService (same engine as a listing's / job's `category`) so
   * custom values self-register into the shared ConnectTag pool and stay
   * canonical. Keep in sync with the marketplace listing.category contract.
   */
  @Prop({ type: String, required: true, trim: true, lowercase: true })
  category: string;

  /** How much the buyer needs (in `unit`s). `null` when unspecified. */
  @Prop({ type: Number, min: 0, default: null })
  quantity?: number | null;

  @Prop({ type: String, enum: LISTING_UNITS, required: false })
  unit?: ListingUnit;

  /** Indicative budget bounds in rupees. `null` when open. */
  @Prop({ type: Number, min: 0, default: null })
  budgetMin?: number | null;

  @Prop({ type: Number, min: 0, default: null })
  budgetMax?: number | null;

  /** Optional needed-by date. */
  @Prop({ type: Date, default: null })
  neededBy?: Date | null;

  @Prop({ type: ListingLocationSchema, default: () => ({}) })
  location: ListingLocation;

  /** open -> sellers may quote; closed -> buyer ended it; awarded -> a quote accepted. */
  @Prop({ type: String, enum: RFQ_STATUSES, default: 'open' })
  status: RfqStatus;

  /** Denormalized count of quotes received -- shown on the board row. */
  @Prop({ type: Number, default: 0 })
  quotesCount: number;

  /**
   * Denormalized "this is seeded demo/sample content" flag, stamped AT CREATE
   * from the author's `User.isDemo` (mirrors how `Post.authorErpLinked` is
   * denormalized in feed.service.ts). One source of truth for both the FE
   * "Sample" disclosure badge and the demo down-rank (applyDemoPenalty). Default
   * false so every real + every legacy RFQ is non-demo.
   * Cross-module: connect/common/demo-rank.ts + web SampleBadge.tsx.
   */
  @Prop({ type: Boolean, default: false })
  isDemo: boolean;

  /**
   * Denormalized lowest LIVE quote price (statuses sent/shortlisted/accepted) --
   * the board card's "low ₹X" signal. Recomputed by RfqService on every quote
   * create/update/withdraw/decline/accept. `null` until a live quote exists.
   */
  @Prop({ type: Number, default: null })
  lowestQuotePrice?: number | null;

  /**
   * The active boost campaign promoting this RFQ to suppliers (`boost_rfq`), or
   * `null`. Mirrors Listing/Job.boostCampaignId. Set by BoostService after the
   * wallet reserve succeeds; powers the in-flight boost gate + "boost again".
   * Cross-module: connect/ads BoostService. Additive -- null for every legacy RFQ.
   */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', default: null })
  boostCampaignId?: Types.ObjectId | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type RfqDocument = Rfq & Document;

export const RfqSchema = SchemaFactory.createForClass(Rfq);

// The board: open RFQs, newest first (optionally narrowed by category).
// isDemo leads so the board's real-first sort (buildRfqBoardSort) is index-served.
RfqSchema.index({ status: 1, isDemo: 1, createdAt: -1 });
RfqSchema.index({ category: 1, status: 1, createdAt: -1 });
// A buyer's own requests.
RfqSchema.index({ buyerUserId: 1, createdAt: -1 });
