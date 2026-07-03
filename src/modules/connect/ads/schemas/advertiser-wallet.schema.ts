import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdvertiserWallet` collection.
 *
 * One prepaid credit wallet per advertiser user.
 * 1 credit = INR 1 ex-GST.
 *
 * `balance`  - spendable credits available for campaign activation.
 * `reserved` - credits locked by live/pending campaigns (not yet spent).
 *
 * Effective spend capacity = balance - reserved. Both fields are updated
 * atomically (findOneAndUpdate with $inc) by the campaign service to avoid
 * double-spend races. `reserved` is released back to `balance` on campaign
 * completion, cancellation, or expiry.
 */
@Schema({ timestamps: true, collection: 'ad_advertiser_wallets' })
export class AdvertiserWallet extends Document {
  /**
   * The advertiser user who owns this wallet. One wallet per user -- enforced
   * by the unique index below.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  ownerUserId: Types.ObjectId;

  /** Spendable credits available. Minimum 0; never goes negative. */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  balance: number;

  /**
   * Credits held by live campaigns. Deducted from `balance` when a campaign
   * is activated; returned when it ends. Minimum 0.
   */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  reserved: number;

  /**
   * Granted (plan-allowance) credits, e.g. a Connect plan's monthly included
   * boost credits. Spent BEFORE `balance` (grant-first) and swept to 0 each
   * cycle once `grantExpiresAt` passes, so unused grants do not roll over.
   * Purchased credits live in `balance` and persist. 1 credit = INR 1. Min 0.
   */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  grantBalance: number;

  /**
   * When the current `grantBalance` expires (the granting subscription's
   * `currentPeriodEnd`). The included-credits grant cron zeroes grantBalance
   * once this passes. `null` when there is no active grant.
   */
  @Prop({ type: Date, default: null })
  grantExpiresAt?: Date | null;

  /** Timestamp of the most recent top-up. `null` until the first top-up. */
  @Prop({ type: Date, default: null })
  lastTopUpAt?: Date | null;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdvertiserWalletDocument = AdvertiserWallet & Document;

export const AdvertiserWalletSchema = SchemaFactory.createForClass(AdvertiserWallet);

// `unique: true` on the @Prop already creates the unique index. No duplicate
// declaration here -- the prop-level flag is the single source of truth.
// (One wallet per Connect User -- Connect has no workspace concept.)
