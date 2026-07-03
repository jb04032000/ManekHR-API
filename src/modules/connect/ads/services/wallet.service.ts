import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AdvertiserWallet,
  type AdvertiserWalletDocument,
} from '../schemas/advertiser-wallet.schema';
import { AdWalletLedger, type AdWalletLedgerDocument } from '../schemas/ad-wallet-ledger.schema';
import { PostHogService } from '../../../../common/posthog/posthog.service';

/**
 * Ledger amount sign convention:
 *
 *   topup       -> amount is +positive  (purchased credits flowing in)
 *   release     -> amount is +positive  (credits returned from reserve)
 *   refund      -> amount is +positive  (credits returned to spendable)
 *   reserve     -> amount is -negative  (credits locked from grant+balance)
 *   debit       -> amount is -negative  (credits permanently consumed)
 *   adjustment  -> signed per direction of correction
 *   grant       -> amount is +positive  (plan-allowance credits into grantBalance)
 *   grant_expire -> amount is -negative (unused grant swept at cycle end)
 *   forfeit     -> amount is -negative  (reserved released with NO credit back;
 *                  account-purge only — the hold is freed so `reserved` doesn't
 *                  stay permanently inflated, but nothing flows to balance/grant)
 *
 * `balanceAfter` and `reservedAfter` are authoritative post-state snapshots
 * taken from the wallet after the atomic update. They allow point-in-time
 * reconstruction without replaying the full ledger chain.
 */

interface LedgerOpts {
  campaignId?: string;
  idempotencyKey?: string;
  ref?: string;
  note?: string;
  recordedBy?: string;
  /** Snapshot of grantBalance after the write (grant / grant_expire / reserve). */
  grantBalanceAfter?: number;
}

interface GrantMeta {
  /**
   * Caller-supplied dedup key (e.g. `grant-<subId>-<cycleStart>`). When present
   * a matching ledger row makes a re-grant a no-op, so a cycle is granted once.
   */
  idempotencyKey?: string;
  /** When the granted credits expire (the subscription's currentPeriodEnd). */
  expiresAt?: Date;
}

interface TopupMeta {
  ref?: string;
  recordedBy?: string;
  note?: string;
  /**
   * Caller-supplied dedup key. When present it is written to the ledger row's
   * partial-unique `idempotencyKey` index so a retried/racing top-up credits
   * exactly once (e.g. a re-confirmed gateway payment passes its payment id).
   */
  idempotencyKey?: string;
}

