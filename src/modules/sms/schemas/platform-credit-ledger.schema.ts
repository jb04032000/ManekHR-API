import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Wave 8.2 — append-only audit ledger for platform marketing credit pool.
 *
 * Every top-up + every campaign send writes a row here. Powers:
 *   - Admin marketing dashboard (recent activity feed)
 *   - Monthly reconciliation against MSG91 invoices for marketing-attributed
 *     burn vs customer-attributed burn
 *   - Audit trail for compliance / tax (marketing spend separate from
 *     customer-revenue cost of goods sold)
 *
 * Never mutated. New rows only.
 */
@Schema({ timestamps: true, collection: 'platformcreditledgers' })
export class PlatformCreditLedger extends Document {
  @Prop({ required: true, enum: ['sms', 'whatsapp'], index: true })
  channel: string;

  @Prop({ required: true, enum: ['topup', 'send', 'adjustment'], index: true })
  type: string;

  /** Positive on top-up + adjustment-add; negative on send + adjustment-deduct. */
  @Prop({ required: true })
  amount: number;

  /** Resulting balance after this row applied. Lets dashboard reconstruct
   * timeline without aggregating from zero. */
  @Prop({ required: true, min: 0 })
  balanceAfter: number;

  /** Admin user that recorded the row. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  recordedBy?: Types.ObjectId;

  /** For send rows: count of recipients in the dispatch. For topup: optional MSG91 ref. */
  @Prop({ type: String })
  ref?: string;

  @Prop({ type: String })
  note?: string;

  /** Optional link back to the campaign / dispatch that consumed credits. */
  @Prop({ type: Types.ObjectId })
  campaignId?: Types.ObjectId;
}

export const PlatformCreditLedgerSchema =
  SchemaFactory.createForClass(PlatformCreditLedger);

PlatformCreditLedgerSchema.index({ channel: 1, createdAt: -1 });
