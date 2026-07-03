import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Listing } from '../marketplace/schemas/listing.schema';
import { Job } from '../jobs/schemas/job.schema';
import { Post } from '../feed/schemas/post.schema';
import { ConnectViewDaily } from '../views/schemas/connect-view-daily.schema';
import { EngagementEdge } from '../feed/schemas/engagement-edge.schema';
import { JobView } from '../jobs/schemas/job-view.schema';
import { AdCampaign } from '../ads/schemas/ad-campaign.schema';
import { ConnectOverLimitService } from '../over-limit/connect-over-limit.service';
import { ConnectBoostNudgeDismissal } from './schemas/connect-boost-nudge-dismissal.schema';
import { ConnectBoostNudgeShown } from './schemas/connect-boost-nudge-shown.schema';
import { BoostNudgeCandidate, BoostNudgeKind } from './boost-nudge.types';
import {
  ACTIVE_BOOST_STATUSES,
  BOOST_CAMPAIGN_KINDS,
  NUDGE_DISMISS_DAYS,
  NUDGE_MAX_CANDIDATES,
  NUDGE_SCAN_LIMIT,
  NUDGE_SHOWN_COOLDOWN_DAYS,
  NUDGE_VIEW_THRESHOLDS,
  NUDGE_WINDOW_DAYS,
  POST_NAME_MAX,
} from './boost-nudge.constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC 'YYYY-MM-DD' for a date (matches the connect_view_daily date keys). */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A short, single-line nudge name from a post body (or a friendly fallback). */
function postName(body: string | null | undefined): string {
  const clean = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Your post';
  return clean.length > POST_NAME_MAX ? `${clean.slice(0, POST_NAME_MAX).trimEnd()}…` : clean;
}

/**
 * ManekHR Connect -- traction-based boost-nudge engine.
 *
 * What it does: surfaces up to {@link NUDGE_MAX_CANDIDATES} of an owner's own
 * entities (listing / post / job) that are (a) getting real attention (>= the
 * per-kind 7-day view threshold) AND (b) actually boostable right now, while
 * respecting a 30-day per-entity dismissal and a 7-day global cool-down.
 *
 * Counting reuses the THREE existing view stores -- no new tracking:
 *   - listing -> connect_view_daily (per-viewer-per-day rollup)
 *   - post    -> connectengagementedges type='view' (unique-viewer edges)
 *   - job     -> connect_job_views (unique-viewer rows)
 *
 * Cross-module links: reads Listing / Job / Post + the three view stores + the
 * ads AdCampaign collection (to skip already-boosted entities) + the over-limit
 * service (to skip suppressed listings/jobs that cannot serve). Writes only the
 * two tiny nudge-state collections. The web side (features/connect/useBoostNudges)
 * renders the result and POSTs back shown/dismiss.
 */
@Injectable()
export class BoostNudgeService {
  private readonly logger = new Logger(BoostNudgeService.name);

  constructor(
    @InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
    @InjectModel(Job.name) private readonly jobModel: Model<Job>,
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(ConnectViewDaily.name) private readonly viewDaily: Model<ConnectViewDaily>,
    @InjectModel(EngagementEdge.name) private readonly edgeModel: Model<EngagementEdge>,
    @InjectModel(JobView.name) private readonly jobViewModel: Model<JobView>,
    @InjectModel(AdCampaign.name) private readonly campaignModel: Model<AdCampaign>,
    @InjectModel(ConnectBoostNudgeDismissal.name)
    private readonly dismissalModel: Model<ConnectBoostNudgeDismissal>,
    @InjectModel(ConnectBoostNudgeShown.name)
    private readonly shownModel: Model<ConnectBoostNudgeShown>,
    private readonly overLimit: ConnectOverLimitService,
  ) {}

  /**
   * The owner's current boost-nudge candidates (ranked by views desc, capped).
   * Returns [] under the global cool-down or when nothing qualifies.
   */
  async getNudges(ownerUserId: string): Promise<{ candidates: BoostNudgeCandidate[] }> {
    const now = new Date();
    const oid = new Types.ObjectId(ownerUserId);

    // 1) Global cool-down -- if a nudge was shown within the window, show none.
    const cooldownCutoff = new Date(now.getTime() - NUDGE_SHOWN_COOLDOWN_DAYS * MS_PER_DAY);
    const shown = await this.shownModel
      .findOne({ ownerUserId: oid, lastShownAt: { $gte: cooldownCutoff } })
      .lean()
      .exec();
    if (shown) return { candidates: [] };

    // 2) Cross-cutting exclusion sets (one query each, owner-scoped).
    const [activeBoost, dismissed] = await Promise.all([
      this.activeBoostSets(oid),
      this.dismissedKeys(oid, now),
    ]);

    // 3) Gather per-kind candidates concurrently. Each kind self-filters on
    //    eligibility + the per-kind view threshold.
    const [listingC, postC, jobC] = await Promise.all([
      this.listingCandidates(oid, activeBoost.listing, dismissed),
      this.postCandidates(oid, activeBoost.post, dismissed),
      this.jobCandidates(oid, activeBoost.job, dismissed),
    ]);

    // 4) Rank by traction (views desc) and cap.
    const candidates = [...listingC, ...postC, ...jobC]
      .sort((a, b) => b.viewsWindow - a.viewsWindow)
      .slice(0, NUDGE_MAX_CANDIDATES);

    return { candidates };
  }

