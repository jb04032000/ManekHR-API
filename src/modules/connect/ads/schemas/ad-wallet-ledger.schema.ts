import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdWalletLedger` collection.
 *
 * Append-only money trail for the advertiser wallet. Every credit balance
 * change (topup, reserve, debit, release, refund, adjustment, grant,
 * grant_expire, forfeit) writes one row.
 * Mirrors the PlatformCreditLedger pattern from the billing module.
 *
 * `amount` is SIGNED: positive for credits flowing in (topup, release, refund),
 * negative for credits flowing out (reserve, debit) or correction adjustments.
 *   forfeit -> amount is -negative (reserved released with no credit back;
 *              account-purge only — a hard-deleted account's unspent boost budget
 *              is destroyed, not refunded, per owner decision OQ-2 2026-07-02).
 * `balanceAfter` / `reservedAfter` are snapshots taken atomically at write time
 * so any point-in-time balance can be reconstructed without replaying the chain.
 *
 * `idempotencyKey` is optional but when present must be unique (enforced via a
 * partial unique index below -- never put `unique: true` on the prop itself
 * because `null` / undefined values would collide on a plain unique index).
 */
@Schema({ timestamps: true, collection: 'ad_wallet_ledgers' })
export class AdWalletLedger extends Document {
  /** The advertiser user this ledger row belongs to. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerUserId: Types.ObjectId;

  /** What caused this balance movement. */
  @Prop({
    type: String,
    enum: [
      'topup',
      'reserve',
      'debit',
      'release',
      'refund',
      'adjustment',
      // M0.6 - Connect included-credit grants (separate, expiring grantBalance).
      'grant',
      'grant_expire',
      // Connect referral reward (free credits; kept distinct from topup/grant for tax/records).
      'referral',
      // Account-purge forfeit (CN-PURGE-1): reserved released with NO credit back
      // when a hard-deleted account's boost source is purged. Distinct from
      // `release` (which credits balance) so the paper trail shows the money was
      // destroyed, not returned. See wallet.service sign-convention header.
      'forfeit',
    ],
    required: true,
  })
  type: string;

  /**
   * Credit amount for this row. SIGNED -- can be negative (debit / reserve).
   * No min constraint so adjustments can correct any direction.
   */
  @Prop({ type: Number, required: true })
  amount: number;

  /** Snapshot of `AdvertiserWallet.balance` immediately after this write. */
  @Prop({ type: Number, required: true })
  balanceAfter: number;

  /** Snapshot of `AdvertiserWallet.reserved` immediately after this write. */
  @Prop({ type: Number, required: true })
  reservedAfter: number;

  /**
   * Snapshot of `AdvertiserWallet.grantBalance` immediately after this write.
   * Present on the rows that move the grant bucket (grant / grant_expire, and
   * reserve when a grant is drawn down); omitted on legacy purchased-only rows.
   */
  @Prop({ type: Number })
  grantBalanceAfter?: number;

  /** The campaign this row is associated with, when applicable. */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign' })
  campaignId?: Types.ObjectId;

  /**
   * Caller-supplied dedup key. When present, the partial unique index
   * (declared below) prevents duplicate processing. Omit for manual
   * adjustments that have no natural idempotency key.
   */
  @Prop({ type: String })
  idempotencyKey?: string;

  /** External reference (payment gateway txn ID, invoice number, etc.). */
  @Prop({ type: String })
  ref?: string;

  /** Human-readable note for admin reconciliation. */
  @Prop({ type: String })
  note?: string;

  /** The user who triggered this ledger entry (admin or system). */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  recordedBy?: Types.ObjectId;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdWalletLedgerDocument = AdWalletLedger & Document;

export const AdWalletLedgerSchema = SchemaFactory.createForClass(AdWalletLedger);

// User money trail -- newest rows first, the most common read pattern.
AdWalletLedgerSchema.index({ ownerUserId: 1, createdAt: -1 });

// Partial unique index: idempotencyKey must be unique ONLY when it is present.
// A plain unique index would treat multiple `undefined` values as duplicates.
AdWalletLedgerSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } },
);
