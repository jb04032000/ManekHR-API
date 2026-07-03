import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  CONTENT_TAKEDOWN_EVENT,
  type ContentTakedownEvent,
} from '../content-reports/content-reports.constants';
import { FilterQuery, Model, Types } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  Post,
  type PostAudio,
  type PostKind,
  type PostMedia,
  type PostMediaLayout,
  type PostVisibility,
} from './schemas/post.schema';
import { FeedEntry } from './schemas/feed-entry.schema';
import { Reaction } from './schemas/reaction.schema';
import { Comment } from './schemas/comment.schema';
import { EngagementEdge } from './schemas/engagement-edge.schema';
import { SeenPost } from './schemas/seen-post.schema';
import { SavedPost } from './schemas/saved-post.schema';
import {
  FeedNegativeSignal,
  type NegativeSignalKind,
  type ClientNegativeSignalKind,
} from './schemas/feed-negative-signal.schema';
import {
  dampenFactor,
  deriveAuthorDampen,
  MUTE_DURATION_DAYS,
  NOT_INTERESTED_AUTHOR_FACTOR,
  NOT_INTERESTED_AUTHOR_WINDOW_DAYS,
  NOT_INTERESTED_POST_FACTOR,
} from './feed-feedback';
import {
  FEED_FANOUT_QUEUE,
  FEED_PAGE_SIZE,
  DISCOVERY_CANDIDATE_LIMIT,
  MAX_POSTS_PER_AUTHOR,
  VIEW_BATCH_MAX,
  AFFINITY_WINDOW_DAYS,
  AFFINITY_SCAN_LIMIT,
  DISCOVERY_CURSOR,
  SEEN_LOAD_LIMIT,
  CANDIDATE_GEN_CACHE_TTL_MS,
  CANDIDATE_GEN_CACHE_MAX,
} from './feed.constants';
import { TtlLruCache } from './feed-candidate-cache';
import type { RankingSignals } from '../profile/connect-profile.service';
import { ConnectProfileService } from '../profile/connect-profile.service';
import { ErpLinkService } from '../profile/erp-link.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { TagService } from '../tags/tag.service';
import { CompanyPageService } from '../entities/services/company-page.service';
import { NetworkService } from '../network/network.service';
import { UserBlock, type UserBlockDocument } from '../inbox/schemas/user-block.schema';
import type { ActivityType, CreatePostDto, FeedTab, MentionInputDto } from './dto/feed.dto';
import { MentionService } from '../mention/mention.service';
import {
  FEED_RANKING_STRATEGY,
  type FeedRankingStrategy,
} from './ranking/feed-ranking-strategy.interface';
import { FeedDiscoveryService } from './discovery/feed-discovery.service';
import { CONNECT_POST_CHANGED, type ConnectPostChangeType } from './events/connect-post.events';
import { MediaOwnershipService } from '../../uploads/services/media-ownership.service';
import { PostVisibilityService } from './post-visibility.service';

/**
 * A feed post's stored data as a plain object — what a `.lean()` read yields,
 * so it is safe to spread (unlike the Mongoose `Post` document, which carries
 * instance methods a spread would drop).
 */
export interface FeedPost {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  kind: PostKind;
  body: string;
  media: PostMedia[];
  /** How a multi-photo `photo` post renders — `grid` (default) or `carousel`.
   *  Optional: legacy posts predate the field (a missing value renders as `grid`). */
  mediaLayout?: PostMediaLayout;
  audio: PostAudio | null;
  hashtags: string[];
  tags: string[];
  /** @mentions (tags) - link-ready refs stored on the post. */
  mentions: import('./schemas/mention.subschema').Mention[];
  visibility: PostVisibility;
  reactionCount: number;
  commentCount: number;
  /** Denormalized unique-viewer tally — rendered as "N views". */
  viewCount: number;
  authorErpLinked: boolean;
  /** Denormalized author demo/sample flag — stamped at create from the author's
   *  `User.isDemo`. Drives the demo down-rank (last ranking multiplier) AND the
   *  FE "Sample" badge from one source. Real authors: false/absent. */
  isDemo?: boolean;
  authorSkills: string[];
  /** Denormalized author home district — GeoLocal discovery. Optional: legacy
   *  posts predate the field. */
  authorDistrict?: string;
  /** Set when this post is a repost — the ROOT original's id. `null` otherwise. */
  repostOf?: Types.ObjectId | null;
  /** Running repost tally on an original. */
  repostCount: number;
  /** Set once the author edits the post after publishing; `null`/absent until
   *  then. Drives the "edited" label. */
  editedAt?: Date | null;
  createdAt: Date;
}

/** A feed post enriched with the viewer's own reaction state + why it surfaced. */
export type FeedItem = FeedPost & {
  viewerReacted: boolean;
  /** True when the viewer has a PLAIN repost of this post's root — drives the
   *  repost toggle's active state. */
  viewerReposted: boolean;
  /** True when the viewer has saved (bookmarked) this post. Drives the
   *  Save / Saved toggle in the post overflow menu. */
  viewerSaved: boolean;
  /**
   * Candidate origin — `in_network` | `trending` | `topic` | `network_out` |
   * `geo`. Drives the "why am I seeing this" chip on discovery items. Absent on
   * the Following tab + deeper For-You pages (pure in-network, no chip).
   */
  origin?: string;
  /** i18n key for the reason chip (e.g. `trending`, `geoLocal`). */
  reason?: string;
  /**
   * The embedded ROOT original for a repost — hydrated server-side so the feed
   * renders "X reposted" + the original in one read. `null` when this post is
   * not a repost, or the original was since deleted.
   */
  original?: FeedPost | null;
};

/** One page of a feed read. */
export interface FeedPage {
  posts: FeedItem[];
  /** Pass back as `?cursor=` for the next page; `null` when caught up. */
  nextCursor: string | null;
  /** True when this page reached the end of the feed (design doc §14). */
  caughtUp: boolean;
}

/**
 * One page of a PUBLIC profile-activity read — a profile owner's public posts,
 * served to anyone (logged-out included). Mirrors `FeedPage` but with RAW posts
 * (no per-item `viewerReacted` / `viewerReposted` / `viewerSaved`): the viewer
 * may be logged out, so there is no viewer state to compute. A repost carries
 * its embedded ROOT `original` (public + live only), exactly like
 * `getPublicPost`.
 */
export interface PublicFeedPage {
  posts: Array<FeedPost & { original?: FeedPost | null }>;
  /** Pass back as `?cursor=` for the next page; `null` when caught up. */
  nextCursor: string | null;
  /** True when this page reached the end of the author's public posts. */
  caughtUp: boolean;
}

/**
 * One of the caller's own comments + a preview of the post it sits on — a row
 * in the profile Activity · Comments tab. `post` is `null` when the parent was
 * since deleted (the comment still lists, just without a live link target).
 */
export interface ActivityComment {
  _id: Types.ObjectId;
  /** The commented-on post — drives the "view post" link. */
  postId: Types.ObjectId;
  body: string;
  createdAt: Date;
  /** The parent post, hydrated for context; `null` if since deleted. */
  post: FeedPost | null;
}

/** One page of the caller's own comments (Activity · Comments tab). */
export interface ActivityCommentsPage {
  comments: ActivityComment[];
  /** Pass back as `?cursor=` for the next page; `null` when caught up. */
  nextCursor: string | null;
  caughtUp: boolean;
}

/** The fan-out job payload enqueued on every post create. */
export interface FanoutJobData {
  /** Discriminant — absent/`'fanout'` is the default post-create fan-out. */
  kind?: 'fanout';
  postId: string;
  authorId: string;
  /** `Post.createdAt` as ISO — the `FeedEntry.postedAt` every follower gets. */
  postedAt: string;
  /**
   * Set when the post was published as a company page: the fan-out audience is
   * the PAGE's followers (not the author's), and every `FeedEntry` is stamped
   * with it so the feed renders the page identity. Absent = personal post.
   */
  companyPageId?: string;
  /**
   * The post's visibility. A `connections`-only personal post is fanned out ONLY
   * to followers who are also the author's connections (write-time gating, B1) —
   * a one-way follower never gets a `FeedEntry` for it. Absent reads as public.
   */
  visibility?: PostVisibility;
}

/**
 * Backfill job — on connection-accept, copy `authorId`'s recent posts into
 * `ownerId`'s feed (closes the connect-AFTER-post gap of write-time fan-out).
 */
export interface BackfillJobData {
  kind: 'backfill';
  ownerId: string;
  authorId: string;
}

/**
 * Garbage-collect job — on unfollow, drop every `FeedEntry` the unfollowed
 * author put in the ex-follower's feed. Write-time fan-out leaves those rows
 * behind, so without this the ex-followee's posts linger in the viewer's feed
 * until the 180-day TTL (the "new enemy" stale-ACL problem). Off the request
 * thread, retried.
 */
export interface GcJobData {
  kind: 'gc';
  /** The feed owner to clean (the ex-follower). */
  ownerId: string;
  /** The author whose entries to remove from that feed (the ex-followee). */
  authorId: string;
}

/** Everything the `connect-feed-fanout` queue carries. */
export type FeedFanoutJobData = FanoutJobData | BackfillJobData | GcJobData;

/**
 * `FeedService` — feed reads + post lifecycle (Phase 3 — Feed).
 *
 * A post is fanned out on write: the author's own `FeedEntry` is written
 * inline (so their post is instant) and a BullMQ job writes the followers'
 * entries (B4). A feed read pulls a `postedAt`-windowed candidate set from
 * `FeedEntry`; `Following` keeps chronological order, `For You` re-ranks the
 * window via the injected `FeedRankingStrategy` with the viewer's live profile —
 * no stored score, so the ranker is hot-swappable (`phase-3-feed.md` Decisions).
 */
@Injectable()
export class FeedService {
  private readonly tracer = trace.getTracer('connect.feed');
  private readonly logger = new Logger(FeedService.name);

  /**
   * Per-viewer cache of the STABLE For-You scoring inputs — the base ranking
   * signals (skills / district / openTo) and the affinity map — so back-to-back
   * page fetches within the TTL skip the profile + engagement-edge reads. The
   * VOLATILE feedback inputs (dampening, seen, hide/mute, block) are NOT cached:
   * they are merged on fresh every page after this stage, so they apply instantly
   * (see `getFeed`). Process-local + native objects (the affinity `Map`), so an
   * in-process LRU, not Redis — see `TtlLruCache` for the full rationale.
   */
  private readonly scoringInputCache = new TtlLruCache<{
    signals: RankingSignals;
    affinity: Map<string, number>;
  }>(CANDIDATE_GEN_CACHE_TTL_MS, CANDIDATE_GEN_CACHE_MAX);

