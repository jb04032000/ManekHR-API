import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { FilterQuery, Model, Types } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { Comment } from './schemas/comment.schema';
import { Mention } from './schemas/mention.subschema';
import { Post } from './schemas/post.schema';
import { EngagementEdge } from './schemas/engagement-edge.schema';
import { ConnectFeedGateway } from './connect-feed.gateway';
import { NotificationsService } from '../../notifications/notifications.service';
import { MentionService, type MentionInput } from '../mention/mention.service';
import { PostVisibilityService } from './post-visibility.service';
import {
  CONTENT_TAKEDOWN_EVENT,
  type ContentTakedownEvent,
} from '../content-reports/content-reports.constants';
import {
  COMMENT_DUPLICATE_WINDOW_MS,
  COMMENT_RATE_LIMIT_DAY,
  COMMENT_RATE_LIMIT_SHORT,
  COMMENT_RATE_WINDOW_DAY_MS,
  COMMENT_RATE_WINDOW_SHORT_MS,
} from './feed.constants';
import {
  buildPage,
  clampPageSize,
  decodeCursor,
  keysetFilter,
  type KeysetRow,
} from '../common/keyset-cursor';

/** A comment as `.lean()` reads it — carries the keyset sort key + parentId.
 *  `mentions` rides through the lean read (no projection narrows it) so the FE
 *  can chip each "@<display>" token; absent on legacy rows written pre-tagging. */
type LeanComment = Comment &
  KeysetRow & {
    parentId: Types.ObjectId | null;
    authorId: Types.ObjectId;
    body: string;
    mentions?: Mention[];
  };

/** One page of a post's comment thread (envelope mirrors the feed's). */
export interface CommentsPage {
  /** Flat list the FE regroups by `parentId`: this page's top-level comments
   *  (newest-first) followed by their replies (oldest-first). */
  items: LeanComment[];
  /** Pass back as `?cursor=` for the next (older) page; `null` when caught up. */
  nextCursor: string | null;
}

/**
 * `CommentService` — post comments (Phase 3 — Feed).
 *
 * Threading is **one level deep**: a reply sets `parentId` to a TOP-LEVEL
 * comment, and `addComment` refuses a reply-to-a-reply. Comments soft-delete
 * (`deletedAt`) so a removed comment leaves its replies' thread intact; the
 * post's `commentCount` is kept in step via `$inc`.
 */
@Injectable()
export class CommentService {
  private readonly tracer = trace.getTracer('connect.feed');

  constructor(
    @InjectModel(Comment.name) private readonly commentModel: Model<Comment>,
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(EngagementEdge.name)
    private readonly engagementEdgeModel: Model<EngagementEdge>,
    private readonly gateway: ConnectFeedGateway,
    private readonly notificationsService: NotificationsService,
    // Resolves + gates @mentions (tags) on the comment write path and computes
    // each tag's link-ready href server-side. @Optional() so positional unit-test
    // constructors keep working; production DI always injects MentionService.
    @Optional()
    private readonly mentions: MentionService,
    // Shared can-view/engage gate (feed harden Bucket 1). @Optional() for the
    // same positional unit-test reason as `mentions`; production DI injects it.
    // Gates comment writes + comment-thread reads so a blocked user / a
    // non-connection on a connections-only post can neither comment nor read.
    @Optional()
    private readonly postVisibility: PostVisibilityService,
  ) {}

