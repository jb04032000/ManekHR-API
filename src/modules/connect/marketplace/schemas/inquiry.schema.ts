import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Listing } from './listing.schema';
import { User } from '../../../users/schemas/user.schema';

/**
 * ManekHR Connect Marketplace -- `Inquiry` collection (Phase M1.5).
 *
 * A buyer's interest signal on a listing: the buyer taps "Contact seller" on
 * a listing card, optionally attaches a short message, and the platform
 * persists a row that the seller sees in their inquiries inbox. Buyers and
 * sellers transact OFF platform (the mediator model) so the inquiry holds
 * only the lead signal -- no chat, no payment, no commitment.
 *
 * PERSON-CENTRIC: `buyerUserId` is the authenticated viewer (never read from
 * the request body); `sellerUserId` is denormalized from `listing.ownerUserId`
 * at create time so the seller's inbox queries do not need a join. Both are
 * `User` references; Connect has no workspace concept.
 *
 * Two business rules baked into the indexes:
 *
 *   1. **Dedupe** -- a buyer can only have ONE inquiry per listing. The
 *      compound `{listingId, buyerUserId}` unique index enforces it; the
 *      service catches the `E11000` and returns the existing row so the
 *      buyer's UX never sees a duplicate error.
 *   2. **Lead metering** -- the seller's per-cycle inquiry count drives the
 *      `ConnectAllowanceService.canUseLead` gate. The `sellerUserId + createdAt`
 *      index keeps the cycle count cheap.
 *
 * The status field tracks the seller-facing lifecycle (`sent` -> `viewed` ->
 * `replied` / `archived`); M1.5 only emits `sent`. The other transitions land
 * with the seller's inbox UI in M1.6.
 */

/** `Inquiry.status` -- the seller-facing lifecycle. */
export const INQUIRY_STATUSES = ['sent', 'viewed', 'replied', 'archived'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

@Schema({ timestamps: true, collection: 'connect_inquiries' })
export class Inquiry extends Document {
  /** The listing the buyer is interested in (public + approved at create time). */
  @Prop({ type: Types.ObjectId, ref: 'Listing', required: true })
  listingId: Listing | Types.ObjectId;

  /** The buyer (always the authenticated viewer). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  buyerUserId: User | Types.ObjectId;

  /** The seller (denormalized from `listing.ownerUserId` so inbox queries skip a join). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  sellerUserId: User | Types.ObjectId;

  /** Optional buyer note; bounded so a low-literacy SMB buyer can fire one quickly. */
  @Prop({ type: String, trim: true, maxlength: 1000, default: '' })
  message: string;

  /** Seller-facing lifecycle state. M1.5 only writes `sent`; M1.6 adds the rest. */
  @Prop({ type: String, enum: INQUIRY_STATUSES, default: 'sent' })
  status: InquiryStatus;

  createdAt?: Date;
  updatedAt?: Date;
}

export type InquiryDocument = Inquiry & Document;

export const InquirySchema = SchemaFactory.createForClass(Inquiry);

// Dedupe: a buyer can only have one inquiry per listing. The service catches
// the resulting E11000 and returns the existing row so the UX never sees a
// duplicate error.
InquirySchema.index({ listingId: 1, buyerUserId: 1 }, { unique: true });
// Seller's inbox: newest received first.
InquirySchema.index({ sellerUserId: 1, createdAt: -1 });
// Buyer's outbox: newest sent first.
InquirySchema.index({ buyerUserId: 1, createdAt: -1 });
// Lead-cap counting: count inquiries received by a seller within the current
// cycle window. Same index as the inbox covers it.
