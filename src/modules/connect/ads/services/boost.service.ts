import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { AdCampaign, type AdCampaignDocument } from '../schemas/ad-campaign.schema';
import { AdSet } from '../schemas/ad-set.schema';
import { AdCreative } from '../schemas/ad-creative.schema';
import { AdDailyRollup } from '../schemas/ad-daily-rollup.schema';
import { Listing, type ListingDocument } from '../../marketplace/schemas/listing.schema';
import { Job, type JobDocument } from '../../jobs/schemas/job.schema';
import { Post } from '../../feed/schemas/post.schema';
import { Rfq, type RfqDocument } from '../../rfq/schemas/rfq.schema';
import { ConnectProfile } from '../../profile/schemas/connect-profile.schema';
import {
  CONNECT_POST_CHANGED,
  type ConnectPostChangedEvent,
} from '../../feed/events/connect-post.events';
import { CONNECT_LISTING_CHANGED } from '../../marketplace/events/connect-listing.events';
import { CONNECT_JOB_CHANGED } from '../../jobs/events/connect-job.events';
import { CONNECT_RFQ_CHANGED } from '../../rfq/events/connect-rfq.events';
import { ConnectOverLimitService } from '../../over-limit/connect-over-limit.service';
import type { TargetingMatchSpec } from '../lib/targeting';
import {
  deriveMetrics,
  last30dIstDateRange,
  currentIstMonthRange,
  type RollupCountRow,
} from '../lib/boost-analytics.helpers';
import { WalletService } from './wallet.service';
import { ConnectPricingConfigService } from './connect-pricing-config.service';
import { CONNECT_PRICING_DEFAULTS } from '../schemas/connect-pricing-config.schema';
import { BOOST_DURATION_DAY_MIN, BOOST_DURATION_DAY_MAX } from '../dto/create-listing-boost.dto';
import { PostHogService } from '../../../../common/posthog/posthog.service';

// ---------------------------------------------------------------------------
// Injection token for the rollup reader
// ---------------------------------------------------------------------------

export const ROLLUP_READER = 'BOOST_ROLLUP_READER';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `spotlight` (Phase 2): the optional premium upgrade on ANY boost. When true the
 * campaign also serves in the premium right-rail (`spotlight_rail`) and is billed
 * at `bid x spotlightMultiplier` (a premium rate). Default false = base boost
 * (feed + section only). Shared across every create input below.
 */
export interface CreateListingBoostInput {
  ownerUserId: string;
  listingId: string;
  objective: 'reach' | 'inquiries';
  totalBudget: number;
  days: number;
  targeting: TargetingMatchSpec;
  spotlight?: boolean;
}

export interface CreateJobBoostInput {
  ownerUserId: string;
  jobId: string;
  objective: 'reach' | 'applications';
  totalBudget: number;
  days: number;
  targeting: TargetingMatchSpec;
  spotlight?: boolean;
}

export interface CreatePostBoostInput {
  ownerUserId: string;
  postId: string;
  /** `reach` (cpm, broad views) or `profile_visits` (cpc, clicks to the author). */
  objective: 'reach' | 'profile_visits';
  totalBudget: number;
  days: number;
  targeting: TargetingMatchSpec;
  spotlight?: boolean;
}

export interface CreateOpenToWorkBoostInput {
  ownerUserId: string;
  /** `reach` (cpm) or `profile_visits` (cpc, employers clicking the profile). */
  objective: 'reach' | 'profile_visits';
  totalBudget: number;
  days: number;
  targeting: TargetingMatchSpec;
  spotlight?: boolean;
}

export interface CreateHiringBoostInput {
  ownerUserId: string;
  /** `reach` (cpm) or `profile_visits` (cpc, workers clicking the profile). */
  objective: 'reach' | 'profile_visits';
  totalBudget: number;
  days: number;
  targeting: TargetingMatchSpec;
  spotlight?: boolean;
}

export interface CreateRfqBoostInput {
  ownerUserId: string;
  rfqId: string;
  /** `reach` (cpm) or `quotes` (cpc, suppliers responding with a quote). */
  objective: 'reach' | 'quotes';
  totalBudget: number;
  days: number;
  targeting: TargetingMatchSpec;
  spotlight?: boolean;
}

/**
 * Default delivery audiences for the intent boosts, by `AdProfile.role` (derived
 * from `ConnectProfile.onboardingIntent`). Applied server-side when the advertiser
 * leaves the role dimension empty, so "reach employers / workers" holds by default
 * even on the broadest targeting. The advertiser can still narrow district/trade.
 * Keep in sync with the web BOOST_ROLES vocab.
 */
const EMPLOYER_AUDIENCE_ROLES = ['workshop_owner', 'buyer'];
const WORKER_AUDIENCE_ROLES = ['karigar'];

/**
 * Internal spec for the shared campaign + ad-set + creative + wallet-reserve
 * pipeline. Exactly one of `sourcePostId` / `sourceListingId` and one of
 * `postRef` / `listingRef` is set, per the campaign / creative kind.
 */
interface BoostBundleSpec {
  ownerUserId: string;
  objective: string;
  totalBudget: number;
  days: number;
  targeting: TargetingMatchSpec;
  campaignKind:
    | 'boost_post'
    | 'boost_listing'
    | 'boost_job'
    | 'boost_open_to_work'
    | 'boost_hiring'
    | 'boost_rfq';
  creativeKind:
    | 'promoted_post'
    | 'promoted_listing'
    | 'promoted_job'
    | 'promoted_open_to_work'
    | 'promoted_hiring'
    | 'promoted_rfq';
  placements: string[];
  /** Phase 2: when true, append `spotlight_rail` + bill at the premium bid. */
  spotlight?: boolean;
  sourcePostId?: string;
  sourceListingId?: string;
  sourceJobId?: string;
  sourceProfileUserId?: string;
  sourceRfqId?: string;
  postRef?: string;
  listingRef?: string;
  jobRef?: string;
  profileRef?: string;
  rfqRef?: string;
}

export interface RollupReader {
  aggregateFor: (campaignId: string) => Promise<{
    impressions: number;
    viewableImpressions: number;
    clicks: number;
    validClicks: number;
    spend: number;
  }>;
}

export interface BoostStatusView {
  status: string;
  objective: string;
  spend: number;
  budgetRemaining: number;
  reach: number;
  views: number;
  clicks: number;
  /** Why an admin took this boost down, shown to the advertiser. null otherwise. */
  moderationReason: string | null;
}

/**
 * One row in the caller's boost-campaign list. Carries the campaign envelope
 * plus REAL lifetime metrics aggregated from `ad_daily_rollups`. There is no
 * inquiry / conversion field because those are not attributed per campaign.
 */
export interface BoostListItem {
  id: string;
  kind: string;
  objective: string;
  status: string;
  totalBudget: number;
  budgetSpent: number;
  startAt: Date;
  endAt: Date;
  /** Source listing id when `kind === 'boost_listing'`, else null. */
  sourceListingId: string | null;
  /** Source job id when `kind === 'boost_job'`, else null. */
  sourceJobId: string | null;
  /** Source post id when `kind === 'boost_post'`, else null. Lets the manager
   *  deep-link a post boost back into its composer ("Boost again"). */
  sourcePostId: string | null;
  /** Source RFQ id when `kind === 'boost_rfq'`, else null. */
  sourceRfqId: string | null;
  /** The promoted profile owner when `kind` is a profile boost, else null. */
  sourceProfileUserId: string | null;
  /**
   * The boosted item's human title, resolved in batch from the source doc so the
   * advertiser's row shows the real product / job / post name (not just the
   * objective). listing/job/rfq -> the doc title; post -> a short body snippet;
   * profile boost -> the owner's profile headline; null when the source doc is
   * missing. (mirrors AdsAdminService.enrichCreative's per-kind title lookup.)
   */
  sourceTitle: string | null;
  /** The boosted item's thumbnail image; only listings carry one (first image), else null. */
  sourceImage: string | null;
  /** Why an admin took this boost down, shown to the advertiser. null otherwise. */
  moderationReason: string | null;
  /** Lifetime impressions. Labelled "reach" in the advertiser UI. */
  impressions: number;
  clicks: number;
  spend: number;
  /** Click-through rate: clicks / impressions, zero-safe. */
  ctr: number;
  /** Average cost per click: spend / clicks, zero-safe. */
  costPerClick: number;
}

/** KPI aggregates across the caller's campaigns. All values are REAL. */
export interface BoostStatsView {
  /** Number of the caller's campaigns currently in `active` status. */
  activeCount: number;
  /** Sum of impressions across the caller's rollups in the last 30 IST days. */
  reach30d: number;
  /** Sum of clicks across the caller's rollups in the last 30 IST days. */
  clicks30d: number;
  /** Sum of spend across the caller's rollups in the current IST month. */
  spendThisMonth: number;
}

/**
 * One quick-start "boost something" candidate the caller already owns and is
 * eligible to boost RIGHT NOW (the status gate mirrors the create gates exactly,
 * so a card can never deep-link into a composer that would 400). Powers the web
 * Boosts-hub quick-start. General feed posts are intentionally NOT boostable
 * (owner decision 2026-06-17), so only `boost_listing` / `boost_job` appear here.
 */
export interface BoostableItem {
  id: string;
  kind: 'boost_listing' | 'boost_job' | 'boost_rfq';
  title: string;
  /** Listing cover image; null for a job / RFQ (no cover). */
  image: string | null;
  /** A short secondary label: listing category, or job role/category, or RFQ category. */
  subtitle: string | null;
  /** Lifetime organic views (jobs only); null when the source has no counter. */
  views: number | null;
}

/**
 * The caller's boostable items grouped by type + their active profile intents.
 * `counts` are the TOTAL eligible items per type (the lists are capped) so the
 * web can render a "See all (N)" link. `intents` are the `ConnectProfile.openTo`
 * toggles; the web shows a contextual nudge only when an intent is on and the
 * matching type has nothing eligible. Cross-module: reads Listing (marketplace),
 * Job (jobs), AdCampaign (in-flight gate), ConnectProfile (intents).
 */
