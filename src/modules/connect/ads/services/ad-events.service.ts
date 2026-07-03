import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import {
  classifyClick,
  IVT_DEDUPE_WINDOW_MS,
  IVT_DAILY_WINDOW_MS,
  type IvtReason,
} from '../lib/ivt';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * CN-ADS-11 (feed harden Bucket 8): a viewability/click beacon received more
 * than this long after the impression was served is almost certainly a replay
 * of a leaked token, not a real event, so it is rejected (recorded, not charged).
 * The impression token is an unsigned UUID; rather than rework it into a signed,
 * self-expiring token (bigger change), we bound the practical abuse window using
 * the stored `servedAt` timestamp. One hour is generous for a genuine
 * long-dwell view while making a leaked token useful for at most that hour.
 */
const BEACON_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * A joined view of one impression row with its campaign billing fields.
 * The real repo impl (T32) does a Mongo $lookup to surface billingEvent/bid/
 * ownerUserId from the AdCampaign collection alongside the AdImpression row.
 */
export interface ImpressionView {
  impressionToken: string;
  campaignId: string;
  adSetId: string;
  ownerUserId: string;
  /** The user the impression was served to. Used for the self-impression guard
   *  AND the CN-ADS-11 beacon caller-match check (only the served viewer may
   *  fire this token's beacons). */
  viewerUserId: string;
  billingEvent: 'cpm' | 'cpc';
  bid: number;
  /** Whether a charge has already been applied for this impression. */
  charged: boolean;
  /** When the impression was served. CN-ADS-11: a beacon received far after this
   *  is almost certainly a replay, not a real viewability event, so it is
   *  rejected past a practical expiry window. */
  servedAt: Date;
  /** The campaign's current lifecycle status. CN-ADS-12: a late beacon for a
   *  campaign that has since paused/completed/been rejected is recorded as
   *  delivered-not-charged rather than billing against a released reserve. */
  campaignStatus: string;
}

/**
 * Input shape for creating a click record.
 */
export interface ClickInput {
  impressionToken: string;
  campaignId: string;
  userId: string;
  valid: boolean;
  /** IVT invalidation reason when `valid` is false; null for valid clicks. */
  invalidReason?: string | null;
  clickedAt: Date;
  chargeAmount: number;
}

// ---------------------------------------------------------------------------
// Collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Reads and atomically updates AdImpression rows.
 *
 * Real impl (T32): Mongoose model with a $lookup aggregation for findOne
 * and a findOneAndUpdate for setViewableAndCharge.
 */
export interface ImpressionRepo {
  /** Returns the joined impression view, or null when the token is unknown. */
  findOne(token: string): Promise<ImpressionView | null>;

  /**
   * Atomically marks the impression viewable and applies the charge amount,
   * but ONLY when the row is not yet charged.
   *
   * Real impl: findOneAndUpdate({ impressionToken, charged: false },
   *   { $set: { viewable: true, charged: true, chargeAmount } }, { new: true })
   * then returns !!result.
   *
   * Returns true when this caller won the atomic update (charge applied).
   * Returns false when another concurrent caller already set charged=true
   * (lost the race -- do NOT double-charge).
   */
  setViewableAndCharge(token: string, chargeAmount: number): Promise<boolean>;

  /**
   * Resets chargeAmount to 0 on an already-charged impression WITHOUT clearing
   * the `charged` flag. Used when the per-impression once-guard was won but the
   * campaign budget claim then failed: the impression stays viewable (delivered)
   * and charged=true (so it is never retried) but accounts for zero spend.
   */
  clearCharge(token: string): Promise<void>;
}

/**
 * Atomically claims campaign budget. The previous `incSpend` was an UNGUARDED
 * `$inc`, so two concurrent charges on a near-exhausted campaign could both push
 * budgetSpent past totalBudget (overspend). `tryConsumeBudget` is a guarded
 * conditional increment: it only succeeds while `budgetSpent + amount <=
 * totalBudget`, and returns whether the claim landed.
 *
 * Real impl (T33): findOneAndUpdate({ _id, $expr: budgetSpent+amount <= totalBudget },
 *   { $inc: { budgetSpent: amount } }) -> !!result.
 */
