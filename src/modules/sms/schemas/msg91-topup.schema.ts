import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Wave 8 — manual MSG91 wallet top-up audit log.
 *
 * MSG91 wallet auto-charge is intentionally NOT wired (decision N7 — protects
 * against runaway spend). Ops manually tops up via the MSG91 dashboard, then
 * records the top-up here for audit + reporting + balance-trend reconstruction
 * when the hourly poll is sparse.
 */
@Schema({ timestamps: true, collection: 'msg91topups' })
export class Msg91TopUp extends Document {
  @Prop({ required: true, default: 'msg91' })
  provider: string;

  /** Top-up amount recorded by ops (paise). */
  @Prop({ required: true, min: 1 })
  amountPaise: number;

  /** Admin user that recorded the top-up. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  recordedBy: Types.ObjectId;

  /** Optional MSG91-side reference id (transaction id from their dashboard). */
  @Prop()
  providerReferenceId?: string;

  /** Optional ops note. */
  @Prop()
  note?: string;
}

export const Msg91TopUpSchema = SchemaFactory.createForClass(Msg91TopUp);

Msg91TopUpSchema.index({ createdAt: -1 });