export interface BoostableSummary {
  listings: BoostableItem[];
  jobs: BoostableItem[];
  /** The caller's open RFQs eligible to boost now (no in-flight boost). */
  rfqs: BoostableItem[];
  counts: { listings: number; jobs: number; rfqs: number };
  intents: { work: boolean; hiring: boolean; deals: boolean; customOrders: boolean };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class BoostService {
  private readonly logger = new Logger(BoostService.name);

  constructor(
    @InjectModel(AdCampaign.name)
    private readonly campaignModel: Model<AdCampaignDocument>,
    @InjectModel(AdSet.name)
    private readonly adSetModel: Model<AdSet>,
    @InjectModel(AdCreative.name)
    private readonly creativeModel: Model<AdCreative>,
    private readonly wallet: WalletService,
    @Inject(ROLLUP_READER)
    private readonly rollups: RollupReader,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    // Optional only so the shipped post-boost unit tests can construct
    // positionally without it; Nest DI always provides it (AdsModule registers
    // the Listing model). Required for the listing-boost path, guarded below.
    @Optional()
    @InjectModel(Listing.name)
    private readonly listingModel?: Model<ListingDocument>,
    // Optional for the same positional-construction reason as listingModel;
    // Nest DI always provides it (AdsModule registers the Job model).
    @Optional()
    @InjectModel(Job.name)
    private readonly jobModel?: Model<JobDocument>,
    // Optional for the same positional-construction reason as the models above;
    // Nest DI always provides it (AdsModule registers the AdDailyRollup model).
    // Required by list() / stats(), guarded in those methods.
    @Optional()
    @InjectModel(AdDailyRollup.name)
    private readonly rollupModel?: Model<AdDailyRollup>,
    // Optional for the same positional-construction reason as the models above;
    // Nest DI always provides it (AdsModule registers the Post model). Required
    // by the post-boost path + the stop-on-delete/unpublish hook, guarded below.
    @Optional()
    @InjectModel(Post.name)
    private readonly postModel?: Model<Post>,
    // Appended LAST so existing positional unit-test constructions are
    // unaffected. Optional: when absent (those tests) we fall back to
    // CONNECT_PRICING_DEFAULTS, which equal the previous hardcoded bid (40/4),
    // min budget (99), and durations ([3,7,14,30]) -- identical behaviour. Nest
    // DI always provides it in production (AdsModule registers the service), so
    // a live admin price change takes effect on the next boost with no deploy.
    @Optional()
    private readonly pricingConfig?: ConnectPricingConfigService,
    // Appended LAST (after pricingConfig) so existing positional unit-test
    // constructions stay valid. Optional: when absent (those tests) the
    // boostable() intents fall back to all-false. Nest DI always provides it in
    // production (AdsModule imports ConnectProfileModule, which exports the
    // ConnectProfile model). Read-only here -- used only by boostable().
    @Optional()
    @InjectModel(ConnectProfile.name)
    private readonly profileModel?: Model<ConnectProfile>,
    // Appended LAST (after profileModel) so existing positional unit-test
    // constructions stay valid. Optional for the same reason; Nest DI always
    // provides it in production (AdsModule registers the Rfq model). Required by
    // the rfq-boost path + boostable() RFQ rail, guarded below.
    @Optional()
    @InjectModel(Rfq.name)
    private readonly rfqModel?: Model<RfqDocument>,
    // CN-LIM-1 (feed harden Bucket 11): the over-limit suppression service, so a
    // listing/job the plan has SUPPRESSED (over its cap under the hide_newest
    // policy) cannot be boosted and never appears in the boostable candidate
    // list. @Optional + LAST so positional unit-test constructors keep working; a
    // no-op under freeze (CONNECT_LIMITS_ENFORCED off). AdsModule imports the
    // over-limit module so DI supplies it in production.
    @Optional()
    private readonly overLimit?: ConnectOverLimitService,
  ) {}

  /**
   * Live pricing levers (bid + min budget + allowed durations), read from the
   * admin-tunable config when the service is injected, else the shipped
   * defaults. Cross-module link: ConnectPricingConfigService (DB + admin CRUD).
   */
  private async getPricing(): Promise<{
    boostBidCpm: number;
    boostBidCpc: number;
    spotlightMultiplier: number;
    boostMinBudget: number;
    boostDurations: number[];
  }> {
    if (this.pricingConfig) {
      const cfg = await this.pricingConfig.getConfig();
      return {
        boostBidCpm: cfg.boostBidCpm,
        boostBidCpc: cfg.boostBidCpc,
        spotlightMultiplier: cfg.spotlightMultiplier,
        boostMinBudget: cfg.boostMinBudget,
        boostDurations: cfg.boostDurations,
      };
    }
    return {
      boostBidCpm: CONNECT_PRICING_DEFAULTS.boostBidCpm,
      boostBidCpc: CONNECT_PRICING_DEFAULTS.boostBidCpc,
      spotlightMultiplier: CONNECT_PRICING_DEFAULTS.spotlightMultiplier,
      boostMinBudget: CONNECT_PRICING_DEFAULTS.boostMinBudget,
      boostDurations: [...CONNECT_PRICING_DEFAULTS.boostDurations],
    };
  }

  /**
   * Boost a marketplace listing (M2.1). Reuses the exact campaign / ad-set /
   * creative / wallet-reserve pipeline as a post boost, with a `boost_listing`
   * campaign + `promoted_listing` creative bound to the `marketplace_rail`
   * placement. Person-centric: the advertiser is the listing owner.
   *
   * Gates (in order):
   *   1. The listing exists and is owned by the caller (404 on a non-owned id,
   *      so ownership is never leaked).
   *   2. `moderationStatus === 'approved'` (owner-locked boost-eligibility gate).
   *   3. No in-flight boost already exists for the listing (pending / active /
   *      paused). A completed / rejected / expired prior boost may be replaced.
   *
   * On success the budget is reserved (grant credits first, then purchased
   * balance) and `Listing.boostCampaignId` is linked to the new campaign.
   */
  async createListingBoost(input: CreateListingBoostInput): Promise<AdCampaignDocument> {
    const listingModel = this.listingModel;
    if (!listingModel) {
      // Never happens under Nest DI; the constructor param is optional only for
      // the post-boost unit tests that construct BoostService positionally.
      throw new Error('BoostService.listingModel is required to boost a listing');
    }

    const listing = await listingModel.findById(input.listingId);
    // ObjectId-equality ownership check (mirrors feed.service deletePost) rather
    // than String() coercion, so a hex/ObjectId type mix cannot slip past a
    // refactor. `.equals` accepts the hex string from the authed caller.
    if (!listing || !(listing.ownerUserId as Types.ObjectId).equals(input.ownerUserId)) {
      throw new NotFoundException('Listing not found');
    }
    // CN-BOOST-2 (Bucket 2): gate on BOTH the moderation state AND the live
    // status, mirroring createPostBoost's live+public double-gate. A paused /
    // sold / draft / expired listing (even if still `moderationStatus:approved`)
    // cannot be boosted — otherwise a boost would serve an item that no longer
    // shows in the marketplace.
    if (listing.moderationStatus !== 'approved' || listing.status !== 'active') {
      throw new BadRequestException('Only an active, approved listing can be boosted');
    }
    // CN-LIM-1 (Bucket 11): a listing SUPPRESSED by the over-limit policy
    // (hide_newest, over the plan cap) is not publicly visible, so it must not be
    // boostable. Reject with an upsell-style message. No-op under freeze.
    if (this.overLimit) {
      const suppressed = await this.overLimit.getSuppressedIds(input.ownerUserId, 'listing');
      if (suppressed.includes(String(listing._id))) {
        throw new BadRequestException(
          'This listing is hidden because you are over your plan limit. Upgrade your plan or free a slot to boost it.',
        );
      }
    }
    if (listing.boostCampaignId) {
      const existing = await this.campaignModel.findById(listing.boostCampaignId);
      if (existing && ['pending_review', 'active', 'paused'].includes(existing.status)) {
        throw new BadRequestException('This listing already has an active boost');
      }
    }

    const campaign = await this.buildBundleAndReserve({
      ownerUserId: input.ownerUserId,
      objective: input.objective,
      totalBudget: input.totalBudget,
      days: input.days,
      spotlight: input.spotlight,
      targeting: input.targeting,
      campaignKind: 'boost_listing',
      creativeKind: 'promoted_listing',
      // In-grid promoted cell (marketplace_grid) + the marketplace right-rail
      // (marketplace_rail) + the unified in-feed sponsored slot (feed_sponsored),
      // so a boosted listing shows as a PROMOTED unit pinned at the top of the
      // marketplace product grid (all breakpoints incl. mobile), in the desktop
      // rail, AND in the feed (Phase 1). `marketplace_grid` is a seeded
      // AdPlacement (see migrations/seed-connect-ad-placements.ts); the
      // marketplace page resolves it via
      // resolvePromotedRailListing('marketplace_grid') and the grid then pins the
      // card at the top (web MarketplaceBrowseScreen). The page passes ONE shared
      // adPageId to the rail + grid decides, so fairness dedupe (C5) still serves
      // a campaign at most once across the two marketplace slots.
      placements: ['marketplace_grid', 'marketplace_rail', 'feed_sponsored'],
      sourceListingId: input.listingId,
      listingRef: input.listingId,
    });

    // Link only after the reserve succeeded (buildBundleAndReserve throws on a
    // short wallet, so we never link a campaign that was rolled back).
    listing.boostCampaignId = campaign._id;
    await listing.save();

    this.posthog?.capture({
      distinctId: input.ownerUserId,
      event: 'ads.boost_created',
      properties: {
        campaignId: String(campaign._id),
        target: 'listing',
        listingId: input.listingId,
        objective: input.objective,
        billingEvent: campaign.billingEvent,
        totalBudget: input.totalBudget,
        days: input.days,
      },
    });

    return campaign;
  }

  /**
   * Boost a job (Phase 5). Mirrors `createListingBoost` exactly with a
   * `boost_job` campaign + `promoted_job` creative bound to the `jobs_rail`
   * placement. Person-centric: the advertiser is the job owner.
   *
   * Gates (in order):
   *   1. The job exists and is owned by the caller (404 on a non-owned id).
   *   2. `status === 'open'` (you boost a job that is taking applications).
   *   3. No in-flight boost already exists for the job (pending / active / paused).
   */
  async createJobBoost(input: CreateJobBoostInput): Promise<AdCampaignDocument> {
    const jobModel = this.jobModel;
    if (!jobModel) {
      throw new Error('BoostService.jobModel is required to boost a job');
    }

    const job = await jobModel.findById(input.jobId);
    // ObjectId-equality ownership check (see createListingBoost) -- consistent
    // with feed.service deletePost, robust to a hex/ObjectId type mix.
    if (!job || !job.companyUserId.equals(input.ownerUserId)) {
      throw new NotFoundException('Job not found');
    }
    if (job.status !== 'open') {
      throw new BadRequestException('Only an open job can be boosted');
    }
    if (job.boostCampaignId) {
      const existing = await this.campaignModel.findById(job.boostCampaignId);
      if (existing && ['pending_review', 'active', 'paused'].includes(existing.status)) {
        throw new BadRequestException('This job already has an active boost');
      }
    }

    const campaign = await this.buildBundleAndReserve({
      ownerUserId: input.ownerUserId,
      objective: input.objective,
      totalBudget: input.totalBudget,
      days: input.days,
      spotlight: input.spotlight,
      targeting: input.targeting,
      campaignKind: 'boost_job',
      creativeKind: 'promoted_job',
      // The jobs-board "Promoted" block is a separate read-path resolver keyed on
      // kind=boost_job (unaffected); `feed_sponsored` adds billed in-feed delivery
      // so a boosted job also reaches the feed (Phase 1).
      placements: ['feed_sponsored'],
      sourceJobId: input.jobId,
      jobRef: input.jobId,
    });

    job.boostCampaignId = campaign._id;
    await job.save();

    this.posthog?.capture({
      distinctId: input.ownerUserId,
      event: 'ads.boost_created',
      properties: {
        campaignId: String(campaign._id),
        target: 'job',
        jobId: input.jobId,
        objective: input.objective,
        billingEvent: campaign.billingEvent,
        totalBudget: input.totalBudget,
        days: input.days,
      },
    });

    return campaign;
  }

  /**
   * Boost one of the caller's own feed posts. Mirrors `createListingBoost` /
   * `createJobBoost` exactly, with a `boost_post` campaign + `promoted_post`
   * creative bound to the LIVE `feed_promoted_post` placement -- the same slot
   * the feed page already serves and the FE already renders + tracks. Once the
   * creative is approved (campaign -> `active`) it serves through that path with
   * no extra wiring.
   *
   * Gates (in order):
   *   1. The post exists and was authored by the caller (404 on a non-owned id,
   *      so authorship is never leaked) -- only the AUTHOR can boost it.
   *   2. The post is live (not soft-deleted).
   *   3. The post is `public` (audit #9: a `connections`-only post must never be
   *      served as a public ad).
   *   4. No in-flight boost already exists for the post (pending / active /
   *      paused) -- no double-boosting one post. A completed / rejected / expired
   *      prior boost may be replaced.
   */
  async createPostBoost(input: CreatePostBoostInput): Promise<AdCampaignDocument> {
    const postModel = this.postModel;
    if (!postModel) {
      // Never happens under Nest DI; the constructor param is optional only for
      // the positional unit-test constructions of BoostService.
      throw new Error('BoostService.postModel is required to boost a post');
    }

    const post = await postModel.findById(input.postId);
    // ObjectId-equality authorship check (mirrors feed.service editPost/deletePost):
    // only the post author may boost it. A non-owned / missing id 404s identically
    // so authorship is never leaked.
    if (!post || !(post.authorId as Types.ObjectId).equals(input.ownerUserId)) {
      throw new NotFoundException('Post not found');
    }
    if (post.deletedAt) {
      throw new BadRequestException('Only a live post can be boosted');
    }
    if (post.visibility !== 'public') {
      // audit #9 -- a private / connections-only post cannot be promoted publicly.
      throw new BadRequestException('Only a public post can be boosted');
    }
    if (post.boostCampaignId) {
      const existing = await this.campaignModel.findById(post.boostCampaignId);
      if (existing && ['pending_review', 'active', 'paused'].includes(existing.status)) {
        throw new BadRequestException('This post already has an active boost');
      }
    }

    const campaign = await this.buildBundleAndReserve({
      ownerUserId: input.ownerUserId,
      objective: input.objective,
      totalBudget: input.totalBudget,
      days: input.days,
      spotlight: input.spotlight,
      targeting: input.targeting,
      campaignKind: 'boost_post',
      creativeKind: 'promoted_post',
      // Unified in-feed sponsored slot (Phase 1; supersedes feed_promoted_post).
      placements: ['feed_sponsored'],
      sourcePostId: input.postId,
      postRef: input.postId,
    });

    // Link only after the reserve succeeded (buildBundleAndReserve throws on a
    // short wallet, so we never link a campaign that was rolled back).
    post.boostCampaignId = campaign._id;
    await post.save();

    this.posthog?.capture({
      distinctId: input.ownerUserId,
      event: 'ads.boost_created',
      properties: {
        campaignId: String(campaign._id),
        target: 'post',
        postId: input.postId,
        objective: input.objective,
        billingEvent: campaign.billingEvent,
        totalBudget: input.totalBudget,
        days: input.days,
      },
    });

    return campaign;
  }

  /**
   * Boost the caller's own profile as a job-seeker ("Open to work"). The ad unit
   * is the advertiser's public profile; it serves on the shared
   * `feed_promoted_profile` slot, targeted at employers, so it reaches the right
   * side. Mirrors the listing/job/post create pattern (gate -> bundle -> reserve).
   *
   * Gates (in order):
   *   1. The caller has a profile with `openTo.work === true` (turn it on first).
   *   2. No in-flight `boost_open_to_work` campaign already exists for the caller.
   *
   * Default audience: when no roles are supplied, defaults to employer roles so
   * the boost reaches employers even on the broadest targeting.
   */
  async createOpenToWorkBoost(input: CreateOpenToWorkBoostInput): Promise<AdCampaignDocument> {
    await this.assertIntentOn(input.ownerUserId, 'work', 'Open to work');
    await this.assertNoInFlightProfileBoost(input.ownerUserId, 'boost_open_to_work');

    const targeting = this.withDefaultRoles(input.targeting, EMPLOYER_AUDIENCE_ROLES);

    const campaign = await this.buildBundleAndReserve({
      ownerUserId: input.ownerUserId,
      objective: input.objective,
      totalBudget: input.totalBudget,
      days: input.days,
      spotlight: input.spotlight,
      targeting,
      campaignKind: 'boost_open_to_work',
      creativeKind: 'promoted_open_to_work',
      // Unified in-feed sponsored slot (Phase 1; supersedes feed_promoted_profile).
      placements: ['feed_sponsored'],
      sourceProfileUserId: input.ownerUserId,
      profileRef: input.ownerUserId,
    });

    this.posthog?.capture({
      distinctId: input.ownerUserId,
      event: 'ads.boost_created',
      properties: {
        campaignId: String(campaign._id),
        target: 'open_to_work',
        objective: input.objective,
        billingEvent: campaign.billingEvent,
        totalBudget: input.totalBudget,
        days: input.days,
      },
    });

    return campaign;
  }

  /**
   * Boost the caller's own hiring status ("Hiring"). Profile/intent level -- NO
   * specific job post required (owner decision 2026-06-18). Mirrors
   * `createOpenToWorkBoost` exactly with the `hiring` intent + worker audience.
   *
   * Gates: `openTo.hiring === true`; no in-flight `boost_hiring` for the caller.
   * Default audience: worker roles when none supplied.
   */
  async createHiringBoost(input: CreateHiringBoostInput): Promise<AdCampaignDocument> {
    await this.assertIntentOn(input.ownerUserId, 'hiring', 'Hiring');
    await this.assertNoInFlightProfileBoost(input.ownerUserId, 'boost_hiring');

    const targeting = this.withDefaultRoles(input.targeting, WORKER_AUDIENCE_ROLES);

    const campaign = await this.buildBundleAndReserve({
      ownerUserId: input.ownerUserId,
      objective: input.objective,
      totalBudget: input.totalBudget,
      days: input.days,
      spotlight: input.spotlight,
      targeting,
      campaignKind: 'boost_hiring',
      creativeKind: 'promoted_hiring',
      // Unified in-feed sponsored slot (Phase 1; supersedes feed_promoted_profile).
      placements: ['feed_sponsored'],
      sourceProfileUserId: input.ownerUserId,
      profileRef: input.ownerUserId,
    });

    this.posthog?.capture({
      distinctId: input.ownerUserId,
      event: 'ads.boost_created',
      properties: {
        campaignId: String(campaign._id),
        target: 'hiring',
        objective: input.objective,
        billingEvent: campaign.billingEvent,
        totalBudget: input.totalBudget,
        days: input.days,
      },
    });

    return campaign;
  }

  /**
   * Boost one of the caller's open RFQs to suppliers. The ad unit is the RFQ; it
   * serves on the `rfq_board` rail placement, targeted (by default) at suppliers
   * whose trade matches the RFQ category. Mirrors createListingBoost/createJobBoost.
   *
   * Gates (in order):
   *   1. The RFQ exists and is owned by the caller (404 on a non-owned id).
   *   2. `status === 'open'` (you boost a request that is taking quotes).
   *   3. No in-flight boost already exists for the RFQ (pending / active / paused).
   *
   * On success the budget is reserved and `Rfq.boostCampaignId` is linked.
   * Default audience: `sectors = [rfq.category]` when no sectors supplied.
   */
  async createRfqBoost(input: CreateRfqBoostInput): Promise<AdCampaignDocument> {
    const rfqModel = this.rfqModel;
    if (!rfqModel) {
      // Never happens under Nest DI; optional only for positional test construction.
      throw new Error('BoostService.rfqModel is required to boost an RFQ');
    }

    const rfq = await rfqModel.findById(input.rfqId);
    // ObjectId-equality ownership check (mirrors createListingBoost): a non-owned
    // / missing id 404s identically so ownership is never leaked.
    if (!rfq || !rfq.buyerUserId.equals(input.ownerUserId)) {
      throw new NotFoundException('Request not found');
    }
    if (rfq.status !== 'open') {
      throw new BadRequestException('Only an open request can be boosted');
    }
    if (rfq.boostCampaignId) {
      const existing = await this.campaignModel.findById(rfq.boostCampaignId);
      if (existing && ['pending_review', 'active', 'paused'].includes(existing.status)) {
        throw new BadRequestException('This request already has an active boost');
      }
    }

    // Default the trade audience to the RFQ category so it reaches matching
    // suppliers; the advertiser can still narrow district / add sectors.
    const targeting =
      input.targeting.sectors && input.targeting.sectors.length > 0
        ? input.targeting
        : { ...input.targeting, sectors: rfq.category ? [rfq.category] : [] };

    const campaign = await this.buildBundleAndReserve({
      ownerUserId: input.ownerUserId,
      objective: input.objective,
      totalBudget: input.totalBudget,
      days: input.days,
      spotlight: input.spotlight,
      targeting,
      campaignKind: 'boost_rfq',
      creativeKind: 'promoted_rfq',
      // Section (RFQ board) + the unified in-feed sponsored slot (Phase 1).
      placements: ['rfq_promoted', 'feed_sponsored'],
      sourceRfqId: input.rfqId,
      rfqRef: input.rfqId,
    });

    // Link only after the reserve succeeded (buildBundleAndReserve throws on a
    // short wallet, so we never link a campaign that was rolled back).
    rfq.boostCampaignId = campaign._id;
    await rfq.save();

    this.posthog?.capture({
      distinctId: input.ownerUserId,
      event: 'ads.boost_created',
      properties: {
        campaignId: String(campaign._id),
        target: 'rfq',
        rfqId: input.rfqId,
        objective: input.objective,
        billingEvent: campaign.billingEvent,
        totalBudget: input.totalBudget,
        days: input.days,
      },
    });

    return campaign;
  }

  /**
   * Gate helper for the two profile boosts: the caller's ConnectProfile must have
   * the given `openTo` intent on. Throws BadRequestException with a friendly
   * "Turn on X first" message otherwise (or when the caller has no profile).
   */
  private async assertIntentOn(
    ownerUserId: string,
    intent: 'work' | 'hiring',
    label: string,
  ): Promise<void> {
    const profileModel = this.profileModel;
    if (!profileModel) {
      throw new Error('BoostService.profileModel is required to boost a profile');
    }
    const profile = await profileModel
      .findOne({ userId: new Types.ObjectId(ownerUserId) })
      .select({ openTo: 1 })
      .lean<{ openTo?: ConnectProfile['openTo'] } | null>();
    if (!profile?.openTo?.[intent]) {
      throw new BadRequestException(`Turn on "${label}" on your profile first`);
    }
  }

  /**
   * Gate helper for the two profile boosts: at most one in-flight boost of a given
   * kind per advertiser (a profile has no artifact doc to hang boostCampaignId on,
   * so the in-flight check is a direct campaign query on kind + owner + status).
   */
  private async assertNoInFlightProfileBoost(
    ownerUserId: string,
    kind: 'boost_open_to_work' | 'boost_hiring',
  ): Promise<void> {
    const existing = await this.campaignModel
      .findOne({
        ownerUserId: new Types.ObjectId(ownerUserId),
        kind,
        status: { $in: ['pending_review', 'active', 'paused'] },
      })
      .select({ _id: 1 })
      .lean();
    if (existing) {
      throw new BadRequestException('You already have an active boost of this kind');
    }
  }

  /**
   * Returns the targeting spec with `roles` defaulted to `fallback` when the
   * advertiser left it empty -- so an intent boost reaches the intended side
   * (employers / workers) by default even on the broadest targeting.
   */
  private withDefaultRoles(targeting: TargetingMatchSpec, fallback: string[]): TargetingMatchSpec {
    if (targeting.roles && targeting.roles.length > 0) return targeting;
    return { ...targeting, roles: [...fallback] };
  }

  /**
   * Shared boost pipeline: create the campaign + ad set + creative, then
   * reserve the budget from the advertiser wallet. If the reserve fails (grant
   * + balance cannot cover it) all three documents are deleted so no orphaned
   * unreserved campaign is left behind, and a BadRequestException is thrown.
   */
  private async buildBundleAndReserve(spec: BoostBundleSpec): Promise<AdCampaignDocument> {
    // Pull the live, admin-tunable pricing levers. These were hardcoded (bid
    // 40/4, min 99, durations [3,7,14,30]); they now come from the DB config so
    // the owner can re-price without a deploy. Enforced here (not only in the
    // DTO) so the rules apply to every boost path AND so a DTO relaxed to a wide
    // guardrail cannot bypass the real business floor.
    const pricing = await this.getPricing();

    // Duration: `boostDurations` are quick-pick PRESETS (admin-tunable), not a
    // hard allowlist - the composer also offers a "Custom" field, so any whole
    // number of days within the guardrail range is accepted (mirrors how the
    // budget presets sit above the enforced boostMinBudget floor).
    if (
      !Number.isInteger(spec.days) ||
      spec.days < BOOST_DURATION_DAY_MIN ||
      spec.days > BOOST_DURATION_DAY_MAX
    ) {
      throw new BadRequestException(
        `Campaign duration must be a whole number between ${BOOST_DURATION_DAY_MIN} and ${BOOST_DURATION_DAY_MAX} days`,
      );
    }
    if (spec.totalBudget < pricing.boostMinBudget) {
      throw new BadRequestException(`Minimum boost budget is ${pricing.boostMinBudget}`);
    }

    const billingEvent = spec.objective === 'reach' ? 'cpm' : 'cpc';
    const baseBid = billingEvent === 'cpm' ? pricing.boostBidCpm : pricing.boostBidCpc;
    // Phase 2 Spotlight: a premium tier billed at `baseBid x spotlightMultiplier`
    // and also eligible for the premium right-rail (`spotlight_rail`). The whole
    // campaign uses the premium bid (so its feed impressions rank higher + cost
    // more too) -- the simplest "charge more" that fits the per-campaign-bid
    // billing engine. Rounded to a whole credit.
    const bid = spec.spotlight ? Math.round(baseBid * pricing.spotlightMultiplier) : baseBid;
    const placements = spec.spotlight ? [...spec.placements, 'spotlight_rail'] : spec.placements;

    const startAt = new Date();
    const endAt = new Date(startAt.getTime() + spec.days * 86_400_000);

    const campaign = await this.campaignModel.create({
      // Force a real ObjectId: persisting the raw string left existing campaigns
      // with a string `ownerUserId`, which (a) broke `.equals` on read (500) and
      // (b) never matched the ObjectId filter in list()/stats() (empty Boosts
      // page). new Types.ObjectId() accepts an ObjectId or a hex string.
      ownerUserId: new Types.ObjectId(spec.ownerUserId),
      kind: spec.campaignKind,
      ...(spec.sourcePostId !== undefined && { sourcePostId: spec.sourcePostId }),
      ...(spec.sourceListingId !== undefined && { sourceListingId: spec.sourceListingId }),
      ...(spec.sourceJobId !== undefined && { sourceJobId: spec.sourceJobId }),
      ...(spec.sourceProfileUserId !== undefined && {
        sourceProfileUserId: spec.sourceProfileUserId,
      }),
      ...(spec.sourceRfqId !== undefined && { sourceRfqId: spec.sourceRfqId }),
      objective: spec.objective,
      // Publish-then-moderate: a launched boost serves immediately (live on
      // create) instead of waiting in pending_review for admin approval. An
      // admin can take a live boost down later via AdsAdminService.reject.
      status: 'active',
      totalBudget: spec.totalBudget,
      budgetSpent: 0,
      startAt,
      endAt,
      pacing: 'even',
      billingEvent,
      bid,
    });

    const adSet = await this.adSetModel.create({
      campaignId: campaign._id,
      targeting: spec.targeting,
      placements,
      freqCapCount: 3,
      freqCapWindowSec: 86_400,
    });

    const creative = await this.creativeModel.create({
      campaignId: campaign._id,
      kind: spec.creativeKind,
      ...(spec.postRef !== undefined && { postRef: spec.postRef }),
      ...(spec.listingRef !== undefined && { listingRef: spec.listingRef }),
      ...(spec.jobRef !== undefined && { jobRef: spec.jobRef }),
      ...(spec.profileRef !== undefined && { profileRef: spec.profileRef }),
      ...(spec.rfqRef !== undefined && { rfqRef: spec.rfqRef }),
      // Publish-then-moderate: the creative is approved on create so it serves
      // right away. Admin take-down flips it to rejected after the fact.
      reviewStatus: 'approved',
    });

    // CN-ADS-1 (Bucket 3): reserveDetailed returns how the budget split across
    // the expiring grant bucket vs purchased balance. Persist that split on the
    // campaign so the matching release() restores each credit to the SAME bucket.
    const reserved = await this.wallet.reserveDetailed(
      spec.ownerUserId,
      spec.totalBudget,
      String(campaign._id),
    );

    if (!reserved.ok) {
      // Clean up all three documents to prevent an orphaned unreserved campaign.
      await this.creativeModel.deleteOne({ _id: creative._id });
      await this.adSetModel.deleteOne({ _id: adSet._id });
      await this.campaignModel.deleteOne({ _id: campaign._id });
      throw new BadRequestException('insufficient wallet balance');
    }

    await this.campaignModel.updateOne(
      { _id: campaign._id },
      {
        $inc: {
          reservedFromGrant: reserved.fromGrant,
          reservedFromBalance: reserved.fromBalance,
        },
      },
    );
    // Keep the returned doc in step with the DB (it was created before the $inc).
    campaign.reservedFromGrant = (campaign.reservedFromGrant ?? 0) + reserved.fromGrant;
    campaign.reservedFromBalance = (campaign.reservedFromBalance ?? 0) + reserved.fromBalance;

    return campaign as AdCampaignDocument;
  }

  // ---------------------------------------------------------------------------
  // T22 -- pause() / resume()
  // ---------------------------------------------------------------------------

  /**
   * Pauses an active campaign: releases the unspent budget back to the wallet
   * and transitions status to 'paused'. If the campaign is not currently
   * 'active', it is returned unchanged (idempotent for already-paused campaigns).
   *
   * Throws NotFoundException on missing campaign or cross-workspace access.
   */
  async pause(id: string, ownerUserId: string): Promise<AdCampaignDocument> {
    const campaign = await this.loadAndVerify(id, ownerUserId);

    if (campaign.status === 'active') {
      const unspent = Math.max(0, campaign.totalBudget - campaign.budgetSpent);
      // CN-ADS-1: restore the unspent to the SAME buckets it was reserved from
      // (grant credits back to the expiring grant bucket, not silently to
      // permanent balance). Consume the tracked split, then zero it since the
      // reserve is now released (a resume re-reserves + re-accumulates).
      const split = this.consumeReserveSplit(campaign, unspent);
      await this.wallet.release(ownerUserId, unspent, id, split);
      campaign.reservedFromGrant = 0;
      campaign.reservedFromBalance = 0;
      campaign.status = 'paused';
      await campaign.save();
    }

    return campaign;
  }

  /**
   * Resumes a paused campaign: re-reserves the remaining budget from the wallet
   * and transitions status to 'active'. If the remaining budget is already 0
   * (fully spent), the wallet reserve call is skipped.
   *
   * Throws NotFoundException on missing campaign or cross-workspace access.
   * Throws BadRequestException when the wallet has insufficient balance.
   */
  async resume(id: string, ownerUserId: string): Promise<AdCampaignDocument> {
    const campaign = await this.loadAndVerify(id, ownerUserId);

    if (campaign.status === 'paused') {
      const need = Math.max(0, campaign.totalBudget - campaign.budgetSpent);
      // CN-ADS-1: re-reserve via the split-aware path so the freshly re-reserved
      // grant/purchased split is re-accumulated onto the campaign for the NEXT
      // release. pause() zeroed the split, so we start from 0 here.
      if (need > 0) {
        const reserved = await this.wallet.reserveDetailed(ownerUserId, need, id);
        if (!reserved.ok) {
          throw new BadRequestException('insufficient wallet balance to resume');
        }
        campaign.reservedFromGrant = (campaign.reservedFromGrant ?? 0) + reserved.fromGrant;
        campaign.reservedFromBalance = (campaign.reservedFromBalance ?? 0) + reserved.fromBalance;
      }
      campaign.status = 'active';
      await campaign.save();
    }

    // Deliberately do NOT emit `connect.boost.activated` on resume: this is a
    // re-activation of an already-funded campaign, not a fresh money commit. The
    // event fires once at first activation in AdsAdminService.approve(); see
    // crewroster-web/lib/analytics-events.ts for the boost funnel. No em-dash.
    return campaign;
  }

  /**
   * Advertiser cancels their OWN boost. Unlike the admin take-down
   * (AdsAdminService.reject), this is the owner's own cancel: the FULL unspent
   * budget is refunded with NO fee, the source doc is unlinked so the item can be
   * boosted again, and the campaign ends (terminal `completed`).
   *
   * Idempotent no-op on an already-terminal campaign (`completed` / `rejected`):
   * the boost is already stopped and settled, so do not refund / unlink / mutate
   * again (a second release would over-release and throw).
   *
   * Budget settle mirrors pause()/stopForPost():
   *   - PAUSED campaign: pause() already released the unspent back to balance, so
   *     do NOT release again (would over-release and throw).
   *   - active / pending_review: the unspent is still reserved, so release the
   *     full amount back to the wallet (no fee withheld -- owner's own cancel).
   *
   * Throws NotFoundException on missing campaign or cross-owner access (via
   * loadAndVerify -- ownership is never leaked).
   */
  async cancel(id: string, ownerUserId: string): Promise<AdCampaignDocument> {
    const campaign = await this.loadAndVerify(id, ownerUserId);

    // Idempotent: an already-terminal boost is stopped + settled. No-op.
    if (['completed', 'rejected'].includes(campaign.status)) {
      return campaign;
    }

    // A paused campaign already released its unspent on pause(); releasing again
    // would over-release and throw.
    const wasPaused = campaign.status === 'paused';
    const unspent = Math.max(0, campaign.totalBudget - campaign.budgetSpent);

    // Refund the FULL unspent (no fee -- owner's own cancel, not a take-down).
    // CN-ADS-1: restore to the original grant/purchased buckets via the tracked
    // split (a paused campaign already released + zeroed its split on pause()).
    if (!wasPaused && unspent > 0) {
      const split = this.consumeReserveSplit(campaign, unspent);
      await this.wallet.release(ownerUserId, unspent, String(campaign._id), split);
      campaign.reservedFromGrant = 0;
      campaign.reservedFromBalance = 0;
    }

    // Unlink the source so the advertiser can boost the item again (the in-flight
    // gate keys on the source's boostCampaignId). Profile boosts (open_to_work /
    // hiring) have no source doc -- nothing to unlink. Best-effort (try/catch),
    // mirroring the admin take-down's unlink: a transient DB failure here must not
    // leave a half-done cancel (refund already applied).
    try {
      await this.unlinkSource(campaign);
    } catch (err) {
      this.logger.error(
        `Failed to unlink source for cancelled campaign ${String(campaign._id)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    campaign.status = 'completed';
    await campaign.save();

    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'ads.boost_cancelled',
      properties: {
        campaignId: String(campaign._id),
        kind: campaign.kind,
        refunded: wasPaused ? 0 : unspent,
      },
    });

    return campaign;
  }

  /**
   * Unlinks the boosted source doc (sets its `boostCampaignId = null`) so the
   * in-flight boost gate clears and the advertiser can boost the item again.
   * Picks the model by whichever source ref the campaign carries; a profile boost
   * has no source doc (nothing to do). Mirrors AdsAdminService.unlinkSource.
   */
  private async unlinkSource(campaign: AdCampaignDocument): Promise<void> {
    if (campaign.sourceListingId && this.listingModel) {
      const listing = await this.listingModel.findById(campaign.sourceListingId);
      if (listing) {
        listing.boostCampaignId = null;
        await listing.save();
      }
      return;
    }
    if (campaign.sourceJobId && this.jobModel) {
      const job = await this.jobModel.findById(campaign.sourceJobId);
      if (job) {
        job.boostCampaignId = null;
        await job.save();
      }
      return;
    }
    if (campaign.sourceRfqId && this.rfqModel) {
      const rfq = await this.rfqModel.findById(campaign.sourceRfqId);
      if (rfq) {
        rfq.boostCampaignId = null;
        await rfq.save();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Early stop -- post deleted / made non-public mid-flight
  // ---------------------------------------------------------------------------

  /**
   * Stops a post's boost campaign when the post can no longer serve (it was
   * soft-deleted or made non-public). Early-stop budget behaviour mirrors
   * `pause()`: any still-reserved budget (an active / pending_review campaign
   * holds a reserve; a paused one already released on pause) is RELEASED back to
   * the wallet, then the campaign is moved to `completed` (terminal -- a deleted
   * / unpublished post cannot be resumed). No-op when the post has no boost, is
   * still live + public, or its campaign is already completed / rejected.
   *
   * Called by `onPostChanged` (the `connect.post.changed` listener) so the
   * campaign stops in the same flow that edits / deletes the post.
   */
  async stopForPost(postId: string): Promise<void> {
    const postModel = this.postModel;
    if (!postModel) return;

    const post = await postModel.findById(postId);
    if (!post) {
      // CN-PURGE-1 (Bucket 2): the post row is GONE (account-purge hard-delete).
      // The live edit/delete path leaves a soft-deleted row, so `!post` means a
      // hard delete. Look the campaign up directly by source ref and FORFEIT its
      // unspent budget (release the reserved hold, credit NOTHING back) per the
      // owner's forfeit decision (OQ-2). Without this, a hard-deleted post's
      // campaign would no-op here and leak its reserve forever.
      const campaign = await this.campaignModel.findOne({
        sourcePostId: new Types.ObjectId(postId),
        status: { $in: ['active', 'pending_review', 'paused'] },
      });
      if (campaign) await this.forfeitCampaign(campaign);
      return;
    }
    if (!post.boostCampaignId) return;
    // Still servable (live + public) => an unrelated edit; nothing to stop.
    if (!post.deletedAt && post.visibility === 'public') return;

    const campaign = await this.campaignModel.findById(post.boostCampaignId);
    if (!campaign) return;
    // Soft-deleted / unpublished post: ordinary refund tail (unspent back to the
    // origin buckets), same as any other early stop.
    await this.completeCampaign(campaign);
  }

  /**
   * Shared abstraction #2 (Bucket 2) — the refund-style stop tail every
   * `stopFor*` uses: release any unspent reserve back to the advertiser's ORIGIN
   * buckets (grant credits to grant, purchased to balance), then flip to
   * `completed`. Idempotent — a no-op on an already-terminal campaign. NOT used
   * by the account-purge forfeit path (`forfeitCampaign` below), which credits
   * nothing back per the owner's forfeit decision (OQ-2).
   */
  private async completeCampaign(campaign: AdCampaignDocument): Promise<void> {
    if (['completed', 'rejected'].includes(campaign.status)) return;
    if (['active', 'pending_review'].includes(campaign.status)) {
      const unspent = Math.max(0, campaign.totalBudget - campaign.budgetSpent);
      if (unspent > 0) {
        const split = this.consumeReserveSplit(campaign, unspent);
        await this.wallet.release(
          String(campaign.ownerUserId),
          unspent,
          String(campaign._id),
          split,
        );
        campaign.reservedFromGrant = 0;
        campaign.reservedFromBalance = 0;
      }
    }
    // A paused campaign already released its reserve on pause() — no release here,
    // just flip to terminal (matches the pre-existing pause-then-cancel contract).
    campaign.status = 'completed';
    await campaign.save();
  }

  /**
   * CN-PURGE-1 (Bucket 2) FORFEIT tail — used ONLY when a campaign's source was
   * hard-deleted by account purge. Frees the reserved hold WITHOUT crediting the
   * advertiser (the account is gone; nothing to give back), writes a `'forfeit'`
   * ledger row for the paper trail, and marks the campaign fully-spent. Distinct
   * from `completeCampaign`, which refunds. See wallet.service `forfeitReserve`.
   *
   * NOTE: the account-purge BATCH handler lives in connect-content-purge.service
   * (raw-collection, off the DI graph) and does this same math directly; this
   * method covers the single-post `stopForPost` hard-delete branch, which can
   * fire independently of the batch purge (e.g. via the post-changed event).
   */
  private async forfeitCampaign(campaign: AdCampaignDocument): Promise<void> {
    if (['completed', 'rejected'].includes(campaign.status)) return;
    const unspent = Math.max(
      0,
      (campaign.reservedFromGrant ?? 0) + (campaign.reservedFromBalance ?? 0),
    );
    const fallback = Math.max(0, campaign.totalBudget - campaign.budgetSpent);
    // Prefer the tracked reserve; fall back to budget-derived for pre-CN-ADS-1
    // campaigns whose split was backfilled to 0/0 but still hold a reserve.
    const toForfeit = unspent > 0 ? unspent : fallback;
    if (toForfeit > 0) {
      await this.wallet.forfeitReserve(
        String(campaign.ownerUserId),
        toForfeit,
        String(campaign._id),
        'account purge: unspent boost budget forfeited (post hard-deleted)',
      );
    }
    campaign.reservedFromGrant = 0;
    campaign.reservedFromBalance = 0;
    campaign.status = 'completed';
    campaign.budgetSpent = campaign.totalBudget; // read as fully-spent, not leftover
    await campaign.save();
  }

  /**
   * Split a release `amount` across the campaign's tracked grant/purchased
   * origin (CN-ADS-1). Since every release in this codebase releases the FULL
   * remaining reserve, this is a straight read of the tracked split, clamped so
   * a rounding/stale mismatch can never exceed `amount`. A pre-CN-ADS-1 campaign
   * (both fields 0, backfilled as all-purchased) yields `fromGrant:0` → the
   * release credits balance exactly as it did before this fix.
   */
  private consumeReserveSplit(
    campaign: AdCampaignDocument,
    amount: number,
  ): { fromGrant: number; fromBalance: number } {
    const fromGrant = Math.max(0, Math.min(campaign.reservedFromGrant ?? 0, amount));
    return { fromGrant, fromBalance: amount - fromGrant };
  }

  /**
   * Stops a listing's boost when the listing can no longer serve (paused, sold,
   * rejected, or edited to a non-active status). Mirrors `stopForPost`'s
   * refund-style shape via `completeCampaign`. No-op when the listing still
   * serves (active + approved), has no boost, or its campaign is terminal.
   * Cross-module: triggered by the CONNECT_LISTING_CHANGED listener below.
   */
  async stopForListing(listingId: string): Promise<void> {
    const listingModel = this.listingModel;
    if (!listingModel) return;
    const listing = await listingModel.findById(listingId);
    if (!listing || !listing.boostCampaignId) return;
    // Still servable => an unrelated edit; nothing to stop.
    if (listing.status === 'active' && listing.moderationStatus === 'approved') return;
    const campaign = await this.campaignModel.findById(listing.boostCampaignId);
    if (campaign) await this.completeCampaign(campaign);
  }

  /**
   * Stops a job's boost when the job is no longer open (filled / closed).
   * No-op when the job still serves (`status === 'open'`), has no boost, or its
   * campaign is terminal. Cross-module: CONNECT_JOB_CHANGED listener below.
   */
  async stopForJob(jobId: string): Promise<void> {
    const jobModel = this.jobModel;
    if (!jobModel) return;
    const job = await jobModel.findById(jobId);
    if (!job || !job.boostCampaignId) return;
    if (job.status === 'open') return;
    const campaign = await this.campaignModel.findById(job.boostCampaignId);
    if (campaign) await this.completeCampaign(campaign);
  }

  /**
   * Stops an RFQ's boost when the RFQ is no longer open (closed / awarded).
   * No-op when the RFQ still serves (`status === 'open'`), has no boost, or its
   * campaign is terminal. Cross-module: CONNECT_RFQ_CHANGED listener below.
   */
  async stopForRfq(rfqId: string): Promise<void> {
    const rfqModel = this.rfqModel;
    if (!rfqModel) return;
    const rfq = await rfqModel.findById(rfqId);
    if (!rfq || !rfq.boostCampaignId) return;
    if (rfq.status === 'open') return;
    const campaign = await this.campaignModel.findById(rfq.boostCampaignId);
    if (campaign) await this.completeCampaign(campaign);
  }

  /**
   * `connect.post.changed` listener -- the post-side mirror of the search
   * indexer's hook. On an edit or delete it re-reads the post and stops the
   * boost campaign if the post is now deleted or non-public (`stopForPost` makes
   * the decision + is a no-op otherwise). `async: true` so a slow release never
   * blocks the post-write request; a `created` change is ignored (a fresh post
   * has no boost yet).
   */
  @OnEvent(CONNECT_POST_CHANGED, { async: true })
  async onPostChanged(payload: ConnectPostChangedEvent): Promise<void> {
    if (payload.change === 'created') return;
    await this.stopForPost(payload.postId);
  }

  /**
   * CN-BOOST-1 (Bucket 2): the listing-side mirror of `onPostChanged`. On any
   * listing state change (pause / sold / owner-edit / admin reject) re-read the
   * listing and stop its boost if it can no longer serve. `stopForListing` is a
   * no-op when the listing is still active+approved, has no boost, or the
   * campaign is already terminal — so a benign edit costs nothing. `async: true`
   * so a slow release never blocks the listing write.
   */
  @OnEvent(CONNECT_LISTING_CHANGED, { async: true })
  async onListingChanged(payload: { listingId: string }): Promise<void> {
    await this.stopForListing(payload.listingId);
  }

  /** CN-BOOST-1: job-side mirror — stop a boost when the job is no longer open. */
  @OnEvent(CONNECT_JOB_CHANGED, { async: true })
  async onJobChanged(payload: { jobId: string; change: string }): Promise<void> {
    if (payload.change === 'created') return;
    await this.stopForJob(payload.jobId);
  }

  /** CN-BOOST-1: rfq-side mirror — stop a boost when the RFQ leaves `open`. */
  @OnEvent(CONNECT_RFQ_CHANGED, { async: true })
  async onRfqChanged(payload: { rfqId: string; change: string }): Promise<void> {
    if (payload.change === 'created') return;
    await this.stopForRfq(payload.rfqId);
  }

  // ---------------------------------------------------------------------------
  // T23 -- status()
  // ---------------------------------------------------------------------------

  /**
   * Returns a read-only status view for a boost campaign, combining persisted
   * campaign state with live rollup aggregation metrics.
   *
   * Throws NotFoundException on missing campaign or cross-workspace access.
   */
  async status(id: string, ownerUserId: string): Promise<BoostStatusView> {
    const campaign = await this.loadAndVerify(id, ownerUserId);

    // Metrics are a non-critical ENRICHMENT of the results view. A rollup
    // aggregation failure (the only thing here that can realistically throw on a
    // valid, just-created campaign) must NOT 500 the whole "view your boost"
    // page -- a freshly launched boost has zero metrics anyway. Degrade to zeros
    // and log the real cause so a genuine aggregation bug stays visible.
    let agg = {
      impressions: 0,
      viewableImpressions: 0,
      clicks: 0,
      validClicks: 0,
      spend: 0,
    };
    try {
      agg = await this.rollups.aggregateFor(id);
    } catch (err) {
      this.logger.error(
        `status(): metrics aggregate failed for boost ${id} -- returning zero metrics. ` +
          (err instanceof Error ? err.stack : String(err)),
      );
    }

    return {
      status: campaign.status,
      objective: campaign.objective,
      spend: campaign.budgetSpent,
      budgetRemaining: Math.max(0, campaign.totalBudget - campaign.budgetSpent),
      reach: agg.viewableImpressions,
      views: agg.impressions,
      clicks: agg.clicks,
      // Surfaced so the advertiser sees the admin's take-down reason on the
      // boost status view.
      moderationReason: campaign.moderationReason ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // list() -- the caller's campaigns with REAL lifetime metrics
  // ---------------------------------------------------------------------------

  /**
   * Lists every campaign owned by the caller, newest first, each enriched with
   * REAL lifetime metrics (impressions / clicks / spend + the ctr + costPerClick
   * derivations) summed from `ad_daily_rollups`. The web tabs the rows by status
   * client-side, so all statuses are returned in one call.
   *
   * Cost: one indexed campaign query (`ownerUserId`) plus one aggregation over
   * the rollups grouped by campaignId. There is intentionally no inquiry /
   * conversion metric -- those are not attributed per campaign anywhere.
   */
  // ---------------------------------------------------------------------------
  // boostable() -- the caller's quick-start "boost something" candidates
  // ---------------------------------------------------------------------------

  /**
   * Return the caller's own listings + jobs that are eligible to boost right now,
   * plus their active profile intents. Eligibility mirrors the create gates so a
   * quick-start card never deep-links into a composer that would reject it:
   *   - listing: owned + `moderationStatus === 'approved'` + no in-flight boost
   *   - job:     owned + `status === 'open'`            + no in-flight boost
   * "No in-flight boost" is resolved in ONE campaign query (no N+1). Lists are
   * capped (the web shows 2-3 per type); `counts` carry the total eligible per
   * type for the "See all (N)" link. General posts are NOT boostable (owner
   * decision), so they never appear here. JWT-scoped: `ownerUserId` = caller.
   */
  async boostable(ownerUserId: string): Promise<BoostableSummary> {
    const ownerOid = new Types.ObjectId(ownerUserId);
    // Generous fetch cap: SMB sellers have tens of items, not hundreds. `counts`
    // is exact up to this cap; beyond it the "See all" page shows the full set.
    const FETCH_CAP = 60;
    const DISPLAY_CAP = 3;

    type ListingLean = {
      _id: Types.ObjectId;
      title: string;
      category: string;
      images: string[];
      boostCampaignId?: Types.ObjectId | null;
    };
    type JobLean = {
      _id: Types.ObjectId;
      title: string;
      category: string;
      role?: string | null;
      views: number;
      boostCampaignId?: Types.ObjectId | null;
    };
    type RfqLean = {
      _id: Types.ObjectId;
      title: string;
      category: string;
      boostCampaignId?: Types.ObjectId | null;
    };

    const [listingDocs, jobDocs, rfqDocs, profile] = await Promise.all([
      this.listingModel
        ? // CN-BOOST-2: candidate listings must also be live (`status:'active'`),
          // matching createListingBoost's gate — never surface a paused/sold
          // listing as boostable.
          this.listingModel
            .find({ ownerUserId: ownerOid, moderationStatus: 'approved', status: 'active' })
            .sort({ createdAt: -1 })
            .limit(FETCH_CAP)
            .select({ title: 1, category: 1, images: 1, boostCampaignId: 1 })
            .lean<ListingLean[]>()
        : Promise.resolve([] as ListingLean[]),
      this.jobModel
        ? this.jobModel
            .find({ companyUserId: ownerOid, status: 'open' })
            .sort({ createdAt: -1 })
            .limit(FETCH_CAP)
            .select({ title: 1, category: 1, role: 1, views: 1, boostCampaignId: 1 })
            .lean<JobLean[]>()
        : Promise.resolve([] as JobLean[]),
      this.rfqModel
        ? this.rfqModel
            .find({ buyerUserId: ownerOid, status: 'open' })
            .sort({ createdAt: -1 })
            .limit(FETCH_CAP)
            .select({ title: 1, category: 1, boostCampaignId: 1 })
            .lean<RfqLean[]>()
        : Promise.resolve([] as RfqLean[]),
      this.profileModel
        ? this.profileModel
            .findOne({ userId: ownerOid })
            .select({ openTo: 1 })
            .lean<{ openTo?: ConnectProfile['openTo'] } | null>()
        : Promise.resolve(null as { openTo?: ConnectProfile['openTo'] } | null),
    ]);

    // One campaign query resolves which linked campaigns are still in-flight
    // (pending_review / active / paused) -- those candidates are filtered out. A
    // candidate with no boostCampaignId, or whose prior boost is completed /
    // rejected / expired, is eligible (it can be re-boosted).
    const linkedIds = [...listingDocs, ...jobDocs, ...rfqDocs]
      .map((d) => d.boostCampaignId)
      .filter((id): id is Types.ObjectId => !!id);
    const inFlight = new Set<string>();
    if (linkedIds.length > 0) {
      const live = await this.campaignModel
        .find(
          { _id: { $in: linkedIds }, status: { $in: ['pending_review', 'active', 'paused'] } },
          { _id: 1 },
        )
        .lean();
      for (const c of live) inFlight.add(String(c._id));
    }
    const eligible = (boostCampaignId?: Types.ObjectId | null) =>
      !boostCampaignId || !inFlight.has(String(boostCampaignId));

    // CN-LIM-1 (Bucket 11): exclude items the over-limit policy has SUPPRESSED
    // (hidden as over the plan cap) so a quick-start card never deep-links into a
    // composer that would then reject the boost. listing + job are the over-limit
    // kinds; RFQ is not subject to over-limit suppression. No-op under freeze.
    const [suppressedListings, suppressedJobs] = this.overLimit
      ? await Promise.all([
          this.overLimit.getSuppressedIds(ownerUserId, 'listing'),
          this.overLimit.getSuppressedIds(ownerUserId, 'job'),
        ])
      : [[] as string[], [] as string[]];
    const suppressedListingSet = new Set(suppressedListings);
    const suppressedJobSet = new Set(suppressedJobs);

    const eligibleListings = listingDocs.filter(
      (l) => eligible(l.boostCampaignId) && !suppressedListingSet.has(String(l._id)),
    );
    const eligibleJobs = jobDocs.filter(
      (j) => eligible(j.boostCampaignId) && !suppressedJobSet.has(String(j._id)),
    );
    const eligibleRfqs = rfqDocs.filter((r) => eligible(r.boostCampaignId));

    const listings: BoostableItem[] = eligibleListings.slice(0, DISPLAY_CAP).map((l) => ({
      id: String(l._id),
      kind: 'boost_listing',
      title: l.title,
      image: Array.isArray(l.images) && l.images.length > 0 ? l.images[0] : null,
      subtitle: l.category ?? null,
      views: null,
    }));
    const jobs: BoostableItem[] = eligibleJobs.slice(0, DISPLAY_CAP).map((j) => ({
      id: String(j._id),
      kind: 'boost_job',
      title: j.title,
      image: null,
      subtitle: j.role || j.category || null,
      views: typeof j.views === 'number' ? j.views : null,
    }));
    const rfqs: BoostableItem[] = eligibleRfqs.slice(0, DISPLAY_CAP).map((r) => ({
      id: String(r._id),
      kind: 'boost_rfq',
      title: r.title,
      image: null,
      subtitle: r.category || null,
      views: null,
    }));

    const openTo = profile?.openTo;

    return {
      listings,
      jobs,
      rfqs,
      counts: {
        listings: eligibleListings.length,
        jobs: eligibleJobs.length,
        rfqs: eligibleRfqs.length,
      },
      intents: {
        work: !!openTo?.work,
        hiring: !!openTo?.hiring,
        deals: !!openTo?.deals,
        customOrders: !!openTo?.customOrders,
      },
    };
  }

  async list(ownerUserId: string): Promise<BoostListItem[]> {
    const rollupModel = this.rollupModel;
    if (!rollupModel) {
      // Never happens under Nest DI; the param is optional only so the post-boost
      // unit tests can construct BoostService positionally.
      throw new Error('BoostService.rollupModel is required to list boosts');
    }

    // Match owner stored as EITHER an ObjectId (correct) or a plain string (the
    // legacy bug) so already-created boosts are not invisible on the Boosts page.
    const campaigns = await this.campaignModel
      .find({ ownerUserId: { $in: [new Types.ObjectId(ownerUserId), ownerUserId] } })
      .sort({ createdAt: -1 })
      .lean();

    if (campaigns.length === 0) return [];

    // One aggregation over the rollups for exactly this caller's campaigns,
    // grouped by campaignId. Keyed by string id for an O(1) per-row merge.
    const campaignIds = campaigns.map((c) => c._id);
    const rollupBuckets: Array<{
      _id: Types.ObjectId;
      impressions: number;
      clicks: number;
      spend: number;
    }> = await rollupModel.aggregate([
      { $match: { campaignId: { $in: campaignIds } } },
      {
        $group: {
          _id: '$campaignId',
          impressions: { $sum: '$impressions' },
          clicks: { $sum: '$clicks' },
          spend: { $sum: '$spend' },
        },
      },
    ]);

    const byCampaign = new Map<string, RollupCountRow>();
    for (const b of rollupBuckets) {
      byCampaign.set(String(b._id), {
        impressions: b.impressions,
        clicks: b.clicks,
        spend: b.spend,
      });
    }

    // Resolve each boost's human title (+ a thumbnail for listings) in BATCH so
    // the advertiser's row shows the real product / job / post name, not just the
    // objective. One $in query per source type across the whole page (no N+1) ->
    // an id->{title,image} map for an O(1) per-row merge. Field names mirror
    // AdsAdminService.enrichCreative: listing.title + images[0], job.title,
    // rfq.title, post body snippet, and the owner's profile headline.
    const sourceTitles = await this.resolveSourceTitles(campaigns);

    return campaigns.map((c) => {
      const sums = byCampaign.get(String(c._id)) ?? { impressions: 0, clicks: 0, spend: 0 };
      const metrics = deriveMetrics(sums);
      const resolved = this.lookupSourceTitle(c, sourceTitles);
      return {
        id: String(c._id),
        kind: c.kind,
        objective: c.objective,
        status: c.status,
        totalBudget: c.totalBudget,
        budgetSpent: c.budgetSpent,
        startAt: c.startAt,
        endAt: c.endAt,
        sourceListingId: c.sourceListingId ? String(c.sourceListingId) : null,
        sourceJobId: c.sourceJobId ? String(c.sourceJobId) : null,
        sourcePostId: c.sourcePostId ? String(c.sourcePostId) : null,
        sourceRfqId: c.sourceRfqId ? String(c.sourceRfqId) : null,
        sourceProfileUserId: c.sourceProfileUserId ? String(c.sourceProfileUserId) : null,
        sourceTitle: resolved.title,
        sourceImage: resolved.image,
        // Surfaced so a taken-down boost can show the admin's reason in the list.
        moderationReason: c.moderationReason ?? null,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        spend: metrics.spend,
        ctr: metrics.ctr,
        costPerClick: metrics.costPerClick,
      };
    });
  }

  /**
   * Batch-resolves the human title (+ a listing thumbnail) for every campaign in
   * a list() page. Collects the distinct source ids per type and runs ONE lean
   * `find({ _id: { $in } })` per non-empty set (no per-row query). Returns four
   * id->value maps the per-row mapper merges in O(1). A model that is not injected
   * (positional test construction) simply yields an empty map -> null titles for
   * that kind, never a crash. Title fields mirror AdsAdminService.enrichCreative.
   */
  private async resolveSourceTitles(
    campaigns: Array<{
      kind: string;
      sourceListingId?: unknown;
      sourceJobId?: unknown;
      sourcePostId?: unknown;
      sourceRfqId?: unknown;
      sourceProfileUserId?: unknown;
    }>,
  ): Promise<{
    listings: Map<string, { title: string | null; image: string | null }>;
    jobs: Map<string, string | null>;
    rfqs: Map<string, string | null>;
    posts: Map<string, string | null>;
    profiles: Map<string, string | null>;
  }> {
    const listingIds = new Set<string>();
    const jobIds = new Set<string>();
    const rfqIds = new Set<string>();
    const postIds = new Set<string>();
    const profileUserIds = new Set<string>();
    for (const c of campaigns) {
      if (c.sourceListingId) listingIds.add(String(c.sourceListingId));
      if (c.sourceJobId) jobIds.add(String(c.sourceJobId));
      if (c.sourceRfqId) rfqIds.add(String(c.sourceRfqId));
      if (c.sourcePostId) postIds.add(String(c.sourcePostId));
      if (c.sourceProfileUserId) profileUserIds.add(String(c.sourceProfileUserId));
    }

    const listings = new Map<string, { title: string | null; image: string | null }>();
    const jobs = new Map<string, string | null>();
    const rfqs = new Map<string, string | null>();
    const posts = new Map<string, string | null>();
    const profiles = new Map<string, string | null>();

    // POST_SNIPPET_LEN: how many chars of the post body to show as its title.
    const POST_SNIPPET_LEN = 60;

    await Promise.all([
      // listing -> title + first image (cover).
      this.listingModel && listingIds.size > 0
        ? this.listingModel
            .find({ _id: { $in: [...listingIds] } })
            .select({ title: 1, images: 1 })
            .lean<Array<{ _id: Types.ObjectId; title?: string; images?: string[] }>>()
            .then((docs) => {
              for (const d of docs) {
                listings.set(String(d._id), {
                  title: d.title ?? null,
                  image: Array.isArray(d.images) && d.images.length > 0 ? d.images[0] : null,
                });
              }
            })
        : Promise.resolve(),
      // job -> title (no image).
      this.jobModel && jobIds.size > 0
        ? this.jobModel
            .find({ _id: { $in: [...jobIds] } })
            .select({ title: 1 })
            .lean<Array<{ _id: Types.ObjectId; title?: string }>>()
            .then((docs) => {
              for (const d of docs) jobs.set(String(d._id), d.title ?? null);
            })
        : Promise.resolve(),
      // rfq -> title (no image).
      this.rfqModel && rfqIds.size > 0
        ? this.rfqModel
            .find({ _id: { $in: [...rfqIds] } })
            .select({ title: 1 })
            .lean<Array<{ _id: Types.ObjectId; title?: string }>>()
            .then((docs) => {
              for (const d of docs) rfqs.set(String(d._id), d.title ?? null);
            })
        : Promise.resolve(),
      // post -> a short body snippet (posts have no title); trim + ellipsis.
      this.postModel && postIds.size > 0
        ? this.postModel
            .find({ _id: { $in: [...postIds] } })
            .select({ body: 1 })
            .lean<Array<{ _id: Types.ObjectId; body?: string }>>()
            .then((docs) => {
              for (const d of docs) {
                posts.set(String(d._id), this.snippet(d.body, POST_SNIPPET_LEN));
              }
            })
        : Promise.resolve(),
      // profile boost (open_to_work / hiring) -> the owner's profile headline,
      // keyed by userId. Cheap (already-injected model); the owner's display name
      // lives on User which this service does not inject, so use the headline.
      this.profileModel && profileUserIds.size > 0
        ? this.profileModel
            .find({ userId: { $in: [...profileUserIds].map((id) => new Types.ObjectId(id)) } })
            .select({ userId: 1, headline: 1 })
            .lean<Array<{ userId: Types.ObjectId; headline?: string }>>()
            .then((docs) => {
              for (const d of docs) {
                profiles.set(String(d.userId), this.snippet(d.headline, 60));
              }
            })
        : Promise.resolve(),
    ]);

    return { listings, jobs, rfqs, posts, profiles };
  }

  /**
   * Picks the resolved title + image for one campaign from the batch maps, by
   * kind. listing carries a thumbnail; everything else has none. A source doc
   * that was not found (deleted) yields null, matching the missing-doc contract.
   */
  private lookupSourceTitle(
    c: {
      sourceListingId?: unknown;
      sourceJobId?: unknown;
      sourcePostId?: unknown;
      sourceRfqId?: unknown;
      sourceProfileUserId?: unknown;
    },
    maps: {
      listings: Map<string, { title: string | null; image: string | null }>;
      jobs: Map<string, string | null>;
      rfqs: Map<string, string | null>;
      posts: Map<string, string | null>;
      profiles: Map<string, string | null>;
    },
  ): { title: string | null; image: string | null } {
    if (c.sourceListingId) {
      const hit = maps.listings.get(String(c.sourceListingId));
      return { title: hit?.title ?? null, image: hit?.image ?? null };
    }
    if (c.sourceJobId) {
      return { title: maps.jobs.get(String(c.sourceJobId)) ?? null, image: null };
    }
    if (c.sourceRfqId) {
      return { title: maps.rfqs.get(String(c.sourceRfqId)) ?? null, image: null };
    }
    if (c.sourcePostId) {
      return { title: maps.posts.get(String(c.sourcePostId)) ?? null, image: null };
    }
    if (c.sourceProfileUserId) {
      return { title: maps.profiles.get(String(c.sourceProfileUserId)) ?? null, image: null };
    }
    return { title: null, image: null };
  }

  /**
   * Trims a free-text field to a short snippet for a row title: collapse to a
   * trimmed string, cut to `len` chars on a value longer than that, add an
   * ellipsis. Empty / missing -> null (so an empty-body post shows no title).
   */
  private snippet(text: string | undefined | null, len: number): string | null {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return null;
    return trimmed.length > len ? `${trimmed.slice(0, len).trimEnd()}…` : trimmed;
  }

  // ---------------------------------------------------------------------------
  // stats() -- KPI aggregates for the caller
  // ---------------------------------------------------------------------------

  /**
   * KPI aggregates for the caller's account, all REAL:
   *   - activeCount     : campaigns currently in `active` status.
   *   - reach30d        : impressions over the caller's rollups in the last 30
   *                       IST days.
   *   - clicks30d       : clicks over the same window.
   *   - spendThisMonth  : spend over the caller's rollups in the current IST
   *                       month.
   *
   * The 30-day and month windows filter on the rollup `date` string (IST
   * 'YYYY-MM-DD'), so the bounds come from the pure IST date-window helpers.
   * No inquiry / conversion KPI is returned -- not attributed.
   */
  async stats(ownerUserId: string, nowMs: number = Date.now()): Promise<BoostStatsView> {
    const rollupModel = this.rollupModel;
    if (!rollupModel) {
      // Never happens under Nest DI; optional only for positional test construction.
      throw new Error('BoostService.rollupModel is required to compute stats');
    }

    const ownerOid = new Types.ObjectId(ownerUserId);

    // Resolve the caller's campaign ids once; both windowed sums scope to them.
    // Match owner as ObjectId OR string (legacy string-stored owners) so the KPI
    // counts include already-created boosts, matching list().
    const owned: Array<{ _id: Types.ObjectId; status: string }> = await this.campaignModel
      .find({ ownerUserId: { $in: [ownerOid, ownerUserId] } }, { _id: 1, status: 1 })
      .lean();

    const activeCount = owned.filter((c) => c.status === 'active').length;

    if (owned.length === 0) {
      return { activeCount: 0, reach30d: 0, clicks30d: 0, spendThisMonth: 0 };
    }

    const campaignIds = owned.map((c) => c._id);

    const { startDateStr: d30Start, endDateStr: d30End } = last30dIstDateRange(nowMs);
    const { startDateStr: mStart, endDateStr: mEnd } = currentIstMonthRange(nowMs);

    // Last-30-IST-days reach + clicks.
    const windowAgg: Array<{ _id: null; reach: number; clicks: number }> =
      await rollupModel.aggregate([
        {
          $match: {
            campaignId: { $in: campaignIds },
            date: { $gte: d30Start, $lte: d30End },
          },
        },
        {
          $group: {
            _id: null,
            reach: { $sum: '$impressions' },
            clicks: { $sum: '$clicks' },
          },
        },
      ]);

    // Current-IST-month spend.
    const monthAgg: Array<{ _id: null; spend: number }> = await rollupModel.aggregate([
      {
        $match: {
          campaignId: { $in: campaignIds },
          date: { $gte: mStart, $lte: mEnd },
        },
      },
      { $group: { _id: null, spend: { $sum: '$spend' } } },
    ]);

    return {
      activeCount,
      reach30d: windowAgg[0]?.reach ?? 0,
      clicks30d: windowAgg[0]?.clicks ?? 0,
      spendThisMonth: monthAgg[0]?.spend ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadAndVerify(id: string, ownerUserId: string): Promise<AdCampaignDocument> {
    let campaign: AdCampaignDocument | null = null;
    try {
      campaign = await this.campaignModel.findById(id);
    } catch (err) {
      // A malformed id (Mongoose CastError) or a transient read error must
      // surface as a clean not-found, NEVER a 500 on the "view your boost" page.
      this.logger.warn(
        `loadAndVerify: findById failed for boost ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new NotFoundException('Boost campaign not found');
    }
    // Ownership check by STRING id, not `.equals`. Some campaign docs have
    // `ownerUserId` persisted as a plain string (not an ObjectId); Mongoose's
    // read path does not re-cast it, so `campaign.ownerUserId.equals` is
    // undefined -> `.equals is not a function` -> a raw 500. Comparing the
    // stringified ids works whether the field is an ObjectId or a string and can
    // never throw. (Keep in sync with the create-time fix that now stores the
    // owner as a real ObjectId, and with list()/stats() which match both forms.)
    if (
      !campaign ||
      !campaign.ownerUserId ||
      String(campaign.ownerUserId) !== String(ownerUserId)
    ) {
      throw new NotFoundException(`Boost campaign not found`);
    }
    return campaign;
  }
}
