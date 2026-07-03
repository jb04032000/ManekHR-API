import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReferralStatus = 'pending' | 'qualified' | 'rewarded' | 'rejected';

/**
 * Connect Referrals -- one row per referred person (tracking + audit).
 * What: lifecycle pending -> qualified (active, credit on hold) -> rewarded
 *   (credited, spendable); or rejected (cap/fraud/clawback).
 * Cross-module links: referrer/referee -> User; referrerLedgerId/refereeLedgerId
 *   -> AdWalletLedger (the granted credit rows). Powers /connect/referrals/me
 *   stats + the admin log.
 * Watch: refereeUserId is UNIQUE (each person referred at most once). Amounts are
 *   snapshotted at qualify time -- never re-read from live config when rewarding.
 */
@Schema({ timestamps: true, collection: 'connect_referrals' })
export class ConnectReferral extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  referrerUserId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  refereeUserId: Types.ObjectId;

  @Prop({ type: String, required: true })
  codeUsed: string;

  @Prop({
    type: String,
    enum: ['pending', 'qualified', 'rewarded', 'rejected'],
    required: true,
    default: 'pending',
  })
  status: ReferralStatus;

  @Prop({ type: String })
  rejectionReason?: string; // self_referral | duplicate | cap_exceeded | budget_exceeded | velocity | fraud_review | manual_clawback

  @Prop({ type: Number, default: 0 })
  referrerCreditAmount: number;

  @Prop({ type: Number, default: 0 })
  refereeCreditAmount: number;

  @Prop({ type: Date })
  qualifiedAt?: Date;

  @Prop({ type: Date })
  rewardedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'AdWalletLedger' })
  referrerLedgerId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'AdWalletLedger' })
  refereeLedgerId?: Types.ObjectId;

  /**
   * Per-side clawback guards (manual reversal idempotency). Set true once a side
   * has been handled by `ReferralService.clawback` -- either its credit was
   * reversed via wallet.adjust, OR the credit was already spent (wallet floored
   * the balance and rejected the debit), in which case we record "we did what we
   * could" and never re-attempt. A retried clawback skips any side already
   * flagged, so a reversal can never be applied twice (no double-debit). Additive,
   * default false -- legacy rows behave as not-yet-clawed.
   */
  @Prop({ type: Boolean, default: false })
  referrerClawedBack?: boolean;

  @Prop({ type: Boolean, default: false })
  refereeClawedBack?: boolean;

  @Prop({ type: Object })
  signupContext?: {
    ipHash?: string;
    deviceHash?: string;
    refereeMobileSnapshot?: string;
    refereeEmailSnapshot?: string;
  };

  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectReferralDocument = ConnectReferral & Document;
export const ConnectReferralSchema = SchemaFactory.createForClass(ConnectReferral);

ConnectReferralSchema.index({ referrerUserId: 1, createdAt: -1 });
ConnectReferralSchema.index({ status: 1, qualifiedAt: 1 }); // release cron scan