  /**
   * Record that a nudge was shown to the owner (starts/refreshes the global
   * cool-down). Idempotent upsert -- the web calls this once when a card renders.
   */
  async markShown(ownerUserId: string): Promise<void> {
    const oid = new Types.ObjectId(ownerUserId);
    await this.shownModel
      .updateOne({ ownerUserId: oid }, { $set: { lastShownAt: new Date() } }, { upsert: true })
      .exec();
  }

  /**
   * Record that the owner dismissed the nudge for one entity (sticks for
   * {@link NUDGE_DISMISS_DAYS} days). Idempotent upsert keyed by (owner, kind,
   * entity) -- a repeat dismiss refreshes the timestamp, never duplicates.
   */
  async dismiss(ownerUserId: string, kind: BoostNudgeKind, entityId: string): Promise<void> {
    const oid = new Types.ObjectId(ownerUserId);
    const eid = new Types.ObjectId(entityId);
    await this.dismissalModel
      .updateOne(
        { ownerUserId: oid, kind, entityId: eid },
        { $set: { dismissedAt: new Date() } },
        { upsert: true },
      )
      .exec();
  }

  // ── Exclusion sets ──────────────────────────────────────────────────────────

  /**
   * Per-kind sets of entity ids that already have an in-flight boost (pending /
   * active / paused). Read from the ads campaign collection in one query via the
   * source refs, so an entity mid-boost is never nudged. Mirrors the create-path
   * guard in boost.service.ts.
   */
  private async activeBoostSets(
    oid: Types.ObjectId,
  ): Promise<{ listing: Set<string>; post: Set<string>; job: Set<string> }> {
    const rows = await this.campaignModel
      .find({
        ownerUserId: oid,
        kind: { $in: BOOST_CAMPAIGN_KINDS as unknown as string[] },
        status: { $in: ACTIVE_BOOST_STATUSES as unknown as string[] },
      })
      .select('sourceListingId sourcePostId sourceJobId')
      .lean()
      .exec();
    const out = { listing: new Set<string>(), post: new Set<string>(), job: new Set<string>() };
    for (const r of rows) {
      if (r.sourceListingId) out.listing.add(String(r.sourceListingId));
      if (r.sourcePostId) out.post.add(String(r.sourcePostId));
      if (r.sourceJobId) out.job.add(String(r.sourceJobId));
    }
    return out;
  }

  /** `${kind}:${entityId}` keys dismissed within the last 30 days. */
  private async dismissedKeys(oid: Types.ObjectId, now: Date): Promise<Set<string>> {
    const cutoff = new Date(now.getTime() - NUDGE_DISMISS_DAYS * MS_PER_DAY);
    const rows = await this.dismissalModel
      .find({ ownerUserId: oid, dismissedAt: { $gte: cutoff } })
      .select('kind entityId')
      .lean()
      .exec();
    return new Set(rows.map((r) => `${r.kind}:${String(r.entityId)}`));
  }

  // ── Per-kind candidate builders ──────────────────────────────────────────────

  private async listingCandidates(
    oid: Types.ObjectId,
    boosted: Set<string>,
    dismissed: Set<string>,
  ): Promise<BoostNudgeCandidate[]> {
    // Public + boost-eligible: an 'active' lifecycle + 'approved' moderation
    // listing is the one that actually serves in the marketplace.
    const rows = await this.listingModel
      .find({ ownerUserId: oid, status: 'active', moderationStatus: 'approved' })
      .select('_id title')
      .sort({ createdAt: -1 })
      .limit(NUDGE_SCAN_LIMIT)
      .lean<Array<{ _id: Types.ObjectId; title: string }>>()
      .exec();
    if (rows.length === 0) return [];

    // Listings hidden by the over-limit policy cannot serve -- never nudge them.
    const suppressed = new Set(await this.overLimit.getSuppressedIds(String(oid), 'listing'));
    const eligible = rows.filter((r) => {
      const id = String(r._id);
      return !suppressed.has(id) && !boosted.has(id) && !dismissed.has(`listing:${id}`);
    });
    if (eligible.length === 0) return [];

    const views = await this.listingViews(eligible.map((r) => r._id));
    return this.toCandidates('listing', eligible, (r) => r.title, views);
  }