  constructor(
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(FeedEntry.name) private readonly feedEntryModel: Model<FeedEntry>,
    @InjectModel(Reaction.name) private readonly reactionModel: Model<Reaction>,
    @InjectQueue(FEED_FANOUT_QUEUE) private readonly fanoutQueue: Queue<FeedFanoutJobData>,
    private readonly profileService: ConnectProfileService,
    private readonly erpLinkService: ErpLinkService,
    @Inject(FEED_RANKING_STRATEGY) private readonly ranker: FeedRankingStrategy,
    private readonly discovery: FeedDiscoveryService,
    @InjectModel(FeedNegativeSignal.name)
    private readonly negativeModel: Model<FeedNegativeSignal>,
    @InjectModel(EngagementEdge.name)
    private readonly engagementEdgeModel: Model<EngagementEdge>,
    @InjectModel(SeenPost.name) private readonly seenPostModel: Model<SeenPost>,
    @InjectModel(SavedPost.name) private readonly savedPostModel: Model<SavedPost>,
    private readonly notifications: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
    @InjectModel(Comment.name) private readonly commentModel: Model<Comment>,
    private readonly tagService: TagService,
    private readonly companyPages: CompanyPageService,
    private readonly network: NetworkService,
    @InjectModel(UserBlock.name)
    private readonly userBlockModel: Model<UserBlockDocument>,
    // Shared media-URL ownership guard. @Optional() so positional unit-test
    // constructors (which stop before this arg) keep working; production DI
    // always injects the real MediaOwnershipService.
    @Optional()
    private readonly media: MediaOwnershipService,
    // Resolves + gates @mentions (tags) on the post write path and computes each
    // tag's link-ready href server-side. @Optional() for the same positional
    // unit-test reason as `media`; production DI always injects MentionService.
    @Optional()
    private readonly mentions: MentionService,
    // Shared can-view/engage gate (feed harden Bucket 1). @Optional() for the
    // same positional unit-test reason as `media`/`mentions`; production DI
    // always injects it. Used to gate embedded repost originals + repost/view
    // read paths so a stranger never sees a connections-only / blocked post.
    @Optional()
    private readonly postVisibility: PostVisibilityService,
  ) {}

  /**
   * The set of user ids the viewer must not see in their feed because of a block
   * in EITHER direction (the viewer blocked them, or they blocked the viewer).
   * Blocks are global, not DM-only: a blocking author's posts must disappear
   * from the feed + discovery, not just the inbox. Usually empty -> one cheap
   * indexed lookup per feed read.
   */
  private async getBlockedUserIds(viewer: Types.ObjectId): Promise<Set<string>> {
    const rows = await this.userBlockModel
      .find({ $or: [{ blockerUserId: viewer }, { blockedUserId: viewer }] })
      .select('blockerUserId blockedUserId')
      .lean<Array<{ blockerUserId: Types.ObjectId; blockedUserId: Types.ObjectId }>>()
      .exec();
    const set = new Set<string>();
    for (const r of rows) {
      set.add(String(r.blockerUserId.equals(viewer) ? r.blockedUserId : r.blockerUserId));
    }
    return set;
  }

  /** Drop posts authored by a blocked user (either direction). No-op when empty. */
  private filterBlocked(posts: FeedPost[], blocked: ReadonlySet<string>): FeedPost[] {
    if (blocked.size === 0) return posts;
    return posts.filter((p) => !blocked.has(String(p.authorId)));
  }

