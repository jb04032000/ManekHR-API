import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import type { AdProfile, TargetingMatchSpec } from '../lib/targeting';
import { matchesTargeting, isUnknownLocationDistrictMatch } from '../lib/targeting';
import { ecpm, score } from '../lib/ecpm';
import { pickTopWithRotation } from '../lib/rotation';
import { PostHogService } from '../../../../common/posthog/posthog.service';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface Placement {
  key: string;
  surface: string;
  floorCpm: number;
  enabled: boolean;
}

export interface Candidate {
  campaignId: string;
  adSetId: string;
  creativeId: string;
  authorUserId: string;
  /** Which ad unit this candidate renders. */
  creativeKind: CreativeKind;
  /** The Connect post id (promoted_post candidates). */
  postRef?: string;
  /** The marketplace listing id (promoted_listing candidates, M2.2). */
  listingRef?: string;
  /** The job id (promoted_job candidates, Phase 5). */
  jobRef?: string;
  /** The advertiser's user id (promoted_open_to_work / promoted_hiring candidates). */
  profileRef?: string;
  /** The RFQ id (promoted_rfq candidates). */
  rfqRef?: string;
  billingEvent: 'cpm' | 'cpc';
  bid: number;
  predictedCtr: number;
  relevance: number;
  targeting: TargetingMatchSpec;
  freqCapCount: number;
  freqCapWindowSec: number;
}

/** The ad-unit kinds the auction can return. */
export type CreativeKind =
  | 'promoted_post'
  | 'promoted_listing'
  | 'promoted_job'
  | 'promoted_open_to_work'
  | 'promoted_hiring'
  | 'promoted_rfq';

export interface DecisionResult {
  impressionToken: string;
  campaignId: string;
  /** Which ad unit won, so the caller renders the right card + hydrates the right ref. */
  creativeKind: CreativeKind;
  /** Set for a promoted_post winner (the feed reads this). */
  postRef?: string;
  /** Set for a promoted_listing winner (the marketplace rail reads this, M2.2). */
  listingRef?: string;
  /** Set for a promoted_job winner (the jobs rail reads this, Phase 5). */
  jobRef?: string;
  /** Set for a promoted_open_to_work / promoted_hiring winner (the feed profile card). */
  profileRef?: string;
  /** Set for a promoted_rfq winner (the RFQ board rail). */
  rfqRef?: string;
}

// ---------------------------------------------------------------------------
// Collaborator interfaces + injection tokens
// ---------------------------------------------------------------------------

export const PLACEMENT_REPO = 'PLACEMENT_REPO';
export interface PlacementRepo {
  get(key: string): Promise<Placement | null>;
}

export const CANDIDATE_REPO = 'CANDIDATE_REPO';
export interface CandidateRepo {
  /**
   * Returns up to `limit` eligible candidates for a placement. `minRemainingCredits`
   * (the placement floor price per impression = floorCpm/1000) is enforced
   * server-side so budget-exhausted campaigns never enter the auction.
   *
   * CN-ADS-8 (feed harden Bucket 8): the optional `kinds` filter restricts the
   * auction to only the given creative kinds. The network page's promoted-profile
   * slot passes `['promoted_open_to_work','promoted_hiring']` so a shared
   * placement's auction never picks a non-profile winner that the page would then
   * discard client-side (wasting the slot). Omitted = every kind (unchanged).
   */
  top(
    placementKey: string,
    limit: number,
    minRemainingCredits?: number,
    kinds?: CreativeKind[],
  ): Promise<Candidate[]>;
}

/** Outcome of one auction decision -- emitted as selection telemetry (F2). */
export type DecisionOutcome =
  | 'served'
  | 'no_candidates'
  | 'all_filtered'
  | 'all_below_floor'
  | 'error';

export const PROFILE_REPO = 'PROFILE_REPO';
/** Note: AdProfileService.get already satisfies this interface. */
export interface ProfileRepo {
  get(userId: string): Promise<AdProfile>;
}

export const FREQ_CAP_REPO = 'FREQ_CAP_REPO';
/** Note: FrequencyCapService satisfies this interface. */
export interface FreqCapRepo {
  hitAndCheck(userId: string, adSetId: string, windowSec: number, cap: number): Promise<boolean>;
}

