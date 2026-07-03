import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Raw Razorpay webhook event log. Every event delivered to the platform
 * webhook endpoint lands here BEFORE dispatch. Provides:
 *   - replay capability for failed processing (admin tool).
 *   - audit trail independent of any business-side state.
 *   - dedup via the gateway-supplied event id (`x-razorpay-event-id` header).
 */
@Schema({ timestamps: true, collection: 'razorpaywebhookevents' })
export class RazorpayWebhookEvent extends Document {
  /** Razorpay's idempotency id for the delivery; unique per event. */
  @Prop({ type: String, required: true, unique: true, index: true })
  eventId: string;

  /** Event type, e.g. 'payment.captured', 'subscription.charged'. */
  @Prop({ type: String, required: true, index: true })
  eventType: string;

  /** Verified flag — was the HMAC signature valid? */
  @Prop({ default: false })
  signatureVerified: boolean;

  /** Raw body bytes as a string (preserved for re-verification on replay). */
  @Prop({ type: String, required: true })
  rawBody: string;

  /** Parsed payload (convenience). Source of truth is `rawBody`. */
  @Prop({ type: Object })
  payload?: Record<string, unknown>;

  /** Gateway-side handle most relevant to the event. */
  @Prop({ type: String, index: true, sparse: true })
  gatewayPaymentId?: string;

  @Prop({ type: String, index: true, sparse: true })
  gatewayOrderId?: string;

  @Prop({ type: String, index: true, sparse: true })
  gatewaySubscriptionId?: string;

  /** Dispatch + processing status. */
  @Prop({
    enum: ['received', 'processing', 'processed', 'failed', 'ignored'],
    default: 'received',
    index: true,
  })
  status: string;

  /** When the dispatch finished. */
  @Prop({ type: Date })
  processedAt?: Date;

  /** Error message if processing failed. Truncated, no PII. */
  @Prop({ type: String })
  errorMessage?: string;

  /** How many times the event has been re-attempted via admin replay. */
  @Prop({ default: 0 })
  replayCount: number;
}

export const RazorpayWebhookEventSchema =
  SchemaFactory.createForClass(RazorpayWebhookEvent);