  /**
   * Directional affinity (B3): how much the viewer has recently engaged with
   * each author, keyed by author id, time-decayed and interaction-weighted
   * (comment / repost > react > view). One bounded indexed read; the ranker
   * lifts high-affinity authors. Near-empty for cold-start users.
   */
  private async getAffinityMap(viewer: Types.ObjectId): Promise<Map<string, number>> {
    const now = Date.now();
    const since = new Date(now - AFFINITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.engagementEdgeModel
      .find({ actorId: viewer, createdAt: { $gte: since } })
      .select('authorId type createdAt')
      .limit(AFFINITY_SCAN_LIMIT)
      .lean<Array<{ authorId: Types.ObjectId; type: string; createdAt: Date }>>()
      .exec();
    const typeWeight: Record<string, number> = {
      comment: 3,
      repost: 3,
      share: 2,
      react: 2,
      view: 0.3,
    };
    const map = new Map<string, number>();
    for (const r of rows) {
      const ageDays = Math.max(0, (now - new Date(r.createdAt).getTime()) / (24 * 60 * 60 * 1000));
      const decay = Math.exp(-ageDays / AFFINITY_WINDOW_DAYS);
      const w = (typeWeight[r.type] ?? 1) * decay;
      const key = String(r.authorId);
      map.set(key, (map.get(key) ?? 0) + w);
    }
    return map;
  }

  /**
   * Drop posts the viewer is not allowed to see. Fan-out targets FOLLOWERS (a
   * one-way edge), but a `connections`-visibility post must only reach the
   * author's mutual connections — so a non-connection follower (or a discovery
   * candidate) carrying a connections-only post is filtered here at read time.
   * The connection lookup runs ONLY when a restricted post is actually present
   * (the common all-public window pays nothing). The viewer always sees their
   * own posts regardless of visibility.
   */
  private async gateVisibility(viewer: Types.ObjectId, posts: FeedPost[]): Promise<FeedPost[]> {
    const restricted = posts.some(
      (p) => p.visibility === 'connections' && !viewer.equals(p.authorId),
    );
    if (!restricted) return posts;
    const connections = await this.network.listConnections(viewer);
    const connectionIds = new Set(connections.map((c) => c.userId));
    return posts.filter(
      (p) =>
        p.visibility !== 'connections' ||
        viewer.equals(p.authorId) ||
        connectionIds.has(String(p.authorId)),
    );
  }

  /**
   * Fire-and-forget `connect.post.changed` so a future post-search indexer
   * (Wave 5) can keep its index warm. No listener yet = clean no-op. Mirrors
   * `ConnectProfileService`'s `connect.profile.changed` emit.
   */
  private emitPostChanged(postId: Types.ObjectId | string, change: ConnectPostChangeType): void {
    this.eventEmitter.emit(CONNECT_POST_CHANGED, { postId: String(postId), change });
  }

  // ── Post lifecycle ───────────────────────────────────────────────────────

  /** Create a post, write the author's own feed entry, enqueue the fan-out. */
  async createPost(authorId: string | Types.ObjectId, dto: CreatePostDto): Promise<Post> {
    return this.withSpan('connect.feed.createPost', async () => {
      const author = this.toObjectId(authorId);
      this.validatePayload(dto);

      const body = (dto.body ?? '').trim();

      // Enforce media ownership BEFORE persisting: every photo/video/document
      // url, each optional video posterUrl, and the optional voice-clip url must
      // be a real file on our storage that THIS caller uploaded. A poster is a
      // client-uploaded image, so it gets the SAME ownership check as the rest.
      // Delegates to the shared media-ownership guard (uploads/services/
      // media-ownership.service); throws BadRequest naming the offending index.
      // Empty/null slots (e.g. a posterless video) are skipped by the guard.
      const mediaUrls = [
        ...(dto.media?.map((m) => m.url) ?? []),
        ...(dto.media?.map((m) => m.posterUrl) ?? []),
        dto.audio?.url,
      ];
      await this.media.assertOwnedMedia(mediaUrls, author);

      // Voice posts: the stored clip length must be the SERVER-parsed duration
      // (uploads probes it from the buffer at upload time), never the client's
      // claim. Look it up by the owned upload record; fall back to the DTO value
      // only for grandfathered clips with no probe on file.
      let audio = dto.kind === 'voice' ? dto.audio : null;
      if (audio) {
        const serverDurationSec = await this.media.getServerAudioDurationByUrl(audio.url, author);
        if (serverDurationSec != null) audio = { ...audio, durationSec: serverDurationSec };
      }

      // Video media: stamp each video item with the SERVER-parsed duration
      // (same source-of-truth rule as voice). Images/docs pass through unchanged;
      // posterUrl + caption are preserved by the spread. Posterless / un-probed
      // (grandfathered) clips simply carry no durationSec.
      const media =
        dto.kind === 'voice'
          ? []
          : await Promise.all(
              (dto.media ?? []).map(async (m) => {
                if (m.type !== 'video') return m;
                const durationSec = await this.media.getServerVideoDurationByUrl(m.url, author);
                return durationSec != null ? { ...m, durationSec } : m;
              }),
            );

      // Publishing AS a company page: verify the caller owns it (getMine 404s
      // otherwise) before the post is attributed to it. `null` = personal post.
      let companyPageId: Types.ObjectId | null = null;
      if (dto.companyPageId) {
        const page = await this.companyPages.getMine(String(author), dto.companyPageId);
        companyPageId = page._id;
      }

      // Author signals are denormalized onto the post so the read-time ranker
      // never joins back to `User` / `ConnectProfile`.
      const [signals, erp] = await Promise.all([
        this.profileService.getRankingSignals(author),
        this.erpLinkService.getUserStatus(author),
      ]);

      // Resolve hashtags to canonical tag slugs (alias-aware) before storing.
      const hashtags = await this.tagService.normalizeHashtags(this.parseHashtags(body));
      // Resolve + gate the @mentions (tags): validates each "@<display>" against
      // the body, enforces block/visibility/cap rules, computes link-ready hrefs
      // server-side, and returns the dedup'd notification recipients (self skipped).
      const visibility = dto.visibility ?? 'public';
      const { stored: mentions, recipientUserIds } = await this.mentions.resolveForWrite(
        author,
        body,
        dto.mentions,
        visibility,
      );
      const post = await this.postModel.create({
        authorId: author,
        companyPageId,
        kind: dto.kind,
        body,
        media,
        mediaLayout: dto.kind === 'photo' ? (dto.mediaLayout ?? 'grid') : 'grid',
        audio,
        hashtags,
        tags: dto.tags ?? [],
        mentions,
        visibility,
        authorErpLinked: erp.linked,
        // Denormalize the author's demo/sample flag (from User.isDemo via the
        // ranking-signals lookup) so the read-time ranker can down-rank demo
        // content and the FE can show the "Sample" badge — both from one source.
        isDemo: signals.isDemo,
        authorSkills: signals.skills,
        authorDistrict: signals.district,
      });
      const postedAt = post.createdAt ?? new Date();
      await this.fanOutPost(post._id, author, postedAt, companyPageId, post.visibility);
      // Grow the tag taxonomy + usage counts (fire-and-forget; never blocks posting).
      void this.tagService.recordUsage(hashtags, String(author));
      this.emitPostChanged(post._id, 'created');
      this.notifyMentioned(recipientUserIds, author, String(post._id), body);
      return post;
    });
  }

  /**
   * Materialize a new post into its author's own feed (instant self-visibility)
   * and enqueue the follower fan-out. Shared by `createPost` + `repost`.
   */
  private async fanOutPost(
    postId: Types.ObjectId,
    authorId: Types.ObjectId,
    postedAt: Date,
    companyPageId: Types.ObjectId | null = null,
    visibility: PostVisibility = 'public',
  ): Promise<void> {
    // The author sees their own post instantly — write that entry inline;
    // followers' entries ride the fan-out queue. A page post stamps the page id
    // so the author's own feed row renders the page identity too.
    await this.feedEntryModel
      .updateOne(
        { ownerId: authorId, postId },
        { $setOnInsert: { authorId, postedAt, companyPageId } },
        { upsert: true },
      )
      .exec();
    await this.fanoutQueue.add(
      'fanout',
      {
        postId: String(postId),
        authorId: String(authorId),
        postedAt: postedAt.toISOString(),
        visibility,
        ...(companyPageId ? { companyPageId: String(companyPageId) } : {}),
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );
  }

  /**
   * Repost a post. Resolves the ROOT (a repost of a repost re-targets the root,
   * so reposts never chain), creates the caller's repost — carrying `quote` as
   * its body when provided — fans it out, bumps the root's `repostCount`, logs
   * the engagement edge, and notifies the root author. A PLAIN (no-quote)
   * repost is idempotent: a second one returns the existing repost.
   */
  async repost(userId: string | Types.ObjectId, originalId: string, quote?: string): Promise<Post> {
    return this.withSpan('connect.feed.repost', async () => {
      const author = this.toObjectId(userId);
      if (!Types.ObjectId.isValid(originalId)) throw new NotFoundException('Post not found.');
      const original = await this.postModel
        .findOne({ _id: new Types.ObjectId(originalId), deletedAt: null })
        .select('authorId repostOf visibility')
        .lean<{
          _id: Types.ObjectId;
          authorId: Types.ObjectId;
          repostOf?: Types.ObjectId | null;
          visibility: PostVisibility;
        }>()
        .exec();
      if (!original) throw new NotFoundException('Post not found.');
      // CN-FEED-1 (Bucket 1): a stranger must not be able to repost a
      // connections-only post (or a post authored by someone who blocked them,
      // either direction) — nor confirm its existence. 404 (not 403) matches the
      // 404-for-non-owned convention elsewhere in this file (deletePost). The
      // gate is skipped only in the positional unit-test build (no injected
      // service); production DI always injects it.
      if (
        this.postVisibility &&
        !(await this.postVisibility.canViewPost(author, {
          _id: original._id,
          authorId: original.authorId,
          visibility: original.visibility,
          deletedAt: null,
        }))
      ) {
        throw new NotFoundException('Post not found.');
      }

      const rootId = original.repostOf ?? original._id;
      // The notify / edge target is the ROOT's author, not the (maybe-repost) one.
      let rootAuthorId = original.authorId;
      if (original.repostOf) {
        const root = await this.postModel
          .findOne({ _id: rootId, deletedAt: null })
          .select('authorId')
          .lean<{ authorId: Types.ObjectId }>()
          .exec();
        if (!root) throw new NotFoundException('Post not found.');
        rootAuthorId = root.authorId;
      }

      const body = (quote ?? '').trim();
      // Plain repost — one per (author, root); a repeat returns the existing one.
      if (!body) {
        const existing = await this.postModel
          .findOne({ repostOf: rootId, authorId: author, body: '', deletedAt: null })
          .lean<Post>()
          .exec();
        if (existing) return existing;
      }

      const repost = await this.postModel.create({
        authorId: author,
        kind: 'text',
        body,
        repostOf: rootId,
        visibility: 'public',
      });
      const postedAt = repost.createdAt ?? new Date();
      await this.fanOutPost(repost._id, author, postedAt);

      await Promise.all([
        this.postModel.updateOne({ _id: rootId }, { $inc: { repostCount: 1 } }).exec(),
        this.engagementEdgeModel
          .updateOne(
            { actorId: author, postId: rootId, type: 'repost' },
            { $setOnInsert: { authorId: rootAuthorId } },
            { upsert: true },
          )
          .exec(),
      ]);

      // Notify the root author — best-effort, skip self-reposts.
      if (!author.equals(rootAuthorId)) {
        void this.notifications
          .dispatch({
            recipientId: rootAuthorId,
            actorId: author,
            category: 'connect.post_reposted',
            entityType: 'Post',
            entityId: String(rootId),
            title: 'Your post was reposted',
            message: 'Reposted your post.',
            batchMessage: (count) => `${count} people reposted your post.`,
          })
          .catch(() => undefined);
      }
      return repost;
    });
  }

  /**
   * Undo the caller's PLAIN (no-quote) repost of a post. Soft-deletes the
   * repost (so it leaves every feed via the `deletedAt` filter), decrements the
   * root tally, and drops the engagement edge. A no-op when nothing is reposted.
   * Quote-reposts are real posts — removed via `deletePost`, not here.
   */
  async unrepost(userId: string | Types.ObjectId, originalId: string): Promise<void> {
    return this.withSpan('connect.feed.unrepost', async () => {
      const author = this.toObjectId(userId);
      if (!Types.ObjectId.isValid(originalId)) throw new NotFoundException('Post not found.');
      const originalObjId = new Types.ObjectId(originalId);
      const original = await this.postModel
        .findOne({ _id: originalObjId, deletedAt: null })
        .select('repostOf')
        .lean<{ repostOf?: Types.ObjectId | null }>()
        .exec();
      const rootId = original?.repostOf ?? originalObjId;

      const repost = await this.postModel
        .findOne({ repostOf: rootId, authorId: author, body: '', deletedAt: null })
        .select('_id')
        .lean<{ _id: Types.ObjectId }>()
        .exec();
      if (!repost) return;

      await this.postModel
        .updateOne({ _id: repost._id }, { $set: { deletedAt: new Date() } })
        .exec();
      await Promise.all([
        this.postModel
          .updateOne({ _id: rootId, repostCount: { $gt: 0 } }, { $inc: { repostCount: -1 } })
          .exec(),
        this.engagementEdgeModel
          .deleteOne({ actorId: author, postId: rootId, type: 'repost' })
          .exec(),
      ]);
    });
  }

  /**
   * Edit one of the caller's own posts. Author-only. Applies the editable text
   * fields (body / tags / visibility), re-parses hashtags from a changed body,
   * stamps `editedAt`, and re-emits `connect.post.changed` so search re-indexes
   * it. The post keeps its `createdAt` + `FeedEntry` rows, so an edit never
   * reorders or re-fans-out the feed (the same post, new content).
   */
  async editPost(
    userId: string | Types.ObjectId,
    postId: string,
    dto: {
      body?: string;
      tags?: string[];
      visibility?: PostVisibility;
      mediaLayout?: PostMediaLayout;
      mentions?: MentionInputDto[];
    },
  ): Promise<Post> {
    return this.withSpan('connect.feed.editPost', async () => {
      const post = await this.postModel
        .findOne({ _id: this.toObjectId(postId), deletedAt: null })
        .exec();
      if (!post) throw new NotFoundException('Post not found.');
      if (!(post.authorId as Types.ObjectId).equals(this.toObjectId(userId))) {
        throw new ForbiddenException('You can only edit your own post.');
      }
      // A repost is a wrapper around someone else's content, not editable text.
      // Editing one would silently turn a plain repost into a fabricated quote.
      if (post.repostOf) {
        throw new BadRequestException('A repost cannot be edited.');
      }
      if (dto.body !== undefined) {
        const body = dto.body.trim();
        // A text post cannot be emptied; a photo / voice post may carry no body.
        if (post.kind === 'text' && !body) {
          throw new BadRequestException('Write something to share.');
        }
        post.body = body;
        post.hashtags = await this.tagService.normalizeHashtags(this.parseHashtags(body));
      }
      // Re-resolve + re-gate the @mentions whenever the body, visibility, OR the
      // tag set changes - NOT only on a body edit. A visibility-narrowing edit
      // (public -> connections) must re-run the reach gate so a tag to a
      // non-connection cannot silently persist on a now-restricted post. The tag
      // set is `dto.mentions` (the picker's new set) when provided, else the
      // existing tags whose "@<name>" token still appears in the effective body
      // (so a body edit that removed a tag's text drops it cleanly). Notifies only
      // genuinely-new entities (by refId), mapped to owner ids, so a re-resolve
      // never re-pings an already-tagged person or page owner.
      if (dto.body !== undefined || dto.visibility !== undefined || dto.mentions !== undefined) {
        const effectiveBody = dto.body !== undefined ? dto.body.trim() : post.body;
        const effectiveVisibility = dto.visibility ?? post.visibility;
        const beforeRefs = new Set((post.mentions ?? []).map((m) => String(m.refId)));
        const input =
          dto.mentions ??
          (post.mentions ?? [])
            .filter((m) => effectiveBody.includes(`@${m.display}`))
            .map((m) => ({ type: m.type, refId: String(m.refId), display: m.display }));
        const { stored, recipients } = await this.mentions.resolveForWrite(
          this.toObjectId(userId),
          effectiveBody,
          input,
          effectiveVisibility,
        );
        post.mentions = stored as never;
        const fresh = [
          ...new Set(recipients.filter((r) => !beforeRefs.has(r.refId)).map((r) => r.ownerUserId)),
        ];
        this.notifyMentioned(fresh, this.toObjectId(userId), String(post._id), effectiveBody);
      }
      // A content edit (body / tags / visibility) stamps `editedAt`; a pure
      // layout flip does not (it is display-only, not a change to the content).
      const contentChanged =
        dto.body !== undefined || dto.tags !== undefined || dto.visibility !== undefined;
      if (dto.tags !== undefined) post.tags = dto.tags;
      if (dto.visibility !== undefined) post.visibility = dto.visibility;
      // Display-only layout flip — only a photo post has a grid/carousel choice.
      if (dto.mediaLayout !== undefined && post.kind === 'photo') {
        post.mediaLayout = dto.mediaLayout;
      }
      if (contentChanged) post.editedAt = new Date();
      await post.save();
      this.emitPostChanged(post._id, 'updated');
      return post;
    });
  }

  /** Soft-delete a post. Only its author may delete it. */
  async deletePost(userId: string | Types.ObjectId, postId: string): Promise<void> {
    return this.withSpan('connect.feed.deletePost', async () => {
      const post = await this.postModel
        .findOne({ _id: this.toObjectId(postId), deletedAt: null })
        .exec();
      if (!post) throw new NotFoundException('Post not found.');
      if (!(post.authorId as Types.ObjectId).equals(this.toObjectId(userId))) {
        throw new ForbiddenException('You can only delete your own post.');
      }
      post.deletedAt = new Date();
      await post.save();
      // Hard-remove the fanned-out feed rows for this post so it leaves every
      // follower's feed immediately (the post itself stays soft-deleted so
      // Profile Activity / repost roots resolve correctly). Without this the
      // entries linger until the TTL and thin out pages at read time.
      await this.feedEntryModel.deleteMany({ postId: post._id });
      // Cascade the view-count dedup storage. `view` EngagementEdge rows are now
      // PERMANENT (no TTL — see ADR-0002) so the lifetime-unique viewCount never
      // re-counts a re-view; we therefore bound their growth by content lifecycle,
      // trimming a deleted post's view edges + seen rows here. Only `view` edges
      // are removed (react/comment/repost edges are bounded by real engagement and
      // unchanged). SeenPost rows are viewer-suppression for a now-gone post.
      // Links: schemas/engagement-edge.schema.ts, schemas/seen-post.schema.ts.
      await Promise.all([
        this.engagementEdgeModel.deleteMany({ postId: post._id, type: 'view' }).exec(),
        this.seenPostModel.deleteMany({ postId: post._id }).exec(),
      ]);
      this.emitPostChanged(post._id, 'deleted');
    });
  }

  /**
   * Moderation takedown (content-reports "Remove"). Hard-removes a REPORTED post
   * via the normal author cascade (soft-delete + feed-row / engagement cleanup +
   * `connect.post.changed`), so the post leaves every surface immediately.
   * Best-effort: a missing / already-deleted post is a no-op and never throws out
   * of the event handler. Non-`post` targets are handled by the owning module's
   * own listener (listing) or by admin account suspend (comment / profile).
   * Links: content-reports.service emits CONTENT_TAKEDOWN_EVENT.
   */
  @OnEvent(CONTENT_TAKEDOWN_EVENT)
  async onContentTakedown(e: ContentTakedownEvent): Promise<void> {
    if (e.targetType !== 'post') return;
    try {
      const post = await this.postModel
        .findOne({ _id: this.toObjectId(e.targetId), deletedAt: null })
        .select('authorId')
        .exec();
      if (!post) return;
      await this.deletePost(post.authorId as Types.ObjectId, e.targetId);
    } catch {
      /* best-effort takedown; an event handler must never throw */
    }
  }

  /** A single public post — backs the shareable `/connect/posts/:id` URL. A
   *  repost carries its embedded ROOT original (when that original is itself
   *  still public + live). */
  async getPublicPost(postId: string): Promise<FeedPost & { original?: FeedPost | null }> {
    if (!Types.ObjectId.isValid(postId)) {
      throw new NotFoundException('Post not found.');
    }
    const post = await this.postModel
      .findOne({ _id: new Types.ObjectId(postId), visibility: 'public', deletedAt: null })
      .lean<FeedPost>()
      .exec();
    if (!post) throw new NotFoundException('Post not found.');
    if (!post.repostOf) return post;
    const original = await this.postModel
      .findOne({ _id: post.repostOf, visibility: 'public', deletedAt: null })
      .lean<FeedPost>()
      .exec();
    return { ...post, original: original ?? null };
  }

  /**
   * One page of a user's PUBLIC posts, newest-first — backs the public profile
   * Activity surface on OTHER people's profiles (`@Public GET
   * /connect/profiles/:slug/activity`). The caller (controller) has already
   * 404-gated a hidden / non-public profile, so this only enforces post-level
   * visibility.
   *
   * Posts only: comments + reactions are owner-only (the authenticated
   * `/me/connect/feed/activity` surface) and are never served here. The viewer
   * may be logged out, so there is NO `toPage` enrichment — raw lean posts, like
   * `getPublicPost`. A repost carries its embedded ROOT `original` (public +
   * live only). Cursor walks `Post.createdAt`.
   */
  async getPublicActivity(
    userId: string | Types.ObjectId,
    cursor?: string,
  ): Promise<PublicFeedPage> {
    return this.withSpan('connect.feed.getPublicActivity', async () => {
      const author = this.toObjectId(userId);
      const filter: FilterQuery<Post> = {
        authorId: author,
        visibility: 'public',
        deletedAt: null,
      };
      if (cursor) {
        const cursorDate = new Date(cursor);
        if (!Number.isNaN(cursorDate.getTime())) filter.createdAt = { $lt: cursorDate };
      }
      const posts = await this.postModel
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(FEED_PAGE_SIZE)
        .lean<FeedPost[]>()
        .exec();
      const caughtUp = posts.length < FEED_PAGE_SIZE;
      const nextCursor = caughtUp ? null : posts[posts.length - 1].createdAt.toISOString();
      return { posts: await this.embedPublicOriginals(posts), nextCursor, caughtUp };
    });
  }

  /**
   * A company page's own public posts, newest-first - the public `/company/[slug]`
   * Posts tab. Mirrors `getPublicActivity` but keyed on `companyPageId` (the page
   * Posts index) rather than `authorId`. Anyone (logged-out included) may read.
   */
  /**
   * A company page's posts. Public callers get `visibility: 'public'` only; the
   * owner's manage console passes `includeNonPublic` so the owner sees ALL their
   * page posts (draft/connections too) - this matches the page-stats count
   * (`CompanyPageStatsService`), which counts posts regardless of visibility, so
   * the badge and the list never disagree.
   */
  async getCompanyPageActivity(
    companyPageId: string | Types.ObjectId,
    cursor?: string,
    opts?: { includeNonPublic?: boolean },
  ): Promise<PublicFeedPage> {
    return this.withSpan('connect.feed.getCompanyPageActivity', async () => {
      const filter: FilterQuery<Post> = {
        companyPageId: this.toObjectId(companyPageId),
        deletedAt: null,
      };
      if (!opts?.includeNonPublic) filter.visibility = 'public';
      if (cursor) {
        const cursorDate = new Date(cursor);
        if (!Number.isNaN(cursorDate.getTime())) filter.createdAt = { $lt: cursorDate };
      }
      const posts = await this.postModel
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(FEED_PAGE_SIZE)
        .lean<FeedPost[]>()
        .exec();
      const caughtUp = posts.length < FEED_PAGE_SIZE;
      const nextCursor = caughtUp ? null : posts[posts.length - 1].createdAt.toISOString();
      return { posts: await this.embedPublicOriginals(posts), nextCursor, caughtUp };
    });
  }

  /**
   * Resolve each repost's embedded ROOT `original` (public + live only) for a
   * page of public posts — the batched, page variant of `getPublicPost`'s
   * single-post original lookup, so a repost in a public Activity list renders
   * with content rather than an empty shell. A non-repost carries no `original`
   * key; a repost whose original is gone / private carries `original: null`.
   */
  private async embedPublicOriginals(
    posts: FeedPost[],
  ): Promise<Array<FeedPost & { original?: FeedPost | null }>> {
    const rootIds = posts.map((p) => p.repostOf).filter((id): id is Types.ObjectId => Boolean(id));
    if (rootIds.length === 0) return posts;
    const originals = await this.postModel
      .find({ _id: { $in: rootIds }, visibility: 'public', deletedAt: null })
      .lean<FeedPost[]>()
      .exec();
    const byId = new Map(originals.map((o) => [String(o._id), o]));
    return posts.map((p) =>
      p.repostOf ? { ...p, original: byId.get(String(p.repostOf)) ?? null } : p,
    );
  }

  // ── Saved posts (private bookmarks) ────────────────────────────────────────

  /**
   * Save (bookmark) a post for the caller. Idempotent: a repeat save is a no-op
   * (the unique { userId, postId } index dedups). 404s on a missing or deleted
   * post so the Saved list never holds a dangling row.
   */
  async savePost(userId: string | Types.ObjectId, postId: string): Promise<{ saved: boolean }> {
    return this.withSpan('connect.feed.savePost', async () => {
      const user = this.toObjectId(userId);
      const rootId = await this.resolveRootId(postId);
      await this.savedPostModel
        .updateOne(
          { userId: user, postId: rootId },
          { $setOnInsert: { userId: user, postId: rootId } },
          { upsert: true },
        )
        .exec();
      return { saved: true };
    });
  }

  /** Un-save a post for the caller. Tolerates a missing bookmark (a no-op).
   *  Resolves the ROOT so it matches the root-keyed save; falls back to the
   *  given id when the post is gone (the client already passes the root id). */
  async unsavePost(userId: string | Types.ObjectId, postId: string): Promise<{ saved: boolean }> {
    return this.withSpan('connect.feed.unsavePost', async () => {
      if (!Types.ObjectId.isValid(postId)) throw new NotFoundException('Post not found.');
      const post = await this.postModel
        .findOne({ _id: new Types.ObjectId(postId) })
        .select('repostOf')
        .lean<{ repostOf?: Types.ObjectId | null }>()
        .exec();
      const rootId = post?.repostOf ?? new Types.ObjectId(postId);
      await this.savedPostModel
        .deleteOne({ userId: this.toObjectId(userId), postId: rootId })
        .exec();
      return { saved: false };
    });
  }

  /**
   * One page of the caller's saved posts, newest-saved first. Reads the
   * SavedPost window (cursor = the previous page's last save time), hydrates the
   * live posts (dropping any since-deleted), and runs them through `toPage` so
   * each carries the viewer's reaction / repost / saved state + any embedded
   * repost original. Identical shape to a feed read, so the Saved tab renders
   * with the same PostCard. No fan-out, no ranking: a private list.
   */
  async listSaved(userId: string | Types.ObjectId, cursor?: string): Promise<FeedPage> {
    return this.withSpan('connect.feed.listSaved', async () => {
      const user = this.toObjectId(userId);
      const filter: FilterQuery<SavedPost> = { userId: user };
      if (cursor) {
        const cursorDate = new Date(cursor);
        if (!Number.isNaN(cursorDate.getTime())) filter.createdAt = { $lt: cursorDate };
      }
      const rows = await this.savedPostModel
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(FEED_PAGE_SIZE)
        .lean<Array<{ postId: Types.ObjectId; createdAt: Date }>>()
        .exec();
      const caughtUp = rows.length < FEED_PAGE_SIZE;
      const nextCursor = caughtUp ? null : rows[rows.length - 1].createdAt.toISOString();
      // Hydrate the live posts, preserving the saved (newest-first) order and
      // dropping any the author has since deleted.
      const posts = await this.postModel
        .find({ _id: { $in: rows.map((r) => r.postId) }, deletedAt: null })
        .lean<FeedPost[]>()
        .exec();
      const byId = new Map(posts.map((p) => [String(p._id), p]));
      const ordered = rows
        .map((r) => byId.get(String(r.postId)))
        .filter((p): p is FeedPost => p !== undefined);
      return this.toPage(user, ordered, nextCursor, caughtUp);
    });
  }

  /** The From-your-ERP callout summary for the caller (design doc §9.4). */
  getErpSummary(
    userId: string | Types.ObjectId,
  ): Promise<{ owner: boolean; karigarCount: number; payrollPaise: number }> {
    return this.erpLinkService.getErpSummary(userId);
  }

  // ── Profile activity (own posts / comments / reactions) ────────────────────

  /**
   * One page of the caller's OWN activity — backs the LinkedIn-style profile
   * Activity tab. Own data only (the caller is the author / commenter /
   * reactor), so there is no fan-out, ranking, or discovery: each view is a
   * plain reverse-chronological window.
   *
   *  - `posts` — the caller's authored posts, hydrated through `toPage` so each
   *    carries the viewer's own reaction / repost / saved state (identical to a
   *    feed item, rendered with the same PostCard).
   *  - `reactions` — the posts the caller liked, newest-liked first, the same
   *    feed shape (mirrors `listSaved`).
   *  - `comments` — the caller's comments, each with a preview of its parent
   *    post (a different shape — `ActivityCommentsPage`).
   */
  async getActivity(
    userId: string | Types.ObjectId,
    type: ActivityType,
    cursor?: string,
  ): Promise<FeedPage | ActivityCommentsPage> {
    return this.withSpan('connect.feed.getActivity', async () => {
      const viewer = this.toObjectId(userId);
      if (type === 'comments') return this.activityComments(viewer, cursor);
      if (type === 'reactions') return this.activityReactions(viewer, cursor);
      return this.activityPosts(viewer, cursor);
    });
  }

  /** The caller's own posts, newest-first. Cursor walks `Post.createdAt`. */
  private async activityPosts(viewer: Types.ObjectId, cursor?: string): Promise<FeedPage> {
    const filter: FilterQuery<Post> = { authorId: viewer, deletedAt: null };
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) filter.createdAt = { $lt: cursorDate };
    }
    const posts = await this.postModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(FEED_PAGE_SIZE)
      .lean<FeedPost[]>()
      .exec();
    const caughtUp = posts.length < FEED_PAGE_SIZE;
    const nextCursor = caughtUp ? null : posts[posts.length - 1].createdAt.toISOString();
    return this.toPage(viewer, posts, nextCursor, caughtUp);
  }