export interface CampaignSpendRepo {
  tryConsumeBudget(campaignId: string, amount: number): Promise<boolean>;
}

/**
 * Subset of WalletService that AdEventsService depends on.
 * WalletService satisfies this interface directly.
 */
export interface WalletDebiter {
  debit(
    ownerUserId: string,
    amount: number,
    campaignId: string,
    idempotencyKey: string,
  ): Promise<unknown>;
}

/**
 * Inserts a click row only when one does not already exist for the token, plus
 * the read/update helpers the IVT and budget-gate paths need.
 *
 * Real impl (T33): inserts into ad_clicks on the unique impressionToken index;
 * on duplicate-key error (code 11000) returns false.
 */
export interface ClickRepo {
  /** Returns true when the row was created (first click), false on duplicate. */
  createIfAbsent(token: string, doc: ClickInput): Promise<boolean>;

  /**
   * Counts clicks by `userId` on `campaignId` with clickedAt >= `since`.
   * Feeds the IVT rapid-duplicate (10 min) and daily-cap (24 h) heuristics.
   */
  countByUserCampaignSince(userId: string, campaignId: string, since: Date): Promise<number>;

  /** Resets chargeAmount on a click (budget-exhausted-after-recording correction). */
  setChargeAmount(token: string, amount: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Injection tokens
// ---------------------------------------------------------------------------

export const IMPRESSION_REPO = 'ADS_IMPRESSION_REPO';
export const CAMPAIGN_SPEND_REPO = 'ADS_CAMPAIGN_SPEND_REPO';
export const WALLET_DEBITER = 'ADS_WALLET_DEBITER';
export const CLICK_REPO = 'ADS_CLICK_REPO';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AdEventsService {
  private readonly logger = new Logger(AdEventsService.name);

  constructor(
    @Inject(IMPRESSION_REPO)
    private readonly impressions: ImpressionRepo,
    @Inject(CAMPAIGN_SPEND_REPO)
    private readonly campaigns: CampaignSpendRepo,
    @Inject(WALLET_DEBITER)
    private readonly wallet: WalletDebiter,
    @Inject(CLICK_REPO)
    private readonly clicks: ClickRepo,
    // PostHogService is @Global(); @Optional so the positional unit-test
    // constructor (4-arg) keeps working without wiring a fake.
    @Optional()
    @Inject(PostHogService)
    private readonly posthog?: PostHogService,
  ) {}

  /**
   * T24 -- CPM two-phase viewability debit. Idempotent.
   *
   * Called by the client viewability beacon when a creative has been
   * in-viewport for the minimum dwell time (50% area, 1 second).
   *
   * For CPM campaigns: atomically marks the impression viewable, claims campaign
   * budget, and charges bid/1000 credits. Both the per-impression once-guard
   * (setViewableAndCharge) AND the guarded budget claim (tryConsumeBudget) must
   * succeed before money moves.
   *
   * For CPC campaigns: marks the impression viewable with zero charge --
   * the actual charge will fire on click via recordClick.
   */
  async recordImpression(token: string, callerUserId?: string): Promise<void> {
    const impr = await this.impressions.findOne(token);
    // Unknown token or already charged -- no-op (idempotency guard).
    if (!impr || impr.charged) return;

    // CN-ADS-11 (feed harden Bucket 8): only the viewer the impression was SERVED
    // to may fire its beacon. A leaked/replayed token used by any other account
    // is silently ignored (this is a billing beacon -- never surface an error).
    // callerUserId is optional so a legacy/internal caller without it still works,
    // but the controller now always passes req.user.sub.
    if (callerUserId && impr.viewerUserId && impr.viewerUserId !== callerUserId) return;

    // CN-ADS-11: reject a beacon received far past the served time (almost
    // certainly a replay). Recorded-not-charged for visibility, then stop.
    if (Date.now() - new Date(impr.servedAt).getTime() > BEACON_MAX_AGE_MS) {
      this.emitDeliveredNotCharged('budget_exhausted', impr, 'impression');
      return;
    }

    // CN-ADS-12 (feed harden Bucket 8): a late beacon for a campaign that is no
    // longer active (paused / completed / rejected) must NOT bill -- its reserve
    // was already released, so wallet.debit would find reserved~0 and throw.
    // Deliver-not-charged instead of letting the mismatch fall to reconcile.
    if (impr.campaignStatus !== 'active') {
      await this.impressions.setViewableAndCharge(token, 0);
      this.emitDeliveredNotCharged('budget_exhausted', impr, 'impression');
      return;
    }

    // Self-impression guard (F3.7, defense-in-depth): the auction already excludes
    // own-author candidates (ad-decision.service), so a viewer should never receive
    // their own ad -- but a fabricated/legacy token must never bill the advertiser
    // for viewing their own creative. Mark viewable for analytics, charge nothing.
    if (impr.viewerUserId && impr.viewerUserId === impr.ownerUserId) {
      await this.impressions.setViewableAndCharge(token, 0);
      this.emitDeliveredNotCharged('self_impression', impr, 'impression');
      return;
    }

    if (impr.billingEvent !== 'cpm') {
      // CPC impressions are free at view time; charge fires on click instead.
      // Mark viewable with zero charge so analytics are accurate.
      await this.impressions.setViewableAndCharge(token, 0);
      return;
    }

    // CPM charge = bid per 1000 impressions, so one impression costs bid/1000.
    const charge = impr.bid / 1000;

    // Atomic per-impression once-guard FIRST: only one concurrent caller wins this
    // update for a given impression. It must precede the budget claim so a retried
    // / raced beacon for the SAME impression cannot double-consume campaign budget.
    const updated = await this.impressions.setViewableAndCharge(token, charge);
    if (!updated) return;

    // Campaign budget gate: guarded atomic claim. Closes the overspend race where
    // two concurrent beacons on DIFFERENT impressions of a near-exhausted campaign
    // both bill -- only the claim that still fits the budget wins. A miss means the
    // budget is gone, so this impression is delivered-but-not-charged (F2.4).
    const budgetOk = await this.campaigns.tryConsumeBudget(impr.campaignId, charge);
    if (!budgetOk) {
      // Undo the optimistic chargeAmount we just wrote (charged stays true so the
      // impression is never retried), then surface the leakage and stop.
      await this.impressions.clearCharge(token);
      this.emitDeliveredNotCharged('budget_exhausted', impr, 'impression');
      return;
    }

    // idempotencyKey = impressionToken (namespace: raw token = impression debit).
    // The wallet's claim-first ledger insert is the durable double-charge backstop.
    await this.wallet.debit(impr.ownerUserId, charge, impr.campaignId, token);
  }

  /**
   * T25 -- CPC click debit. Idempotent + IVT-filtered.
   *
   * Called when a user clicks an ad. The unique impressionToken index on
   * ad_clicks enforces one-click-per-impression at the DB level; createIfAbsent
   * surfaces that as a boolean so we skip billing on duplicates.
   *
   * IVT (ads/lib/ivt.ts classifyClick): self-clicks, bot user-agents, rapid
   * duplicates (same user+campaign inside the dedupe window), and per-day cap
   * breaches are RECORDED with their reason for the audit trail but never billed.
   *
   * For CPM campaigns: a valid click is still recorded (for CTR analytics) but no
   * charge is applied -- the CPM impression was already billed at view time.
   */
  async recordClick(token: string, userId: string, userAgent?: string | null): Promise<void> {
    const impr = await this.impressions.findOne(token);
    // Unknown token -- no-op.
    if (!impr) return;

    // CN-ADS-11 (feed harden Bucket 8): the click beacon must come from the
    // viewer the impression was served to; a leaked token clicked by another
    // account is ignored. Also reject a beacon far past the served time (replay).
    if (impr.viewerUserId && impr.viewerUserId !== userId) return;
    if (Date.now() - new Date(impr.servedAt).getTime() > BEACON_MAX_AGE_MS) return;

    // IVT signals: prior clicks by this user on this campaign in the two windows.
    // Counted BEFORE inserting this click, so they exclude the current click.
    const now = new Date();
    const recentClickCount = await this.clicks.countByUserCampaignSince(
      userId,
      impr.campaignId,
      new Date(now.getTime() - IVT_DEDUPE_WINDOW_MS),
    );
    const dailyClickCount = await this.clicks.countByUserCampaignSince(
      userId,
      impr.campaignId,
      new Date(now.getTime() - IVT_DAILY_WINDOW_MS),
    );

    const verdict = classifyClick({
      clickerUserId: userId,
      ownerUserId: impr.ownerUserId,
      userAgent,
      recentClickCount,
      dailyClickCount,
    });

    // Only a VALID click on a CPC campaign carries a positive charge.
    const willCharge = verdict.valid && impr.billingEvent === 'cpc';
    const charge = willCharge ? impr.bid : 0;

    // Insert the click row (with validity + reason). The unique impressionToken
    // index enforces one-click-per-impression; a duplicate returns false -> no-op.
    const created = await this.clicks.createIfAbsent(token, {
      impressionToken: token,
      campaignId: impr.campaignId,
      userId,
      valid: verdict.valid,
      invalidReason: verdict.reason ?? null,
      clickedAt: now,
      chargeAmount: charge,
    });
    if (!created) return;

    // Invalid click: stored above for the audit trail, excluded from billing and
    // from advertiser-facing (valid) click counts. Never reaches the debit.
    if (!verdict.valid) {
      // classifyClick always sets a reason when valid is false; the ?? only
      // satisfies the optional-property type and is never actually reached.
      this.emitDeliveredNotCharged(verdict.reason ?? 'bot_ua', impr, 'click');
      return;
    }

    // CPM campaign click: recorded for analytics but NOT charged here --
    // the impression was already billed at view time.
    if (impr.billingEvent !== 'cpc') return;

    // CN-ADS-12: a late CPC click for a campaign that has since left `active`
    // (paused / completed / rejected) must NOT bill -- its reserve was released,
    // so the debit would find reserved~0 and throw. Deliver-not-charged instead.
    if (impr.campaignStatus !== 'active') {
      this.emitDeliveredNotCharged('budget_exhausted', impr, 'click');
      return;
    }

    // Campaign budget gate (same guarded claim as the impression path).
    const budgetOk = await this.campaigns.tryConsumeBudget(impr.campaignId, impr.bid);
    if (!budgetOk) {
      await this.clicks.setChargeAmount(token, 0);
      this.emitDeliveredNotCharged('budget_exhausted', impr, 'click');
      return;
    }

    // idempotencyKey uses 'click:' prefix to distinguish from the impression
    // debit key (raw token) so both debits can coexist in the ledger for a
    // CPM+click campaign without colliding on the unique idempotencyKey index.
    await this.wallet.debit(impr.ownerUserId, impr.bid, impr.campaignId, 'click:' + token);
  }

  /**
   * F2.4 -- revenue-leakage visibility. Emits ONE structured warn + ONE metric
   * whenever an ad was delivered (impression viewable / click recorded) but NOT
   * billed (self-traffic, IVT-invalidated, or campaign budget exhausted). Cheap
   * (no extra query). The complementary wallet-side integrity scan lives in
   * ReconcileCron.detectReservedDrift -- this extends that visibility to the
   * delivered-but-uncharged direction rather than duplicating it.
   */
  private emitDeliveredNotCharged(
    reason: IvtReason | 'self_impression' | 'budget_exhausted',
    impr: ImpressionView,
    eventType: 'impression' | 'click',
  ): void {
    this.logger.warn(
      `ads delivered-not-charged: ${eventType} campaign=${impr.campaignId} ` +
        `billing=${impr.billingEvent} reason=${reason}`,
    );
    this.posthog?.capture({
      distinctId: String(impr.ownerUserId),
      event: 'ads.delivered_not_charged',
      properties: {
        campaignId: String(impr.campaignId),
        billingEvent: impr.billingEvent,
        eventType,
        reason,
      },
    });
  }
}