  private async jobCandidates(
    oid: Types.ObjectId,
    boosted: Set<string>,
    dismissed: Set<string>,
  ): Promise<BoostNudgeCandidate[]> {
    // Only an OPEN job is boostable + publicly listed.
    const rows = await this.jobModel
      .find({ companyUserId: oid, status: 'open' })
      .select('_id title')
      .sort({ createdAt: -1 })
      .limit(NUDGE_SCAN_LIMIT)
      .lean<Array<{ _id: Types.ObjectId; title: string }>>()
      .exec();
    if (rows.length === 0) return [];

    // Jobs are a capped kind too -- a suppressed (over-limit) job is hidden.
    const suppressed = new Set(await this.overLimit.getSuppressedIds(String(oid), 'job'));
    const eligible = rows.filter((r) => {
      const id = String(r._id);
      return !suppressed.has(id) && !boosted.has(id) && !dismissed.has(`job:${id}`);
    });
    if (eligible.length === 0) return [];

    const views = await this.jobViews(eligible.map((r) => r._id));
    return this.toCandidates('job', eligible, (r) => r.title, views);
  }

  private async postCandidates(
    oid: Types.ObjectId,
    boosted: Set<string>,
    dismissed: Set<string>,
  ): Promise<BoostNudgeCandidate[]> {
    // Only a live, PUBLIC post can be boosted (a connections-only post cannot be
    // promoted publicly). Posts are not a capped kind, so there is no suppression.
    const rows = await this.postModel
      .find({ authorId: oid, deletedAt: null, visibility: 'public' })
      .select('_id body')
      .sort({ createdAt: -1 })
      .limit(NUDGE_SCAN_LIMIT)
      .lean<Array<{ _id: Types.ObjectId; body?: string }>>()
      .exec();
    if (rows.length === 0) return [];

    const eligible = rows.filter((r) => {
      const id = String(r._id);
      return !boosted.has(id) && !dismissed.has(`post:${id}`);
    });
    if (eligible.length === 0) return [];

    const views = await this.postViews(eligible.map((r) => r._id));
    return this.toCandidates('post', eligible, (r) => postName(r.body), views);
  }

  /** Build candidates for entities whose windowed views clear the kind threshold. */
  private toCandidates<T extends { _id: Types.ObjectId }>(
    kind: BoostNudgeKind,
    rows: T[],
    nameOf: (row: T) => string,
    views: Map<string, number>,
  ): BoostNudgeCandidate[] {
    const threshold = NUDGE_VIEW_THRESHOLDS[kind];
    const out: BoostNudgeCandidate[] = [];
    for (const r of rows) {
      const v = views.get(String(r._id)) ?? 0;
      if (v < threshold) continue;
      out.push({
        kind,
        entityId: String(r._id),
        name: nameOf(r),
        viewsWindow: v,
        windowDays: NUDGE_WINDOW_DAYS,
      });
    }
    return out;
  }

  // ── Windowed view counts (reuse existing stores -- no new tracking) ──────────

  /** Last-7-day view totals per listing id, from the connect_view_daily rollup. */
  private async listingViews(ids: Types.ObjectId[]): Promise<Map<string, number>> {
    // Calendar-day window: today and the 6 prior UTC days (matches how the daily
    // rollup is keyed by 'YYYY-MM-DD').
    const startDay = utcDay(new Date(Date.now() - (NUDGE_WINDOW_DAYS - 1) * MS_PER_DAY));
    const rows = await this.viewDaily
      .find({ targetType: 'listing', targetId: { $in: ids }, date: { $gte: startDay } })
      .select('targetId count')
      .lean()
      .exec();
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = String(r.targetId);
      m.set(k, (m.get(k) ?? 0) + r.count);
    }
    return m;
  }

  /** Last-7-day unique-viewer counts per post id, from the view engagement edges. */
  private async postViews(ids: Types.ObjectId[]): Promise<Map<string, number>> {
    const since = new Date(Date.now() - NUDGE_WINDOW_DAYS * MS_PER_DAY);
    const rows = await this.edgeModel
      .aggregate<{
        _id: Types.ObjectId;
        c: number;
      }>([
        { $match: { postId: { $in: ids }, type: 'view', createdAt: { $gte: since } } },
        { $group: { _id: '$postId', c: { $sum: 1 } } },
      ])
      .exec();
    return new Map(rows.map((r) => [String(r._id), r.c]));
  }

  /** Last-7-day unique-viewer counts per job id, from connect_job_views. */
  private async jobViews(ids: Types.ObjectId[]): Promise<Map<string, number>> {
    const since = new Date(Date.now() - NUDGE_WINDOW_DAYS * MS_PER_DAY);
    const rows = await this.jobViewModel
      .aggregate<{
        _id: Types.ObjectId;
        c: number;
      }>([
        { $match: { jobId: { $in: ids }, createdAt: { $gte: since } } },
        { $group: { _id: '$jobId', c: { $sum: 1 } } },
      ])
      .exec();
    return new Map(rows.map((r) => [String(r._id), r.c]));
  }
}
