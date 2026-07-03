import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { LIST_HARD_CAP } from '../common/keyset-cursor';
import { ConnectionRequest } from './schemas/connection-request.schema';
import { Connection } from './schemas/connection.schema';
import { Follow } from './schemas/follow.schema';
import { User } from '../../users/schemas/user.schema';
import type { ConnectionRequestAction, InvitationBox } from './dto/network.dto';
import { NotificationsService } from '../../notifications/notifications.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { FEED_FANOUT_QUEUE } from '../feed/feed.constants';
import type { FeedFanoutJobData } from '../feed/feed.service';

/**
 * BullMQ options for the connect-accept feed-backfill jobs — bounded retries +
 * auto-cleanup so the queue never accretes completed/failed job records (the
 * memory/resource-management contract for Connect background work).
 */
const FEED_BACKFILL_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 200,
};

/** One entry in a user's connection list — the other person + when it formed. */
export interface ConnectionSummary {
  /** The connected `User`'s id (the viewer is the implicit other end). */
  userId: string;
  /** When the connection formed. */
  since: Date;
}

/** Mutual-connection result between a viewer and a target. */
export interface MutualConnections {
  count: number;
  /** The ids of the `User`s connected to BOTH the viewer and the target. */
  userIds: string[];
}

/** The viewer's relationship to a target `User` — drives profile-page CTAs. */
export interface RelationshipState {
  /** An accepted `Connection` exists between the two. */
  connected: boolean;
  /** The target has a pending request awaiting the viewer's response. */
  incomingRequest: boolean;
  /** The viewer has a pending request awaiting the target's response. */
  outgoingRequest: boolean;
  /** The viewer follows the target. */
  following: boolean;
  /** The viewer IS the target — viewing one's own profile; no actions apply. */
  self: boolean;
  /** The pending INCOMING request's id when `incomingRequest` (else null) —
   *  lets the profile Accept / Ignore the request inline. */
  incomingRequestId: string | null;
  /** The pending OUTGOING request's id when `outgoingRequest` (else null) —
   *  lets the viewer Withdraw the request from the profile. */
  outgoingRequestId: string | null;
}

/** Network badge counts for the caller. */
export interface NetworkCounts {
  /** Incoming connection requests awaiting the caller's response. */
  pendingRequests: number;
  connections: number;
  /** People the caller follows (outbound follow edges). */
  following: number;
  /** People who follow the caller (inbound follow edges). */
  followers: number;
}

/**
 * `NetworkService` — the Connect professional-graph mechanics (Phase 2).
 *
 * Connections are symmetric + consented (request → accept); follows are
 * asymmetric + instant. Mongo adjacency, no graph DB. A `Connection` is stored
 * once as a canonical ordered pair (`Connection` schema doc-comment).
 *
 * All writes throw typed Nest exceptions on a guard violation — unlike
 * `ErpLinkService` (a trust *enhancement* that degrades silently), the network
 * graph is core data and a bad write must surface, not be swallowed.
 */
@Injectable()
export class NetworkService {
  private readonly tracer = trace.getTracer('connect.network');

