import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as Sentry from '@sentry/nestjs';
import {
  CONNECT_PURGE_MANIFEST,
  type ConnectPurgeEntry,
  type ConnectUserFieldMatch,
} from './connect-purge-manifest';
import { CONNECT_POST_CHANGED } from '../feed/events/connect-post.events';
import { CONNECT_LISTING_CHANGED } from '../marketplace/events/connect-listing.events';
import { CONNECT_JOB_CHANGED } from '../jobs/events/connect-job.events';
import { CONNECT_PROFILE_CHANGED } from '../profile/events/connect-profile.events';
import { CONNECT_COMPANY_PAGE_CHANGED } from '../entities/events/connect-company-page.events';
import { CONNECT_STOREFRONT_CHANGED } from '../entities/events/connect-storefront.events';

/** Live quote statuses that feed an RFQ's quotesCount + lowestQuotePrice.
 *  KEEP IN SYNC with RfqService.LIVE_QUOTE_STATUSES. */
const LIVE_QUOTE_STATUSES = ['sent', 'shortlisted', 'accepted'];
/** A rating at or above this is a Wilson "positive". KEEP IN SYNC with
 *  ReviewService / BrokerReviewService POSITIVE_THRESHOLD. */
const POSITIVE_THRESHOLD = 4;
/** Wilson z-score (95% confidence). KEEP IN SYNC with ReviewService WILSON_Z. */
const WILSON_Z = 1.96;

/** Per-purge outcome, returned to the finalize/cron caller for the audit log. */
export interface ConnectPurgeSummary {
  userId: string;
  collectionsProcessed: number;
  rowsDeleted: number;
  rowsModified: number;
  failures: Array<{ collection: string; error: string }>;
}

/**
 * Connect content purge (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A, "the largest
 * net-new build"). Runs the irreversible Day-30 purge of a user's Connect data,
 * driven entirely by {@link CONNECT_PURGE_MANIFEST} (one classified row per
 * `connect_*` collection — the completeness gate fails the build if any is
 * missing, and a positive leak test asserts no document resolves to the erased
 * identity afterwards).
 *
 * Used by:
 *  - Scope-1 (Delete Connect): the Day-30 connect-purge sweep runs this for an
 *    account whose `connectDeletion.state==='pending'` window has elapsed.
 *  - Scope-3 (Delete account): {@link AccountDeletionFinalizeService.finalizeOne}
 *    runs this at the documented "Phase 3 seam" — BEFORE the identity scrub, so
 *    the by-user queries still see the live identity.
 *
 * DESIGN: the service depends only on the raw Mongoose connection + the event
 * bus — deliberately NOT on the Connect service graph (which would create import
 * cycles and a heavy construction tree). The §3A counterpart-aggregate recomputes
 * (class `c`) are therefore re-implemented inline against the raw collections,
 * each carrying a "KEEP IN SYNC with <service>" note next to the source formula
 * it mirrors (ReviewService / BrokerReviewService Wilson aggregate, RfqService
 * lowestQuote, the `$inc`-clamped feed / job counters, the FeedService.deletePost
 * cascade). This keeps the purge a single, end-to-end testable unit.
 *
 * Per-collection fault isolation: one collection's failure never aborts the
 * sweep — it is logged + Sentry'd + recorded in the returned summary's
 * `failures[]`, and the rest of the purge proceeds (best-effort, so the maximum
 * possible amount of the user's data is erased on every run; the caller can
 * decide whether to advance the deletion marker based on `failures`).
 */
@Injectable()
export class ConnectContentPurgeService {
  private readonly logger = new Logger(ConnectContentPurgeService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** The raw MongoDB driver db handle (the connection is live at runtime). */
  private db() {
    const db = this.connection.db;
    if (!db) throw new Error('Mongo connection has no db handle');
    return db;
  }

  /**
   * Purge every Connect document that belongs to / references `userId`, per the
   * manifest. Returns a summary for the audit log. Best-effort + fault-isolated.
   */
  async purgeUserConnectContent(userId: string): Promise<ConnectPurgeSummary> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new Error(`ConnectContentPurgeService: invalid userId "${userId}"`);
    }
    const uid = new Types.ObjectId(userId);
    const summary: ConnectPurgeSummary = {
      userId,
      collectionsProcessed: 0,
      rowsDeleted: 0,
      rowsModified: 0,
      failures: [],
    };

