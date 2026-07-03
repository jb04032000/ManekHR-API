import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Wave 8.2 — platform-side credit pool for marketing campaigns.
 *
 * Decoupled from customer credit-pack balances:
 *   - Customer balance lives on `Subscription.appliedEntitlements.communications`.
 *   - This pool is a separate counter the platform owner tops up MANUALLY
 *     (after paying MSG91/AiSensy out-of-band) and then debits when sending
 *     marketing campaigns from `/admin/communications/marketing`.
 *
 * One row per channel. Atomic `$inc` on top-up + send. Audit trail goes to
 * `PlatformCreditLedger` (separate collection).
 */
@Schema({ timestamps: true, collection: 'platformcreditpools' })
export class PlatformCreditPool extends Document {
  @Prop({ required: true, enum: ['sms', 'whatsapp'], unique: true })
  channel: string;

  /** Current balance in credits (NOT paise — credits map 1:1 to MSG91 sends). */
  @Prop({ required: true, default: 0, min: 0 })
  balance: number;

  /** Last manual top-up timestamp for ops dashboard display. */
  @Prop({ type: Date })
  lastTopUpAt?: Date;
}

export const PlatformCreditPoolSchema =
  SchemaFactory.createForClass(PlatformCreditPool);
