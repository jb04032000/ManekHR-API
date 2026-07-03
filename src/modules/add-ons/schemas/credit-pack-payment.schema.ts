import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Wave 7 — payment intent + capture record for user-initiated credit-pack
 * purchases. Distinct from `SubscriptionPayment` (plan-bound) because the
 * credit-pack flow has no plan/billingCycle anchor — only the AddOnDefinition.
 *
 * Lifecycle: created → captured (Razorpay paid) → activated (PurchasedAddOn
 * created + balance applied). `failed` and `cancelled` are terminal.
 *
 * Idempotency: `gatewayPaymentId` is unique-indexed; replayed webhooks /
 * confirm calls are deduped at write time.
 */
@Schema({ timestamps: true, collection: 'creditpackpayments' })
export class CreditPackPayment extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Subscription', required: true, index: true })
  subscriptionId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'AddOnDefinition', required: true })
  addOnDefinitionId: Types.ObjectId;

  @Prop({ required: true, default: 1 })
  quantity: number;

  @Prop({
    enum: ['created', 'captured', 'activated', 'failed', 'cancelled'],
    default: 'created',
    index: true,
  })
  status: string;

  @Prop({ type: String, index: true, sparse: true })
  gatewayOrderId?: string;

  @Prop({ type: String, index: true, sparse: true, unique: true })
  gatewayPaymentId?: string;

  @Prop({ required: true })
  amountPaise: number;

  /** Linked PurchasedAddOn id once activated. */
  @Prop({ type: Types.ObjectId, ref: 'PurchasedAddOn', sparse: true })
  purchasedAddOnId?: Types.ObjectId;

  @Prop({ type: Date })
  capturedAt?: Date;

  @Prop({ type: Date })
  activatedAt?: Date;

  @Prop({ type: String })
  failureReason?: string;
}

export const CreditPackPaymentSchema =
  SchemaFactory.createForClass(CreditPackPayment);

CreditPackPaymentSchema.index({ userId: 1, createdAt: -1 });
CreditPackPaymentSchema.index({ status: 1, createdAt: -1 });
