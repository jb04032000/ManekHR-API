import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdWalletTopup` collection.
 *
 * Payment intent + capture record for advertiser-initiated wallet top-ups
 * through the gateway (Razorpay). Mirrors the billing module's
 * `CreditPackPayment` shape but is person-centric: the owner is a Connect
 * `User` (`ownerUserId`), never a workspace -- Connect has no workspace.
 *
 * Lifecycle: created -> paid (Razorpay signature verified + wallet credited)
 * or created -> failed (signature verification failed). `failed` is terminal.
 *
 * The wallet itself is denominated in RUPEES (1 credit = INR 1 ex-GST), so we
 * persist both `amountRupees` (credited to the wallet) and `amountPaise`
 * (what Razorpay charged). Conversion happens once at the gateway boundary.
 *
 * Idempotency: `razorpayOrderId` is unique-indexed; a replayed confirm against
 * an already-`paid` intent is a safe no-op (handled in the service) and the
 * wallet-ledger idempotencyKey prevents a double credit at the ledger layer.
 */
@Schema({ timestamps: true, collection: 'ad_wallet_topups' })
export class AdWalletTopup extends Document {
  /** The advertiser user who initiated this top-up. One owner per intent. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  ownerUserId: Types.ObjectId;

  /** Amount credited to the wallet on success, in whole rupees. Min 99. */
  @Prop({ type: Number, required: true, min: 99 })
  amountRupees: number;

  /** Amount charged via Razorpay, in paise (amountRupees * 100). */
  @Prop({ type: Number, required: true })
  amountPaise: number;

  /** Settlement currency. INR only for the Indian market. */
  @Prop({ type: String, required: true, default: 'INR' })
  currency: string;

  /** Razorpay order id returned by orders.create. Unique across intents. */
  @Prop({ type: String, required: true, unique: true })
  razorpayOrderId: string;

  /** Razorpay payment id from the signed checkout payload. Set on confirm. */
  @Prop({ type: String })
  razorpayPaymentId?: string;

  /** Intent lifecycle state. */
  @Prop({
    type: String,
    enum: ['created', 'paid', 'failed'],
    default: 'created',
    index: true,
  })
  status: string;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdWalletTopupDocument = AdWalletTopup & Document;

export const AdWalletTopupSchema = SchemaFactory.createForClass(AdWalletTopup);

// Owner top-up history -- newest rows first, the most common read pattern.
AdWalletTopupSchema.index({ ownerUserId: 1, createdAt: -1 });

// One intent per Razorpay order id. `unique: true` on the @Prop above already
// declares this; the explicit index keeps the intent self-documenting and
// matches the credit-pack-payment convention.
AdWalletTopupSchema.index({ razorpayOrderId: 1 }, { unique: true });