export const PACING_REPO = 'PACING_REPO';
/** Note: PacingRepoRedis satisfies this interface. */
export interface PacingRepo {
  isThrottled(campaignId: string): Promise<boolean>;
}

export const CAMPAIGN_CAP_REPO = 'CAMPAIGN_CAP_REPO';
/**
 * Platform daily frequency cap: at most N impressions of one campaign per
 * viewer per day (fairness control C4). Distinct from FreqCapRepo (the
 * advertiser's own per-ad-set window). `withinDailyCap` is read-only; the cap
 * is only consumed by `recordServe`, called on the auction winner.
 * Note: AdFairnessService satisfies this interface.
 */
export interface CampaignCapRepo {
  withinDailyCampaignCap(viewerKey: string, campaignId: string): Promise<boolean>;
  recordDailyCampaignServe(viewerKey: string, campaignId: string): Promise<void>;
}

export const PAGE_DEDUPE_REPO = 'PAGE_DEDUPE_REPO';
/**
 * Per-page dedupe (fairness control C5): a campaign serves at most once across
 * ALL slots of one page response. The caller threads a `pageRequestId`; served
 * campaigns are recorded against it and excluded from later slots on the same
 * page. Note: AdFairnessService satisfies this interface.
 */
export interface PageDedupeRepo {
  servedCampaigns(pageRequestId: string): Promise<string[]>;
  markServedOnPage(pageRequestId: string, campaignId: string): Promise<void>;
}

export const SUPPRESSION_REPO = 'SUPPRESSION_REPO';
/**
 * Viewer "hide this sponsored post" suppression (Phase 7d). When a reader hides
 * an ad, that campaign stops serving to THEM — the ad-side equivalent of feed
 * `not_interested`. `isCampaignSuppressed` is read-only and checked before any
 * cap hit so a suppressed candidate consumes nothing.
 * Note: AdFairnessService satisfies this interface.
 */
export interface SuppressionRepo {
  isCampaignSuppressed(viewerKey: string, campaignId: string): Promise<boolean>;
}

export const IMPRESSION_OPENER = 'IMPRESSION_OPENER';
export interface ImpressionOpener {
  open(input: {
    campaignId: string;
    adSetId: string;
    creativeId: string;
    userId: string;
    placementKey: string;
  }): Promise<{ impressionToken: string }>;
}

export const BLOCK_REPO = 'BLOCK_REPO';
/**
 * Bidirectional user-block check (audit B5). `isBlocked(viewerId, authorUserId)`
 * returns true when EITHER side blocked the other, so a boosted post never
 * serves across a block in either direction. Backed by the inbox `UserBlock`
 * collection (the same source the feed read path consults).
 */
