import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Marketplace -- promotional credit-drop campaign (Phase M3.2).
 *
 * An admin-triggered gift of free boost credits to a set of Connect sellers.
 * Each drop grants `amountPerUser` credits into every recipient's EXPIRING
 * grant bucket (the same bucket plan-included boost credits land in -- see
 * WalletService.grant / IncludedCreditsGrantCron), so the credits are clearly
 * promotional, spent before purchased balance, and (optionally) expire.
 *
 * This row is the campaign record: it exists for the admin history list, for
 * audit, and to key the per-user grant idempotency (`promo-drop-<id>-<userId>`)
 * so a retried drop never double-credits. The actual per-user money movement is
 * the AdWalletLedger `grant` rows; this is the campaign envelope over them.
 */
@Schema({ collection: 'connect_credit_drops', timestamps: true })
export class ConnectCreditDrop extends Document {
  /** Credits granted to each recipient. */
  @Prop({ required: true, min: 1 })
  amountPerUser: number;

  /** Admin-readable reason / campaign label (e.g. "Diwali 2026 seller gift"). */
  @Prop({ required: true, trim: true })
  note: string;

  /** When the granted credits expire. `null` = no expiry (stay until spent). */
  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  /**
   * Who received the drop:
   *  - `subscribers`: every active Connect / bundle subscriber (optionally
   *    narrowed to a single plan via `planId`).
   *  - `users`: an explicit list of Connect users (`targetUserIds`).
   */
  @Prop({ type: String, enum: ['subscribers', 'users'], required: true })
  targetMode: string;

  /** Optional plan filter for `subscribers` mode. `null` = all plans. */
  @Prop({ type: Types.ObjectId, ref: 'Plan', default: null })
  planId: Types.ObjectId | null;

  /** The explicit recipient ids for `users` mode (empty for `subscribers`). */
  @Prop({ type: [Types.ObjectId], ref: 'User', default: [] })
  targetUserIds: Types.ObjectId[];

  /** How many sellers were actually credited (after dedupe + per-user success). */
  @Prop({ default: 0 })
  recipientCount: number;

  /** recipientCount * amountPerUser -- the total credits handed out. */
  @Prop({ default: 0 })
  totalCreditsGranted: number;

  /** The platform admin who ran the drop (from the JWT subject, never the body). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;
}

export type ConnectCreditDropDocument = ConnectCreditDrop & Document;

export const ConnectCreditDropSchema = SchemaFactory.createForClass(ConnectCreditDrop);

// Admin history list is newest-first.
ConnectCreditDropSchema.index({ createdAt: -1 });