  constructor(
    @InjectModel(ConnectionRequest.name)
    private readonly connectionRequestModel: Model<ConnectionRequest>,
    @InjectModel(Connection.name)
    private readonly connectionModel: Model<Connection>,
    @InjectModel(Follow.name)
    private readonly followModel: Model<Follow>,
    // Read-only — backs the demo↔real cross-gate on connect/follow. The User
    // model is provided here via ConnectProfileModule's re-exported MongooseModule
    // (same source SuggestionService reads for the live-owner guard).
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly notificationsService: NotificationsService,
    @InjectQueue(FEED_FANOUT_QUEUE)
    private readonly feedQueue: Queue<FeedFanoutJobData>,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /**
   * Best-effort notification dispatch — Phase 7a wired the central pipeline.
   * Network writes succeed independently; a notification failure is logged
   * + Sentry-captured inside `dispatch` and never blocks the primary write.
   */
  private async notify(
    category:
      | 'connect.connection_requested'
      | 'connect.connection_accepted'
      | 'connect.followed'
      | 'connect.page_followed',
    recipientId: Types.ObjectId | string,
    actorId: Types.ObjectId | string,
    entityType: string,
    entityId: string,
    title: string,
    message: string,
  ): Promise<void> {
    await this.notificationsService
      .dispatch({
        recipientId,
        actorId,
        category,
        entityType,
        entityId,
        title,
        message,
      })
      .catch(() => undefined);
  }

  // ── Demo isolation ─────────────────────────────────────────────────────

  /**
   * Block a graph edge (connect request / follow) between a seeded sample
   * account and a real user, in EITHER direction. Demo↔demo and real↔real are
   * allowed. The marker mirrors the rest of Connect (jobs.service / ad-repos):
   * `User.isDemo` OR an `@connect-demo.zari360.test` email. One batched query
   * resolves both parties. Friendly `ForbiddenException` on a cross attempt.
   * Cross-module: reads User.
   */
  private async assertNoDemoCross(
    a: Types.ObjectId,
    b: Types.ObjectId,
    action: 'connect' | 'follow',
  ): Promise<void> {
    const rows = await this.userModel
      .find({ _id: { $in: [a, b] } })
      .select('_id isDemo email')
      .lean<Array<{ _id: Types.ObjectId; isDemo?: boolean; email?: string }>>()
      .exec();
    const isDemo = (id: Types.ObjectId): boolean => {
      const u = rows.find((r) => r._id.equals(id));
      return !!u && (u.isDemo === true || (u.email ?? '').endsWith('@connect-demo.zari360.test'));
    };
    const aDemo = isDemo(a);
    const bDemo = isDemo(b);
    if (aDemo !== bDemo) {
      const verb = action === 'connect' ? 'connect with' : 'follow';
      throw new ForbiddenException(
        `This is a sample profile shown as an example, so you cannot ${verb} it.`,
      );
    }
  }

  // ── Connection requests ────────────────────────────────────────────────

  /**
   * Send a connection request. Guards: no self-request, no request when the
   * pair is already connected, no second pending request in either direction.
   */
  async sendRequest(
    fromUserId: string | Types.ObjectId,
    toUserId: string | Types.ObjectId,
    note?: string,
  ): Promise<ConnectionRequest> {
    return this.withSpan('connect.network.sendRequest', {}, async () => {
      const from = this.toObjectId(fromUserId);
      const to = this.toObjectId(toUserId);
      if (from.equals(to)) {
        throw new BadRequestException('You cannot send a connection request to yourself.');
      }

      // Demo isolation — a sample account and a real user can't connect (either way).
      await this.assertNoDemoCross(from, to, 'connect');

      const { userA, userB } = this.sortedPair(from, to);
      const alreadyConnected = await this.connectionModel.findOne({ userA, userB }).lean().exec();
      if (alreadyConnected) {
        throw new BadRequestException('You are already connected with this person.');
      }

      const pending = await this.connectionRequestModel
        .findOne({
          status: 'pending',
          $or: [
            { fromUserId: from, toUserId: to },
            { fromUserId: to, toUserId: from },
          ],
        })
        .lean()
        .exec();
      if (pending) {
        throw new BadRequestException('A connection request between you two is already pending.');
      }

      const trimmed = note?.trim();
      const created = await this.connectionRequestModel.create({
        fromUserId: from,
        toUserId: to,
        status: 'pending',
        note: trimmed ? trimmed : null,
      });
      // Best-effort fan-out — the recipient's bell + notifications center
      // light up in realtime via the in-platform channel.
      void this.notify(
        'connect.connection_requested',
        to,
        from,
        'ConnectionRequest',
        String(created._id),
        'New connection request',
        trimmed ? trimmed : 'Wants to connect with you.',
      );
      return created;
    });
  }

  /**
   * Accept or ignore a pending request. Only the recipient may respond.
   * Accepting creates the symmetric `Connection` (idempotently).
   */
  async respondToRequest(
    userId: string | Types.ObjectId,
    requestId: string,
    action: ConnectionRequestAction,
  ): Promise<ConnectionRequest> {
    return this.withSpan('connect.network.respondToRequest', { action }, async () => {
      const me = this.toObjectId(userId);
      const request = await this.connectionRequestModel.findById(this.toObjectId(requestId)).exec();
      if (!request) {
        throw new NotFoundException('Connection request not found.');
      }
      if (!(request.toUserId as Types.ObjectId).equals(me)) {
        throw new ForbiddenException('Only the recipient can respond to this request.');
      }
      if (request.status !== 'pending') {
        throw new BadRequestException('This request has already been answered.');
      }

      request.status = action === 'accept' ? 'accepted' : 'ignored';
      request.respondedAt = new Date();
      await request.save();

      if (action === 'accept') {
        const { userA, userB } = this.sortedPair(
          request.fromUserId as Types.ObjectId,
          request.toUserId as Types.ObjectId,
        );
        const existing = await this.connectionModel.findOne({ userA, userB }).lean().exec();
        if (!existing) {
          await this.connectionModel.create({ userA, userB, since: new Date() });
        }
        // Connect implies a MUTUAL follow. Feed fan-out is follower-based
        // (`FeedFanoutProcessor` writes to `listFollowerIds`), so without this
        // two connected members would never see each other's posts. Created
        // SILENTLY via `ensureFollow` (not `followUser`) — the
        // `connection_accepted` notification below already covers the event;
        // emitting `connect.followed` too would double-notify. Idempotent, so a
        // pre-existing follow (e.g. they already followed before connecting) is
        // a no-op.
        await Promise.all([
          this.ensureFollow(
            request.fromUserId as Types.ObjectId,
            request.toUserId as Types.ObjectId,
          ),
          this.ensureFollow(
            request.toUserId as Types.ObjectId,
            request.fromUserId as Types.ObjectId,
          ),
        ]);
        // Backfill each peer's recent posts into the other's feed. Fan-out is
        // write-time, so a post made BEFORE the connection existed would never
        // reach the new follower — this closes that gap. Queued (retried, off
        // the request thread); a backfill failure never blocks the accept.
        const fromId = String(request.fromUserId);
        const toId = String(request.toUserId);
        await Promise.all([
          this.feedQueue.add(
            'backfill',
            { kind: 'backfill', ownerId: fromId, authorId: toId },
            FEED_BACKFILL_JOB_OPTS,
          ),
          this.feedQueue.add(
            'backfill',
            { kind: 'backfill', ownerId: toId, authorId: fromId },
            FEED_BACKFILL_JOB_OPTS,
          ),
        ]);
        // Notify the original sender that their request was accepted.
        void this.notify(
          'connect.connection_accepted',
          request.fromUserId as Types.ObjectId,
          me,
          'ConnectionRequest',
          String(request._id),
          'Connection request accepted',
          'You are now connected.',
        );
      }
      return request;
    });
  }

  /** Withdraw a pending request. Only the sender may withdraw. */
  async withdrawRequest(
    userId: string | Types.ObjectId,
    requestId: string,
  ): Promise<ConnectionRequest> {
    return this.withSpan('connect.network.withdrawRequest', {}, async () => {
      const me = this.toObjectId(userId);
      const request = await this.connectionRequestModel.findById(this.toObjectId(requestId)).exec();
      if (!request) {
        throw new NotFoundException('Connection request not found.');
      }
      if (!(request.fromUserId as Types.ObjectId).equals(me)) {
        throw new ForbiddenException('Only the sender can withdraw this request.');
      }
      if (request.status !== 'pending') {
        throw new BadRequestException('This request can no longer be withdrawn.');
      }
      request.status = 'withdrawn';
      request.respondedAt = new Date();
      await request.save();
      return request;
    });
  }

  /**
   * List the caller's invitations. `received` / `sent` → pending requests in
   * that direction; `archive` → all answered (non-pending) requests touching
   * the caller. Newest first.
   */
  async listInvitations(
    userId: string | Types.ObjectId,
    box: InvitationBox = 'received',
  ): Promise<ConnectionRequest[]> {
    const me = this.toObjectId(userId);
    const filter =
      box === 'received'
        ? { toUserId: me, status: 'pending' }
        : box === 'sent'
          ? { fromUserId: me, status: 'pending' }
          : { status: { $ne: 'pending' }, $or: [{ fromUserId: me }, { toUserId: me }] };
    return (
      this.connectionRequestModel
        .find(filter)
        .sort({ createdAt: -1 })
        // Controller-only read -> a flat DoS backstop. Invitations rarely pile up,
        // but a hostile inbox should never return an unbounded list.
        .limit(LIST_HARD_CAP)
        .lean<ConnectionRequest[]>()
        .exec()
    );
  }

  // ── Connections ────────────────────────────────────────────────────────

  /**
   * The caller's connections — the other person + when each formed. `opts.limit`
   * bounds the read for the HTTP endpoint (the controller passes `LIST_HARD_CAP`);
   * INTERNAL callers (feed visibility gating + fan-out) omit it and still get the
   * full set, since they must consider every connection. Newest first.
   */
  async listConnections(
    userId: string | Types.ObjectId,
    opts: { limit?: number } = {},
  ): Promise<ConnectionSummary[]> {
    const me = this.toObjectId(userId);
    const query = this.connectionModel.find({ $or: [{ userA: me }, { userB: me }] }).sort({
      since: -1,
    });
    if (opts.limit !== undefined) query.limit(opts.limit);
    const rows = await query
      .lean<Array<{ userA: Types.ObjectId; userB: Types.ObjectId; since: Date }>>()
      .exec();
    return rows.map((row) => ({
      userId: String(row.userA.equals(me) ? row.userB : row.userA),
      since: row.since,
    }));
  }

  /** Remove a connection. Idempotency is not implied — a missing edge 404s. */
  async removeConnection(userId: string | Types.ObjectId, otherUserId: string): Promise<void> {
    return this.withSpan('connect.network.removeConnection', {}, async () => {
      const me = this.toObjectId(userId);
      const other = this.toObjectId(otherUserId);
      if (me.equals(other)) {
        throw new BadRequestException('Invalid connection.');
      }
      const { userA, userB } = this.sortedPair(me, other);
      const result = await this.connectionModel.deleteOne({ userA, userB }).exec();
      if (result.deletedCount === 0) {
        throw new NotFoundException('You are not connected with this person.');
      }
    });
  }

  /**
   * Mutual connections between the viewer and a target — the `User`s connected
   * to both. Powers the "N mutual connections" line on people cards.
   */
  async mutualConnections(
    viewerId: string | Types.ObjectId,
    targetId: string | Types.ObjectId,
  ): Promise<MutualConnections> {
    return this.withSpan('connect.network.mutualConnections', {}, async () => {
      const viewer = this.toObjectId(viewerId);
      const target = this.toObjectId(targetId);
      const [viewerConns, targetConns] = await Promise.all([
        this.connectionUserIds(viewer),
        this.connectionUserIds(target),
      ]);
      const targetSet = new Set(targetConns);
      const userIds = viewerConns.filter((id) => targetSet.has(id));
      return { count: userIds.length, userIds };
    });
  }

  /** The viewer's relationship to a target `User`. */
  async getRelationship(
    viewerId: string | Types.ObjectId,
    targetId: string | Types.ObjectId,
  ): Promise<RelationshipState> {
    const viewer = this.toObjectId(viewerId);
    const target = this.toObjectId(targetId);
    if (viewer.equals(target)) {
      return {
        connected: false,
        incomingRequest: false,
        outgoingRequest: false,
        following: false,
        self: true,
        incomingRequestId: null,
        outgoingRequestId: null,
      };
    }
    const { userA, userB } = this.sortedPair(viewer, target);
    const [connection, incoming, outgoing, follow] = await Promise.all([
      this.connectionModel.findOne({ userA, userB }).lean().exec(),
      this.connectionRequestModel
        .findOne({ fromUserId: target, toUserId: viewer, status: 'pending' })
        .lean()
        .exec(),
      this.connectionRequestModel
        .findOne({ fromUserId: viewer, toUserId: target, status: 'pending' })
        .lean()
        .exec(),
      this.followModel
        .findOne({ followerId: viewer, followeeType: 'user', followeeId: target })
        .lean()
        .exec(),
    ]);
    return {
      connected: connection !== null,
      incomingRequest: incoming !== null,
      outgoingRequest: outgoing !== null,
      following: follow !== null,
      self: false,
      incomingRequestId: incoming ? String(incoming._id) : null,
      outgoingRequestId: outgoing ? String(outgoing._id) : null,
    };
  }

  // ── Follows ────────────────────────────────────────────────────────────

  /**
   * Follow a `User` (asymmetric, instant, idempotent). Phase 2 follows are
   * always `followeeType: 'user'` — Company Pages arrive in Phase 6.
   */
  /**
   * Idempotently create a follow edge WITHOUT notifying. Returns whether a NEW
   * edge was created, so the caller decides whether to fire `connect.followed`:
   *  - a MANUAL follow (the Follow button → `followUser`) notifies;
   *  - a connection-IMPLIED follow (created on accept) stays SILENT — the
   *    `connection_accepted` notification already covers that event, so a
   *    second `connect.followed` would be a duplicate.
   * Callers guarantee `follower !== followee` (sendRequest blocks self-requests
   * and `followUser` guards self-follow).
   */
  private async ensureFollow(
    follower: Types.ObjectId,
    followee: Types.ObjectId,
    followeeType: 'user' | 'companyPage' = 'user',
  ): Promise<{ follow: Follow; created: boolean }> {
    // Defensive: never create a self-follow edge, even if a malformed self
    // connection request reached the accept path (sendRequest guards this too).
    if (followeeType === 'user' && follower.equals(followee)) {
      throw new BadRequestException('You cannot follow yourself.');
    }
    // ATOMIC upsert — a single round-trip closes the findOne-then-create race
    // where a concurrent feed fan-out (`listFollowerIds`) could observe a
    // half-written follow edge and drop a recipient. The unique
    // { followerId, followeeType, followeeId } index is the backstop.
    const filter = { followerId: follower, followeeType, followeeId: followee };
    const res = await this.followModel
      .findOneAndUpdate(
        filter,
        { $setOnInsert: filter },
        { upsert: true, new: true, includeResultMetadata: true },
      )
      .exec();
    // `updatedExisting === false` ⇒ this call performed the insert (new edge),
    // so the caller fires `connect.followed`; a matched existing edge stays silent.
    const created = res.lastErrorObject?.updatedExisting === false;
    return { follow: res.value, created };
  }

  async followUser(followerId: string | Types.ObjectId, followeeUserId: string): Promise<Follow> {
    return this.withSpan('connect.network.followUser', {}, async () => {
      const follower = this.toObjectId(followerId);
      const followee = this.toObjectId(followeeUserId);
      if (follower.equals(followee)) {
        throw new BadRequestException('You cannot follow yourself.');
      }
      // Demo isolation — a sample account and a real user can't follow (either way).
      await this.assertNoDemoCross(follower, followee, 'follow');
      const { follow, created } = await this.ensureFollow(follower, followee);
      // Manual, deliberate follow → notify the followee. (The accept path calls
      // `ensureFollow` directly and stays silent.)
      if (created) {
        void this.notify(
          'connect.followed',
          followee,
          follower,
          'Follow',
          String(follow._id),
          'New follower',
          'Started following you.',
        );
      }
      return follow;
    });
  }

  /** Unfollow a `User`. A missing follow edge 404s. */
  async unfollowUser(followerId: string | Types.ObjectId, followeeUserId: string): Promise<void> {
    return this.withSpan('connect.network.unfollowUser', {}, async () => {
      const result = await this.followModel
        .deleteOne({
          followerId: this.toObjectId(followerId),
          followeeType: 'user',
          followeeId: this.toObjectId(followeeUserId),
        })
        .exec();
      if (result.deletedCount === 0) {
        throw new NotFoundException('You are not following this person.');
      }
      // Drop the ex-followee's posts from the unfollower's feed (the "new enemy"
      // cleanup). Queued off the request thread on the shared feed queue, so a
      // GC failure never blocks the unfollow; the 180-day TTL is the backstop.
      await this.feedQueue.add(
        'gc',
        { kind: 'gc', ownerId: String(followerId), authorId: String(followeeUserId) },
        FEED_BACKFILL_JOB_OPTS,
      );
    });
  }

  // ── Company page follows ───────────────────────────────────────────────

  /**
   * Follow a company page. `ownerUserId` (the page owner, resolved by the caller
   * from `CompanyPageService`) gates self-follow and receives the notification.
   */
  async followCompanyPage(
    followerId: string | Types.ObjectId,
    companyPageId: string,
    ownerUserId: string | Types.ObjectId,
  ): Promise<Follow> {
    return this.withSpan('connect.network.followCompanyPage', {}, async () => {
      const follower = this.toObjectId(followerId);
      const owner = this.toObjectId(ownerUserId);
      if (follower.equals(owner)) {
        throw new BadRequestException('You cannot follow your own page.');
      }
      const page = this.toObjectId(companyPageId);
      const { follow, created } = await this.ensureFollow(follower, page, 'companyPage');
      if (created) {
        void this.notify(
          'connect.page_followed',
          owner,
          follower,
          'CompanyPage',
          String(page),
          'New page follower',
          'Started following your page.',
        );
        this.posthog?.capture({
          distinctId: String(follower),
          event: 'connect.page_followed',
          properties: { companyPageId: String(page), ownerUserId: String(owner) },
        });
      }
      return follow;
    });
  }

  /** Unfollow a company page. A missing follow edge 404s. */
  async unfollowCompanyPage(
    followerId: string | Types.ObjectId,
    companyPageId: string,
  ): Promise<void> {
    return this.withSpan('connect.network.unfollowCompanyPage', {}, async () => {
      const result = await this.followModel
        .deleteOne({
          followerId: this.toObjectId(followerId),
          followeeType: 'companyPage',
          followeeId: this.toObjectId(companyPageId),
        })
        .exec();
      if (result.deletedCount === 0) {
        throw new NotFoundException('You are not following this page.');
      }
    });
  }

  /** Whether the caller follows the given company page. */
  async isFollowingCompanyPage(
    followerId: string | Types.ObjectId,
    companyPageId: string,
  ): Promise<boolean> {
    const row = await this.followModel
      .findOne({
        followerId: this.toObjectId(followerId),
        followeeType: 'companyPage',
        followeeId: this.toObjectId(companyPageId),
      })
      .select('_id')
      .lean<{ _id: Types.ObjectId } | null>()
      .exec();
    return row !== null;
  }

  /** How many members follow the given company page. */
  async countCompanyPageFollowers(companyPageId: string | Types.ObjectId): Promise<number> {
    return this.followModel
      .countDocuments({ followeeType: 'companyPage', followeeId: this.toObjectId(companyPageId) })
      .exec();
  }

  /**
   * Everything the caller follows, newest first. `opts.limit` bounds the read for
   * the HTTP endpoint (the controller passes `LIST_HARD_CAP`); the INTERNAL
   * discovery caller (network-out source) omits it to weigh every follow.
   */
  async listFollowing(
    userId: string | Types.ObjectId,
    opts: { limit?: number } = {},
  ): Promise<Follow[]> {
    const query = this.followModel
      .find({ followerId: this.toObjectId(userId) })
      .sort({ createdAt: -1 });
    if (opts.limit !== undefined) query.limit(opts.limit);
    return query.lean<Follow[]>().exec();
  }

  /** Everyone who follows the caller (inbound user-follow edges), newest first.
   *  Each row's `followerId` is the follower; the web hydrates that id. Controller-
   *  only read, so a flat DoS backstop keeps a hub user's follower list bounded
   *  (the accurate total comes from the separate `/counts` endpoint). */
  async listFollowers(userId: string | Types.ObjectId): Promise<Follow[]> {
    return this.followModel
      .find({ followeeType: 'user', followeeId: this.toObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(LIST_HARD_CAP)
      .lean<Follow[]>()
      .exec();
  }

  /**
   * The ids of every `User` who follows the given user — the fan-out audience
   * for that user's feed posts (Phase 3 — Feed). Served by the `Follow`
   * `{ followeeType, followeeId }` index.
   */
  async listFollowerIds(userId: string | Types.ObjectId): Promise<string[]> {
    const rows = await this.followModel
      .find({ followeeType: 'user', followeeId: this.toObjectId(userId) })
      .select('followerId')
      .lean<Array<{ followerId: Types.ObjectId }>>()
      .exec();
    return rows.map((row) => String(row.followerId));
  }

  /**
   * The ids of every `User` who follows the given company page — the fan-out
   * audience for that page's posts. Same `{ followeeType, followeeId }` index as
   * the user path, just `followeeType: 'companyPage'`.
   */
  async listCompanyPageFollowerIds(companyPageId: string | Types.ObjectId): Promise<string[]> {
    const rows = await this.followModel
      .find({ followeeType: 'companyPage', followeeId: this.toObjectId(companyPageId) })
      .select('followerId')
      .lean<Array<{ followerId: Types.ObjectId }>>()
      .exec();
    return rows.map((row) => String(row.followerId));
  }

  /**
   * The company-page ids the caller follows — one indexed query backing the
   * company directory's per-card Follow state (so each card renders the right
   * Follow / Following affordance without an N+1 per-card check).
   */
  async listFollowedCompanyPageIds(userId: string | Types.ObjectId): Promise<string[]> {
    const rows = await this.followModel
      .find({ followerId: this.toObjectId(userId), followeeType: 'companyPage' })
      .select('followeeId')
      .lean<Array<{ followeeId: Types.ObjectId }>>()
      .exec();
    return rows.map((row) => String(row.followeeId));
  }

  // ── Counts ─────────────────────────────────────────────────────────────

  /** Network badge counts for the caller (drives the nav badge + profile). */
  async getCounts(userId: string | Types.ObjectId): Promise<NetworkCounts> {
    const me = this.toObjectId(userId);
    const [pendingRequests, connections, following, followers] = await Promise.all([
      this.connectionRequestModel.countDocuments({ toUserId: me, status: 'pending' }).exec(),
      this.connectionModel.countDocuments({ $or: [{ userA: me }, { userB: me }] }).exec(),
      this.followModel.countDocuments({ followerId: me }).exec(),
      this.followModel.countDocuments({ followeeType: 'user', followeeId: me }).exec(),
    ]);
    return { pendingRequests, connections, following, followers };
  }

  /**
   * Public social-proof counts for ANY user — `{ connections, followers }`,
   * each an independent edge count (a connection who later unfollowed is not in
   * `followers`; a one-way follower who never connected is). Powers the counts
   * on a public profile header. No viewer scope — these are public numbers.
   */
  async getPublicProfileCounts(
    userId: string | Types.ObjectId,
  ): Promise<{ connections: number; followers: number }> {
    const target = this.toObjectId(userId);
    const [connections, followers] = await Promise.all([
      this.connectionModel.countDocuments({ $or: [{ userA: target }, { userB: target }] }).exec(),
      this.followModel.countDocuments({ followeeType: 'user', followeeId: target }).exec(),
    ]);
    return { connections, followers };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** The ids of every `User` connected to `me`. */
  private async connectionUserIds(me: Types.ObjectId): Promise<string[]> {
    const rows = await this.connectionModel
      .find({ $or: [{ userA: me }, { userB: me }] })
      .select('userA userB')
      .lean<Array<{ userA: Types.ObjectId; userB: Types.ObjectId }>>()
      .exec();
    return rows.map((row) => String(row.userA.equals(me) ? row.userB : row.userA));
  }

  /**
   * Canonical ordered pair — `userA` is the lexicographically-smaller id. A
   * `Connection` is symmetric, so ordering the pair lets it be stored once.
   */
  private sortedPair(
    a: Types.ObjectId,
    b: Types.ObjectId,
  ): { userA: Types.ObjectId; userB: Types.ObjectId } {
    return a.toHexString() <= b.toHexString() ? { userA: a, userB: b } : { userA: b, userB: a };
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    if (id instanceof Types.ObjectId) return id;
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid id.');
    }
    return new Types.ObjectId(id);
  }

  /**
   * OpenTelemetry span wrapper — mirrors `ErpLinkService.withSpan`. Span
   * attributes carry only ids / counts / enums, never raw PII.
   */
  private async withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttributes(attributes);
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