export interface BlockRepo {
  isBlocked(viewerId: string, authorUserId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// AdDecisionService
// ---------------------------------------------------------------------------

/**
 * Telemetry sampling rate for auction decisions (0..1). 1 = emit every decision.
 * Auction volume is one event per slot render; if that ever dwarfs the metrics
 * budget, lower this constant (e.g. 0.1) to sample. Kept at 1 so every empty slot
 * is explainable from the logs out of the box.
 */
const DECISION_TELEMETRY_SAMPLE_RATE = 1;

/**
 * Score multiplier applied to a candidate that cleared a DISTRICT-targeted spec
 * ONLY via the unknown-location fallback (viewer district blank / unrecognized —
 * see lib/targeting `isUnknownLocationDistrictMatch`). Region targeting now keeps
 * unknown-location viewers eligible instead of excluding them; this modest
 * down-rank (0.7) means that when a confidently-local viewer (recognized
 * district in the target list) is also a candidate for the slot, they win the
 * tie/ordering, while unknown-location viewers still get served when no better
 * local match exists. Kept conservative so region boosts still reach real volume.
 */
const UNKNOWN_LOCATION_SCORE_FACTOR = 0.7;

@Injectable()
export class AdDecisionService {
  private readonly logger = new Logger(AdDecisionService.name);

  constructor(
    @Inject(PLACEMENT_REPO) private readonly placements: PlacementRepo,
    @Inject(CANDIDATE_REPO) private readonly candidates: CandidateRepo,
    @Inject(PROFILE_REPO) private readonly profiles: ProfileRepo,
    @Inject(FREQ_CAP_REPO) private readonly freqCap: FreqCapRepo,
    @Inject(PACING_REPO) private readonly pacing: PacingRepo,
    @Inject(IMPRESSION_OPENER) private readonly impressions: ImpressionOpener,
    // PostHogService is @Global(); @Optional so the positional unit-test
    // constructor (6-arg) keeps working without wiring a fake.
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    // Bidirectional block check (audit B5). @Optional so the positional unit-test
    // constructors that stop before this arg keep working; Nest DI always
    // provides it (AdsModule binds BLOCK_REPO). When absent, no block filtering.
    @Optional() @Inject(BLOCK_REPO) private readonly blocks?: BlockRepo,
    // Platform fairness controls (C4 daily campaign cap, C5 per-page dedupe).
    // @Optional so the positional unit-test constructors that stop earlier keep
    // working; Nest DI always provides both (AdsModule binds them to
    // AdFairnessService). When absent, the cap / dedupe simply do not apply.
    @Optional() @Inject(CAMPAIGN_CAP_REPO) private readonly campaignCap?: CampaignCapRepo,
    @Optional() @Inject(PAGE_DEDUPE_REPO) private readonly pageDedupe?: PageDedupeRepo,
    // Viewer "hide this sponsored post" suppression (Phase 7d). @Optional so the
    // positional unit-test constructors that stop earlier keep working; Nest DI
    // always provides it (AdsModule binds SUPPRESSION_REPO to AdFairnessService).
    // When absent, suppression simply does not apply.
    @Optional() @Inject(SUPPRESSION_REPO) private readonly suppression?: SuppressionRepo,
  ) {}

  /**
   * Hot-path ad decision: given a viewer userId and a placement key, pick the
   * highest-scoring eligible ad candidate and open an impression record.
   *
   * Returns null when no eligible candidate exists (caller falls back to house promo).
   *
   * Steps:
   *  1. Fetch and validate placement (must exist + be enabled).
   *  2. Fetch viewer AdProfile (for targeting matching).
   *  3. Fetch up to 50 candidates for the placement.
   *  4. Score eligible candidates sequentially (own-author, targeting, pacing, freqcap filters).
   *  5. Sort descending by score; pick winner.
   *  6. Apply floor CPM gate.
   *  7. Open impression and return result.
   *
   * Note: freqCap.hitAndCheck consumes a hit even for candidates that lose the
   * auction (accepted simplification - fine for single-candidate slots and low
   * contention scenarios).
   *
   * Candidates are processed sequentially with for..of + await rather than
   * Promise.all because freqCap.hitAndCheck has a side effect (incrementing
   * the hit counter) and order matters for correctness.
   */
  async decide({
    userId,
    placementKey,
    pageRequestId,
    kinds,
  }: {
    userId: string;
    placementKey: string;
    /**
     * Opaque per-page-render id (fairness C5). When two slots on the same page
     * (e.g. marketplace rail + grid) pass the same id, a campaign that wins one
     * is excluded from the others. Absent / empty -> dedupe is a no-op.
     */
    pageRequestId?: string;
    /**
     * CN-ADS-8: restrict the auction to these creative kinds. The network page's
     * promoted-profile slot passes the two profile-boost kinds so the shared
     * auction never returns a non-profile winner it would then discard. Omitted
     * = every kind.
     */
    kinds?: CreativeKind[];
  }): Promise<DecisionResult | null> {
    try {
      // Step 1: validate placement
      const placement = await this.placements.get(placementKey);
      if (!placement || !placement.enabled) {
        // A disabled / missing placement is a configuration outcome, not a
        // selection outcome -- treat it as no candidates (nothing could serve).
        this.emitDecision('no_candidates', { placementKey, candidateCount: 0, floorCpm: 0 });
        return null;
      }

      // Step 2: fetch viewer profile for targeting
      const profile = await this.profiles.get(userId);

      // Step 3: fetch candidates. Pass the placement floor price (floorCpm per
      // impression = floorCpm/1000) so budget-exhausted campaigns are excluded
      // server-side rather than failing later.
      const minRemainingCredits = placement.floorCpm / 1000;
      // CN-ADS-8: thread the optional kinds filter so a shared placement's auction
      // only considers the caller's requested kinds (e.g. profile boosts only).
      const candidateList = await this.candidates.top(placementKey, 50, minRemainingCredits, kinds);

      // Campaigns already served elsewhere on this page render (C5). Fetched once
      // up front; an empty / absent pageRequestId yields an empty set so dedupe
      // is inert on single-slot pages.
      const dedupedSet = new Set<string>(
        this.pageDedupe && pageRequestId
          ? await this.pageDedupe.servedCampaigns(pageRequestId)
          : [],
      );

      // Step 4: score eligible candidates. Track WHY candidates were filtered so
      // the telemetry breakdown can explain a thin / empty slot (fairness C7).
      const scored: { c: Candidate; s: number }[] = [];
      let frequencyCapped = 0; // per-ad-set cap (FreqCapRepo) + daily campaign cap (C4)
      let pageDeduped = 0; // already served on this page (C5)

      for (const c of candidateList) {
        // Never show a user their own boosted post
        if (c.authorUserId === userId) continue;

        // Never serve across a block, either direction (audit B5). Checked
        // before the freq-cap hit so a blocked candidate consumes nothing.
        if (this.blocks && (await this.blocks.isBlocked(userId, c.authorUserId))) continue;

        // Never serve a campaign the viewer hid (Phase 7d — sponsored "Hide").
        // Read-only + checked before any cap hit, so a suppressed candidate
        // consumes no frequency budget.
        if (this.suppression && (await this.suppression.isCampaignSuppressed(userId, c.campaignId)))
          continue;

        // Targeting must match viewer profile
        if (!matchesTargeting(c.targeting, profile)) continue;

        // Skip pacing-throttled campaigns
        if (await this.pacing.isThrottled(c.campaignId)) continue;

        // Per-page dedupe (C5): a campaign already shown in another slot of this
        // same page render never serves twice. Checked before any cap hit so a
        // deduped candidate consumes no frequency budget.
        if (dedupedSet.has(c.campaignId)) {
          pageDeduped++;
          continue;
        }

        // Daily campaign cap (C4): read-only, so it never burns the cap for a
        // candidate that loses the auction. Checked before the per-ad-set hit.
        if (
          this.campaignCap &&
          !(await this.campaignCap.withinDailyCampaignCap(userId, c.campaignId))
        ) {
          frequencyCapped++;
          continue;
        }

        // freqCap.hitAndCheck consumes a hit even on losing candidates
        if (
          !(await this.freqCap.hitAndCheck(userId, c.adSetId, c.freqCapWindowSec, c.freqCapCount))
        ) {
          frequencyCapped++;
          continue;
        }

        // Region down-rank: if this candidate targets districts and the viewer
        // matched only via the unknown-location fallback (blank / unrecognized
        // district), apply a modest score penalty so confidently-local viewers
        // are preferred for the slot. No-op for non-district-targeted candidates
        // and for viewers with a recognized local district. See lib/targeting.
        const baseScore = score(
          ecpm({ billingEvent: c.billingEvent, bid: c.bid, predictedCtr: c.predictedCtr }),
          c.relevance,
        );
        const s = isUnknownLocationDistrictMatch(c.targeting, profile)
          ? baseScore * UNKNOWN_LOCATION_SCORE_FACTOR
          : baseScore;

        scored.push({ c, s });
      }

      const base = {
        placementKey,
        candidateCount: candidateList.length,
        floorCpm: placement.floorCpm,
        filtered: { frequency_capped: frequencyCapped, page_deduped: pageDeduped },
      };

      // Step 5: pick a winner. Sort descending, then rotate among effective ties
      // (fairness C6) so equal bidders share inventory rather than the same
      // campaign always taking the slot.
      if (scored.length === 0) {
        // Distinguish "nothing fetched" from "all candidates filtered out" so an
        // empty slot is explainable: no_candidates vs all_filtered.
        this.emitDecision(candidateList.length === 0 ? 'no_candidates' : 'all_filtered', base);
        return null;
      }
      scored.sort((a, b) => b.s - a.s);
      const winner = pickTopWithRotation(scored);

      // Step 6: floor CPM gate - if winner does not clear the floor, fall back to house promo
      const winnerEcpm = ecpm({
        billingEvent: winner.billingEvent,
        bid: winner.bid,
        predictedCtr: winner.predictedCtr,
      });
      if (winnerEcpm < placement.floorCpm) {
        this.emitDecision('all_below_floor', { ...base, winnerEcpm });
        return null;
      }

      // Step 7: open impression record and return
      const { impressionToken } = await this.impressions.open({
        campaignId: winner.campaignId,
        adSetId: winner.adSetId,
        creativeId: winner.creativeId,
        userId,
        placementKey,
      });

      // Record the served winner against the fairness counters (C4 daily cap +
      // C5 page dedupe). Both are best-effort and must not block the response;
      // a failure here should not blank a slot that already won, so swallow.
      try {
        if (this.campaignCap)
          await this.campaignCap.recordDailyCampaignServe(userId, winner.campaignId);
        if (this.pageDedupe && pageRequestId)
          await this.pageDedupe.markServedOnPage(pageRequestId, winner.campaignId);
      } catch (e) {
        this.logger.warn(`ads fairness record failed (non-fatal): ${(e as Error).message}`);
      }

      this.emitDecision('served', {
        ...base,
        winnerCampaignId: winner.campaignId,
        winnerEcpm,
      });

      return {
        impressionToken,
        campaignId: winner.campaignId,
        creativeKind: winner.creativeKind,
        ...(winner.postRef !== undefined ? { postRef: winner.postRef } : {}),
        ...(winner.listingRef !== undefined ? { listingRef: winner.listingRef } : {}),
        ...(winner.jobRef !== undefined ? { jobRef: winner.jobRef } : {}),
        ...(winner.profileRef !== undefined ? { profileRef: winner.profileRef } : {}),
        ...(winner.rfqRef !== undefined ? { rfqRef: winner.rfqRef } : {}),
      };
    } catch (err) {
      // Selection telemetry must still record the failure so a blank slot caused
      // by an exception is not silently invisible. Re-throw so the caller's
      // error handling (and Sentry) is unchanged.
      this.emitDecision('error', { placementKey, candidateCount: 0, floorCpm: 0 });
      throw err;
    }
  }

  /**
   * F2.3 -- selection telemetry. Emits exactly ONE structured log + ONE metric per
   * auction decision so every empty slot is explainable (no candidates? all below
   * floor? all filtered out?). Cheap: no extra queries, fields only. Sampled by
   * DECISION_TELEMETRY_SAMPLE_RATE (constant; 1 = always). Mirrors the
   * Logger + PostHogService pattern used by the ads reconcile cron.
   */
  private emitDecision(
    outcome: DecisionOutcome,
    fields: {
      placementKey: string;
      candidateCount: number;
      floorCpm: number;
      winnerCampaignId?: string;
      winnerEcpm?: number;
      /**
       * Fairness filter breakdown (C7): how many candidates were dropped by the
       * daily campaign cap / per-ad-set cap (frequency_capped) and by per-page
       * dedupe (page_deduped). Present on every outcome (zeros when the path
       * exits before the scoring loop, e.g. missing placement).
       */
      filtered?: { frequency_capped: number; page_deduped: number };
    },
  ): void {
    // Deterministic, allocation-free sample gate. SAMPLE_RATE 1 short-circuits to
    // always-emit; lower it only if auction volume threatens the metrics budget.
    if (DECISION_TELEMETRY_SAMPLE_RATE < 1 && Math.random() >= DECISION_TELEMETRY_SAMPLE_RATE) {
      return;
    }

    const filtered = fields.filtered ?? { frequency_capped: 0, page_deduped: 0 };

    this.logger.log(
      `ads auction decided: placement=${fields.placementKey} outcome=${outcome} ` +
        `candidates=${fields.candidateCount} floorCpm=${fields.floorCpm} ` +
        `freqCapped=${filtered.frequency_capped} pageDeduped=${filtered.page_deduped}` +
        (fields.winnerCampaignId ? ` winner=${fields.winnerCampaignId}` : '') +
        (fields.winnerEcpm !== undefined ? ` winnerEcpm=${fields.winnerEcpm}` : ''),
    );

    this.posthog?.capture({
      distinctId: 'system',
      event: 'ads.auction_decided',
      properties: {
        placement: fields.placementKey,
        outcome,
        candidateCount: fields.candidateCount,
        floorCpm: fields.floorCpm,
        // Fairness outcome breakdown (C7).
        frequency_capped: filtered.frequency_capped,
        page_deduped: filtered.page_deduped,
        ...(fields.winnerCampaignId !== undefined && { winnerCampaignId: fields.winnerCampaignId }),
        ...(fields.winnerEcpm !== undefined && { winnerEcpm: fields.winnerEcpm }),
      },
    });
  }
}
