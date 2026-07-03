import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AdCreative, type AdCreativeDocument } from '../schemas/ad-creative.schema';
import { AdCampaign, type AdCampaignDocument } from '../schemas/ad-campaign.schema';
import { AdSet, type AdSetDocument } from '../schemas/ad-set.schema';
import { AdPlacement, type AdPlacementDocument } from '../schemas/ad-placement.schema';
import { Listing, type ListingDocument } from '../../marketplace/schemas/listing.schema';
import { Job, type JobDocument } from '../../jobs/schemas/job.schema';
import { Rfq, type RfqDocument } from '../../rfq/schemas/rfq.schema';
import { WalletService } from './wallet.service';
import { ConnectPricingConfigService } from './connect-pricing-config.service';
import { CONNECT_PRICING_DEFAULTS } from '../schemas/connect-pricing-config.schema';
import type { AdvertiserWalletDocument } from '../schemas/advertiser-wallet.schema';
import { AuditService } from '../../../../modules/audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import type { AdminPlacementDto } from '../dto/admin-placement.dto';
import type { AdminWalletAdjustDto } from '../dto/admin-wallet-adjust.dto';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { NotificationsService } from '../../../notifications/notifications.service';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PendingCreativeView {
  _id: Types.ObjectId;
  reviewStatus: string;
  campaignId: Types.ObjectId;
  postRef?: Types.ObjectId | null;
  listingRef?: Types.ObjectId | null;
  jobRef?: Types.ObjectId | null;
  /** Advertiser's own profile (promoted_open_to_work / promoted_hiring); = ownerUserId. */
  profileRef?: Types.ObjectId | null;
  /** The boosted RFQ (promoted_rfq creatives only). */
  rfqRef?: Types.ObjectId | null;
  /** Title of the boosted listing (promoted_listing creatives only); null otherwise. */
  listingTitle?: string | null;
  /** Title of the boosted job (promoted_job creatives only); null otherwise. */
  jobTitle?: string | null;
  /** Title of the boosted RFQ (promoted_rfq creatives only); null otherwise. */
  rfqTitle?: string | null;
  kind: string;
  createdAt?: Date;
  updatedAt?: Date;
  campaign?: {
    objective: string;
    totalBudget: number;
    ownerUserId: unknown;
  } | null;
}

export interface ReviewResult {
  creativeId: string;
  campaignId: string;
  status: string;
}

/**
 * One row in the admin "live boosts" panel (publish-then-moderate take-down
 * queue). The FE consumes this with the SAME shape as a pending-review item
 * (`AdminLiveBoost extends AdminPendingCreative`), so a live row is exactly the
 * `PendingCreativeView` shape (real `_id` = creativeId, nested `campaign`,
 * per-kind title fields, `kind` = the CREATIVE kind) PLUS one boolean
 * `spotlight` (does the ad set serve the premium `spotlight_rail`). Matching the
 * pending shape gives the FE a real creativeId for its take-down reject call.
 */
export interface LiveCampaignView extends PendingCreativeView {
  /** True when the ad set serves on the premium `spotlight_rail` placement. */
  spotlight: boolean;
}

export interface RevenueResult {
  revenue: number;
}

// ---------------------------------------------------------------------------
// Analytics helpers (product-funnel mirror of the billing activation)
// ---------------------------------------------------------------------------

/**
 * Maps a campaign `kind` (`boost_post` | `boost_listing` | `boost_job`) to the
 * subject vocabulary the FE boost funnel uses (`post` | `listing` | `job`) by
 * stripping the `boost_` prefix. Keeps the server `connect.boost.activated`
 * event's `kind` property aligned with `BoostSubject` in the FE catalog
 * (crewroster-web/lib/analytics-events.ts). Falls back to the raw kind for any
 * unexpected value.
 */
function mapBoostKind(kind: string): string {
  return kind.startsWith('boost_') ? kind.slice('boost_'.length) : kind;
}

/**
 * Buckets a rupee amount into a coarse band so analytics never carries the
 * exact committed budget. Boundaries are a deliberate local copy of the FE
 * `bucketRupees` helper (crewroster-web/lib/analytics-events.ts) so the
 * `budgetBucket` property is directly comparable across the funnel. Do NOT
 * import across repos; keep the two copies in sync by hand if the bands change.
 */