    for (const entry of CONNECT_PURGE_MANIFEST) {
      try {
        const { deleted, modified } = await this.purgeOne(entry, uid);
        summary.rowsDeleted += deleted;
        summary.rowsModified += modified;
        summary.collectionsProcessed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.failures.push({ collection: entry.collection, error: message });
        this.logger.error(
          `[purgeUserConnectContent] ${entry.collection} failed for ${userId}: ${message}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'connect-account-purge', op: `purge.${entry.collection}` },
          extra: { userId, collection: entry.collection },
        });
      }
    }

    this.logger.log(
      `[purgeUserConnectContent] ${userId}: ${summary.rowsDeleted} deleted, ${summary.rowsModified} modified across ${summary.collectionsProcessed} collections, ${summary.failures.length} failures.`,
    );
    return summary;
  }

  /** Dispatch one manifest entry. Returns the rows it deleted / modified. */
  private async purgeOne(
    entry: ConnectPurgeEntry,
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    // Bespoke counterpart-aggregate / cascade handlers (§3A class c + the posts
    // cascade). The handler owns the full delete-and-recompute for its collection.
    if (entry.handler) {
      return this.runHandler(entry.handler, uid);
    }

    let deleted = 0;
    let modified = 0;

    // (a)/(b-out) hard-delete the user's rows. Capture ids first when we must
    // de-index the now-gone entities (the search listener re-reads + drops them).
    if (entry.deleteWhereUser && entry.deleteWhereUser.length > 0) {
      const filter = this.userMatchFilter(uid, entry.deleteWhereUser);
      const ids = entry.deindexAfter
        ? (
            await this.db()
              .collection(entry.collection)
              .find(filter, { projection: { _id: 1 } })
              .toArray()
          ).map((d) => d._id as Types.ObjectId)
        : [];
      const res = await this.db().collection(entry.collection).deleteMany(filter);
      deleted += res.deletedCount ?? 0;
      if (entry.deindexAfter) this.deindex(entry.deindexAfter, ids, uid);
    }

    // (b-msg) retain the row; null the nullable user FK(s).
    for (const field of entry.nullUserFields ?? []) {
      const res = await this.db()
        .collection(entry.collection)
        .updateMany({ [field]: uid }, { $set: { [field]: null } });
      modified += res.modifiedCount ?? 0;
    }

    // null-fk / config: $pull the user id out of array fields (seenBy, targetUserIds).
    for (const field of entry.pullUserFromArrays ?? []) {
      const res = await this.db()
        .collection(entry.collection)
        .updateMany({ [field]: uid }, { $pull: { [field]: uid } } as Record<string, unknown>);
      modified += res.modifiedCount ?? 0;
    }

    // (b-out) pull the embedded element the user AUTHORED from OTHER docs.
    if (entry.pullEmbedded) {
      const { arrayPath, userSubField } = entry.pullEmbedded;
      const res = await this.db()
        .collection(entry.collection)
        .updateMany({ [`${arrayPath}.${userSubField}`]: uid }, {
          $pull: { [arrayPath]: { [userSubField]: uid } },
        } as Record<string, unknown>);
      modified += res.modifiedCount ?? 0;
    }

    // (b-about)/(d)/(e): retain — nothing to do beyond any pull above.
    return { deleted, modified };
  }

  /** Build the `{ $or: [...] }` (or single-clause) match for a user's rows. */
  private userMatchFilter(
    uid: Types.ObjectId,
    matches: ConnectUserFieldMatch[],
  ): Record<string, unknown> {
    const clauses = matches.map((m) => {
      const clause: Record<string, unknown> = { [m.field]: uid };
      // Polymorphic id: only a User reference when the sibling discriminator
      // matches, so we never delete an unrelated row that happens to share an id.
      if (m.whenSibling) clause[m.whenSibling.field] = m.whenSibling.equals;
      return clause;
    });
    return clauses.length === 1 ? clauses[0] : { $or: clauses };
  }

  // ── bespoke handlers (§3A class c + the posts cascade) ──────────────────────

  private async runHandler(
    handler: NonNullable<ConnectPurgeEntry['handler']>,
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    switch (handler) {
      case 'feed-posts':
        return this.purgeFeedPosts(uid);
      case 'feed-reactions':
        return this.purgeFeedReactions(uid);
      case 'feed-comments':
        return this.purgeFeedComments(uid);
      case 'rfq-quotes':
        return this.purgeRfqQuotes(uid);
      case 'job-applications':
        return this.purgeJobApplications(uid);
      case 'job-views':
        return this.purgeJobViews(uid);
      case 'reviews':
        return this.purgeReviews(uid);
      case 'broker-reviews':
        return this.purgeBrokerReviews(uid);
      case 'views-seen':
        return this.purgeViewsSeen(uid);
      case 'ads-purge':
        return this.purgeAdsForUser(uid);
      case 'rfq-orphans':
        return this.purgeRfqOrphans(uid);
      case 'job-orphans':
        return this.purgeJobOrphans(uid);
    }
  }

  /**
   * Hard-delete the user's posts + their entire engagement subtree, mirroring the
   * FeedService.deletePost cascade (de-fan feed entries, drop view edges + seen
   * rows) and extending it to a full purge (the post is hard-gone, so every child
   * row keyed on it goes too). Emits CONNECT_POST_CHANGED('deleted') per post so
   * the search indexer drops it. KEEP IN SYNC with FeedService.deletePost.
   */
  private async purgeFeedPosts(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const posts = await this.db()
      .collection('connectposts')
      .find({ authorId: uid }, { projection: { _id: 1 } })
      .toArray();
    const postIds = posts.map((p) => p._id as Types.ObjectId);
    if (postIds.length === 0) return { deleted: 0, modified: 0 };

    // Drop every child row keyed on the gone posts (others' reactions/comments
    // too — the post no longer exists for them to attach to).
    const inPosts = { postId: { $in: postIds } };
    await Promise.all([
      this.db().collection('connectreactions').deleteMany(inPosts),
      this.db().collection('connectcomments').deleteMany(inPosts),
      this.db().collection('connectfeedentries').deleteMany(inPosts),
      this.db().collection('connectengagementedges').deleteMany(inPosts),
      this.db().collection('connectseenposts').deleteMany(inPosts),
      this.db().collection('connectsavedposts').deleteMany(inPosts),
    ]);
    const res = await this.db()
      .collection('connectposts')
      .deleteMany({ _id: { $in: postIds } });
    for (const id of postIds) {
      this.emit(CONNECT_POST_CHANGED, { postId: String(id), change: 'deleted' });
    }
    // CN-PURGE-2 (Bucket 10): scrub the erased user's @mention chip out of OTHER
    // people's SURVIVING posts (their own posts are gone above). The literal
    // "@name" text in the body is left as-is (owner decision OQ-5, 2026-07-02 —
    // not redacted). Dropping just the mention sub-doc (keyed on refId) makes the
    // chip stop rendering as a live link, degrading to plain text per the mention
    // schema's documented behaviour. Uses the same $pull shape as the generic
    // pullEmbedded path. The feed-posts handler owns this collection, so it does
    // this inline (purgeOne short-circuits to the handler for handler rows).
    const mentionPull = await this.pullMentionRefs('connectposts', uid);
    return { deleted: res.deletedCount ?? 0, modified: mentionPull };
  }

  /**
   * $pull every mention sub-doc referencing `uid` (a profile mention's `refId`)
   * out of `collection`'s `mentions[]` arrays, across ALL docs (CN-PURGE-2).
   * Shared by the feed-posts + feed-comments handlers. Returns rows modified.
   */
  private async pullMentionRefs(collection: string, uid: Types.ObjectId): Promise<number> {
    const res = await this.db()
      .collection(collection)
      .updateMany({ 'mentions.refId': uid }, {
        $pull: { mentions: { refId: uid } },
      } as Record<string, unknown>);
    return res.modifiedCount ?? 0;
  }

  /**
   * Delete the user's reactions on OTHERS' posts (b-out) and decrement each
   * counterpart Post.reactionCount (one reaction per post per user — unique
   * index). KEEP IN SYNC with ReactionService's `$inc`-clamped reactionCount.
   */
  private async purgeFeedReactions(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const reactions = await this.db()
      .collection('connectreactions')
      .find({ userId: uid }, { projection: { postId: 1 } })
      .toArray();
    const postIds = this.distinctIds(reactions.map((r) => r.postId as Types.ObjectId));
    const res = await this.db().collection('connectreactions').deleteMany({ userId: uid });
    let modified = 0;
    if (postIds.length > 0) {
      const upd = await this.db()
        .collection('connectposts')
        .updateMany(
          { _id: { $in: postIds }, reactionCount: { $gt: 0 } },
          { $inc: { reactionCount: -1 } },
        );
      modified = upd.modifiedCount ?? 0;
    }
    return { deleted: res.deletedCount ?? 0, modified };
  }

  /**
   * Delete the user's comments and decrement each counterpart Post.commentCount
   * by the number of the user's LIVE (non-soft-deleted) comments on it — those
   * are what the denormalized count reflects. Clamped at 0 via a pipeline update.
   * KEEP IN SYNC with CommentService's `$inc`-clamped commentCount.
   */
  private async purgeFeedComments(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const live = await this.db()
      .collection('connectcomments')
      .aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { authorId: uid, deletedAt: null } },
        { $group: { _id: '$postId', n: { $sum: 1 } } },
      ])
      .toArray();
    const res = await this.db().collection('connectcomments').deleteMany({ authorId: uid });
    let modified = 0;
    for (const { _id: postId, n } of live) {
      const upd = await this.db()
        .collection('connectposts')
        .updateOne({ _id: postId }, [
          { $set: { commentCount: { $max: [0, { $subtract: ['$commentCount', n] }] } } },
        ]);
      modified += upd.modifiedCount ?? 0;
    }
    // CN-PURGE-2: scrub the erased user's @mention chip out of OTHERS' surviving
    // comments (see purgeFeedPosts for the full rationale; literal text kept).
    modified += await this.pullMentionRefs('connectcomments', uid);
    return { deleted: res.deletedCount ?? 0, modified };
  }

  /**
   * Delete the seller's quotes (b-out) and recompute each counterpart RFQ's
   * quotesCount + lowestQuotePrice from its remaining LIVE non-demo quotes.
   * KEEP IN SYNC with RfqService.recomputeLowestQuote + the quotesCount `$inc`.
   */
  private async purgeRfqQuotes(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    // Only LIVE non-demo quotes ever contributed to quotesCount.
    const counted = await this.db()
      .collection('connect_quotes')
      .aggregate<{ _id: Types.ObjectId; n: number }>([
        {
          $match: {
            sellerUserId: uid,
            status: { $in: LIVE_QUOTE_STATUSES },
            isDemo: { $ne: true },
          },
        },
        { $group: { _id: '$rfqId', n: { $sum: 1 } } },
      ])
      .toArray();
    const allQuotes = await this.db()
      .collection('connect_quotes')
      .find({ sellerUserId: uid }, { projection: { rfqId: 1 } })
      .toArray();
    const affectedRfqs = this.distinctIds(allQuotes.map((q) => q.rfqId as Types.ObjectId));

    const res = await this.db().collection('connect_quotes').deleteMany({ sellerUserId: uid });

    let modified = 0;
    for (const { _id: rfqId, n } of counted) {
      const upd = await this.db()
        .collection('connect_rfqs')
        .updateOne({ _id: rfqId }, [
          { $set: { quotesCount: { $max: [0, { $subtract: ['$quotesCount', n] }] } } },
        ]);
      modified += upd.modifiedCount ?? 0;
    }
    for (const rfqId of affectedRfqs) {
      const [agg] = await this.db()
        .collection('connect_quotes')
        .aggregate<{ low: number }>([
          { $match: { rfqId, status: { $in: LIVE_QUOTE_STATUSES }, isDemo: { $ne: true } } },
          { $group: { _id: null, low: { $min: '$price' } } },
        ])
        .toArray();
      await this.db()
        .collection('connect_rfqs')
        .updateOne({ _id: rfqId }, { $set: { lowestQuotePrice: agg?.low ?? null } });
    }
    return { deleted: res.deletedCount ?? 0, modified };
  }

  /**
   * Delete the applicant's job applications (b-out) and decrement each counterpart
   * Job.applicationsCount (one application per job per applicant — unique index).
   */
  private async purgeJobApplications(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const apps = await this.db()
      .collection('connect_job_applications')
      .find({ applicantUserId: uid }, { projection: { jobId: 1 } })
      .toArray();
    const jobIds = this.distinctIds(apps.map((a) => a.jobId as Types.ObjectId));
    const res = await this.db()
      .collection('connect_job_applications')
      .deleteMany({ applicantUserId: uid });
    let modified = 0;
    if (jobIds.length > 0) {
      const upd = await this.db()
        .collection('connect_jobs')
        .updateMany(
          { _id: { $in: jobIds }, applicationsCount: { $gt: 0 } },
          { $inc: { applicationsCount: -1 } },
        );
      modified = upd.modifiedCount ?? 0;
    }
    return { deleted: res.deletedCount ?? 0, modified };
  }

  /** Delete the user's job-view markers and decrement each counterpart Job.views. */
  private async purgeJobViews(uid: Types.ObjectId): Promise<{ deleted: number; modified: number }> {
    const views = await this.db()
      .collection('connect_job_views')
      .find({ viewerId: uid }, { projection: { jobId: 1 } })
      .toArray();
    const jobIds = this.distinctIds(views.map((v) => v.jobId as Types.ObjectId));
    const res = await this.db().collection('connect_job_views').deleteMany({ viewerId: uid });
    let modified = 0;
    if (jobIds.length > 0) {
      const upd = await this.db()
        .collection('connect_jobs')
        .updateMany({ _id: { $in: jobIds }, views: { $gt: 0 } }, { $inc: { views: -1 } });
      modified = upd.modifiedCount ?? 0;
    }
    return { deleted: res.deletedCount ?? 0, modified };
  }

  /**
   * Delete the reviews the user WROTE (b-out) and recompute each reviewed
   * subject's SellerRating from their remaining active reviews. Reviews ABOUT the
   * user (subjectUserId) are retained (b-about). KEEP IN SYNC with
   * ReviewService.computeAndPersistAggregate.
   */
  private async purgeReviews(uid: Types.ObjectId): Promise<{ deleted: number; modified: number }> {
    const written = await this.db()
      .collection('connect_reviews')
      .find({ reviewerUserId: uid }, { projection: { subjectUserId: 1 } })
      .toArray();
    const subjects = this.distinctIds(written.map((r) => r.subjectUserId as Types.ObjectId));
    const res = await this.db().collection('connect_reviews').deleteMany({ reviewerUserId: uid });
    let modified = 0;
    for (const subject of subjects) {
      const rows = await this.db()
        .collection('connect_reviews')
        .find({ subjectUserId: subject, status: 'active' }, { projection: { rating: 1 } })
        .toArray();
      modified += await this.persistRating(
        'connect_seller_ratings',
        'subjectUserId',
        subject,
        rows,
      );
    }
    return { deleted: res.deletedCount ?? 0, modified };
  }

  /**
   * Delete the broker reviews the user WROTE (b-out) and recompute each broker's
   * BrokerRating from their remaining active reviews. Reviews ABOUT the user as
   * broker are retained (anonymous third-party). KEEP IN SYNC with
   * BrokerReviewService.computeAndPersistAggregate (counts active, non-deleted).
   */
  private async purgeBrokerReviews(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const written = await this.db()
      .collection('connect_broker_reviews')
      .find({ reviewerUserId: uid }, { projection: { brokerUserId: 1 } })
      .toArray();
    const brokers = this.distinctIds(written.map((r) => r.brokerUserId as Types.ObjectId));
    const res = await this.db()
      .collection('connect_broker_reviews')
      .deleteMany({ reviewerUserId: uid });
    let modified = 0;
    for (const broker of brokers) {
      const rows = await this.db()
        .collection('connect_broker_reviews')
        .find(
          { brokerUserId: broker, status: 'active', deletedAt: { $in: [null, undefined] } },
          { projection: { rating: 1 } },
        )
        .toArray();
      modified += await this.persistRating('connect_broker_ratings', 'brokerUserId', broker, rows);
    }
    return { deleted: res.deletedCount ?? 0, modified };
  }

  /**
   * Recompute + persist a Wilson rating aggregate from a subject's remaining
   * rating rows. Shared by the seller + broker recompute. KEEP IN SYNC with
   * Review/BrokerReview computeAndPersistAggregate (count/avg/positive/wilson).
   */
  private async persistRating(
    ratingCollection: string,
    subjectField: string,
    subject: Types.ObjectId,
    rows: Array<{ rating?: number }>,
  ): Promise<number> {
    const count = rows.length;
    const sum = rows.reduce((s, r) => s + (r.rating ?? 0), 0);
    const positive = rows.filter((r) => (r.rating ?? 0) >= POSITIVE_THRESHOLD).length;
    const ratingAvg = count === 0 ? 0 : Math.round((sum / count) * 10) / 10;
    const upd = await this.db()
      .collection(ratingCollection)
      .updateOne(
        { [subjectField]: subject },
        {
          $set: {
            ratingCount: count,
            ratingAvg,
            positiveCount: positive,
            wilsonScore: this.wilson(positive, count),
          },
        },
        { upsert: true },
      );
    return (upd.modifiedCount ?? 0) + (upd.upsertedCount ?? 0);
  }

  /** Wilson lower bound at z=1.96. KEEP IN SYNC with ReviewService.wilson. */
  private wilson(positive: number, n: number): number {
    if (n === 0) return 0;
    const p = positive / n;
    const z2 = WILSON_Z * WILSON_Z;
    const denom = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const margin = WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return (centre - margin) / denom;
  }

  /**
   * Delete the user's per-day view markers and decrement each viewed target's
   * ConnectViewDaily count (the user's contribution to OTHER targets' totals),
   * plus drop inbound markers that target the user's own profile. The user's own
   * inbound ConnectViewDaily rollups are deleted by the connect_view_daily entry.
   */
  private async purgeViewsSeen(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const seen = await this.db()
      .collection('connect_view_seen')
      .find({ viewerUserId: uid }, { projection: { targetType: 1, targetId: 1, date: 1 } })
      .toArray();
    let modified = 0;
    for (const s of seen) {
      const upd = await this.db()
        .collection('connect_view_daily')
        .updateOne(
          { targetType: s.targetType, targetId: s.targetId, date: s.date, count: { $gt: 0 } },
          { $inc: { count: -1 } },
        );
      modified += upd.modifiedCount ?? 0;
    }
    const own = await this.db().collection('connect_view_seen').deleteMany({ viewerUserId: uid });
    // Inbound markers (others viewed the user's profile) reference the user too.
    const inbound = await this.db()
      .collection('connect_view_seen')
      .deleteMany({ targetType: 'profile', targetId: uid });
    return { deleted: (own.deletedCount ?? 0) + (inbound.deletedCount ?? 0), modified };
  }

  /**
   * CN-PURGE-1 (Bucket 2) — stop the user's in-flight boost campaigns and
   * FORFEIT their unspent reserve. Campaign rows are RETAINED (billing evidence,
   * `klass:'billing'`); this only mutates their state. FORFEIT (owner decision
   * OQ-2, 2026-07-02): the account is gone, so the unspent budget is destroyed,
   * not refunded — we decrement `ad_advertiser_wallets.reserved` by the unspent
   * amount with NO balance/grant credit, write a `type:'forfeit'` ledger row for
   * the paper trail (mirroring WalletService.forfeitReserve, re-implemented here
   * against the raw collection since this service is deliberately OFF the Connect
   * DI graph — see the class header), and mark the campaign completed with
   * budgetSpent bumped to totalBudget (so no money reads as leftover either).
   *
   * Idempotent: the `status` filter excludes already-completed campaigns, and the
   * wallet decrement is guarded (`reserved: {$gte: unspent}`), so a redundant
   * purge run never double-forfeits or writes a second ledger row.
   */
  private async purgeAdsForUser(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const campaigns = await this.db()
      .collection('ad_campaigns')
      .find(
        { ownerUserId: uid, status: { $in: ['active', 'pending_review', 'paused'] } },
        {
          projection: {
            reservedFromGrant: 1,
            reservedFromBalance: 1,
            totalBudget: 1,
            budgetSpent: 1,
          },
        },
      )
      .toArray();

    let modified = 0;
    for (const c of campaigns) {
      // Prefer the CN-ADS-1 tracked reserve; fall back to budget-derived for
      // pre-field campaigns (backfilled to 0/0 but still holding a reserve).
      const tracked = (c.reservedFromGrant ?? 0) + (c.reservedFromBalance ?? 0);
      const fallback = Math.max(0, (c.totalBudget ?? 0) - (c.budgetSpent ?? 0));
      const unspent = tracked > 0 ? tracked : fallback;

      if (unspent > 0) {
        // Free the hold with NO credit back (forfeit). Guarded so reserved can
        // never go negative; a miss (already freed) simply skips the ledger row.
        const walletUpd = await this.db()
          .collection('ad_advertiser_wallets')
          .findOneAndUpdate(
            { ownerUserId: uid, reserved: { $gte: unspent } },
            { $inc: { reserved: -unspent } },
            { returnDocument: 'after' },
          );
        // `findOneAndUpdate` result shape differs across driver versions; read the
        // post-doc defensively (raw driver returns the doc directly here).
        const walletDoc =
          (walletUpd as { value?: Record<string, unknown> } | null)?.value ??
          (walletUpd as Record<string, unknown> | null);
        if (walletDoc) {
          await this.db()
            .collection('ad_wallet_ledgers')
            .insertOne({
              ownerUserId: uid,
              type: 'forfeit',
              amount: -unspent,
              // balance is unchanged by a forfeit; reserved is the post-decrement value.
              balanceAfter: (walletDoc.balance as number) ?? 0,
              reservedAfter: (walletDoc.reserved as number) ?? 0,
              campaignId: c._id as Types.ObjectId,
              note: 'account purge: unspent boost budget forfeited (post hard-deleted)',
              createdAt: new Date(),
              updatedAt: new Date(),
            });
        }
      }

      // Mark completed + fully-spent so the campaign's own numbers stay consistent
      // (no leftover budget on the campaign side either).
      const campUpd = await this.db()
        .collection('ad_campaigns')
        .updateOne(
          { _id: c._id },
          {
            $set: {
              status: 'completed',
              budgetSpent: c.totalBudget ?? 0,
              reservedFromGrant: 0,
              reservedFromBalance: 0,
            },
          },
        );
      modified += campUpd.modifiedCount ?? 0;
    }
    // No hard delete — campaigns are billing-retained rows; only state changed.
    return { deleted: 0, modified };
  }

  /**
   * CN-PURGE-3 (Bucket 10) — hard-delete the user's own RFQs AND cascade-delete
   * the third-party rows left orphaned by the gone RFQ: OTHERS' quotes keyed on
   * those RFQ ids (mirrors purgeFeedPosts: capture parent ids first, then cascade,
   * then delete the parents). NOTE: `connect_view_daily` has NO rfq target type
   * (only storefront/listing/profile), so there are no view rollups to clean for
   * an RFQ — the audit's "view_daily rollups targeting those RFQs" does not apply
   * to this schema (documented drift; see the harden report).
   */
  private async purgeRfqOrphans(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const rfqs = await this.db()
      .collection('connect_rfqs')
      .find({ buyerUserId: uid }, { projection: { _id: 1 } })
      .toArray();
    const rfqIds = rfqs.map((r) => r._id as Types.ObjectId);
    if (rfqIds.length === 0) return { deleted: 0, modified: 0 };

    // Cascade: OTHERS' quotes on the now-gone RFQs (the seller-side own-quote
    // purge is handled separately by the 'rfq-quotes' handler; this is the
    // inverse — quotes orphaned because the BUYER's RFQ vanished).
    const quotes = await this.db()
      .collection('connect_quotes')
      .deleteMany({ rfqId: { $in: rfqIds } });
    const own = await this.db()
      .collection('connect_rfqs')
      .deleteMany({ _id: { $in: rfqIds } });
    return { deleted: (own.deletedCount ?? 0) + (quotes.deletedCount ?? 0), modified: 0 };
  }

  /**
   * CN-PURGE-3 — hard-delete the user's own jobs, de-index them, AND cascade-
   * delete the third-party rows orphaned by the gone job: OTHERS' applications +
   * saved-job rows + job-view markers keyed on those job ids. Mirrors
   * purgeFeedPosts (capture ids, cascade, delete parents, emit de-index).
   */
  private async purgeJobOrphans(
    uid: Types.ObjectId,
  ): Promise<{ deleted: number; modified: number }> {
    const jobs = await this.db()
      .collection('connect_jobs')
      .find({ companyUserId: uid }, { projection: { _id: 1 } })
      .toArray();
    const jobIds = jobs.map((j) => j._id as Types.ObjectId);
    if (jobIds.length === 0) return { deleted: 0, modified: 0 };

    const inJobs = { jobId: { $in: jobIds } };
    const [apps, saves, views] = await Promise.all([
      this.db().collection('connect_job_applications').deleteMany(inJobs),
      this.db().collection('connect_saved_jobs').deleteMany(inJobs),
      this.db().collection('connect_job_views').deleteMany(inJobs),
    ]);
    const own = await this.db()
      .collection('connect_jobs')
      .deleteMany({ _id: { $in: jobIds } });
    // De-index each gone job (the handler owns this now that the manifest row is
    // handler-driven and no longer carries deindexAfter).
    this.deindex('job', jobIds, uid);
    return {
      deleted:
        (own.deletedCount ?? 0) +
        (apps.deletedCount ?? 0) +
        (saves.deletedCount ?? 0) +
        (views.deletedCount ?? 0),
      modified: 0,
    };
  }

  // ── search de-index (§3A.f) ─────────────────────────────────────────────────

  /** Signal the search indexer to drop the now-deleted entities. */
  private deindex(
    kind: NonNullable<ConnectPurgeEntry['deindexAfter']>,
    ids: Types.ObjectId[],
    uid: Types.ObjectId,
  ): void {
    switch (kind) {
      case 'profile':
        // The people index is keyed on userId, not the profile _id.
        this.emit(CONNECT_PROFILE_CHANGED, { userId: String(uid) });
        break;
      case 'listing':
        for (const id of ids) this.emit(CONNECT_LISTING_CHANGED, { listingId: String(id) });
        break;
      case 'job':
        for (const id of ids)
          this.emit(CONNECT_JOB_CHANGED, { jobId: String(id), change: 'closed' });
        break;
      case 'company-page':
        for (const id of ids)
          this.emit(CONNECT_COMPANY_PAGE_CHANGED, { companyPageId: String(id) });
        break;
      case 'storefront':
        for (const id of ids) this.emit(CONNECT_STOREFRONT_CHANGED, { storefrontId: String(id) });
        break;
    }
  }

  /** Fire-and-forget emit, guarded so a synchronous listener throw never aborts
   *  the purge (the search write is async + the DB delete already committed). */
  private emit(event: string, payload: unknown): void {
    try {
      this.eventEmitter.emit(event, payload);
    } catch (err) {
      this.logger.warn(
        `[deindex] emit ${event} failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /** De-duplicate a list of ObjectIds (by hex). */
  private distinctIds(ids: Types.ObjectId[]): Types.ObjectId[] {
    const seen = new Set<string>();
    const out: Types.ObjectId[] = [];
    for (const id of ids) {
      const hex = String(id);
      if (!seen.has(hex)) {
        seen.add(hex);
        out.push(id);
      }
    }
    return out;
  }
}
