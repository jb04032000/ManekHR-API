import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';

import { AdPlacement } from '../schemas/ad-placement.schema';
import { AdSet } from '../schemas/ad-set.schema';
import { AdCampaign } from '../schemas/ad-campaign.schema';
import { AdCreative } from '../schemas/ad-creative.schema';
import { AdImpression } from '../schemas/ad-impression.schema';
import { AdClick } from '../schemas/ad-click.schema';
import { UserBlock, type UserBlockDocument } from '../../inbox/schemas/user-block.schema';
import { User } from '../../../users/schemas/user.schema';

import type {
  PlacementRepo,
  Placement,
  CandidateRepo,
  Candidate,
  CreativeKind,
  ImpressionOpener,
  BlockRepo,
} from './ad-decision.service';
import type {
  ImpressionRepo,
  ImpressionView,
  CampaignSpendRepo,
  ClickRepo,
  ClickInput,
} from './ad-events.service';
import type { RollupReader } from './boost.service';

// ---------------------------------------------------------------------------
// PlacementRepoMongo
// ---------------------------------------------------------------------------

/**
 * Reads AdPlacement documents by key.
 * Implements PlacementRepo from ad-decision.service.
 */
@Injectable()
export class PlacementRepoMongo implements PlacementRepo {
  constructor(
    @InjectModel(AdPlacement.name)
    private readonly placementModel: Model<AdPlacement>,
  ) {}

  async get(key: string): Promise<Placement | null> {
    const doc = await this.placementModel.findOne({ key }).lean();
    if (!doc) return null;
    return {
      key: doc.key,
      surface: doc.surface,
      floorCpm: doc.floorCpm,
      enabled: doc.enabled,
    };
  }
}

// ---------------------------------------------------------------------------
// Platform-wide cross-sell rail eligibility (Wave 2 foundation)
// ---------------------------------------------------------------------------

/**
 * Cross-sell RAIL placement keys that serve "any active listing-objective boost"
 * even when the campaign's AdSet did NOT bind that exact key. This is what lets
 * an EXISTING listing boost (bound only to the canonical marketplace/feed keys —
 * see boost.service.createListingBoost) appear on EVERY Connect cross-sell rail
 * with zero re-boost and zero backfill.
 *
 * Mechanism (Option A): for these keys, CandidateRepoMongo.top widens its AdSet
 * lookup to also match AdSets bound to the canonical listing keys, then keeps
 * ONLY promoted_listing candidates from that widened set. Every other gate is
 * unchanged and applied downstream:
 *   - targeting + budget + flight-window + floor + fairness/dedupe -> ad-decision.service
 *   - self-view exclusion (own author) -> ad-decision.service
 *   - leak/visibility safety -> web hydration uses the PUBLIC getter
 *     (resolvePromotedRailListing -> getPublicListing), so a paused / unpublished
 *     / removed listing never renders.
 *
 * Keep in sync with seed-connect-ad-placements.ts (these keys + the Wave 2 keys
 * must be seeded + enabled) and with the web Wave 2 page resolvers.
 */
export const CROSS_SELL_RAIL_PLACEMENTS: ReadonlySet<string> = new Set<string>([
  // Existing entity / board / search rails.
  'company_page',
  'storefront_page',
  'rfq_board',
  'rfq_detail',
  'search_results',
  // Wave 2 page rails (resolved by web on the matching pages).
  'jobs_detail',
  'listing_detail',
  'post_detail',
  'profile_view',
  'activity_feed',
  'stores_hub',
  'storefront_manage',
  'pages_hub',
  'company_manage',
]);

/**
 * The placement keys a normal listing boost actually binds (boost.service
 * createListingBoost). A cross-sell rail widens its lookup to these so existing
 * boosts qualify without re-boost. `feed_sponsored` is intentionally excluded:
 * it is a FEED slot already carrying every boost kind, not a listing-only signal.
 */
const CANONICAL_LISTING_BOUND_PLACEMENTS = ['marketplace_grid', 'marketplace_rail'] as const;

