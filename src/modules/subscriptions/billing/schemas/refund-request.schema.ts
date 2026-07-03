import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Refund request lifecycle (D1h).
 *
 * Created by either:
 *   - Customer self-serve (when `RefundPolicy.customerSelfServiceEnabled`).
 *     Auto-approved + executed if within window AND policy allows it
 *     without secondary approval. Otherwise enters `pending_admin`.
 *   - Admin-direct (admin issues refund without prior request from
 *     customer — e.g. proactive goodwill credit). Created in
 *     `approved` state and executed immediately.
 *
 * State machine:
 *   pending_admin → approved | rejected
 *   approved      → processing → processed | failed
 *
 * Idempotency: at most one in-flight request per payment (unique
 * partial index on `subscriptionPaymentId` while status is
 * `pending_admin` or `approved` or `processing`). A second request
 * for a payment that already has an in-flight refund is rejected at
 * service layer.
 *
 * On `processed`, the matching refund subdoc on the SubscriptionPayment
 * is updated by the existing webhook handler (D1d wired
 * `refund.created/processed`).
 */
@Schema({ timestamps: true, collection: 'refundrequests' })
export class RefundRequest extends Document {
  // Indexed by the explicit UNIQUE PARTIAL index
  // `RefundRequestSchema.index({ subscriptionPaymentId: 1 }, { unique, partialFilterExpression })`
  // below (enforces one in-flight refund per payment). Do NOT add `index: true`
  // here too: it created a redundant non-unique {subscriptionPaymentId:1} index
  // (the "Duplicate schema index" warning), and because both auto-name to
  // `subscriptionPaymentId_1` the collision risked the partial-unique index not
  // building. RefundRequest is only ever read by `_id`, so no plain all-status
  // index on this field is needed. Keep this @Prop and that .index() in sync on merge.
  @Prop({
    type: Types.ObjectId,
    ref: 'SubscriptionPayment',
    required: true,
  })
  subscriptionPaymentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  /** Amount being refunded in paise. Same as full payment for a full refund. */
  @Prop({ required: true })
  amountPaise: number;

  /** Whether this is a partial refund (`amountPaise < payment.totalPaise`). */
  @Prop({ default: false })
  isPartial: boolean;

  @Prop({ type: String, required: true, maxlength: 500 })
  reason: string;

  @Prop({
    enum: ['pending_admin', 'approved', 'rejected', 'processing', 'processed', 'failed'],
    default: 'pending_admin',
    index: true,
  })
  status: string;

  /** 'self' = customer-initiated; 'admin' = direct admin issuance. */
  @Prop({ enum: ['self', 'admin'], required: true })
  initiatedBy: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  approvedBy?: Types.ObjectId;

  @Prop({ type: Date })
  approvedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  rejectedBy?: Types.ObjectId;

  @Prop({ type: Date })
  rejectedAt?: Date;

  @Prop({ type: String, maxlength: 500 })
  rejectionReason?: string;

  /** Razorpay refund id once executed. Unique sparse — protects against double-refund. */
  @Prop({ type: String, index: true, sparse: true, unique: true })
  gatewayRefundId?: string;

  @Prop({ type: Date })
  processedAt?: Date;

  @Prop({ type: String, maxlength: 500 })
  failureReason?: string;

  /**
   * Speed used at gateway. `normal` (free, 3-5 working days) is the
   * default. `optimum` is admin-override for instant refunds (extra fees).
   */
  @Prop({ enum: ['normal', 'optimum'], default: 'normal' })
  speed: string;
}

export const RefundRequestSchema = SchemaFactory.createForClass(RefundRequest);

// One in-flight refund request per payment. Excludes terminal states
// (rejected, processed, failed). Protects against double-refund races.
// SINGLE source of the {subscriptionPaymentId:1} index — the @Prop above
// intentionally omits `index` so this partial-unique index is the only one.
RefundRequestSchema.index(
  { subscriptionPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['pending_admin', 'approved', 'processing'] },
    },
  },
);

// Hot path — admin queue.
RefundRequestSchema.index({ status: 1, createdAt: -1 });
