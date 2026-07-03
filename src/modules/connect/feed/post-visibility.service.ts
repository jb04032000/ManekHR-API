import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Post, type PostVisibility } from './schemas/post.schema';
import { UserBlock, type UserBlockDocument } from '../inbox/schemas/user-block.schema';
import { NetworkService } from '../network/network.service';

/**
 * The minimal shape a post must expose to be run through the visibility gate.
 * A `.lean()` Post (or any projection that carries these three fields) satisfies
 * it, so callers pass whatever slim doc they already hold — no re-read needed.
 */
export interface ViewablePost {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  visibility: PostVisibility; // 'public' | 'connections'
  deletedAt?: Date | null;
}

/**
 * Shared abstraction #1 (Connect feed harden, Bucket 1) — the SINGLE place that
 * answers "can this viewer see / engage with this post."
 *
 * Why this exists: the public feed path already filtered visibility+block on an
 * embedded repost original, but the authenticated path (repost, comment, react,
 * comment-thread reads, view recording, the realtime watch join) did not — six
 * separate leaks of connections-only / blocked-author posts. Consolidating the
 * check here means every one of those call sites agrees on exactly one contract.
 *
 * Semantics are DERIVED from (and kept identical to) `FeedService.gateVisibility`
 * + `getBlockedUserIds`, which stay the batch/page source of truth for the feed
 * read itself — this service only generalizes that same logic so per-item call
 * sites (repost/comment/react/view/watch) can reuse it. Keep the two in sync: a
 * change to what "visible" means must land in both, or the feed page and the
 * engagement endpoints will disagree.
 *
 * Cross-module links: reads `UserBlock` (owned/written by the inbox module) and
 * `NetworkService.listConnections` (the network module). Injected into
 * `FeedService`, `CommentService`, `ReactionService`, and `ConnectFeedGateway`.
 * NOTE (author-active): this gate deliberately does NOT check whether the post's
 * author is still an active account — no existing feed path does, so adding it
 * would be a scope-expanding behavior change (owner decision OQ-1, 2026-07-02:
 * deferred to a separate pass).
 */
@Injectable()
export class PostVisibilityService {
  constructor(
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(UserBlock.name)
    private readonly userBlockModel: Model<UserBlockDocument>,
    private readonly network: NetworkService,
  ) {}

  /**
   * True when `viewer` may READ this post (feed embed, comment thread, view
   * count, realtime watch). Order matches the batch path: soft-deleted first,
   * then block (either direction), then connections-only audience.
   */
  async canViewPost(viewer: Types.ObjectId, post: ViewablePost): Promise<boolean> {
    // 1. Soft-deleted / moderation-removed (takedown reuses the same
    //    `deletedAt` soft-delete, so this one check covers both).
    if (post.deletedAt != null) return false;
    // The viewer's own post is always visible to them, regardless of audience —
    // mirrors gateVisibility's `viewer.equals(p.authorId)` carve-out. (A block
    // against yourself is impossible, so the self case short-circuits cleanly.)
    if (viewer.equals(post.authorId)) return true;
    // 2. Block in EITHER direction — symmetric, matches getBlockedUserIds.
    if (await this.isBlockedEitherWay(viewer, post.authorId)) return false;
    // 3. Connections-only audience — viewer must be a connection of the author.
    if (post.visibility === 'connections') {
      return this.isConnection(viewer, post.authorId);
    }
    return true;
  }

  /**
   * True when `viewer` may ENGAGE with this post (react, comment, repost, save).
   * Today engagement never had a rule broader than visibility, so this is a
   * straight delegate to `canViewPost` — kept as a distinct exported name (not
   * an alias) so a future engagement-only rule has one obvious seam without a
   * breaking rename. YAGNI to diverge them now.
   */
  async canEngagePost(viewer: Types.ObjectId, post: ViewablePost): Promise<boolean> {
    return this.canViewPost(viewer, post);
  }

  /**
   * Batch form for page-level filtering (feed / activity / saved / view-record).
   * One block read + at most one connection read for the whole page (the
   * connection read runs ONLY when a connections-only post is actually present),
   * mirroring `getBlockedUserIds` + `gateVisibility` consolidated into one call.
   */
  async filterViewable<T extends ViewablePost>(viewer: Types.ObjectId, posts: T[]): Promise<T[]> {
    if (posts.length === 0) return posts;
    const blocked = await this.getBlockedUserIds(viewer);
    // Only pay for the connection lookup if a restricted (not-own) post is here.
    const hasRestricted = posts.some(
      (p) => p.visibility === 'connections' && !viewer.equals(p.authorId),
    );
    const connectionIds = hasRestricted ? await this.connectionIdSet(viewer) : new Set<string>();
    return posts.filter((p) => {
      if (p.deletedAt != null) return false;
      if (viewer.equals(p.authorId)) return true;
      if (blocked.has(String(p.authorId))) return false;
      if (p.visibility === 'connections') return connectionIds.has(String(p.authorId));
      return true;
    });
  }

  /**
   * Convenience for callers that hold only a post id string (the realtime
   * gateway's `post:watch` join): load the post's gate fields and answer
   * `canViewPost`. Returns false for a missing / soft-deleted post so a stranger
   * cannot even confirm the id exists. Keeps the PostModel read in this service
   * so the gateway needs no model wiring of its own.
   */
  async canWatchPostId(viewer: Types.ObjectId, postId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(postId)) return false;
    const post = await this.postModel
      .findOne({ _id: new Types.ObjectId(postId), deletedAt: null })
      .select('authorId visibility')
      .lean<{ _id: Types.ObjectId; authorId: Types.ObjectId; visibility: PostVisibility }>()
      .exec();
    if (!post) return false;
    return this.canViewPost(viewer, {
      _id: post._id,
      authorId: post.authorId,
      visibility: post.visibility,
      deletedAt: null,
    });
  }

  // ── internals (kept identical to FeedService's private versions) ──────────

  /** Blocked in either direction (viewer blocked them, or they blocked viewer). */
  private async isBlockedEitherWay(a: Types.ObjectId, b: Types.ObjectId): Promise<boolean> {
    const row = await this.userBlockModel
      .exists({
        $or: [
          { blockerUserId: a, blockedUserId: b },
          { blockerUserId: b, blockedUserId: a },
        ],
      })
      .exec();
    return row != null;
  }

  /** Is `viewer` a connection of `author`? One indexed membership check. */
  private async isConnection(viewer: Types.ObjectId, author: Types.ObjectId): Promise<boolean> {
    const connectionIds = await this.connectionIdSet(author);
    return connectionIds.has(String(viewer));
  }

  private async connectionIdSet(userId: Types.ObjectId): Promise<Set<string>> {
    const connections = await this.network.listConnections(userId);
    return new Set(connections.map((c) => c.userId));
  }

  /** The user ids blocked in either direction — the batch analogue of the
   *  single-pair check, identical to `FeedService.getBlockedUserIds`. */
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
}