/**
 * Seeded demo/sample account marker (Demo-Content Scope B). An account is demo
 * when User.isDemo === true OR its email ends with @connect-demo.zari360.test.
 * Mirrors the same marker used by the sitemap exclusion + FE "Sample" badge, so
 * the auction hard-gate and the public crawl-exclusion agree on one definition.
 */
const DEMO_EMAIL_SUFFIX = '@connect-demo.zari360.test';
const isDemoUser = (u: { isDemo?: boolean; email?: string | null }): boolean =>
  u.isDemo === true || (typeof u.email === 'string' && u.email.endsWith(DEMO_EMAIL_SUFFIX));

/**
 * CN-ADS-6: defensive ceiling on the initial adSet scan for one placement.
 * Well above realistic live inventory per slot, so it never truncates a genuine
 * auction, but bounds the work if a placement's fan-out ever grows unexpectedly
 * (the auction only needs the top few by bid anyway; the sort+slice happens after).
 */
const ADSET_SCAN_CAP = 500;

// ---------------------------------------------------------------------------
// CandidateRepoMongo
// ---------------------------------------------------------------------------

/**
 * Fetches the top N ad candidates for a placement key.
 * Implements CandidateRepo from ad-decision.service.
 *
 * CN-ADS-6 (feed harden Bucket 8): this was an uncapped adSet scan with an N+1
 * per-adSet campaign + creative lookup — the hottest path in the whole ads
 * cluster (`/decide` fires most often), so a growing placement fan-out
 * compounded every other ads latency. Rewritten to: (1) cap the initial adSet
 * scan (defensive ceiling), then (2) batch-load the eligible campaigns + their
 * approved creatives with two `$in` queries and join in memory — same
 * eligibility predicate + same output, but 2 queries instead of 2N. The
 * demo-owner hard gate + bid sort + limit slice are unchanged.
 *
 * predictedCtr is hardcoded to 0.01 and relevance to 1. These are accepted
 * foundation constants pending a learning/ML ranking layer.
 */
