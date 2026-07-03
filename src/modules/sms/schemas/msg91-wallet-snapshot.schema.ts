import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Wave 8 — hourly snapshot of MSG91 wallet balance.
 *
 * Written by `Msg91BalanceService` cron. Drives:
 *   - admin dashboard wallet card + 30d burn graph
 *   - low-watermark alerts (<5x daily burn → warn; <1x daily burn → page)
 *   - projection of zero-date for ops planning.
 *
 * Append-only — every poll writes a new row. Truncate via TTL or manual ops
 * job after 90 days (handled outside this schema).
 */
@Schema({ timestamps: true, collection: 'msg91walletsnapshots' })
export class Msg91WalletSnapshot extends Document {
  @Prop({ required: true, default: 'msg91' })
  provider: string;

  /** Wallet balance in paise. -1 if poll failed (preserve gap visibility). */
  @Prop({ required: true })
  balancePaise: number;

  /** When the poll happened. */
  @Prop({ required: true, default: () => new Date(), index: -1 })
  polledAt: Date;

  /** Raw MSG91 payload — last 1KB only, for ops debugging. */
  @Prop()
  rawResponse?: string;

  /** Error message if poll failed. */
  @Prop()
  errorMessage?: string;
}

export const Msg91WalletSnapshotSchema =
  SchemaFactory.createForClass(Msg91WalletSnapshot);