  /** Comment on a post, or reply (one level) to a top-level comment. */
  async addComment(
    userId: string | Types.ObjectId,
    postId: string,
    body: string,
    parentId?: string,
    mentions?: MentionInput[],
  ): Promise<Comment> {
    return this.withSpan('connect.feed.addComment', async () => {
      // CN-FEED-4: the engage gate runs inside requireLivePost against the
      // commenter, so a blocked commenter 404s before the write (which also
      // makes the "notify a blocking author" leak moot — the write never lands).
      const post = await this.requireLivePost(postId, this.toObjectId(userId));

      // When this is a reply, capture the parent comment's author so we can
      // notify them after the reply persists (skip-self handled below).
      let parentAuthorId: Types.ObjectId | null = null;
      if (parentId) {
        if (!Types.ObjectId.isValid(parentId)) {
          throw new NotFoundException('Parent comment not found.');
        }
        const parent = await this.commentModel
          .findOne({ _id: new Types.ObjectId(parentId), deletedAt: null })
          .select('postId parentId authorId')
          .lean<{
            postId: Types.ObjectId;
            parentId: Types.ObjectId | null;
            authorId: Types.ObjectId;
          }>()
          .exec();
        if (!parent) {
          throw new NotFoundException('Parent comment not found.');
        }
        if (!parent.postId.equals(post._id)) {
          throw new BadRequestException('That comment is on a different post.');
        }
        // One level only — a reply cannot itself be replied to.
        if (parent.parentId !== null) {
          throw new BadRequestException('Replies cannot be nested further.');
        }
        parentAuthorId = parent.authorId;
      }

      const commenterId = this.toObjectId(userId);

      // Per-(user,post) engagement anti-spam. Runs AFTER the post + parent
      // guards (so a 404/400 still wins) but BEFORE the write. The duplicate
      // check comes first so a retry of a just-posted comment is a graceful
      // no-op and never burns the member's rate budget or trips a 429.
      const dup = await this.findRecentDuplicate(commenterId, post._id, body);
      if (dup) return dup;
      await this.assertCommentRateLimit(commenterId, post._id);

      // Resolve + gate the @mentions (tags): validates each "@<display>" against
      // the body, enforces block/visibility/cap rules, computes link-ready hrefs
      // server-side, and returns the dedup'd notification recipients (self skipped).
      // Reach gate uses the POST AUTHOR's audience (5th arg), not the commenter's:
      // on a connections-only post you can only tag someone who can SEE that post
      // (a connection of the author), never just a connection of the commenter -
      // otherwise the tag + its notification snippet would leak the post to an
      // out-of-audience person. Block + self-skip still key off the commenter.
      const { stored: resolvedMentions, recipientUserIds } = await this.mentions.resolveForWrite(
        commenterId,
        body.trim(),
        mentions,
        post.visibility,
        post.authorId,
      );

      const comment = await this.commentModel.create({
        postId: post._id,
        authorId: commenterId,
        body: body.trim(),
        parentId: parentId ? new Types.ObjectId(parentId) : null,
        mentions: resolvedMentions,
      });
      await this.postModel.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } }).exec();
      // Unified engagement edge — the "commented on" signal for network-out
      // discovery + analytics (idempotent: one comment edge per actor-post).
      await this.engagementEdgeModel
        .updateOne(
          { actorId: commenterId, postId: post._id, type: 'comment' },
          { $setOnInsert: { authorId: post.authorId } },
          { upsert: true },
        )
        .exec();
      this.gateway.emitPostActivity({
        postId,
        reactionCount: post.reactionCount,
        commentCount: post.commentCount + 1,
      });
      // Notify the post author of the new comment (best-effort), skip
      // self-comments. Fires for top-level comments AND replies (a reply is
      // still activity on their post).
      if (!commenterId.equals(post.authorId)) {
        void this.notificationsService
          .dispatch({
            recipientId: post.authorId,
            actorId: commenterId,
            category: 'connect.post_commented',
            entityType: 'Post',
            entityId: postId,
            title: 'New comment on your post',
            message: body.trim().slice(0, 140),
            batchMessage: (count) => `${count} people commented on your post.`,
          })
          .catch(() => undefined);
      }
      // Notify the PARENT comment author of a reply (best-effort). Skip when
      // the replier is the parent author (self-reply), and when the parent
      // author is also the post author (already notified just above, so no
      // double-ping for one reply).
      if (
        parentAuthorId &&
        !commenterId.equals(parentAuthorId) &&
        !parentAuthorId.equals(post.authorId)
      ) {
        void this.notificationsService
          .dispatch({
            recipientId: parentAuthorId,
            actorId: commenterId,
            category: 'connect.post_replied',
            entityType: 'Post',
            entityId: postId,
            title: 'New reply to your comment',
            message: body.trim().slice(0, 140),
            batchMessage: (count) => `${count} people replied to your comment.`,
          })
          .catch(() => undefined);
      }
      // Tag alerts: notify each tagged party once. Skip self, the post author,
      // and the parent-comment author (all already handled above) so one comment
      // never double-pings the same person. Best-effort - never blocks the write.
      const alreadyNotified = new Set<string>([
        String(commenterId),
        String(post.authorId),
        ...(parentAuthorId ? [String(parentAuthorId)] : []),
      ]);
      for (const rid of recipientUserIds) {
        if (alreadyNotified.has(rid)) continue;
        void this.notificationsService
          .dispatch({
            recipientId: rid,
            actorId: commenterId,
            category: 'connect.post_mentioned',
            entityType: 'Post',
            entityId: postId,
            title: 'You were mentioned',
            message: body.trim().slice(0, 140),
            batchMessage: (count) => `${count} people mentioned you.`,
          })
          .catch(() => undefined);
      }
      return comment;
    });
  }

  /**
   * One page of a post's comment thread. TOP-LEVEL comments are keyset-paginated
   * newest-first (createdAt desc, `_id` desc tiebreak — the feed convention plus
   * the tiebreak a busy thread needs); each page carries ITS top-level comments'
   * replies too, so a parent and its replies never split across a page boundary
   * (the FE regroups the flat `items` list by `parentId`). Replies are one level
   * deep and ride with their parent un-paginated (bounded in practice). Default
   * 20 top-level comments per page, max 50.
   */
  async listComments(
    postId: string,
    viewerId: string | Types.ObjectId,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<CommentsPage> {
    if (!Types.ObjectId.isValid(postId)) {
      throw new NotFoundException('Post not found.');
    }
    const post = new Types.ObjectId(postId);
    const viewer = this.toObjectId(viewerId);
    // CN-FEED-5 (feed harden Bucket 1): a non-connection must not read the
    // comment thread of a connections-only post, and a blocked user (either
    // direction) must not read the blocker's post's thread. One extra indexed
    // point-read (same shape as requireLivePost), then the shared view gate —
    // 404 on failure (never confirm a hidden post's existence). Skipped only in
    // the positional unit-test build with no injected gate.
    if (this.postVisibility) {
      const target = await this.postModel
        .findOne({ _id: post, deletedAt: null })
        .select('authorId visibility')
        .lean<{
          _id: Types.ObjectId;
          authorId: Types.ObjectId;
          visibility: 'public' | 'connections';
        }>()
        .exec();
      if (
        !target ||
        !(await this.postVisibility.canViewPost(viewer, {
          _id: target._id,
          authorId: target.authorId,
          visibility: target.visibility,
          deletedAt: null,
        }))
      ) {
        throw new NotFoundException('Post not found.');
      }
    }
    const limit = clampPageSize(opts.limit);
    const cursor = decodeCursor(opts.cursor);

    // Over-fetch by one to detect a further page without a count query.
    const topFilter: FilterQuery<Comment> = {
      postId: post,
      parentId: null,
      deletedAt: null,
      ...keysetFilter(cursor),
    };
    const topWindow = await this.commentModel
      .find(topFilter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean<LeanComment[]>()
      .exec();
    const { items: top, nextCursor } = buildPage(topWindow, limit);

    // Replies for exactly the page's top-level comments, oldest-first (natural
    // reading order within a thread). Empty when the page has no top-level rows.
    const replies = top.length
      ? await this.commentModel
          .find({
            postId: post,
            parentId: { $in: top.map((c) => c._id) },
            deletedAt: null,
          })
          .sort({ createdAt: 1, _id: 1 })
          // Hard cap so a post with many replies can't return thousands of docs.
          .limit(500)
          .lean<LeanComment[]>()
          .exec()
      : [];

    return { items: [...top, ...replies], nextCursor };
  }

  /** Soft-delete a comment. Only its author may delete it. */
  async deleteComment(userId: string | Types.ObjectId, commentId: string): Promise<void> {
    return this.withSpan('connect.feed.deleteComment', async () => {
      if (!Types.ObjectId.isValid(commentId)) {
        throw new NotFoundException('Comment not found.');
      }
      const comment = await this.commentModel.findById(new Types.ObjectId(commentId)).exec();
      if (!comment || comment.deletedAt) {
        throw new NotFoundException('Comment not found.');
      }
      if (!(comment.authorId as Types.ObjectId).equals(this.toObjectId(userId))) {
        throw new ForbiddenException('You can only delete your own comment.');
      }
      await this.softDeleteComment(comment._id);
    });
  }

  /**
   * Moderation takedown of a reported comment (CN-MOD-2, feed harden Bucket 6).
   *
   * The `content-reports` module's admin "Remove" action emits
   * CONTENT_TAKEDOWN_EVENT; the comment module owns the reaction for its own
   * `targetType`, exactly like feed.service (post) + listing-moderation (listing)
   * already do (shared abstraction #3 — reuse the existing dispatch pattern, no
   * new shared helper). Runs the SAME cascade as an author-initiated delete
   * (soft-delete + commentCount decrement + realtime count push) via the shared
   * `softDeleteComment` tail, just without the author-only ForbiddenException —
   * mirroring how feed.service.onContentTakedown reuses `deletePost`.
   *
   * Cross-module link: content-reports.service emits the event on admin remove;
   * the admin already audits the action there, so no extra audit here. Idempotent
   * (a re-fire on an already-removed comment is a no-op via the guard below).
   */
  @OnEvent(CONTENT_TAKEDOWN_EVENT)
  async onContentTakedown(e: ContentTakedownEvent): Promise<void> {
    if (e.targetType !== 'comment') return;
    if (!Types.ObjectId.isValid(e.targetId)) return;
    await this.softDeleteComment(new Types.ObjectId(e.targetId));
  }

  /**
   * Shared soft-delete cascade for a comment id: flip `deletedAt`, decrement the
   * post's `commentCount` (floored at 0), and push the refreshed counts to the
   * post's realtime watchers. A no-op when the comment is missing or already
   * removed — so both the author-delete path and the admin-takedown path are
   * safe to call it, and a redundant takedown never double-decrements the count.
   */
  private async softDeleteComment(commentId: Types.ObjectId): Promise<void> {
    const comment = await this.commentModel.findById(commentId).exec();
    if (!comment || comment.deletedAt) return;
    comment.deletedAt = new Date();
    await comment.save();
    await this.postModel
      .updateOne({ _id: comment.postId, commentCount: { $gt: 0 } }, { $inc: { commentCount: -1 } })
      .exec();

    // Realtime — broadcast the post's refreshed counts to its watchers.
    const fresh = await this.postModel
      .findById(comment.postId)
      .select('reactionCount commentCount')
      .lean<{ _id: Types.ObjectId; reactionCount: number; commentCount: number }>()
      .exec();
    if (fresh) {
      this.gateway.emitPostActivity({
        postId: String(fresh._id),
        reactionCount: fresh.reactionCount,
        commentCount: fresh.commentCount,
      });
    }
  }

  // ── Anti-spam helpers ──────────────────────────────────────────────────

  /**
   * Collapse a comment body to its anti-spam canonical form: trim the ends and
   * fold every run of whitespace to a single space. Two submissions that differ
   * only in spacing / trailing newlines hash to the same string, so a retry
   * that re-serialized the text slightly differently is still caught as a dup.
   */
  private normalizeBody(body: string): string {
    return body.trim().replace(/\s+/g, ' ');
  }

  /**
   * Duplicate-rejection (B): if this member posted the SAME normalized body on
   * THIS post within the last {@link COMMENT_DUPLICATE_WINDOW_MS}, return that
   * existing comment instead of creating a second row. Returning the prior
   * comment (rather than a 409) is the gentler contract for the FE — a
   * double-tap / fast network retry just resolves to the comment the user
   * already sees, with no error toast. The window is short and the
   * `authorId + postId + createdAt` index keeps this a tiny, bounded read.
   */
  private async findRecentDuplicate(
    authorId: Types.ObjectId,
    postId: Types.ObjectId,
    body: string,
  ): Promise<Comment | null> {
    const since = new Date(Date.now() - COMMENT_DUPLICATE_WINDOW_MS);
    const recent = await this.commentModel
      .find({ authorId, postId, createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      // The short-window rate cap bounds how many rows can exist here; a small
      // ceiling keeps the scan trivial even at the edge.
      .limit(COMMENT_RATE_LIMIT_SHORT)
      .exec();
    const normalized = this.normalizeBody(body);
    return recent.find((c) => this.normalizeBody(c.body) === normalized) ?? null;
  }

  /**
   * Per-(user,post) rate limit (A): a member may post at most
   * {@link COMMENT_RATE_LIMIT_SHORT} comments on one post per
   * {@link COMMENT_RATE_WINDOW_SHORT_MS} and {@link COMMENT_RATE_LIMIT_DAY} per
   * {@link COMMENT_RATE_WINDOW_DAY_MS}. Counts the member's own comments on the
   * post from the comments collection (indexed `authorId + postId + createdAt`).
   * Deleted comments are intentionally still counted — otherwise a spammer could
   * delete-and-repost to slip the cap. Over the limit → a friendly 429 mirroring
   * the inbox rate-limit error shape (`{ code, message }`).
   */
  private async assertCommentRateLimit(
    authorId: Types.ObjectId,
    postId: Types.ObjectId,
  ): Promise<void> {
    const now = Date.now();
    const shortCount = await this.commentModel
      .countDocuments({
        authorId,
        postId,
        createdAt: { $gte: new Date(now - COMMENT_RATE_WINDOW_SHORT_MS) },
      })
      .exec();
    if (shortCount >= COMMENT_RATE_LIMIT_SHORT) {
      throw new HttpException(
        {
          code: 'CONNECT_COMMENT_RATE_LIMITED',
          message:
            'You are commenting on this post too quickly. Please wait a moment and try again.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const dayCount = await this.commentModel
      .countDocuments({
        authorId,
        postId,
        createdAt: { $gte: new Date(now - COMMENT_RATE_WINDOW_DAY_MS) },
      })
      .exec();
    if (dayCount >= COMMENT_RATE_LIMIT_DAY) {
      throw new HttpException(
        {
          code: 'CONNECT_COMMENT_DAILY_LIMIT',
          message: "You have reached today's comment limit for this post. Try again tomorrow.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Load a non-deleted post or 404 — with author + tallies for the realtime
   *  emit + notification, plus `visibility` for the @mention reach gate.
   *
   *  CN-FEED-4 (feed harden Bucket 1): also runs the shared engage gate for
   *  `viewer`, so a blocked user (either direction) or a non-connection on a
   *  connections-only post 404s here (never 403 — never confirm a hidden post's
   *  existence) before any comment write. Skipped only in the positional
   *  unit-test build with no injected gate; production DI always injects it. */
  private async requireLivePost(
    postId: string,
    viewer: Types.ObjectId,
  ): Promise<{
    _id: Types.ObjectId;
    authorId: Types.ObjectId;
    reactionCount: number;
    commentCount: number;
    visibility: 'public' | 'connections';
  }> {
    if (!Types.ObjectId.isValid(postId)) {
      throw new NotFoundException('Post not found.');
    }
    const post = await this.postModel
      .findOne({ _id: new Types.ObjectId(postId), deletedAt: null })
      .select('authorId reactionCount commentCount visibility')
      .lean<{
        _id: Types.ObjectId;
        authorId: Types.ObjectId;
        reactionCount: number;
        commentCount: number;
        visibility: 'public' | 'connections';
      }>()
      .exec();
    if (!post) throw new NotFoundException('Post not found.');
    if (
      this.postVisibility &&
      !(await this.postVisibility.canEngagePost(viewer, {
        _id: post._id,
        authorId: post.authorId,
        visibility: post.visibility,
        deletedAt: null,
      }))
    ) {
      throw new NotFoundException('Post not found.');
    }
    return post;
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
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