@Injectable()
export class CandidateRepoMongo implements CandidateRepo {
  constructor(
    @InjectModel(AdSet.name)
    private readonly adSetModel: Model<AdSet>,
    @InjectModel(AdCampaign.name)
    private readonly campaignModel: Model<AdCampaign>,
    @InjectModel(AdCreative.name)
    private readonly creativeModel: Model<AdCreative>,
    // User: read-only, batch-loaded to HARD-GATE demo/sample-owned candidates out
    // of the auction (Demo-Content Scope B). A demo-owned campaign must never win
    // a paid/sponsored slot or be billed. Cross-module: same isDemo marker as the
    // sitemap exclusion + the FE "Sample" badge.
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  async top(
    placementKey: string,
    limit: number,
    minRemainingCredits = 0,
    kinds?: CreativeKind[],
  ): Promise<Candidate[]> {
    const now = new Date();
    // CN-ADS-8: when a kinds filter is supplied, only these creative kinds enter
    // the auction (a shared placement serving one specific surface, e.g. the
    // network page's profile-boost-only slot). Undefined = every kind.
    const kindFilter = kinds && kinds.length > 0 ? new Set<CreativeKind>(kinds) : null;

    // Cross-sell rail (Wave 2): a listing boost is eligible here without binding
    // this exact key. Widen the lookup to AdSets bound to the canonical listing
    // keys too, then keep ONLY promoted_listing candidates (below). Non-cross-sell
    // keys keep the strict exact-key match, so feed/marketplace/spotlight behave
    // exactly as before. The multikey {placements:1} index serves the $in too.
    const isCrossSell = CROSS_SELL_RAIL_PLACEMENTS.has(placementKey);
    const adSets = await this.adSetModel
      .find(
        isCrossSell
          ? { placements: { $in: [placementKey, ...CANONICAL_LISTING_BOUND_PLACEMENTS] } }
          : { placements: placementKey },
      )
      // CN-ADS-6: bounded scan (defensive ceiling) instead of an uncapped fetch.
      .limit(ADSET_SCAN_CAP)
      .lean();

    const candidates: Candidate[] = [];
    if (adSets.length === 0) return candidates;

    // CN-ADS-6: batch-load the eligible campaigns + approved creatives with two
    // `$in` queries (was one findOne PER adSet = the N+1). The campaign query
    // carries the IDENTICAL server-side eligibility predicate as before (status
    // active, within flight window, remaining budget positive AND >= the
    // placement floor), just applied to the whole candidate set at once.
    const campaignIds = [...new Set(adSets.map((s) => String(s.campaignId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const [eligibleCampaigns, approvedCreatives] = await Promise.all([
      this.campaignModel
        .find({
          _id: { $in: campaignIds },
          status: 'active',
          startAt: { $lte: now },
          endAt: { $gt: now },
          $expr: {
            $and: [
              { $gt: [{ $subtract: ['$totalBudget', '$budgetSpent'] }, 0] },
              { $gte: [{ $subtract: ['$totalBudget', '$budgetSpent'] }, minRemainingCredits] },
            ],
          },
        })
        .lean(),
      this.creativeModel
        .find({ campaignId: { $in: campaignIds }, reviewStatus: 'approved' })
        .lean(),
    ]);
    const campaignById = new Map(eligibleCampaigns.map((c) => [String(c._id), c]));
    // One approved creative per campaign (matches the prior per-adSet findOne,
    // which took the first approved creative for the campaign). Keep the first seen.
    const creativeByCampaign = new Map<string, (typeof approvedCreatives)[number]>();
    for (const cr of approvedCreatives) {
      const key = String(cr.campaignId);
      if (!creativeByCampaign.has(key)) creativeByCampaign.set(key, cr);
    }

    for (const adSet of adSets) {
      // In-memory join against the batch-loaded maps (was an N+1 pair of findOnes).
      const campaign = campaignById.get(String(adSet.campaignId));
      if (!campaign) continue; // not eligible (predicate above dropped it).
      const creative = creativeByCampaign.get(String(adSet.campaignId));
      if (!creative) continue; // no approved creative.

      // The ad unit kind drives which target ref is carried. promoted_listing has
      // a listingRef, promoted_job a jobRef, the two profile boosts a profileRef,
      // promoted_rfq an rfqRef. Unknown kinds fall back to promoted_post.
      const KNOWN_KINDS: CreativeKind[] = [
        'promoted_post',
        'promoted_listing',
        'promoted_job',
        'promoted_open_to_work',
        'promoted_hiring',
        'promoted_rfq',
      ];
      const creativeKind: CreativeKind = KNOWN_KINDS.includes(creative.kind as CreativeKind)
        ? (creative.kind as CreativeKind)
        : 'promoted_post';

      // Cross-sell rail eligibility (Wave 2): these rails serve ONLY a listing
      // boost. The widened lookup above can return an AdSet bound to a canonical
      // listing key whose creative is somehow not a listing — drop it so a
      // cross-sell rail never serves a non-listing card. Exact-key (non-cross-sell)
      // placements keep every kind, so the feed/marketplace/spotlight slots are
      // untouched. The web hydrates via the public listing getter (leak-safe).
      if (isCrossSell && creativeKind !== 'promoted_listing') continue;

      // CN-ADS-8: drop any candidate whose kind is not in the requested set.
      if (kindFilter && !kindFilter.has(creativeKind)) continue;

      const isProfileKind =
        creativeKind === 'promoted_open_to_work' || creativeKind === 'promoted_hiring';

      candidates.push({
        campaignId: String(campaign._id),
        adSetId: String(adSet._id),
        creativeId: String(creative._id),
        // advertiser = ownerUserId (a Connect User, NOT workspaceId)
        authorUserId: String(campaign.ownerUserId),
        creativeKind,
        ...(creativeKind === 'promoted_post' && creative.postRef
          ? { postRef: String(creative.postRef) }
          : {}),
        ...(creativeKind === 'promoted_listing' && creative.listingRef
          ? { listingRef: String(creative.listingRef) }
          : {}),
        ...(creativeKind === 'promoted_job' && creative.jobRef
          ? { jobRef: String(creative.jobRef) }
          : {}),
        ...(isProfileKind && creative.profileRef
          ? { profileRef: String(creative.profileRef) }
          : {}),
        ...(creativeKind === 'promoted_rfq' && creative.rfqRef
          ? { rfqRef: String(creative.rfqRef) }
          : {}),
        billingEvent: campaign.billingEvent as 'cpm' | 'cpc',
        bid: campaign.bid,
        // Foundation constants - replace with ML-derived values in the ranking phase.
        predictedCtr: 0.01,
        relevance: 1,
        targeting: adSet.targeting ?? {
          roles: [],
          sectors: [],
          districts: [],
          companySizes: [],
        },
        freqCapCount: adSet.freqCapCount,
        freqCapWindowSec: adSet.freqCapWindowSec,
      });
    }

    // HARD GATE (Demo-Content Scope B): exclude any candidate whose owner is a
    // seeded demo/sample account so demo content NEVER enters a paid/sponsored
    // slot or gets billed. Batch-load the distinct owner Users in one query
    // (selecting only isDemo + email — the two marker fields), build a demo-owner
    // id set, then drop matching candidates. This is an exclusion, not a
    // down-rank: paid placements are real-money inventory, so a demo owner is
    // ineligible outright (unlike the organic feed/search, which only down-rank
    // demo via applyDemoPenalty so a sample can still fill an empty slot).
    if (candidates.length > 0) {
      const ownerIds = [...new Set(candidates.map((c) => c.authorUserId))];
      const owners = await this.userModel
        .find({ _id: { $in: ownerIds } })
        .select('_id isDemo email')
        .lean();
      const demoOwnerIds = new Set<string>(owners.filter(isDemoUser).map((u) => String(u._id)));
      if (demoOwnerIds.size > 0) {
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (demoOwnerIds.has(candidates[i].authorUserId)) candidates.splice(i, 1);
        }
      }
    }

    return candidates.sort((a, b) => b.bid - a.bid).slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// ImpressionOpenerMongo
// ---------------------------------------------------------------------------

/**
 * Creates a new AdImpression document and returns its token.
 * Implements ImpressionOpener from ad-decision.service.
 */
@Injectable()
export class ImpressionOpenerMongo implements ImpressionOpener {
  constructor(
    @InjectModel(AdImpression.name)
    private readonly impressionModel: Model<AdImpression>,
  ) {}

  async open(input: {
    campaignId: string;
    adSetId: string;
    creativeId: string;
    userId: string;
    placementKey: string;
  }): Promise<{ impressionToken: string }> {
    const impressionToken = randomUUID();

    await this.impressionModel.create({
      campaignId: input.campaignId,
      adSetId: input.adSetId,
      creativeId: input.creativeId,
      userId: input.userId,
      placementKey: input.placementKey,
      impressionToken,
      servedAt: new Date(),
      viewable: false,
      charged: false,
      chargeAmount: 0,
    });

    return { impressionToken };
  }
}

// ---------------------------------------------------------------------------
// ImpressionRepoMongo
// ---------------------------------------------------------------------------

/**
 * Reads and atomically updates AdImpression rows.
 * Implements ImpressionRepo from ad-events.service.
 *
 * findOne does a two-query JOIN (impression then campaign) to surface
 * campaign.ownerUserId, campaign.billingEvent, and campaign.bid into the
 * ImpressionView. This avoids schema denormalization while keeping the
 * billing engine independent of the campaign collection layout.
 */
@Injectable()
export class ImpressionRepoMongo implements ImpressionRepo {
  constructor(
    @InjectModel(AdImpression.name)
    private readonly impressionModel: Model<AdImpression>,
    @InjectModel(AdCampaign.name)
    private readonly campaignModel: Model<AdCampaign>,
  ) {}

  async findOne(token: string): Promise<ImpressionView | null> {
    const impr = await this.impressionModel.findOne({ impressionToken: token }).lean();
    if (!impr) return null;

    const campaign = await this.campaignModel.findById(impr.campaignId).lean();
    if (!campaign) return null;

    return {
      impressionToken: token,
      campaignId: String(impr.campaignId),
      adSetId: String(impr.adSetId),
      // The viewer the impression was served to -- powers the self-impression guard.
      viewerUserId: String(impr.userId),
      // Surface campaign-level billing fields so the events service does not
      // need to load the campaign separately.
      ownerUserId: String(campaign.ownerUserId),
      billingEvent: campaign.billingEvent as 'cpm' | 'cpc',
      bid: campaign.bid,
      charged: impr.charged,
      // CN-ADS-11 / CN-ADS-12 (feed harden Bucket 8): surface servedAt (replay
      // expiry) + the campaign's live status (late-beacon gate). Both come from
      // rows already loaded above, so no extra query.
      servedAt: impr.servedAt,
      campaignStatus: String(campaign.status),
    };
  }

  async setViewableAndCharge(token: string, chargeAmount: number): Promise<boolean> {
    const r = await this.impressionModel.findOneAndUpdate(
      { impressionToken: token, charged: false },
      { $set: { viewable: true, charged: true, chargeAmount } },
      { new: true },
    );
    // Returns false when r is null - meaning another concurrent caller already
    // set charged=true and won the race. Do NOT double-charge in that case.
    return !!r;
  }

  async clearCharge(token: string): Promise<void> {
    // Reset chargeAmount to 0 without clearing `charged` (so the impression is
    // never retried). Used when the per-impression guard was won but the campaign
    // budget claim failed: the view stays counted, the spend does not.
    await this.impressionModel.updateOne({ impressionToken: token }, { $set: { chargeAmount: 0 } });
  }
}

// ---------------------------------------------------------------------------
// CampaignSpendRepoMongo
// ---------------------------------------------------------------------------

/**
 * Atomically claims campaign budget. Implements CampaignSpendRepo from
 * ad-events.service.
 *
 * The previous `incSpend` was an UNGUARDED `$inc`, so two concurrent charges on a
 * near-exhausted campaign could both push budgetSpent past totalBudget. This
 * guarded conditional increment closes that race: the `$expr` only matches while
 * `budgetSpent + amount <= totalBudget`, so a budget-exhausted campaign stops
 * being billable IMMEDIATELY. Returns whether the claim landed -- the caller skips
 * the wallet debit (and records delivered-but-not-charged) on a miss.
 */
@Injectable()
export class CampaignSpendRepoMongo implements CampaignSpendRepo {
  constructor(
    @InjectModel(AdCampaign.name)
    private readonly campaignModel: Model<AdCampaign>,
  ) {}

  async tryConsumeBudget(campaignId: string, amount: number): Promise<boolean> {
    const updated = await this.campaignModel.findOneAndUpdate(
      {
        _id: campaignId,
        $expr: { $lte: [{ $add: ['$budgetSpent', amount] }, '$totalBudget'] },
      },
      { $inc: { budgetSpent: amount } },
      { new: true },
    );
    // null = the guard failed (no headroom) -> campaign budget exhausted.
    return !!updated;
  }
}

// ---------------------------------------------------------------------------
// ClickRepoMongo
// ---------------------------------------------------------------------------

/**
 * Inserts a click row only when one does not already exist for the token.
 * Implements ClickRepo from ad-events.service.
 *
 * The unique impressionToken index on the ad_clicks collection enforces
 * one-click-per-impression at the DB level. A duplicate-key error (code 11000)
 * is surfaced as false rather than thrown, so callers skip billing on duplicates.
 */
@Injectable()
export class ClickRepoMongo implements ClickRepo {
  constructor(
    @InjectModel(AdClick.name)
    private readonly clickModel: Model<AdClick>,
  ) {}

  async createIfAbsent(token: string, doc: ClickInput): Promise<boolean> {
    try {
      await this.clickModel.create({
        impressionToken: token,
        campaignId: doc.campaignId,
        userId: doc.userId,
        valid: doc.valid,
        // Persist the IVT reason (audit trail + future tuning); null on valid clicks.
        invalidReason: doc.invalidReason ?? null,
        clickedAt: doc.clickedAt,
        chargeAmount: doc.chargeAmount,
      });
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
  }

  async countByUserCampaignSince(userId: string, campaignId: string, since: Date): Promise<number> {
    // Hits the { userId, campaignId, clickedAt } index. Counts every click
    // (valid or not) so a hammering bot is rate-limited by its own attempts.
    return this.clickModel.countDocuments({
      userId,
      campaignId,
      clickedAt: { $gte: since },
    });
  }

  async setChargeAmount(token: string, amount: number): Promise<void> {
    await this.clickModel.updateOne({ impressionToken: token }, { $set: { chargeAmount: amount } });
  }
}

// ---------------------------------------------------------------------------
// RollupReaderMongo
// ---------------------------------------------------------------------------

/**
 * Live real-time aggregation of impression and click metrics for a campaign.
 * Implements RollupReader from boost.service.
 *
 * This queries ad_impressions and ad_clicks directly rather than the nightly
 * AdDailyRollup snapshots, so the boost status view is always current. The
 * nightly rollup cron is used for historical reporting, not for live status.
 *
 * campaignId matching: AdImpression.campaignId and AdClick.campaignId are both
 * stored as Types.ObjectId refs (see schemas). The incoming campaignId string is
 * cast to a new Types.ObjectId for the $match so Mongo uses the compound index
 * on {campaignId, servedAt} correctly. This mirrors the pattern in rollup.cron.ts
 * where imp._id is used directly (already an ObjectId from the $group _id field).
 */
@Injectable()
export class RollupReaderMongo implements RollupReader {
  constructor(
    @InjectModel(AdImpression.name)
    private readonly impressionModel: Model<AdImpression>,
    @InjectModel(AdClick.name)
    private readonly clickModel: Model<AdClick>,
  ) {}

  async aggregateFor(campaignId: string): Promise<{
    impressions: number;
    viewableImpressions: number;
    clicks: number;
    validClicks: number;
    spend: number;
  }> {
    // Cast string campaignId to ObjectId so the $match hits the indexed field
    // correctly. Mongoose stores campaignId as Types.ObjectId on both collections.
    const campaignOid = new Types.ObjectId(campaignId);

    const impressionBuckets: Array<{
      _id: null;
      impressions: number;
      viewableImpressions: number;
      spend: number;
    }> = await this.impressionModel.aggregate([
      { $match: { campaignId: campaignOid } },
      {
        $group: {
          _id: null,
          impressions: { $sum: 1 },
          viewableImpressions: { $sum: { $cond: ['$viewable', 1, 0] } },
          spend: { $sum: '$chargeAmount' },
        },
      },
    ]);

    const clickBuckets: Array<{
      _id: null;
      clicks: number;
      validClicks: number;
    }> = await this.clickModel.aggregate([
      { $match: { campaignId: campaignOid } },
      {
        $group: {
          _id: null,
          clicks: { $sum: 1 },
          validClicks: { $sum: { $cond: ['$valid', 1, 0] } },
        },
      },
    ]);

    const imp = impressionBuckets[0];
    const clk = clickBuckets[0];

    return {
      impressions: imp?.impressions ?? 0,
      viewableImpressions: imp?.viewableImpressions ?? 0,
      spend: imp?.spend ?? 0,
      clicks: clk?.clicks ?? 0,
      validClicks: clk?.validClicks ?? 0,
    };
  }
}

// ---------------------------------------------------------------------------
// BlockRepoMongo
// ---------------------------------------------------------------------------

/**
 * Bidirectional block check for the auction (audit B5). Implements BlockRepo
 * from ad-decision.service over the inbox `UserBlock` collection -- the SAME
 * source the feed read path consults (feed.service.getBlockedUserIds), so a
 * boosted post is filtered identically to an organic one. A single `$or` query
 * covers both directions (viewer blocked owner OR owner blocked viewer).
 */
@Injectable()
export class BlockRepoMongo implements BlockRepo {
  constructor(
    @InjectModel(UserBlock.name)
    private readonly userBlockModel: Model<UserBlockDocument>,
  ) {}

  async isBlocked(viewerId: string, authorUserId: string): Promise<boolean> {
    // Self can never block self; skip the query (also avoids a bogus match on a
    // self-impression that the own-author filter already excludes upstream).
    if (viewerId === authorUserId) return false;
    const viewer = new Types.ObjectId(viewerId);
    const author = new Types.ObjectId(authorUserId);
    const row = await this.userBlockModel
      .findOne({
        $or: [
          { blockerUserId: viewer, blockedUserId: author },
          { blockerUserId: author, blockedUserId: viewer },
        ],
      })
      .select('_id')
      .lean();
    return !!row;
  }
}