function bucketRupees(amount: number): string {
  const n = Number.isFinite(amount) ? amount : 0;
  if (n < 100) return '<100';
  if (n < 300) return '100-299';
  if (n < 600) return '300-599';
  if (n < 1000) return '600-999';
  if (n < 2500) return '1k-2.4k';
  if (n < 5000) return '2.5k-4.9k';
  return '5k+';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Platform-admin surface for the ads sub-system.
 *
 * Responsibilities:
 *   - Creative review queue (approve / reject) with wallet refund on rejection.
 *   - Placement slot configuration (floor CPM, enabled flag).
 *   - Platform-wide revenue rollup (foundation -- by-day / by-product in later phases).
 *
 * Audited: every write emits an `AppModule.ADS` audit event via `AuditService.logEvent`.
 *
 * NOTE: `listPending` performs one `findById` per creative to load its campaign.
 * At review-queue scale (O(tens) of pending items) this is acceptable. Add a
 * `$in` aggregate if the queue grows to hundreds.
 */
@Injectable()
export class AdsAdminService {
  private readonly logger = new Logger(AdsAdminService.name);

  constructor(
    @InjectModel(AdCreative.name)
    private readonly creativeModel: Model<AdCreativeDocument>,
    @InjectModel(AdCampaign.name)
    private readonly campaignModel: Model<AdCampaignDocument>,
    @InjectModel(AdPlacement.name)
    private readonly placementModel: Model<AdPlacementDocument>,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    // Optional only so the shipped admin tests construct positionally without it;
    // Nest DI always provides it (AdsModule registers the Listing model). Used to
    // surface the listing title for promoted_listing creatives in the queue.
    @Optional()
    @InjectModel(Listing.name)
    private readonly listingModel?: Model<ListingDocument>,
    // Same positional-construction reason; used to surface the job title for
    // promoted_job creatives in the review queue.
    @Optional()
    @InjectModel(Job.name)
    private readonly jobModel?: Model<JobDocument>,
    // Same positional-construction reason; used to surface the RFQ title for
    // promoted_rfq creatives in the review queue.
    @Optional()
    @InjectModel(Rfq.name)
    private readonly rfqModel?: Model<RfqDocument>,
    // Appended LAST so existing positional admin tests stay valid. Optional for
    // the same positional-construction reason; Nest DI always provides it
    // (AdsModule registers the AdSet model). Used by listLive() to detect the
    // premium Spotlight rail placement on a live boost.
    @Optional()
    @InjectModel(AdSet.name)
    private readonly adSetModel?: Model<AdSetDocument>,
    // Appended LAST (after adSetModel). Optional so positional tests omit it;
    // Nest DI always provides it. Supplies the live, admin-tunable review fee
    // withheld from a take-down refund. Falls back to the shipped default when
    // absent (positional test construction).
    @Optional()
    private readonly pricingConfig?: ConnectPricingConfigService,
    // Appended LAST (after pricingConfig). Optional so positional tests omit it;
    // Nest DI always provides it (AdsModule imports NotificationsModule). Used to
    // best-effort notify the advertiser when their boost is taken down.
    @Optional()
    @Inject(NotificationsService)
    private readonly notifications?: NotificationsService,
  ) {}

  /**
   * The flat admin review fee (rupees) withheld from a take-down refund. Read
   * from the live admin-tunable config when injected, else the shipped default.
   */
  private async getModerationReviewFee(): Promise<number> {
    if (this.pricingConfig) {
      const cfg = await this.pricingConfig.getConfig();
      return cfg.moderationReviewFee;
    }
    return CONNECT_PRICING_DEFAULTS.moderationReviewFee;
  }

  // ---------------------------------------------------------------------------
  // Review queue
  // ---------------------------------------------------------------------------

  /**
   * Returns all creatives with `reviewStatus: 'pending'`, each enriched with
   * its parent campaign's `objective`, `totalBudget`, and `ownerUserId` so the
   * admin reviewer sees context without a second round-trip from the UI.
   */
  async listPending(): Promise<PendingCreativeView[]> {
    const creatives = await this.creativeModel.find({ reviewStatus: 'pending' }).lean().exec();
    return Promise.all(creatives.map((creative) => this.enrichCreative(creative)));
  }

  /**
   * Enriches one lean creative into the queue-row shape the FE consumes: the raw
   * creative fields + per-kind source title (listing/job/rfq) + a nested
   * `campaign` summary (objective / totalBudget / ownerUserId). Shared by
   * `listPending` and `listLive` so both lists carry the SAME shape (the FE
   * `AdminLiveBoost` extends `AdminPendingCreative`). One findById per creative;
   * acceptable at review/take-down-queue scale (see class note).
   */
  private async enrichCreative(creative: {
    _id: Types.ObjectId;
    campaignId: Types.ObjectId;
    kind: string;
    listingRef?: Types.ObjectId | null;
    jobRef?: Types.ObjectId | null;
    rfqRef?: Types.ObjectId | null;
    [k: string]: unknown;
  }): Promise<PendingCreativeView> {
    const campaign = (await this.campaignModel.findById(creative.campaignId).lean().exec()) as {
      objective: string;
      totalBudget: number;
      ownerUserId: unknown;
    } | null;

    // Surface the listing title for a promoted_listing creative so the queue is
    // self-describing for either ad unit (post boosts carry the postRef the
    // console previews; listing boosts carry a listingRef).
    let listingTitle: string | null = null;
    if (creative.kind === 'promoted_listing' && creative.listingRef && this.listingModel) {
      const listing = (await this.listingModel
        .findById(creative.listingRef)
        .select('title')
        .lean()
        .exec()) as { title?: string } | null;
      listingTitle = listing?.title ?? null;
    }

    let jobTitle: string | null = null;
    if (creative.kind === 'promoted_job' && creative.jobRef && this.jobModel) {
      const job = (await this.jobModel.findById(creative.jobRef).select('title').lean().exec()) as {
        title?: string;
      } | null;
      jobTitle = job?.title ?? null;
    }

    // Surface the RFQ title for a promoted_rfq creative (mirrors listing/job) so
    // the queue is self-describing for the rfq boost too.
    let rfqTitle: string | null = null;
    if (creative.kind === 'promoted_rfq' && creative.rfqRef && this.rfqModel) {
      const rfq = (await this.rfqModel.findById(creative.rfqRef).select('title').lean().exec()) as {
        title?: string;
      } | null;
      rfqTitle = rfq?.title ?? null;
    }

    return {
      ...creative,
      listingTitle,
      jobTitle,
      rfqTitle,
      campaign: campaign
        ? {
            objective: campaign.objective,
            totalBudget: campaign.totalBudget,
            ownerUserId: campaign.ownerUserId,
          }
        : null,
    } as PendingCreativeView;
  }

  /**
   * Returns every LIVE boost (campaign status `active` or `paused`), newest
   * first, for the admin take-down panel. Each row is exactly the `listPending`
   * shape (real `_id` = creativeId, nested `campaign`, per-kind title fields,
   * `kind` = the creative kind) PLUS a `spotlight` flag (does the ad set serve
   * the premium `spotlight_rail` placement). The FE takes a row down via
   * `reject` using its `_id` (the creative id), so reusing the pending mapper is
   * what gives the take-down call a real creativeId.
   */
  async listLive(): Promise<LiveCampaignView[]> {
    const campaigns = await this.campaignModel
      .find({ status: { $in: ['active', 'paused'] } })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return Promise.all(
      campaigns.map(async (campaign) => {
        // Resolve the creative for this campaign; it carries the _id the FE
        // reject call needs plus the per-kind ref the title lookup uses.
        const creative = (await this.creativeModel
          .findOne({ campaignId: campaign._id })
          .lean()
          .exec()) as {
          _id: Types.ObjectId;
          campaignId: Types.ObjectId;
          kind: string;
          listingRef?: Types.ObjectId | null;
          jobRef?: Types.ObjectId | null;
          rfqRef?: Types.ObjectId | null;
        } | null;

        // Spotlight = the ad set serves the premium `spotlight_rail` placement.
        let spotlight = false;
        if (this.adSetModel) {
          const adSet = (await this.adSetModel
            .findOne({ campaignId: campaign._id })
            .select('placements')
            .lean()
            .exec()) as { placements?: string[] } | null;
          spotlight = Array.isArray(adSet?.placements)
            ? adSet.placements.includes('spotlight_rail')
            : false;
        }

        // Pending shape + spotlight. enrichCreative re-derives the nested
        // campaign summary so a live row is interchangeable with a pending one.
        // Defensive: a campaign with no creative degrades to a minimal row (no
        // _id) rather than crashing the whole list.
        if (!creative) {
          return {
            _id: null,
            campaignId: campaign._id,
            kind: campaign.kind,
            spotlight,
          } as unknown as LiveCampaignView;
        }
        const enriched = await this.enrichCreative(creative);
        return { ...enriched, spotlight };
      }),
    );
  }

  /**
   * Approves a creative.
   *
   * Side-effects (in order):
   *   1. creative.reviewStatus -> 'approved', reviewedBy -> adminUserId
   *   2. campaign.status -> 'active'
   *   3. AuditService.logEvent (creative_approved)
   */
  async approve(creativeId: string, adminUserId: string, note?: string): Promise<ReviewResult> {
    const creative = await this.creativeModel.findById(creativeId);
    if (!creative) {
      throw new NotFoundException(`AdCreative ${creativeId} not found`);
    }

    creative.reviewStatus = 'approved';
    creative.reviewedBy = new Types.ObjectId(adminUserId);
    await creative.save();

    const campaign = await this.campaignModel.findById(creative.campaignId);
    if (campaign) {
      campaign.status = 'active';
      await campaign.save();
    }

    await this.audit.logEvent({
      module: AppModule.ADS,
      entityType: 'AdCreative',
      entityId: creativeId,
      action: 'creative_approved',
      actorId: adminUserId,
      meta: {
        campaignId: String(creative.campaignId),
        ...(note !== undefined && { note }),
      },
    });

    this.posthog?.capture({
      distinctId: adminUserId,
      event: 'ads.creative_approved',
      properties: {
        creativeId,
        campaignId: String(creative.campaignId),
      },
    });

    // Product-funnel mirror of the billing activation: approval is the
    // authoritative moment a boost campaign becomes 'active' (money committed),
    // so emit `connect.boost.activated` here to close the FE boost funnel
    // (connect.boost.cta_clicked -> flow_started -> submitted -> activated; see
    // crewroster-web/lib/analytics-events.ts). Billing / wallet reserve is the
    // source of truth for revenue; this event is the sampled analytics mirror
    // only and never carries the exact budget (bucketed) or drives any charge.
    // distinctId = the campaign OWNER (the advertiser whose funnel this closes),
    // not the admin reviewer. Fire-and-forget: capture() is a no-op without a
    // key and must never throw out of approve().
    if (campaign) {
      this.posthog?.capture({
        distinctId: String(campaign.ownerUserId),
        event: 'connect.boost.activated',
        properties: {
          kind: mapBoostKind(campaign.kind),
          budgetBucket: bucketRupees(campaign.totalBudget),
          durationDays: Math.max(
            1,
            Math.ceil((campaign.endAt.getTime() - campaign.startAt.getTime()) / 86_400_000),
          ),
        },
      });
    }

    return {
      creativeId,
      campaignId: String(creative.campaignId),
      status: 'approved',
    };
  }

  /**
   * Take a boost down (also the legacy "reject a creative" path). Works on a
   * campaign in ANY status -- publish-then-moderate launches boosts live, so this
   * is now the way an admin takes a LIVE boost down with a custom reason.
   *
   * Idempotency: a take-down on an ALREADY-terminal campaign (`completed` or
   * `rejected`) is a no-op -- no creative/campaign mutation, no budget move, no
   * unlink, no notify -- and returns the campaign's existing terminal status.
   *
   * Side-effects (in order) for a live take-down:
   *   1. creative.reviewStatus -> 'rejected', rejectionReason -> reason, reviewedBy -> adminUserId
   *   2. campaign.status -> 'rejected', campaign.moderationReason -> reason
   *   3. Budget settle. unspent = max(0, totalBudget - budgetSpent).
   *      - PAUSED campaign: pause() already released the unspent back to balance,
   *        so DO NOT release again (would over-release and throw). The fee is
   *        skipped here too (the money is already spendable; re-charging it would
   *        need a balance debit the wallet does not expose on this path).
   *      - active/pending_review campaign: charge the withheld fee out of
   *        `reserved` via wallet.debit (the serving-spend charge path) and
   *        release the remaining refund, so `reserved` nets to 0 (fee charged +
   *        refund released) -- no reconcile drift. Both moves are skipped when
   *        their amount is 0.
   *   4. Unlink the source doc (listing / job / RFQ) so the advertiser can
   *      relaunch -- best-effort (try/catch), like the notification.
   *   5. Best-effort notify the advertiser with the reason (never blocks the take-down).
   *   6. AuditService.logEvent (creative_rejected) including the withheld review fee.
   */
  async reject(creativeId: string, adminUserId: string, reason: string): Promise<ReviewResult> {
    const creative = await this.creativeModel.findById(creativeId);
    if (!creative) {
      throw new NotFoundException(`AdCreative ${creativeId} not found`);
    }

    // H1 -- idempotent take-down: if the campaign is already terminal
    // (completed / rejected) the boost is already stopped and settled. No-op:
    // do not mutate the creative/campaign, move budget, unlink, or notify.
    const existing = await this.campaignModel.findById(creative.campaignId);
    if (existing && ['completed', 'rejected'].includes(existing.status)) {
      return {
        creativeId,
        campaignId: String(creative.campaignId),
        status: existing.status,
      };
    }

    creative.reviewStatus = 'rejected';
    creative.rejectionReason = reason;
    creative.reviewedBy = new Types.ObjectId(adminUserId);
    await creative.save();

    // Withhold a flat admin review fee from the refund (publish-then-moderate).
    const fee = await this.getModerationReviewFee();
    let reviewFeeWithheld = 0;

    const campaign = existing;
    if (campaign) {
      // Capture the pre-flip status: a PAUSED campaign already released its
      // unspent budget on pause(), so the settle path below must not touch the
      // wallet again.
      const wasPaused = campaign.status === 'paused';

      campaign.status = 'rejected';
      // Shown to the advertiser on the taken-down boost (list() / status()).
      campaign.moderationReason = reason;
      await campaign.save();

      const unspent = Math.max(0, campaign.totalBudget - campaign.budgetSpent);

      if (wasPaused) {
        // M1 -- pause() already returned the unspent to the spendable balance
        // (reserved is ~0). Releasing again would over-release and throw. We
        // also skip the fee here: the credits are already spendable and the
        // wallet exposes no clean balance-debit on this path, so a paused
        // take-down forgoes the fee rather than crash.
        reviewFeeWithheld = 0;
      } else {
        // active / pending_review: the unspent is still in `reserved`. Charge
        // the withheld fee out of reserved (M2 -- the same debit path serving
        // spend uses) and release the remaining refund, so reserved nets to 0
        // with no drift. Each move is skipped when its amount is 0.
        reviewFeeWithheld = Math.min(unspent, fee);
        const refund = Math.max(0, unspent - fee);

        if (reviewFeeWithheld > 0) {
          // Consume the fee from reserved permanently (it becomes platform
          // revenue, not refunded). Deterministic idempotency key so a retried
          // take-down charges the fee exactly once.
          await this.wallet.debit(
            String(campaign.ownerUserId),
            reviewFeeWithheld,
            String(campaign._id),
            `takedown-fee:${String(campaign._id)}`,
          );
        }
        if (refund > 0) {
          await this.wallet.release(String(campaign.ownerUserId), refund, String(campaign._id));
        }
      }

      // Unlink the source so the advertiser can relaunch a fresh boost (the
      // in-flight gate keys on the source's boostCampaignId). Profile boosts
      // (open_to_work / hiring) have no source doc, so nothing to unlink.
      // M3 -- best-effort: a transient DB failure here must not leave a
      // half-done take-down (status/refund already applied), so it is swallowed
      // + logged, like the notification below.
      try {
        await this.unlinkSource(campaign);
      } catch (err) {
        this.logger.error(
          `Failed to unlink source for taken-down campaign ${String(campaign._id)}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Best-effort advertiser notification -- never breaks the take-down.
      await this.notifyTakenDown(campaign, reason);
    }

    await this.audit.logEvent({
      module: AppModule.ADS,
      entityType: 'AdCreative',
      entityId: creativeId,
      action: 'creative_rejected',
      actorId: adminUserId,
      reason,
      meta: {
        campaignId: String(creative.campaignId),
        reviewFeeWithheld,
      },
    });

    this.posthog?.capture({
      distinctId: adminUserId,
      event: 'ads.creative_rejected',
      properties: {
        creativeId,
        campaignId: String(creative.campaignId),
        reason,
      },
    });

    return {
      creativeId,
      campaignId: String(creative.campaignId),
      status: 'rejected',
    };
  }

  /**
   * Unlinks the boosted source doc (sets its `boostCampaignId = null`) so the
   * in-flight boost gate clears and the advertiser can relaunch. Picks the model
   * by whichever source ref the campaign carries; a profile boost has no source
   * doc (nothing to do). Best-effort within the take-down: a missing model or
   * missing doc is a no-op.
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

  /**
   * Best-effort: tell the advertiser their boost was taken down + why. Wrapped in
   * a try/catch so a notification failure never breaks the take-down. No-op when
   * the notifications service is not wired (positional test construction).
   */
  private async notifyTakenDown(campaign: AdCampaignDocument, reason: string): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.dispatch({
        recipientId: campaign.ownerUserId,
        category: 'connect.boost_taken_down',
        title: 'Your boost was taken down',
        message: `Your boost was taken down by our team. Reason: ${reason}`,
        entityType: 'AdCampaign',
        entityId: String(campaign._id),
        type: 'warning',
        metadata: { reason },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify advertiser ${String(campaign.ownerUserId)} of boost take-down ` +
          `for campaign ${String(campaign._id)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Placement configuration
  // ---------------------------------------------------------------------------

  /** Returns all placement slots (platform-wide, no workspace scoping). */
  async listPlacements(): Promise<AdPlacementDocument[]> {
    return this.placementModel.find().exec();
  }

  /**
   * Updates `floorCpm` and `enabled` on a placement slot identified by `key`.
   * Throws NotFoundException when the key does not exist.
   * Audits the change with action `placement_updated`.
   */
  async updatePlacement(
    key: string,
    dto: Pick<AdminPlacementDto, 'floorCpm' | 'enabled'>,
    adminUserId: string,
  ): Promise<AdPlacementDocument> {
    const updated = await this.placementModel.findOneAndUpdate(
      { key },
      { $set: { floorCpm: dto.floorCpm, enabled: dto.enabled } },
      { new: true },
    );

    if (!updated) {
      throw new NotFoundException(`AdPlacement with key '${key}' not found`);
    }

    await this.audit.logEvent({
      module: AppModule.ADS,
      entityType: 'AdPlacement',
      entityId: String(updated._id),
      action: 'placement_updated',
      actorId: adminUserId,
      meta: {
        key,
        floorCpm: dto.floorCpm,
        enabled: dto.enabled,
      },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Revenue rollup
  // ---------------------------------------------------------------------------

  /**
   * Returns the platform-wide total ad spend across all campaigns.
   * Foundation implementation -- per-day and per-product breakdowns are a
   * later phase addition.
   */
  async getRevenue(): Promise<RevenueResult> {
    const result = await this.campaignModel.aggregate<{ _id: null; revenue: number }>([
      { $group: { _id: null, revenue: { $sum: '$budgetSpent' } } },
    ]);

    return { revenue: result[0]?.revenue ?? 0 };
  }

  // ---------------------------------------------------------------------------
  // Wallet adjustment (admin manual credit / debit)
  // ---------------------------------------------------------------------------

  /**
   * Reads an advertiser's wallet for the admin console (spendable `balance`,
   * granted `grantBalance`, locked `reserved`). Upserts an empty wallet if the
   * user has never had one, so the console always shows a concrete row.
   */
  async getWallet(userId: string): Promise<AdvertiserWalletDocument> {
    return this.wallet.getWallet(userId);
  }

  /**
   * Applies a signed manual adjustment to an advertiser's spendable balance and
   * records it: the WalletService writes the `adjustment` ledger row (the money
   * trail), then we audit the operator action and emit the analytics event.
   *
   * Order matters: the wallet mutation + ledger write run first so a refusal
   * (e.g. debit larger than balance) throws BEFORE any audit/analytics noise is
   * emitted. The audit row is the authoritative operator record; the PostHog
   * event is a fire-and-forget product-analytics mirror (no-op without a key)
   * and never carries the exact amount beyond what audit already holds.
   */
  async adjustWallet(
    userId: string,
    dto: AdminWalletAdjustDto,
    adminUserId: string,
  ): Promise<AdvertiserWalletDocument> {
    const wallet = await this.wallet.adjust(userId, dto.amount, adminUserId, dto.reason, dto.note);

    await this.audit.logEvent({
      module: AppModule.ADS,
      entityType: 'AdvertiserWallet',
      entityId: userId,
      action: 'wallet_admin_adjustment',
      actorId: adminUserId,
      meta: {
        amount: dto.amount,
        reason: dto.reason,
      },
    });

    // Product-analytics mirror of the admin action. distinctId = the wallet
    // OWNER (the advertiser whose balance moved), aligning with the rest of the
    // ads funnel. Fire-and-forget: capture() is a no-op without a key and must
    // never throw out of adjustWallet().
    this.posthog?.capture({
      distinctId: userId,
      event: 'ads.wallet_admin_adjustment',
      properties: {
        amount: dto.amount,
        balanceAfter: wallet.balance,
      },
    });

    return wallet;
  }
}
