import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Marketplace -- a seller's Quote on an RFQ (Phase 4, W4).
 *
 * A structured one-shot offer (price + lead time + note), NOT a chat. The buyer
 * compares the quotes on their RFQ and contacts the chosen seller off-platform
 * (mediator model). One quote per seller per RFQ (unique index) -- a seller
 * edits or withdraws rather than stacking.
 */
// `shortlisted` sits between sent and accepted: the buyer marks finalists while
// comparing (mirrors the jobs application shortlist). Feeds the "My quotes"
// shortlisted stat on the web RFQ board KPI strip.
export const QUOTE_STATUSES = ['sent', 'shortlisted', 'accepted', 'declined', 'withdrawn'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

@Schema({ timestamps: true, collection: 'connect_quotes' })
export class Quote extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Rfq', required: true })
  rfqId: Types.ObjectId;

  /** The seller making the offer. Person-centric. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  sellerUserId: Types.ObjectId;

  /** Optional storefront the seller is quoting from (for the buyer's context). */
  @Prop({ type: Types.ObjectId, ref: 'Storefront', default: null })
  storefrontId?: Types.ObjectId | null;

  /** Quoted TOTAL in rupees (the number the buyer compares; the board's
   *  lowestQuotePrice + "low ₹X" read this). When the seller quotes per-unit,
   *  `rate` x `rateQuantity` is the breakdown and `price` holds the product. */
  @Prop({ type: Number, min: 0, required: true })
  price: number;

  /** Optional per-unit rate breakdown (rupees per the RFQ's unit). `null` for
   *  a lump-sum quote. Web mirror: QuoteComposer rate calculator. */
  @Prop({ type: Number, min: 0, default: null })
  rate?: number | null;

  /** The quantity the rate covers (usually the RFQ's quantity). */
  @Prop({ type: Number, min: 0, default: null })
  rateQuantity?: number | null;

  /** What the rate includes -- preset slugs (approval-sample, gst-included,
   *  pickup-delivery, packing, materials) or short custom strings. */
  @Prop({ type: [String], default: [] })
  includes: string[];

  /** How long the offer stands, in days from the last update. `null` = till
   *  the request closes. Display-only (buyer sees "valid till X"); not enforced. */
  @Prop({ type: Number, min: 1, default: null })
  validityDays?: number | null;

  /** Work-sample photo URLs (R2, `connect-portfolio` bucket; max 5). Proof of
   *  similar work -- the strongest trust signal next to price. */
  @Prop({ type: [String], default: [] })
  sampleUrls: string[];

  /** Quoted lead / delivery time in days. `null` when unspecified. */
  @Prop({ type: Number, min: 0, default: null })
  leadTimeDays?: number | null;

  /** Free-text terms / note (e.g. "GST extra, 50% advance, sample ready"). */
  @Prop({ type: String, trim: true, maxlength: 2000, default: '' })
  message: string;

  /** sent -> live; shortlisted -> buyer finalist; accepted -> buyer picked it
   *  (RFQ awarded); declined (buyer) / withdrawn (seller). */
  @Prop({ type: String, enum: QUOTE_STATUSES, default: 'sent' })
  status: QuoteStatus;

  /**
   * Denormalized "this is seeded demo/sample content" flag, stamped AT CREATE
   * from the seller's `User.isDemo` (same contract as Rfq.isDemo / Post
   * .authorErpLinked). Drives the FE "Sample" badge on a quote AND keeps demo
   * quotes out of a real RFQ's aggregates (quotesCount / lowestQuotePrice /
   * quoteStats) -- see RfqService.recomputeLowestQuote + createQuote. Default
   * false so every real + every legacy quote is non-demo.
   */
  @Prop({ type: Boolean, default: false })
  isDemo: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type QuoteDocument = Quote & Document;

export const QuoteSchema = SchemaFactory.createForClass(Quote);

// One quote per seller per RFQ (the seller edits/withdraws instead of stacking).
QuoteSchema.index({ rfqId: 1, sellerUserId: 1 }, { unique: true });
// A seller's own sent quotes, newest first.
QuoteSchema.index({ sellerUserId: 1, createdAt: -1 });
