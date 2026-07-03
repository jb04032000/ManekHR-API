import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One row per payment attempt. Captures the gateway-side identifiers, the
 * captured/refunded amounts in paise, the GST breakdown, and any coupon
 * redemption that altered the charged amount. Supports the full audit trail
 * for both one-time orders and recurring auto-debit charges.
 *
 * Lifecycle:
 *   created   → order created on gateway, awaiting authorisation.
 *   captured  → payment captured, money in.
 *   failed    → payment authorisation/capture failed; `failureReason` set.
 *   refunded  → fully refunded.
 *   partially_refunded — at least one refund < full amount.
 *
 * Idempotency:
 *   - `gatewayPaymentId` is unique-indexed; a duplicate webhook delivery for
 *     the same `payment.captured` event is rejected at write time.
 *   - `idempotencyKey` (caller-supplied) gates client retries before the
 *     order is even created.
 */
@Schema({ _id: false })
export class SubscriptionPaymentRefund {
  @Prop({ type: String, required: true })
  refundId: string;

  @Prop({ required: true })
  amountPaise: number;

  @Prop({ type: String })
  reason?: string;

  @Prop({ enum: ['pending', 'processed', 'failed'], default: 'pending' })
  status: string;

  @Prop({ type: Date, default: () => new Date() })
  initiatedAt: Date;

  @Prop({ type: Date })
  processedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  initiatedBy?: Types.ObjectId;
}

@Schema({ timestamps: true, collection: 'subscriptionpayments' })
export class SubscriptionPayment extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  /** Subscription this payment is bound to. May be set after a successful capture. */
  @Prop({ type: Types.ObjectId, ref: 'Subscription', index: true })
  subscriptionId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Plan', required: true })
  planId: Types.ObjectId;

  @Prop({ enum: ['monthly', 'yearly', 'lifetime'], required: true })
  billingCycle: string;

  /** 'one_time' = single order; 'recurring' = via Razorpay Subscriptions API. */
  @Prop({ enum: ['one_time', 'recurring'], required: true })
  paymentMode: string;

  /**
   * What this payment row was raised for.
   *   'checkout'    = a fresh subscription purchase (the default — every
   *                   pre-Task-4 row is implicitly a checkout payment).
   *   'plan_change' = an upgrade proration charge raised by the
   *                   customer-facing change-plan flow (Task 4).
   *
   * Existing rows have no `context` persisted; the schema default backfills
   * them to `'checkout'` on read, so no migration is required.
   */
  @Prop({ type: String, enum: ['checkout', 'plan_change'], default: 'checkout' })
  context: string;

  @Prop({
    enum: [
      'created',
      'authorised',
      'captured',
      'failed',
      'refunded',
      'partially_refunded',
      'cancelled',
    ],
    default: 'created',
    index: true,
  })
  status: string;

  // ── Gateway side ──────────────────────────────────────────────────────
  @Prop({ enum: ['razorpay', 'manual'], default: 'razorpay' })
  gateway: string;

  /** Razorpay order id (or n/a for manual). */
  @Prop({ type: String, index: true, sparse: true })
  gatewayOrderId?: string;

  /** Razorpay payment id once captured. UNIQUE — dedups webhook replays. */
  @Prop({ type: String, index: true, sparse: true, unique: true })
  gatewayPaymentId?: string;

  /** Razorpay subscription id when paymentMode='recurring'. */
  @Prop({ type: String, index: true, sparse: true })
  gatewaySubscriptionId?: string;

  /**
   * Razorpay payment-link id (D1i) — set when admin issued the
   * payment via `POST /admin/billing/payment-links`. The link's
   * `payment_link.paid` webhook round-trips back via this id.
   */
  @Prop({ type: String, index: true, sparse: true })
  gatewayPaymentLinkId?: string;

  /** Caller-supplied idempotency key, dedups client retries. */
  @Prop({ type: String, sparse: true })
  idempotencyKey?: string;

  // ── Amounts (paise) ───────────────────────────────────────────────────
  /** Plan's listed price for the chosen cycle. */
  @Prop({ required: true })
  planPricePaise: number;

  /** Discount applied via coupon (paise). */
  @Prop({ default: 0 })
  discountPaise: number;

  /** GST in paise (taxableBasePaise * gstRate%). */
  @Prop({ default: 0 })
  gstPaise: number;

  /** Net amount paid by the customer. */
  @Prop({ required: true })
  totalPaise: number;

  /** GST rate at the time of charge (snapshot — plan rate may change later). */
  @Prop({ default: 18 })
  gstRatePercent: number;

  // ── Coupon snapshot ───────────────────────────────────────────────────
  @Prop({ type: Types.ObjectId, ref: 'Coupon' })
  appliedCouponId?: Types.ObjectId;

  @Prop({ type: String })
  appliedCouponCode?: string;

  // ── Manual payment fields (when gateway='manual') ────────────────────
  @Prop({ type: String })
  manualReceiptNumber?: string;

  @Prop({ type: String })
  manualPaymentMethod?: string; // 'neft' | 'cheque' | 'cash' | etc.

  @Prop({ type: Date })
  manualPaymentDate?: Date;

  @Prop({ type: String })
  manualNotes?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  manualRecordedBy?: Types.ObjectId;

  // ── Failure ───────────────────────────────────────────────────────────
  @Prop({ type: String })
  failureReason?: string;

  @Prop({ type: Number })
  attemptNumber?: number;

  // ── Refunds ───────────────────────────────────────────────────────────
  @Prop({ type: [SubscriptionPaymentRefund], default: [] })
  refunds: SubscriptionPaymentRefund[];

  // ── GST invoice generated for this payment ────────────────────────────
  @Prop({ type: String, index: true, sparse: true })
  invoiceNumber?: string;

  @Prop({ type: String })
  invoicePdfUrl?: string;

  @Prop({ type: Date })
  invoiceGeneratedAt?: Date;

  /**
   * Billing-profile snapshot at order/mandate creation time (D1f). The
   * invoice generator reads ONLY from this snapshot — never re-reads
   * the User — so historical invoices remain reproducible after the
   * customer edits their billing profile.
   *
   * `recipientName` defaults to User.name; `recipientEmail` defaults
   * to User.email. Other fields come from `User.billingProfile`.
   */
  @Prop({
    type: {
      recipientName: { type: String, required: false },
      recipientEmail: { type: String, required: false },
      recipientContact: { type: String, required: false },
      gstin: { type: String, required: false },
      businessName: { type: String, required: false },
      addressLine1: { type: String, required: false },
      addressLine2: { type: String, required: false },
      city: { type: String, required: false },
      state: { type: String, required: false },
      stateCode: { type: String, required: false },
      pincode: { type: String, required: false },
      country: { type: String, required: false, default: 'India' },
    },
    required: false,
    _id: false,
  })
  billingSnapshot?: {
    recipientName?: string;
    recipientEmail?: string;
    recipientContact?: string;
    gstin?: string;
    businessName?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    stateCode?: string;
    pincode?: string;
    country?: string;
  };

  // ── Timing ────────────────────────────────────────────────────────────
  @Prop({ type: Date })
  authorisedAt?: Date;

  @Prop({ type: Date })
  capturedAt?: Date;

  @Prop({ type: Date })
  failedAt?: Date;
}

export const SubscriptionPaymentSchema = SchemaFactory.createForClass(SubscriptionPayment);

// Hot-path: list a user's payment history newest-first.
SubscriptionPaymentSchema.index({ userId: 1, createdAt: -1 });
// Hot-path: admin filter by status + date.
SubscriptionPaymentSchema.index({ status: 1, createdAt: -1 });