@Injectable()
export class WalletService {
  constructor(
    @InjectModel(AdvertiserWallet.name)
    private readonly walletModel: Model<AdvertiserWalletDocument>,
    @InjectModel(AdWalletLedger.name)
    private readonly ledgerModel: Model<AdWalletLedgerDocument>,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns the wallet for a user, creating an empty one (balance 0,
   * reserved 0) if it does not yet exist.
   *
   * The upsert is the atomic race-guard: two concurrent first-touches both
   * miss the findOne; the unique ownerUserId index makes the second upsert
   * resolve to the existing doc rather than inserting a duplicate.
   */
  async getWallet(ownerUserId: string): Promise<AdvertiserWalletDocument> {
    const existing = await this.walletModel.findOne({ ownerUserId });
    if (existing) return existing;

    return this.walletModel.findOneAndUpdate(
      { ownerUserId },
      { $setOnInsert: { balance: 0, reserved: 0 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ) as Promise<AdvertiserWalletDocument>;
  }

  /**
   * Credits the user wallet by `amount` and records a topup ledger row.
   *
   * Throws BadRequestException when amount <= 0.
   * Upserts the wallet if it does not exist yet.
   */
  async topup(
    ownerUserId: string,
    amount: number,
    meta?: TopupMeta,
  ): Promise<AdvertiserWalletDocument> {
    if (amount <= 0) {
      throw new BadRequestException('top-up amount must be positive');
    }

    // Idempotency fast-path: when the caller supplies a dedup key and a topup
    // ledger row already exists for it, this credit already happened. Return
    // the current wallet WITHOUT re-incrementing the balance (a retried /
    // racing gateway confirm must credit exactly once). The partial-unique
    // ledger index is the durable backstop for the concurrent case below.
    if (meta?.idempotencyKey) {
      const existing = await this.ledgerModel.findOne({
        idempotencyKey: meta.idempotencyKey,
      });
      if (existing) {
        return this.getWallet(ownerUserId);
      }
    }

    const updated = await this.walletModel.findOneAndUpdate(
      { ownerUserId },
      {
        $inc: { balance: amount },
        $set: { lastTopUpAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Write the topup ledger row directly (NOT via writeLedger, which swallows
    // 11000) so a concurrent duplicate that loses the unique-index race can be
    // undone -- otherwise the balance increment above would stick twice.
    if (meta?.idempotencyKey) {
      try {
        await this.ledgerModel.create({
          ownerUserId,
          type: 'topup',
          amount,
          balanceAfter: updated.balance,
          reservedAfter: updated.reserved,
          idempotencyKey: meta.idempotencyKey,
          ...(meta.ref !== undefined && { ref: meta.ref }),
          ...(meta.recordedBy !== undefined && { recordedBy: meta.recordedBy }),
          ...(meta.note !== undefined && { note: meta.note }),
        });
      } catch (err: unknown) {
        if ((err as { code?: number })?.code === 11000) {
          // Concurrent sibling already credited with this key. Undo our
          // balance increment so the credit lands exactly once, then return
          // the corrected wallet.
          const reverted = await this.walletModel.findOneAndUpdate(
            { ownerUserId },
            { $inc: { balance: -amount } },
            { new: true },
          );
          return (reverted ?? updated) as AdvertiserWalletDocument;
        }
        throw err;
      }
    } else {
      await this.writeLedger(ownerUserId, 'topup', amount, updated.balance, updated.reserved, {
        ref: meta?.ref,
        recordedBy: meta?.recordedBy,
        note: meta?.note,
      });
    }

    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'ads.wallet_topped_up',
      properties: {
        amount,
        balanceAfter: updated.balance,
      },
    });

    return updated;
  }

  /**
   * Admin manual credit (+) / debit (−) to the SPENDABLE `balance` bucket,
   * recording one `adjustment` ledger row. Used by the platform-admin wallet
   * console for goodwill credits, refunds, or corrections.
   *
   * `amount` is SIGNED whole rupees: positive credits, negative debits. Refuses
   * to drive `balance` below 0 (a debit larger than the current balance throws,
   * and NO ledger row is written). Never touches `grantBalance` or `reserved` —
   * granted credits are cycle-scoped and reserved is owned by the campaign
   * reserve/debit/release flow.
   *
   * The guarded ($gte) decrement makes the floor race-safe: a concurrent spend
   * that drops the balance under the requested debit makes the update miss and
   * the call rejects rather than going negative.
   */
  async adjust(
    ownerUserId: string,
    amount: number,
    adminUserId: string,
    reason: string,
    note?: string,
  ): Promise<AdvertiserWalletDocument> {
    if (!Number.isFinite(amount) || amount === 0) {
      throw new BadRequestException('amount must be a non-zero number');
    }

    // Ensure the wallet exists (upsert) so a first-touch admin credit has a row
    // to increment. getWallet also gives us the pre-state for the floor check.
    const wallet = await this.getWallet(ownerUserId);
    const next = (wallet.balance ?? 0) + amount;
    if (next < 0) {
      throw new BadRequestException('insufficient balance for this deduction');
    }

    // Guard the decrement so a debit can never drive balance below 0 even under
    // a concurrent spend. On a credit (amount > 0) the guard is trivially true.
    // On a debit the $gte ensures balance >= |amount| at write time.
    const filter: Record<string, unknown> = { ownerUserId };
    if (amount < 0) filter.balance = { $gte: -amount };

    const updated = await this.walletModel.findOneAndUpdate(
      filter,
      { $inc: { balance: amount } },
      { new: true },
    );
    if (!updated) {
      // The guard missed: a concurrent spend dropped the balance under the
      // requested debit between the read above and this write.
      throw new BadRequestException('insufficient balance for this deduction');
    }

    await this.writeLedger(ownerUserId, 'adjustment', amount, updated.balance, updated.reserved, {
      note: `${reason}${note ? ': ' + note : ''}`,
      recordedBy: adminUserId,
    });

    return updated;
  }

  /**
   * Reserves `amount` for a campaign, drawing the expiring grant bucket BEFORE
   * purchased balance (grant-first spend) so a plan's monthly free credits are
   * consumed before the user's bought credits.
   *
   * The grant/purchased split is computed from a read, then applied with a
   * guarded ($gte) update so a concurrent change can never overspend either
   * bucket; a guard miss means the wallet moved under us, so we recompute and
   * retry. The grant guard is omitted when nothing is drawn from grant, so a
   * wallet created before grantBalance existed (field absent) still matches and
   * behaves exactly as the original balance-only reserve.
   *
   * Returns true when the reserve succeeded, false when grant + balance combined
   * is insufficient (no ledger row is written in the false case). Thin boolean
   * wrapper over `reserveDetailed` for callers that don't need the split.
   */
  async reserve(ownerUserId: string, amount: number, campaignId: string): Promise<boolean> {
    return (await this.reserveDetailed(ownerUserId, amount, campaignId)).ok;
  }

  /**
   * CN-ADS-1 (Bucket 3): the split-aware reserve. Identical mechanics to the old
   * boolean `reserve`, but ALSO returns how the amount was split across the
   * expiring grant bucket vs purchased balance. The caller (boost.service)
   * accumulates that split onto the campaign (`reservedFromGrant` /
   * `reservedFromBalance`) so the matching `release()` can restore each credit to
   * the SAME bucket it came from, instead of always crediting 100% to purchased
   * balance (which silently converted expiring grant credits into permanent ones).
   *
   * On failure returns `{ ok:false, fromGrant:0, fromBalance:0 }` and writes no
   * ledger row — identical false-path behaviour to before.
   */
  async reserveDetailed(
    ownerUserId: string,
    amount: number,
    campaignId: string,
  ): Promise<{ ok: boolean; fromGrant: number; fromBalance: number }> {
    if (amount <= 0) throw new BadRequestException('reserve amount must be positive');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wallet = await this.walletModel.findOne({ ownerUserId });
      const grantBalance = wallet?.grantBalance ?? 0;
      const balance = wallet?.balance ?? 0;
      if (grantBalance + balance < amount) return { ok: false, fromGrant: 0, fromBalance: 0 };

      const fromGrant = Math.min(grantBalance, amount);
      const fromBalance = amount - fromGrant;

      // Guard only the buckets we actually draw from. Omitting the grant guard
      // when fromGrant is 0 keeps the query matching pre-grant wallets (no field).
      const filter: Record<string, unknown> = { ownerUserId, balance: { $gte: fromBalance } };
      if (fromGrant > 0) filter.grantBalance = { $gte: fromGrant };

      const inc: Record<string, number> = { balance: -fromBalance, reserved: amount };
      if (fromGrant > 0) inc.grantBalance = -fromGrant;

      const updated = await this.walletModel.findOneAndUpdate(filter, { $inc: inc }, { new: true });
      if (!updated) continue; // raced with a concurrent wallet write - recompute and retry

      const doc = updated as AdvertiserWalletDocument;
      await this.writeLedger(ownerUserId, 'reserve', -amount, doc.balance, doc.reserved, {
        campaignId,
        grantBalanceAfter: doc.grantBalance ?? 0,
      });
      return { ok: true, fromGrant, fromBalance };
    }

    return { ok: false, fromGrant: 0, fromBalance: 0 }; // persistent contention; caller may retry
  }

  /**
   * Charge-once debit: consumes `amount` from reserved for an impression/click.
   * Double-charge protection is INTRINSIC here - it does not depend on any
   * caller gating upstream.
   *
   * `idempotencyKey` is derived by the caller from the business event so the
   * same event always maps to the same key (see ad-events.service):
   *   - CPM impression debit -> the raw `impressionToken`.
   *   - CPC click debit      -> `'click:' + impressionToken`.
   * The two namespaces let a CPM-plus-click campaign carry both debits without
   * colliding on the partial-unique `idempotencyKey` ledger index.
   *
   * Grant-first does NOT apply here: the grant-vs-purchased split was already
   * decided at reserve() time, so `reserved` is origin-agnostic and debit simply
   * draws it down.
   *
   * Ordered-writes (claim-first) pattern -- the ledger row IS the charge-once
   * record, so we CLAIM the key BEFORE moving money:
   *   1. Insert the debit ledger row first. The partial-unique idempotencyKey
   *      index is the single gate: a replayed / retried / concurrently-raced
   *      charge for the same event collides here (11000) and no-ops, so the
   *      guarded decrement below can never run twice -- even if an upstream
   *      `charged` flag was forgotten.
   *   2. Apply the guarded ($gte) reserved decrement. On genuine insufficiency
   *      we release our just-inserted claim so a later legitimate retry is not
   *      permanently blocked, then reject.
   *   3. Finalize the authoritative balanceAfter / reservedAfter snapshot.
   *
   * This deliberately differs from topup() / grant(), which increment-then-write
   * (their money move is an unbounded, reversible credit that cannot fail).
   * debit's move is a guarded decrement that CAN fail, and re-running it after a
   * crash would double-charge -- so the claim must come first.
   *
   * Failure window: if the process dies after step 1 but before step 2, the key
   * is recorded yet `reserved` was never drawn down. A retry then no-ops, so the
   * event is UNDER-charged (never double) -- the safe direction. The ads reconcile
   * cron DETECTS this (report-only): its reserved-integrity pass reconstructs the
   * ledger-implied `reserved` per owner and flags a positive drift (actual >
   * expected) as a claimed-but-never-debited row, logging + emitting a metric for
   * a human to investigate. It does NOT auto-correct -- see
   * ReconcileCron.detectReservedDrift.
   */
  async debit(
    ownerUserId: string,
    amount: number,
    campaignId: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (amount <= 0) throw new BadRequestException('debit amount must be positive');

    // Seed the post-state snapshot from a current read; debit never moves
    // `balance`, only `reserved`, so balanceAfter is already final and
    // reservedAfter is finalized from the atomic decrement result below.
    const before = await this.walletModel.findOne({ ownerUserId });
    const seedBalance = (before as AdvertiserWalletDocument | null)?.balance ?? 0;
    const seedReserved = (before as AdvertiserWalletDocument | null)?.reserved ?? 0;

    // Step 1 -- CLAIM the idempotency key by inserting the ledger row first.
    try {
      await this.ledgerModel.create({
        ownerUserId,
        type: 'debit',
        amount: -amount,
        balanceAfter: seedBalance,
        reservedAfter: seedReserved - amount,
        campaignId,
        idempotencyKey,
      });
    } catch (err: unknown) {
      // Already charged (sequential retry OR a concurrent sibling that won the
      // unique-index race). Exactly-once is preserved -- no-op.
      if ((err as { code?: number })?.code === 11000) return;
      throw err;
    }

    // Step 2 -- guarded decrement: only fires when reserved >= amount.
    const updated = await this.walletModel.findOneAndUpdate(
      { ownerUserId, reserved: { $gte: amount } },
      { $inc: { reserved: -amount } },
      { new: true },
    );

    if (!updated) {
      // Genuinely insufficient reserved. Release the claim we just inserted so a
      // legitimate later retry (after a corrective reserve) is not permanently
      // blocked, then reject. This only ever deletes the row THIS call created:
      // a pre-existing key would have hit the 11000 no-op above.
      await this.ledgerModel.deleteOne({ idempotencyKey });
      throw new BadRequestException('insufficient reserved credits for debit');
    }

    // Step 3 -- finalize the authoritative post-state snapshot.
    const doc = updated as AdvertiserWalletDocument;
    await this.ledgerModel.updateOne(
      { idempotencyKey },
      { $set: { balanceAfter: doc.balance, reservedAfter: doc.reserved } },
    );
  }

  /**
   * Returns `amount` from reserved back to spendable (campaign ended / cancelled
   * / paused).
   *
   * CN-ADS-1 (Bucket 3): the optional `split` restores each credit to the SAME
   * bucket it was originally reserved from — `split.fromGrant` back to the
   * EXPIRING `grantBalance` (with the wallet's CURRENT `grantExpiresAt`
   * preserved, so a grant that already fully expired between reserve and release
   * does NOT un-expire), and `split.fromBalance` back to purchased `balance`.
   * Without a `split` (legacy callers, and every path where the origin split is
   * not tracked), the whole amount credits `balance` exactly as before — so this
   * is backward-compatible. Callers pass the campaign's tracked
   * `reservedFromGrant`/`reservedFromBalance`; since every release in this
   * codebase releases the FULL remaining reserve, that is a 1:1 restore.
   *
   * Throws BadRequestException when amount <= 0 or when releasing more than the
   * currently reserved balance (guard prevents reserved going negative).
   */
  async release(
    ownerUserId: string,
    amount: number,
    campaignId: string,
    split?: { fromGrant: number; fromBalance: number },
  ): Promise<void> {
    if (amount <= 0) throw new BadRequestException('release amount must be positive');

    // Resolve how much goes to each bucket. Default (no split) = all to balance,
    // identical to the pre-CN-ADS-1 behaviour. A supplied split is clamped so a
    // stale/rounding mismatch can never credit more than `amount` in total.
    let toGrant = 0;
    let toBalance = amount;
    if (split) {
      toGrant = Math.max(0, Math.min(split.fromGrant, amount));
      toBalance = amount - toGrant;
    }

    // Guarded decrement: only fires when reserved >= amount, preventing reserved
    // from going negative on an over-release. Credit grant + balance in the same
    // atomic $inc so the release is a single wallet write.
    const inc: Record<string, number> = { reserved: -amount, balance: toBalance };
    if (toGrant > 0) inc.grantBalance = toGrant;

    const updated = await this.walletModel.findOneAndUpdate(
      { ownerUserId, reserved: { $gte: amount } },
      { $inc: inc },
      { new: true },
    );

    if (!updated) throw new BadRequestException('cannot release more than reserved');

    const doc = updated as AdvertiserWalletDocument;
    await this.writeLedger(ownerUserId, 'release', amount, doc.balance, doc.reserved, {
      campaignId,
      // Snapshot grantBalance on the row when the release touched the grant
      // bucket, matching the reserve row's grant snapshot convention.
      ...(toGrant > 0 && { grantBalanceAfter: doc.grantBalance ?? 0 }),
    });
  }

  /**
   * CN-PURGE-1 (Bucket 2) — FORFEIT the reserved hold: decrement `reserved` by
   * `amount` with NO credit to `balance` or `grantBalance`, and write a
   * `'forfeit'` ledger row (negative `amount`). Used ONLY by the account-purge
   * path: a hard-deleted account's unspent boost budget is destroyed, not
   * refunded (owner decision OQ-2, 2026-07-02). Freeing the hold (rather than a
   * true no-op) is essential — otherwise `reserved` would stay permanently
   * inflated, surfacing as a never-resolving drift in the reconcile cron's
   * reserved-integrity pass. Distinct from `release`, which credits money back.
   *
   * Guarded decrement ($gte) prevents `reserved` going negative; a miss means
   * the hold was already freed elsewhere, so we no-op (idempotent — a redundant
   * purge run never double-forfeits). The wallet row itself is retained per the
   * billing-evidence manifest class; only its `reserved` state changes.
   */
  async forfeitReserve(
    ownerUserId: string,
    amount: number,
    campaignId: string,
    note: string,
  ): Promise<void> {
    if (amount <= 0) throw new BadRequestException('forfeit amount must be positive');

    const updated = await this.walletModel.findOneAndUpdate(
      { ownerUserId, reserved: { $gte: amount } },
      { $inc: { reserved: -amount } }, // reserved only — NO balance/grant credit.
      { new: true },
    );
    // Idempotent: a miss means the hold is already gone (e.g. a retried purge) —
    // do not throw, and write no second ledger row.
    if (!updated) return;

    const doc = updated as AdvertiserWalletDocument;
    await this.writeLedger(ownerUserId, 'forfeit', -amount, doc.balance, doc.reserved, {
      campaignId,
      note,
    });
  }

  /**
   * Grants `amount` plan-allowance credits into the SEPARATE, expiring
   * grantBalance bucket (Connect included boost credits). Granted credits are
   * spent before purchased balance and expire each cycle; purchased `balance` is
   * never touched here.
   *
   * Idempotent on `meta.idempotencyKey` (e.g. `grant-<subId>-<cycleStart>`): a
   * matching ledger row makes a re-grant a no-op, so a cycle is credited once.
   * Mirrors topup's direct-create + 11000-undo so a racing duplicate that loses
   * the unique-index race is reverted, crediting exactly once.
   */
  async grant(
    ownerUserId: string,
    amount: number,
    meta: GrantMeta,
  ): Promise<AdvertiserWalletDocument> {
    if (amount <= 0) {
      throw new BadRequestException('grant amount must be positive');
    }

    // Idempotency fast-path: a grant ledger row for this key means it happened.
    if (meta?.idempotencyKey) {
      const existing = await this.ledgerModel.findOne({ idempotencyKey: meta.idempotencyKey });
      if (existing) {
        return this.getWallet(ownerUserId);
      }
    }

    const updated = await this.walletModel.findOneAndUpdate(
      { ownerUserId },
      {
        $inc: { grantBalance: amount },
        ...(meta.expiresAt !== undefined && { $set: { grantExpiresAt: meta.expiresAt } }),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (meta?.idempotencyKey) {
      // Direct create (NOT writeLedger, which swallows 11000) so a concurrent
      // duplicate that loses the unique-index race can undo the grant increment.
      try {
        await this.ledgerModel.create({
          ownerUserId,
          type: 'grant',
          amount,
          balanceAfter: updated.balance,
          reservedAfter: updated.reserved,
          grantBalanceAfter: updated.grantBalance,
          idempotencyKey: meta.idempotencyKey,
        });
      } catch (err: unknown) {
        if ((err as { code?: number })?.code === 11000) {
          const reverted = await this.walletModel.findOneAndUpdate(
            { ownerUserId },
            { $inc: { grantBalance: -amount } },
            { new: true },
          );
          return (reverted ?? updated) as AdvertiserWalletDocument;
        }
        throw err;
      }
    } else {
      await this.writeLedger(ownerUserId, 'grant', amount, updated.balance, updated.reserved, {
        grantBalanceAfter: updated.grantBalance,
      });
    }

    return updated;
  }

  /**
   * Credits a referral reward into the permanent spendable `balance` bucket and
   * writes a `type:'referral'` ledger row. The `referral` ledger type keeps free
   * referral credits separable from purchased/granted/adjusted credits for
   * tax/records.
   *
   * What: idempotent credit of whole-rupee referral credits to one user.
   * Cross-module: called by ReferralService.releaseHeldReferrals (one call per
   *   side, keys `referral:<id>:referrer` / `referral:<id>:referee`); clawback
   *   reverses via adjust(). Returns the ledger id + post-state balance so the
   *   referral row can record which ledger row credited it.
   * Watch: idempotent on `opts.idempotencyKey` (partial-unique ledger index) so
   *   the release cron can retry safely -- running twice credits EXACTLY once and
   *   returns the FIRST row's { ledgerId, balanceAfter }. Mirrors topup/grant's
   *   increment-then-write-with-11000-undo so a racing duplicate that loses the
   *   unique-index race is reverted, never double-crediting.
   */
  async creditReferral(
    userId: string,
    amount: number,
    opts: { idempotencyKey: string; referralId?: string; recordedBy?: string },
  ): Promise<{ ledgerId: string; balanceAfter: number }> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('referral credit amount must be positive');
    }

    // Idempotency fast-path: a referral ledger row for this key means this credit
    // already happened. Return that row's id + balance WITHOUT re-incrementing
    // (a retried release must credit exactly once). The partial-unique ledger
    // index below is the durable backstop for the concurrent case.
    const prior = await this.ledgerModel.findOne({ idempotencyKey: opts.idempotencyKey });
    if (prior) {
      return {
        ledgerId: String((prior as AdWalletLedgerDocument)._id),
        balanceAfter: (prior as AdWalletLedgerDocument).balanceAfter,
      };
    }

    // Credit the permanent balance bucket, upserting a first-touch wallet (mirror
    // adjust/topup). The move is an unbounded reversible increment, so we
    // increment first then write the claiming ledger row.
    const updated = await this.walletModel.findOneAndUpdate(
      { ownerUserId: userId },
      { $inc: { balance: amount } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Direct create (NOT writeLedger, which swallows 11000) so a concurrent
    // duplicate that loses the unique-index race can undo the balance increment.
    try {
      const row = await this.ledgerModel.create({
        ownerUserId: userId,
        type: 'referral',
        amount,
        balanceAfter: updated.balance,
        reservedAfter: updated.reserved,
        idempotencyKey: opts.idempotencyKey,
        ...(opts.recordedBy !== undefined && { recordedBy: opts.recordedBy }),
        ...(opts.referralId !== undefined && { note: `referral:${opts.referralId}` }),
      });

      this.posthog?.capture({
        distinctId: userId,
        event: 'ads.referral_credit',
        properties: { userId, amount, balanceAfter: updated.balance },
      });

      return {
        ledgerId: String((row as AdWalletLedgerDocument)._id),
        balanceAfter: updated.balance,
      };
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === 11000) {
        // Concurrent sibling already credited with this key. Undo our balance
        // increment so the credit lands exactly once, then return the winning
        // row's id + balance.
        await this.walletModel.findOneAndUpdate(
          { ownerUserId: userId },
          { $inc: { balance: -amount } },
          { new: true },
        );
        const winner = await this.ledgerModel.findOne({ idempotencyKey: opts.idempotencyKey });
        if (winner) {
          return {
            ledgerId: String((winner as AdWalletLedgerDocument)._id),
            balanceAfter: (winner as AdWalletLedgerDocument).balanceAfter,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Sweeps an expired grant: when `grantExpiresAt` has passed and grantBalance
   * is positive, zeroes grantBalance and writes a `grant_expire` ledger row.
   * Purchased `balance` is untouched. Returns the amount expired (0 = nothing
   * due). The cron calls this before granting the next cycle. The guarded update
   * pins the read grantBalance, so a concurrent grant cannot be clobbered (a race
   * just yields 0 here; the next sweep handles it).
   */
  async expireGrants(ownerUserId: string): Promise<number> {
    const now = new Date();
    const wallet = await this.walletModel.findOne({ ownerUserId });
    const grantBalance = wallet?.grantBalance ?? 0;
    const grantExpiresAt = wallet?.grantExpiresAt ?? null;
    if (grantBalance <= 0 || !grantExpiresAt || grantExpiresAt > now) {
      return 0;
    }

    const updated = await this.walletModel.findOneAndUpdate(
      { ownerUserId, grantBalance, grantExpiresAt: { $lte: now } },
      { $set: { grantBalance: 0, grantExpiresAt: null } },
      { new: true },
    );
    if (!updated) return 0; // raced with a concurrent grant/expire; next run handles it

    const doc = updated as AdvertiserWalletDocument;
    await this.writeLedger(ownerUserId, 'grant_expire', -grantBalance, doc.balance, doc.reserved, {
      grantBalanceAfter: 0,
    });
    return grantBalance;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Appends a ledger row. Swallows duplicate-key errors (code 11000) so that
   * callers passing an idempotencyKey are safe to retry without double-writing.
   * Any other error is re-thrown.
   *
   * NOTE: the debit path does NOT use this helper for its main ledger write -
   * it needs to detect 11000 in order to undo a reserved decrement. This helper
   * is used for topup / reserve / release where a duplicate key on retry is
   * truly harmless and needs no undo.
   */
  private async writeLedger(
    ownerUserId: string,
    type: string,
    amount: number,
    balanceAfter: number,
    reservedAfter: number,
    opts?: LedgerOpts,
  ): Promise<void> {
    try {
      await this.ledgerModel.create({
        ownerUserId,
        type,
        amount,
        balanceAfter,
        reservedAfter,
        ...(opts?.campaignId !== undefined && { campaignId: opts.campaignId }),
        ...(opts?.idempotencyKey !== undefined && { idempotencyKey: opts.idempotencyKey }),
        ...(opts?.ref !== undefined && { ref: opts.ref }),
        ...(opts?.note !== undefined && { note: opts.note }),
        ...(opts?.recordedBy !== undefined && { recordedBy: opts.recordedBy }),
        ...(opts?.grantBalanceAfter !== undefined && { grantBalanceAfter: opts.grantBalanceAfter }),
      });
    } catch (err: any) {
      if (err?.code === 11000) return; // Idempotent retry - row already exists.
      throw err;
    }
  }
}