  /**
   * The posts the caller has liked, newest-liked first. Pagination walks the
   * `Reaction` rows (cursor = the previous page's last reaction time); the live
   * posts are hydrated in reaction order, dropping any since-deleted. Mirrors
   * `listSaved` exactly — same windowed-rows-then-hydrate shape.
   */
  private async activityReactions(viewer: Types.ObjectId, cursor?: string): Promise<FeedPage> {
    const filter: FilterQuery<Reaction> = { userId: viewer };
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) filter.createdAt = { $lt: cursorDate };
    }
    const rows = await this.reactionModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(FEED_PAGE_SIZE)
      .lean<Array<{ postId: Types.ObjectId; createdAt: Date }>>()
      .exec();
    const caughtUp = rows.length < FEED_PAGE_SIZE;
    const nextCursor = caughtUp ? null : rows[rows.length - 1].createdAt.toISOString();
    const posts = await this.postModel
      .find({ _id: { $in: rows.map((r) => r.postId) }, deletedAt: null })
      .lean<FeedPost[]>()
      .exec();
    const byId = new Map(posts.map((p) => [String(p._id), p]));
    const ordered = rows
      .map((r) => byId.get(String(r.postId)))
      .filter((p): p is FeedPost => p !== undefined);
    return this.toPage(viewer, ordered, nextCursor, caughtUp);
  }

  /**
   * The caller's own comments, newest-first, each with a preview of the post it
   * sits on. Cursor walks `Comment.createdAt`; the parent posts are batch-loaded
   * (a since-deleted parent yields `post: null` so the comment still lists).
   */
  private async activityComments(
    viewer: Types.ObjectId,
    cursor?: string,
  ): Promise<ActivityCommentsPage> {
    const filter: FilterQuery<Comment> = { authorId: viewer, deletedAt: null };
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) filter.createdAt = { $lt: cursorDate };
    }
    const rows = await this.commentModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(FEED_PAGE_SIZE)
      .lean<Array<{ _id: Types.ObjectId; postId: Types.ObjectId; body: string; createdAt: Date }>>()
      .exec();
    const caughtUp = rows.length < FEED_PAGE_SIZE;
    const nextCursor = caughtUp ? null : rows[rows.length - 1].createdAt.toISOString();
    const postIds = [...new Set(rows.map((r) => String(r.postId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const posts = postIds.length
      ? await this.postModel
          .find({ _id: { $in: postIds }, deletedAt: null })
          .lean<FeedPost[]>()
          .exec()
      : [];
    const byId = new Map(posts.map((p) => [String(p._id), p]));
    const comments: ActivityComment[] = rows.map((r) => ({
      _id: r._id,
      postId: r.postId,
      body: r.body,
      createdAt: r.createdAt,
      post: byId.get(String(r.postId)) ?? null,
    }));
    return { comments, nextCursor, caughtUp };
  }

  // ── Feed read ────────────────────────────────────────────────────────────

  /**
   * One page of the caller's feed. Pulls a `postedAt`-windowed candidate set
   * from `FeedEntry`; `following` keeps it chronological, `foryou` re-ranks
   * the window via the injected `FeedRankingStrategy`.
   */
  async getFeed(
    viewerId: string | Types.ObjectId,
    tab: FeedTab,
    cursor?: string,
  ): Promise<FeedPage> {
    return this.withSpan('connect.feed.getFeed', async () => {
      const viewer = this.toObjectId(viewerId);

      // ── In-network window (the materialized follower timeline) ──
      // Over-fetch (3x the page) so that after dropping since-deleted posts,
      // muted authors and visibility-gated posts we can still fill a full page
      // and drive the cursor off SURVIVING items — not the raw entry window,
      // which would render thin/empty pages whenever entries point at dropped
      // posts (F5).
      // The For-You discovery-continuation cursor (C1): the in-network timeline
      // is already exhausted, so skip the in-network query entirely and let
      // discovery carry the page (it excludes what was already served-as-seen).
      const isDiscoveryCursor = cursor === DISCOVERY_CURSOR;
      const OVERFETCH = FEED_PAGE_SIZE * 3;
      let entries: Array<{ postId: Types.ObjectId; postedAt: Date }> = [];
      let rawCaughtUp = true;
      if (!isDiscoveryCursor) {
        const filter: FilterQuery<FeedEntry> = { ownerId: viewer };
        if (cursor) {
          const cursorDate = new Date(cursor);
          if (!Number.isNaN(cursorDate.getTime())) {
            filter.postedAt = { $lt: cursorDate };
          }
        }
        entries = await this.feedEntryModel
          .find(filter)
          .sort({ postedAt: -1 })
          .limit(OVERFETCH)
          .lean<Array<{ postId: Types.ObjectId; postedAt: Date }>>()
          .exec();
        rawCaughtUp = entries.length < OVERFETCH;
      }
      // Drop hidden/muted (negative) + since-deleted (hydrate) + visibility-gated
      // (a connections-only post that reached a non-connection follower).
      // ONE negative-signal read per page carries BOTH the hard-exclusion sets
      // (hide/mute) used here AND the For-You dampening maps used below — read
      // FRESH every page so a just-tapped hide/mute applies on the very next page.
      const negative = await this.loadNegativeSignals(viewer);
      const blocked = await this.getBlockedUserIds(viewer);
      const survivors = await this.gateVisibility(
        viewer,
        this.filterBlocked(
          this.applyNegative(await this.hydrateEntries(entries), negative),
          blocked,
        ),
      );
      // The page is the newest FEED_PAGE_SIZE survivors; the cursor is the LAST
      // shown survivor's time (survivors keep postedAt-desc order, and
      // FeedEntry.postedAt === Post.createdAt), so the next page continues right
      // after it. More remains when there are extra survivors OR the raw window
      // was not exhausted.
      const inNetwork = survivors.slice(0, FEED_PAGE_SIZE);
      const moreInNetwork = survivors.length > FEED_PAGE_SIZE || !rawCaughtUp;
      const lastShown = inNetwork[inNetwork.length - 1];
      // CN-FEED-8 (feed harden Bucket 7): when a whole over-fetch window is
      // entirely filtered out (block/mute/visibility) `survivors` is empty, so
      // there is no `lastShown` to drive the cursor — yet older raw entries may
      // still exist beyond the fetched window. Advancing the cursor to the LAST
      // RAW entry's postedAt lets the next request re-fetch from there instead of
      // falsely reporting "caught up". Bounded by `rawCaughtUp`: once the raw
      // window is exhausted there is genuinely nothing more, so we stop (no loop).
      const lastRawEntry = entries[entries.length - 1];
      let nextCursor =
        moreInNetwork && lastShown ? new Date(lastShown.createdAt).toISOString() : null;
      if (nextCursor === null && survivors.length === 0 && !rawCaughtUp && lastRawEntry) {
        nextCursor = new Date(lastRawEntry.postedAt).toISOString();
      }
      const inNetworkCaughtUp = nextCursor === null;

      // Following — pure in-network, reverse-chronological. No discovery, no
      // re-rank. (Following stays a pure "people you follow" timeline; its empty
      // case is handled at the UX layer, not by borrowing discovery here.)
      if (tab === 'following') {
        return this.toPage(viewer, inNetwork, nextCursor, inNetworkCaughtUp);
      }

      // For You — rank the in-network window and enrich with discovery on EVERY
      // page (F7), not only page 1. When the viewer follows no one `inNetwork` is
      // empty and discovery carries the page (cold-start, never blank); for a
      // viewer WITH a network, deeper pages keep getting fresh discovery instead
      // of collapsing to in-network-only.
      // Reader-feedback inputs (Phase 7d): the already-served set + the decayed
      // not-interested dampening maps, both fed to the ranker as down-rank
      // multipliers (never exclusions).
      // The STABLE scoring inputs (base ranking signals + affinity) come from the
      // per-viewer cache so a warm page skips the profile + engagement-edge reads;
      // the VOLATILE inputs (seen + dampening) are read fresh and merged on top,
      // so reader feedback is never stale beyond this page.
      // One request clock shared by the cache TTL check, the ranker, and the
      // discovery window (so a single page is internally time-consistent).
      const ctxNow = Date.now();
      const seenPostIds = await this.getSeenPostIds(viewer);
      const scoring = await this.getScoringInputs(viewer, ctxNow);
      const signals = {
        ...scoring.signals,
        // Directional affinity for the ranker (B3) — built once, used for both
        // the in-network and discovery ranking passes below.
        affinity: scoring.affinity,
        // Phase 7d dampening — not-interested (post + derived author), read fresh.
        dampenByPost: negative.dampenByPost,
        dampenByAuthor: negative.dampenByAuthor,
        seenPostIds,
      };
      const ctx = { now: ctxNow, tab, viewerId: viewer };
      const rankedIn = await this.ranker.rank(inNetwork, signals, ctx);
      // Exclude only what the viewer already has IN-NETWORK (so a discovery copy
      // of an in-network post is not duplicated). Seen posts are NOT excluded from
      // discovery on a normal page (Phase 7d): they stay eligible and the ranker
      // applies a seen penalty, so they fade rather than vanish and a heavily-
      // engaged one can resurface. EXCEPTION: on the pure-discovery continuation
      // (cold-start infinite scroll) we still exclude already-served posts so each
      // sentinel page advances instead of re-serving the same dampened candidates.
      const exclude = new Set<string>(inNetwork.map((p) => String(p._id)));
      if (isDiscoveryCursor) {
        for (const id of seenPostIds) exclude.add(id);
      }
      const discoveryRaw = await this.discovery.getCandidates(
        {
          viewerId: viewer,
          now: ctx.now,
          limit: DISCOVERY_CANDIDATE_LIMIT,
          viewerSkills: signals.skills,
          viewerDistrict: signals.district,
        },
        exclude,
      );
      // CN-FEED-12 (feed harden Bucket 7): the discovery path is backed by a ~60s
      // candidate-pool cache, so it can hand back a post that was deleted / taken
      // down WITHIN that window (in-network posts already get a same-request
      // deletedAt:null filter via hydrateEntries; the cache-backed discovery path
      // bypasses it). Batch-verify the candidate ids are still live in ONE indexed
      // query and drop any that are gone, so a just-removed post never lingers in
      // For-You/trending for up to a minute.
      const discovery = await this.dropDeletedCandidates(discoveryRaw);
      const rankedDiscovery = await this.ranker.rank(
        await this.gateVisibility(
          viewer,
          this.filterBlocked(
            this.applyNegative(
              discovery.map((c) => c.post),
              negative,
            ),
            blocked,
          ),
        ),
        signals,
        ctx,
      );
      // In-network leads (~70/30): every 3rd slot is a discovery item. Each list
      // is capped per author for the mix, then a FINAL cross-list author cap
      // (C3) so one author cannot appear up to 6x via both lists.
      const ordered = this.diversify(
        this.interleaveFeed(
          this.diversify(rankedIn, MAX_POSTS_PER_AUTHOR),
          this.diversify(rankedDiscovery, MAX_POSTS_PER_AUTHOR),
          FEED_PAGE_SIZE,
        ),
        MAX_POSTS_PER_AUTHOR,
      );
      // Cap seeded demo/sample posts to ~30% of the page (never leaving it short)
      // so a thin early network isn't dominated by sample content — a hard
      // ceiling on top of the read-time demo down-rank. Order preserved.
      const capped = this.capDemo(ordered);
      // Tag each post's origin so the UI can show a "why am I seeing this" chip
      // on discovery items (in-network posts carry no chip).
      const originById = new Map<string, { origin: string; reason?: string }>();
      for (const p of inNetwork) originById.set(String(p._id), { origin: 'in_network' });
      for (const c of discovery) {
        originById.set(String(c.post._id), { origin: c.origin, reason: c.reason });
      }
      // Mark the served discovery posts seen so the NEXT page never re-serves
      // them — removes cross-page repeats AND lets discovery paginate (C1).
      // CN-FEED-9 (feed harden Bucket 7): mark seen ONLY the discovery posts that
      // actually SURVIVED into the final page (`capped`), not every candidate
      // `discovery` returned. Marking un-rendered candidates seen burned them
      // (they were suppressed from future pages without ever being shown), which
      // silently dropped discovery content the reader never saw.
      const renderedDiscoveryIds = capped
        .filter((p) => originById.get(String(p._id))?.origin !== 'in_network')
        .map((p) => p._id);
      if (renderedDiscoveryIds.length > 0) void this.markServedSeen(viewer, renderedDiscoveryIds);
      // Once the in-network timeline is exhausted (`nextCursor` null) keep
      // paginating pure discovery via the sentinel cursor (C1), so a zero/low-
      // network viewer gets infinite scroll instead of a single page.
      const forYouCursor = nextCursor ?? (discovery.length > 0 ? DISCOVERY_CURSOR : null);
      return this.toPage(viewer, capped, forYouCursor, forYouCursor === null, originById);
    });
  }

  /**
   * Compact trending posts for the feed right-rail "Trending in your trade"
   * panel — viewer-agnostic recent-popular PUBLIC posts (excludes the viewer's
   * own), newest-popular first. Each item links to its post; an empty result
   * hides the rail. Reuses the discovery `TrendingSource` (same cold-start
   * widening), so the rail is real data, never a placeholder.
   */
  async getTrendingRail(
    viewerId: string | Types.ObjectId,
    limit = 5,
  ): Promise<Array<{ postId: string; snippet: string; reactionCount: number }>> {
    const viewer = this.toObjectId(viewerId);
    const [candidates, blocked] = await Promise.all([
      this.discovery.getTrending({
        viewerId: viewer,
        now: Date.now(),
        limit,
        viewerSkills: [],
        viewerDistrict: undefined,
      }),
      this.getBlockedUserIds(viewer),
    ]);
    return candidates
      .filter((c) => !blocked.has(String(c.post.authorId)))
      .map((c) => ({
        postId: String(c.post._id),
        snippet: (c.post.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
        reactionCount: c.post.reactionCount ?? 0,
      }));
  }

  /** Resolve a `FeedEntry` window into live posts (drops any since-deleted). */
  private async hydrateEntries(
    entries: Array<{ postId: Types.ObjectId; postedAt: Date }>,
  ): Promise<FeedPost[]> {
    if (entries.length === 0) return [];
    const posts = await this.postModel
      .find({ _id: { $in: entries.map((e) => e.postId) }, deletedAt: null })
      // PERF: scan the in-network window media-LIGHT — the ranking/visibility pass
      // never reads `media`, and it can be 300KB+ of inline data per post. The
      // heavy blob is re-hydrated for only the rendered page in toPage
      // (loadMediaByIds). Keep in sync with the discovery/*.source.ts scans.
      .select('-media')
      .lean<FeedPost[]>()
      .exec();
    const byId = new Map(posts.map((p) => [String(p._id), p]));
    return entries
      .map((e) => byId.get(String(e.postId)))
      .filter((p): p is FeedPost => p !== undefined);
  }

  /**
   * Re-hydrate the display-only `media` blob for JUST the posts on the rendered
   * page. The candidate windows (in-network hydrateEntries + the 4 discovery
   * sources) are scanned WITHOUT `media` — the ranking/visibility pass never
   * reads it and it can be 300KB+ of inline data per post — so we fetch it back
   * only for the <=FEED_PAGE_SIZE posts actually shown, making feed latency
   * independent of the candidate-pool size. Cross-links: hydrateEntries +
   * discovery/*.source.ts (the media-light scans), post.schema `media`.
   */
  private async loadMediaByIds(ids: Types.ObjectId[]): Promise<Map<string, PostMedia[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.postModel
      .find({ _id: { $in: ids } })
      .select('media')
      .lean<Array<{ _id: Types.ObjectId; media?: PostMedia[] }>>()
      .exec();
    return new Map(rows.map((r) => [String(r._id), r.media ?? []]));
  }

  /** Attach the viewer's reaction state + shape a `FeedPage`. */
  private async toPage(
    viewer: Types.ObjectId,
    ordered: FeedPost[],
    nextCursor: string | null,
    caughtUp: boolean,
    originById?: ReadonlyMap<string, { origin: string; reason?: string }>,
  ): Promise<FeedPage> {
    // C2 — never show a root and its repost (or two reposts of one root) in the
    // same page; keep the first (highest-ranked) occurrence.
    ordered = this.dedupByRoot(ordered);
    if (ordered.length === 0) return { posts: [], nextCursor: null, caughtUp: true };
    const postIds = ordered.map((p) => p._id);
    const [reacted, originals, reposted, saved, mediaById] = await Promise.all([
      this.viewerReactions(viewer, postIds),
      // CN-FEED-1: embedded repost originals are gated for THIS viewer, so a
      // connections-only / blocked original never leaks via a public wrapper.
      this.loadOriginals(viewer, ordered),
      this.viewerReposts(viewer, ordered),
      this.viewerSaves(viewer, ordered),
      // PERF: the candidate windows are scanned media-LIGHT (see hydrateEntries +
      // discovery/*.source.ts); re-hydrate the heavy display `media` blob for ONLY
      // this rendered page so feed latency is independent of the candidate-pool
      // size (a fat inline-media post is 300KB+ over the wire).
      this.loadMediaByIds(postIds),
    ]);
    const items: FeedItem[] = ordered.map((p) => {
      const tag = originById?.get(String(p._id));
      const rootId = String(p.repostOf ?? p._id);
      const original = p.repostOf ? (originals.get(String(p.repostOf)) ?? null) : undefined;
      return this.stripInternal({
        ...p,
        // Media comes from the page-scoped re-hydration, not the media-light scan.
        media: mediaById.get(String(p._id)) ?? p.media ?? [],
        viewerReacted: reacted.has(String(p._id)),
        viewerReposted: reposted.has(rootId),
        viewerSaved: saved.has(rootId),
        origin: tag?.origin,
        reason: tag?.reason,
        original: original ? this.stripInternal({ ...original }) : original,
      });
    });
    return { posts: items, nextCursor, caughtUp };
  }

  /**
   * Drop fields the unfiltered `.lean()` read carries but the feed FE never reads
   * (serializer leakage). `authorDistrict` is a server-only GeoLocal ranking input
   * (not in the web `FeedPost` type, never rendered); `boostCampaignId` is an ads
   * lifecycle link (display-only, never feed-rendered); `updatedAt` + `__v` are
   * Mongo bookkeeping. Ranking has already run by the time `toPage` builds items,
   * so removing these from the RESPONSE never affects ordering. Mutates the passed
   * (freshly spread) copy in place — never the cached/source post.
   */
  private stripInternal<T extends object>(item: T): T {
    const rec = item as Record<string, unknown>;
    delete rec.authorDistrict;
    delete rec.boostCampaignId;
    delete rec.updatedAt;
    delete rec.__v;
    return item;
  }

  /**
   * The set of ROOT post ids (as strings) the viewer has plain-reposted among a
   * page's posts — drives each item's `viewerReposted` toggle state. Keyed by
   * root so a repost and its original agree.
   */
  private async viewerReposts(viewer: Types.ObjectId, posts: FeedPost[]): Promise<Set<string>> {
    const rootIds = [...new Set(posts.map((p) => String(p.repostOf ?? p._id)))].map(
      (id) => new Types.ObjectId(id),
    );
    if (rootIds.length === 0) return new Set();
    const rows = await this.postModel
      .find({ repostOf: { $in: rootIds }, authorId: viewer, body: '', deletedAt: null })
      .select('repostOf')
      .lean<Array<{ repostOf: Types.ObjectId }>>()
      .exec();
    return new Set(rows.map((r) => String(r.repostOf)));
  }

  /**
   * The set of ROOT post ids (as strings) the viewer has saved among a page's
   * posts. Keyed by root (a save bookmarks the content, not the repost wrapper),
   * so it mirrors `viewerReposts` and a repost + its original agree. Drives each
   * item's `viewerSaved` state.
   */
  private async viewerSaves(viewer: Types.ObjectId, posts: FeedPost[]): Promise<Set<string>> {
    const rootIds = [...new Set(posts.map((p) => String(p.repostOf ?? p._id)))].map(
      (id) => new Types.ObjectId(id),
    );
    if (rootIds.length === 0) return new Set();
    const rows = await this.savedPostModel
      .find({ userId: viewer, postId: { $in: rootIds } })
      .select('postId')
      .lean<Array<{ postId: Types.ObjectId }>>()
      .exec();
    return new Set(rows.map((r) => String(r.postId)));
  }

  /**
   * CN-FEED-12: drop discovery candidates whose post has since been soft-deleted
   * / taken down (the discovery pool cache can be up to ~60s stale). One indexed
   * `{_id:{$in}, deletedAt:null}` read; returns only the still-live candidates,
   * preserving order. A no-op on an empty list.
   */
  private async dropDeletedCandidates<T extends { post: { _id: Types.ObjectId } }>(
    candidates: T[],
  ): Promise<T[]> {
    if (candidates.length === 0) return candidates;
    const ids = candidates.map((c) => c.post._id);
    const live = await this.postModel
      .find({ _id: { $in: ids }, deletedAt: null })
      .select('_id')
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    const liveSet = new Set(live.map((p) => String(p._id)));
    return candidates.filter((c) => liveSet.has(String(c.post._id)));
  }

  /**
   * Batch-load the embedded ROOT originals for any reposts in a page.
   *
   * CN-FEED-1 (feed harden Bucket 1): the authenticated path previously embedded
   * an original filtered only by `deletedAt`, leaking a connections-only /
   * blocked-author original to a stranger who could see the (always-public)
   * repost wrapper. Every hydrated original is now run through the shared
   * `filterViewable` gate for THIS viewer; any that fail are simply left out of
   * the returned Map, so `toPage`'s existing `originals.get(...) ?? null`
   * fallback renders the FE's already-built "original unavailable" empty state
   * (identical to the since-deleted case). `postVisibility` is @Optional() in
   * the constructor, so a positional unit-test build with no gate falls back to
   * the prior deleted-only behavior — production DI always injects it.
   */
  private async loadOriginals(
    viewer: Types.ObjectId,
    posts: FeedPost[],
  ): Promise<Map<string, FeedPost>> {
    const ids = posts
      .map((p) => p.repostOf)
      .filter((id): id is Types.ObjectId => id !== null && id !== undefined);
    if (ids.length === 0) return new Map();
    const originals = await this.postModel
      .find({ _id: { $in: ids }, deletedAt: null })
      .lean<FeedPost[]>()
      .exec();
    const viewable = this.postVisibility
      ? await this.postVisibility.filterViewable(viewer, originals)
      : originals;
    return new Map(viewable.map((o) => [String(o._id), o]));
  }

  /**
   * Merge a ranked primary (in-network) list with a ranked secondary
   * (discovery) list, primary-favoured (~70/30): every 3rd slot is a discovery
   * item when one is available, else fill from primary. Falls back to
   * all-secondary when primary is empty (cold-start). Capped at `limit`.
   */
  private interleaveFeed(primary: FeedPost[], secondary: FeedPost[], limit: number): FeedPost[] {
    const out: FeedPost[] = [];
    let i = 0;
    let j = 0;
    while (out.length < limit && (i < primary.length || j < secondary.length)) {
      const discoverySlot = (out.length + 1) % 3 === 0;
      if (discoverySlot && j < secondary.length) {
        out.push(secondary[j++]);
      } else if (i < primary.length) {
        out.push(primary[i++]);
      } else if (j < secondary.length) {
        out.push(secondary[j++]);
      } else {
        break;
      }
    }
    return out;
  }

  /**
   * Author diversity — cap any single author to `maxPerAuthor` posts so the
   * feed never shows a wall from one prolific poster. Preserves rank order;
   * drops only the over-cap (lower-ranked) extras.
   */
  private diversify(posts: FeedPost[], maxPerAuthor: number): FeedPost[] {
    const perAuthor = new Map<string, number>();
    const out: FeedPost[] = [];
    for (const p of posts) {
      const author = String(p.authorId);
      const seen = perAuthor.get(author) ?? 0;
      if (seen >= maxPerAuthor) continue;
      perAuthor.set(author, seen + 1);
      out.push(p);
    }
    return out;
  }

  /**
   * Demo/sample cap — limit seeded demo posts to ~30% of a page so a thin early
   * network can't fill For-You with sample content, WITHOUT ever leaving the
   * page short: a demo post over the cap is dropped only if real (non-demo)
   * posts remain to take its place; otherwise it stays (better an example than a
   * gap while the community grows). Preserves rank order; pairs with the
   * read-time `applyDemoPenalty` down-rank (this is the hard ceiling on top of
   * the soft down-rank). `isDemo` is the same flag the FE "Sample" badge reads.
   */
  private capDemo(posts: FeedPost[]): FeedPost[] {
    const realCount = posts.filter((p) => p.isDemo !== true).length;
    // Allow demo up to 30% of the page, but never fewer than (pageSize-realCount)
    // so we still fill the page when there isn't enough real content.
    const maxDemo = Math.max(Math.floor(posts.length * 0.3), Math.max(0, posts.length - realCount));
    let demoUsed = 0;
    const out: FeedPost[] = [];
    for (const p of posts) {
      if (p.isDemo === true) {
        if (demoUsed >= maxDemo) continue;
        demoUsed += 1;
      }
      out.push(p);
    }
    return out;
  }

  // ── Negative signals ("show me less") ──────────────────────────────────

  /**
   * Record a client "show me less" signal (Phase 7c/7d). Idempotent.
   *   - `mute_author`    → stamps a +30d `expiresAt` so the mute auto-lifts (and
   *                        a re-apply refreshes the 30 days);
   *   - `hide_post`      → persists with no expiry;
   *   - `not_interested` → persists, then re-evaluates the author-derivation rule
   *                        (>= 3 of one author's posts marked in 90d auto-derives
   *                        a `not_interested_author` dampen — spec A3).
   *
   * `hide_post`, `not_interested`, and an active `mute_author` HARD-EXCLUDE from
   * BOTH tabs; `not_interested` ALSO dampens For-You scoring (the derived author
   * down-rank). Undo via `removeNegativeSignal`. Blocks (`UserBlock`) stay a
   * separate, absolute exclusion handled in `getBlockedUserIds`.
   */
  async addNegativeSignal(
    userId: string | Types.ObjectId,
    kind: ClientNegativeSignalKind,
    targetId: string,
  ): Promise<void> {
    return this.withSpan('connect.feed.addNegativeSignal', async () => {
      if (!Types.ObjectId.isValid(targetId)) {
        throw new NotFoundException('Target not found.');
      }
      const viewer = this.toObjectId(userId);
      const target = new Types.ObjectId(targetId);
      const filter = { viewerId: viewer, kind, targetId: target };
      // A mute carries a 30-day expiry (refreshed on re-apply via $set); every
      // other kind persists with a null expiry (the TTL index skips null dates).
      const expiresAt =
        kind === 'mute_author'
          ? new Date(Date.now() + MUTE_DURATION_DAYS * 24 * 60 * 60 * 1000)
          : null;
      await this.negativeModel
        .updateOne(filter, { $setOnInsert: filter, $set: { expiresAt } }, { upsert: true })
        .exec();
      // A new not-interested mark may cross the author-derivation threshold.
      if (kind === 'not_interested') {
        await this.refreshAuthorDerivation(viewer, target);
      }
    });
  }

  /**
   * Undo a client "show me less" signal (Phase 7d). Idempotent — undoing one that
   * was never set is a no-op. Undoing a not-interested mark re-evaluates the
   * author derivation (it may fall back under the threshold and lift the derived
   * author dampen).
   */
  async removeNegativeSignal(
    userId: string | Types.ObjectId,
    kind: ClientNegativeSignalKind,
    targetId: string,
  ): Promise<void> {
    return this.withSpan('connect.feed.removeNegativeSignal', async () => {
      if (!Types.ObjectId.isValid(targetId)) {
        throw new NotFoundException('Target not found.');
      }
      const viewer = this.toObjectId(userId);
      const target = new Types.ObjectId(targetId);
      await this.negativeModel.deleteOne({ viewerId: viewer, kind, targetId: target }).exec();
      if (kind === 'not_interested') {
        await this.refreshAuthorDerivation(viewer, target);
      }
    });
  }

  /**
   * Re-evaluate the DERIVED `not_interested_author` dampen for one author after a
   * not-interested mark on one of their posts is added or removed (spec A3).
   * Counts the viewer's DISTINCT not-interested post marks authored by that author
   * within the 90-day window; at/above the threshold it upserts the derived row
   * (a dampen, never an exclusion), below it removes any derived row. No-op when
   * the marked post is gone (e.g. an undo after the post was deleted).
   */
  private async refreshAuthorDerivation(
    viewer: Types.ObjectId,
    markedPostId: Types.ObjectId,
  ): Promise<void> {
    const post = await this.postModel
      .findOne({ _id: markedPostId })
      .select('authorId')
      .lean<{ authorId: Types.ObjectId }>()
      .exec();
    if (!post?.authorId) return;
    const author = post.authorId;
    const since = new Date(Date.now() - NOT_INTERESTED_AUTHOR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // The viewer's recent not-interested POST marks (bounded — a viewer's feedback
    // set is small; AFFINITY_SCAN_LIMIT is a safe shared cap).
    const marks = await this.negativeModel
      .find({ viewerId: viewer, kind: 'not_interested', createdAt: { $gte: since } })
      .select('targetId')
      .limit(AFFINITY_SCAN_LIMIT)
      .lean<Array<{ targetId: Types.ObjectId }>>()
      .exec();
    const markedPostIds = marks.map((m) => m.targetId);
    const posts = markedPostIds.length
      ? await this.postModel
          .find({ _id: { $in: markedPostIds } })
          .select('authorId')
          .lean<Array<{ _id: Types.ObjectId; authorId: Types.ObjectId }>>()
          .exec()
      : [];
    const count = posts.filter((p) => author.equals(p.authorId)).length;
    const derivedFilter = {
      viewerId: viewer,
      kind: 'not_interested_author' as const,
      targetId: author,
    };
    if (deriveAuthorDampen(count)) {
      await this.negativeModel
        .updateOne(
          derivedFilter,
          { $setOnInsert: { ...derivedFilter, expiresAt: null } },
          { upsert: true },
        )
        .exec();
    } else {
      await this.negativeModel.deleteOne(derivedFilter).exec();
    }
  }

  /**
   * Load the viewer's negative signals in ONE read and split them into the four
   * buckets the feed needs (Phase 7d), replacing the old separate
   * `getNegativeFilter` (hide/mute) + `buildDampening` (not-interested) reads:
   *
   *   HARD EXCLUSION (both tabs):
   *     - `hiddenPostIds`   — `hide_post` post ids + `not_interested` post ids
   *                           (not-interested also hides the post, not just dampens);
   *     - `mutedAuthorIds`  — `mute_author` author ids, only while unexpired.
   *   FOR-YOU DAMPEN (down-rank multipliers in (0,1], age-decayed):
   *     - `dampenByPost`    — `not_interested` post marks (kept alongside the
   *                           exclusion so the author-derivation signal still feeds the ranker);
   *     - `dampenByAuthor`  — derived `not_interested_author` marks.
   *
   * One indexed read per page regardless of page size (the per-viewer signal set
   * is small — the `{ viewerId: 1 }` index serves it). Read FRESH every page (NOT
   * cached) so a hide/mute/not-interested tapped between pages applies at once.
   */
  private async loadNegativeSignals(viewer: Types.ObjectId): Promise<{
    hiddenPostIds: Set<string>;
    mutedAuthorIds: Set<string>;
    dampenByPost: Map<string, number>;
    dampenByAuthor: Map<string, number>;
  }> {
    const rows = await this.negativeModel
      .find({ viewerId: viewer })
      .select('kind targetId expiresAt createdAt')
      .lean<
        Array<{
          kind: NegativeSignalKind;
          targetId: Types.ObjectId;
          expiresAt?: Date | null;
          createdAt?: Date;
        }>
      >()
      .exec();
    const now = Date.now();
    const hiddenPostIds = new Set<string>();
    const mutedAuthorIds = new Set<string>();
    const dampenByPost = new Map<string, number>();
    const dampenByAuthor = new Map<string, number>();
    for (const row of rows) {
      const id = String(row.targetId);
      switch (row.kind) {
        case 'hide_post':
          hiddenPostIds.add(id);
          break;
        case 'mute_author':
          // The TTL monitor can lag (~60s), so also skip an already-expired mute
          // at read time — a mute lifts exactly when its 30 days are up.
          if (!row.expiresAt || new Date(row.expiresAt).getTime() > now) {
            mutedAuthorIds.add(id);
          }
          break;
        case 'not_interested_author': {
          const ageDays = row.createdAt
            ? Math.max(0, (now - new Date(row.createdAt).getTime()) / 86_400_000)
            : 0;
          dampenByAuthor.set(id, dampenFactor(ageDays, NOT_INTERESTED_AUTHOR_FACTOR));
          break;
        }
        case 'not_interested': {
          // not-interested now does BOTH: hard-exclude this post from both tabs
          // (so a dismissed post never reappears on refresh, like hide_post) AND
          // keep its decayed For-You dampen below (the "show me less like this"
          // author-derivation signal still feeds the ranker via dampenByPost).
          hiddenPostIds.add(id);
          const ageDays = row.createdAt
            ? Math.max(0, (now - new Date(row.createdAt).getTime()) / 86_400_000)
            : 0;
          dampenByPost.set(id, dampenFactor(ageDays, NOT_INTERESTED_POST_FACTOR));
          break;
        }
      }
    }
    return { hiddenPostIds, mutedAuthorIds, dampenByPost, dampenByAuthor };
  }

  /**
   * The STABLE per-viewer For-You scoring inputs — base ranking signals
   * (skills / district / openTo) + the affinity map (B3) — cached for
   * `CANDIDATE_GEN_CACHE_TTL_MS` so back-to-back pages skip the profile +
   * engagement-edge reads. A cache miss runs both reads in parallel and stores
   * the native result (the affinity `Map` keeps its identity). The VOLATILE
   * feedback inputs (dampening / seen / hide / mute / block) are deliberately
   * NOT in here — `getFeed` reads those fresh and merges them on top, so they
   * apply instantly even on a warm cache. `now` is the request clock (testable).
   */
  private async getScoringInputs(
    viewer: Types.ObjectId,
    now: number,
  ): Promise<{ signals: RankingSignals; affinity: Map<string, number> }> {
    const key = String(viewer);
    const cached = this.scoringInputCache.get(key, now);
    if (cached) return cached;
    const [signals, affinity] = await Promise.all([
      this.profileService.getRankingSignals(viewer),
      this.getAffinityMap(viewer),
    ]);
    const value = { signals, affinity };
    this.scoringInputCache.set(key, value, now);
    return value;
  }

  /** Drop hidden posts + muted-author posts from a candidate set (hard exclusion,
   *  both tabs). No-op when empty. */
  private applyNegative(
    posts: FeedPost[],
    filter: { hiddenPostIds: Set<string>; mutedAuthorIds: Set<string> },
  ): FeedPost[] {
    if (filter.hiddenPostIds.size === 0 && filter.mutedAuthorIds.size === 0) return posts;
    return posts.filter(
      (p) =>
        !filter.hiddenPostIds.has(String(p._id)) && !filter.mutedAuthorIds.has(String(p.authorId)),
    );
  }

  // ── Impressions (post views + seen-suppression) ───────────────────────────

  /**
   * Record that a batch of posts entered the viewer's viewport. ONE viewport
   * signal drives two writes:
   *   1. a `view` `EngagementEdge` per (viewer, post) — idempotent; only the
   *      FIRST unique view bumps the post's denormalized `viewCount`;
   *   2. a `SeenPost` row — so the post is suppressed from the viewer's For-You
   *      discovery candidates (TTL-bounded).
   *
   * Self-views never count (an author viewing their own post). The post id list
   * is de-duped, validated, and capped at `VIEW_BATCH_MAX`. Idempotent — a
   * re-send of the same batch records no new views. OTel span only (high-volume
   * read-side signal — no PostHog noise).
   */
  async recordViews(
    viewerId: string | Types.ObjectId,
    postIds: string[],
  ): Promise<{ recorded: number }> {
    return this.withSpan('connect.feed.recordViews', async (span) => {
      const viewer = this.toObjectId(viewerId);
      const ids = [...new Set(postIds)]
        .filter((id) => Types.ObjectId.isValid(id))
        .slice(0, VIEW_BATCH_MAX)
        .map((id) => new Types.ObjectId(id));
      if (ids.length === 0) return { recorded: 0 };

      const posts = await this.postModel
        .find({ _id: { $in: ids }, deletedAt: null })
        .select('authorId visibility')
        .lean<
          Array<{ _id: Types.ObjectId; authorId: Types.ObjectId; visibility: PostVisibility }>
        >()
        .exec();
      // An author viewing their own post never counts as a view.
      const ownFiltered = posts.filter((p) => !viewer.equals(p.authorId));
      // CN-FEED-14 (Bucket 1): only record a view for a post the viewer may
      // actually see. A post the viewer cannot see (connections-only, blocked
      // either direction) silently drops out of `targets` exactly like an
      // already-self-viewed one — no distinguishable error, so this also closes
      // the "probe existence of connections-only ids" side-channel. Skipped only
      // in the positional unit-test build with no injected gate.
      const targets = this.postVisibility
        ? await this.postVisibility.filterViewable(
            viewer,
            ownFiltered.map((p) => ({ ...p, deletedAt: null })),
          )
        : ownFiltered;
      if (targets.length === 0) return { recorded: 0 };

      // 1. view edges — idempotent upsert per (viewer, post, 'view').
      const edgeRes = await this.engagementEdgeModel.bulkWrite(
        targets.map((p) => ({
          updateOne: {
            filter: { actorId: viewer, postId: p._id, type: 'view' as const },
            update: {
              $setOnInsert: {
                actorId: viewer,
                postId: p._id,
                authorId: p.authorId,
                type: 'view' as const,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      // Only NEW edges (a first unique view) bump the denormalized count. The
      // bulkWrite keys `upsertedIds` by op index → map back to the post ids.
      const insertedIdx = Object.keys(edgeRes?.upsertedIds ?? {});
      if (insertedIdx.length > 0) {
        const firstViewIds = insertedIdx.map((i) => targets[Number(i)]._id);
        await this.postModel
          .updateMany({ _id: { $in: firstViewIds } }, { $inc: { viewCount: 1 } })
          .exec();
      }

      // 2. seen rows — suppress these from future For-You discovery (TTL-bounded).
      await this.seenPostModel.bulkWrite(
        targets.map((p) => ({
          updateOne: {
            filter: { viewerId: viewer, postId: p._id },
            update: { $setOnInsert: { viewerId: viewer, postId: p._id, seenAt: new Date() } },
            upsert: true,
          },
        })),
        { ordered: false },
      );

      span.setAttribute('connect.views.recorded', targets.length);
      return { recorded: targets.length };
    });
  }

  /** The set of post ids (as strings) the viewer has recently seen. Bounded to
   *  the most-recent `SEEN_LOAD_LIMIT` (C3) so the read never loads an unbounded
   *  per-viewer set; older seen posts may resurface in discovery, which is fine. */
  private async getSeenPostIds(viewer: Types.ObjectId): Promise<Set<string>> {
    const rows = await this.seenPostModel
      .find({ viewerId: viewer })
      .select('postId')
      .sort({ seenAt: -1 })
      .limit(SEEN_LOAD_LIMIT)
      .lean<Array<{ postId: Types.ObjectId }>>()
      .exec();
    return new Set(rows.map((r) => String(r.postId)));
  }

  /** Mark posts as seen at SERVE time (C1) so the next page does not re-serve
   *  them. Idempotent upsert; fire-and-forget (a failure just risks a repeat). */
  private async markServedSeen(viewer: Types.ObjectId, postIds: Types.ObjectId[]): Promise<void> {
    if (postIds.length === 0) return;
    try {
      await this.seenPostModel.bulkWrite(
        postIds.map((postId) => ({
          updateOne: {
            filter: { viewerId: viewer, postId },
            update: { $setOnInsert: { viewerId: viewer, postId, seenAt: new Date() } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    } catch (err) {
      // Best-effort - never break a feed read on a seen-tracking write. Log so a
      // persistent failure (which silently degrades "already seen" dedup, making
      // users re-see posts) is visible. No PII; count + message only.
      this.logger.warn(
        `feed seen-post tracking write failed (${postIds.length} ids): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Dedup an original post and its reposts within one page (C2): a viewer should
   * never see both a root post and a repost of it (or two reposts of one root)
   * in the same page. Keys on the repost root (`repostOf ?? _id`); keeps the
   * first (highest-ranked) occurrence.
   */
  private dedupByRoot(posts: FeedPost[]): FeedPost[] {
    const seenRoots = new Set<string>();
    const out: FeedPost[] = [];
    for (const p of posts) {
      const root = String(p.repostOf ?? p._id);
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);
      out.push(p);
    }
    return out;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** The set of post ids (as strings) the viewer has reacted to. */
  private async viewerReactions(
    viewer: Types.ObjectId,
    postIds: Types.ObjectId[],
  ): Promise<Set<string>> {
    if (postIds.length === 0) return new Set();
    const rows = await this.reactionModel
      .find({ userId: viewer, postId: { $in: postIds } })
      .select('postId')
      .lean<Array<{ postId: Types.ObjectId }>>()
      .exec();
    return new Set(rows.map((r) => String(r.postId)));
  }

  /**
   * Resolve a post id to its ROOT post id, or 404 if the post is missing /
   * deleted. A repost re-targets its root (a repost is never itself a root), so
   * saves key by root: a bookmark survives the repost wrapper being removed and
   * always points at the real content. Mirrors the repost toggle's root keying.
   */
  private async resolveRootId(postId: string): Promise<Types.ObjectId> {
    if (!Types.ObjectId.isValid(postId)) throw new NotFoundException('Post not found.');
    const post = await this.postModel
      .findOne({ _id: new Types.ObjectId(postId), deletedAt: null })
      .select('repostOf')
      .lean<{ _id: Types.ObjectId; repostOf?: Types.ObjectId | null }>()
      .exec();
    if (!post) throw new NotFoundException('Post not found.');
    return post.repostOf ?? post._id;
  }

  /** Guard that the post payload matches its `kind`. */
  private validatePayload(dto: CreatePostDto): void {
    const mediaCount = dto.media?.length ?? 0;
    switch (dto.kind) {
      case 'text':
        if (!dto.body?.trim()) {
          throw new BadRequestException('Write something to share.');
        }
        break;
      case 'photo':
      case 'video':
      case 'document':
        if (mediaCount === 0) {
          throw new BadRequestException(`A ${dto.kind} post needs at least one attachment.`);
        }
        break;
      case 'voice':
        if (!dto.audio) {
          throw new BadRequestException('A voice post needs a recording.');
        }
        break;
    }
  }

  /** Parse `#hashtags` out of a post body — lowercased, de-duped, capped at 10. */
  private parseHashtags(body: string): string[] {
    const matches: string[] = body.match(/#[\p{L}\p{N}_]{1,50}/gu) ?? [];
    const tags = matches.map((m) => m.slice(1).toLowerCase());
    return [...new Set(tags)].slice(0, 10);
  }

  /** Fire one "you were tagged" alert per recipient (best-effort, batchable).
   *  Recipients are pre-deduped + self-skipped by MentionService. Links: feed ->
   *  notifications (connect.post_mentioned). Never blocks the post write. */
  private notifyMentioned(
    recipientUserIds: string[],
    actorId: Types.ObjectId,
    postId: string,
    body: string,
  ): void {
    for (const rid of recipientUserIds) {
      void this.notifications
        .dispatch({
          recipientId: rid,
          actorId,
          category: 'connect.post_mentioned',
          entityType: 'Post',
          entityId: postId,
          title: 'You were mentioned',
          message: body.trim().slice(0, 140),
          batchMessage: (count) => `${count} people mentioned you.`,
        })
        .catch(() => undefined);
    }
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    if (id instanceof Types.ObjectId) return id;
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid id.');
    }
    return new Types.ObjectId(id);
  }

  /** OpenTelemetry span wrapper — mirrors `NetworkService.withSpan`. */
  private async withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
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
