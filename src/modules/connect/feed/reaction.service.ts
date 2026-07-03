import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { Reaction } from './schemas/reaction.schema';
import { Post, type PostVisibility } from './schemas/post.schema';
import { EngagementEdge } from './schemas/engagement-edge.schema';
import { ConnectFeedGateway } from './connect-feed.gateway';
import { NotificationsService } from '../../notifications/notifications.service';
import { PostVisibilityService } from './post-visibility.service';

/** The outcome of a react / unreact toggle — the new state + the post tally. */
export interface ReactionResult {
  /** True after `react`, false after `unreact`. */
  reacted: boolean;
  /** The post's reaction count after the toggle. */
  reactionCount: number;
}

/**
 * `ReactionService` — post reactions (Phase 3 — Feed).
 *
 * Phase 3 ships one reaction type (`like`). `react` is idempotent (an upsert,
 * so a double-tap never double-counts) and `unreact` tolerates a missing row;
 * the post's `reactionCount` is kept in step via `$inc` so a feed read never
 * has to count. Reaction-driven notifications are batched in Wave 5 (§12.3).
 */
@Injectable()
export class ReactionService {
  private readonly tracer = trace.getTracer('connect.feed');

  constructor(
    @InjectModel(Reaction.name) private readonly reactionModel: Model<Reaction>,
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(EngagementEdge.name)
    private readonly engagementEdgeModel: Model<EngagementEdge>,
    private readonly gateway: ConnectFeedGateway,
    private readonly notificationsService: NotificationsService,
    // Shared can-view/engage gate (feed harden Bucket 1). @Optional() so
    // positional unit-test constructors keep working; production DI injects it.
    // Gates react/unreact so a blocked user / non-connection on a
    // connections-only post cannot react (404, never confirms existence).
    @Optional()
    private readonly postVisibility: PostVisibilityService,
  ) {}

  /** Add the caller's `like` to a post. Idempotent. */
  async react(userId: string | Types.ObjectId, postId: string): Promise<ReactionResult> {
    return this.withSpan('connect.feed.react', async () => {
      const reactorId = this.toObjectId(userId);
      const post = await this.requireLivePost(postId, reactorId);
      const result = await this.reactionModel
        .updateOne(
          { postId: post._id, userId: reactorId },
          { $setOnInsert: { type: 'like' } },
          { upsert: true },
        )
        .exec();
      // Only a genuinely new row moves the tally — a repeat tap is a no-op.
      if (result.upsertedCount > 0) {
        const updated = await this.bumpCount(post._id, 1);
        // Unified engagement edge (network-out discovery + analytics) —
        // idempotent upsert; the react edge mirrors the like state and is
        // removed on unreact.
        await this.engagementEdgeModel
          .updateOne(
            { actorId: reactorId, postId: post._id, type: 'react' },
            { $setOnInsert: { authorId: post.authorId } },
            { upsert: true },
          )
          .exec();
        this.gateway.emitPostActivity({
          postId,
          reactionCount: updated,
          commentCount: post.commentCount,
        });
        // Notify the post author — best-effort, skip self-reacts.
        if (!reactorId.equals(post.authorId)) {
          void this.notificationsService
            .dispatch({
              recipientId: post.authorId,
              actorId: reactorId,
              category: 'connect.post_reacted',
              entityType: 'Post',
              entityId: postId,
              title: 'New reaction on your post',
              message: 'Liked your post.',
              batchMessage: (count) => `${count} people reacted to your post.`,
            })
            .catch(() => undefined);
        }
        return { reacted: true, reactionCount: updated };
      }
      return { reacted: true, reactionCount: post.reactionCount };
    });
  }

  /** Remove the caller's reaction from a post. Tolerates a missing reaction. */
  async unreact(userId: string | Types.ObjectId, postId: string): Promise<ReactionResult> {
    return this.withSpan('connect.feed.unreact', async () => {
      const post = await this.requireLivePost(postId, this.toObjectId(userId));
      const result = await this.reactionModel
        .deleteOne({ postId: post._id, userId: this.toObjectId(userId) })
        .exec();
      if (result.deletedCount > 0) {
        const updated = await this.bumpCount(post._id, -1);
        await this.engagementEdgeModel
          .deleteOne({ actorId: this.toObjectId(userId), postId: post._id, type: 'react' })
          .exec();
        this.gateway.emitPostActivity({
          postId,
          reactionCount: updated,
          commentCount: post.commentCount,
        });
        return { reacted: false, reactionCount: updated };
      }
      return { reacted: false, reactionCount: post.reactionCount };
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Load a non-deleted post or 404. Returns the `_id` + author + tallies.
   *
   *  CN-FEED-4 (feed harden Bucket 1): also runs the shared engage gate for
   *  `viewer`, so a blocked user (either direction) or a non-connection on a
   *  connections-only post 404s here (never 403) before any reaction write.
   *  Skipped only in the positional unit-test build with no injected gate. */
  private async requireLivePost(
    postId: string,
    viewer: Types.ObjectId,
  ): Promise<{
    _id: Types.ObjectId;
    authorId: Types.ObjectId;
    reactionCount: number;
    commentCount: number;
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
        visibility: PostVisibility;
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

  /**
   * Move a post's `reactionCount` by `delta` and return the new value. The
   * count is floored at 0 so a stray double-unreact cannot drive it negative.
   */
  private async bumpCount(postId: Types.ObjectId, delta: number): Promise<number> {
    const updated = await this.postModel
      .findByIdAndUpdate(postId, { $inc: { reactionCount: delta } }, { new: true })
      .select('reactionCount')
      .lean<{ reactionCount: number }>()
      .exec();
    const next = updated?.reactionCount ?? 0;
    if (next < 0) {
      await this.postModel.updateOne({ _id: postId }, { $set: { reactionCount: 0 } }).exec();
      return 0;
    }
    return next;
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
