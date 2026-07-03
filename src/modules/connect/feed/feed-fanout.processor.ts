import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FeedEntry } from './schemas/feed-entry.schema';
import { Post } from './schemas/post.schema';
import { FEED_FANOUT_QUEUE, BACKFILL_LIMIT } from './feed.constants';
import { ConnectFeedGateway } from './connect-feed.gateway';
import { NetworkService } from '../network/network.service';
import type { FanoutJobData, BackfillJobData, GcJobData, FeedFanoutJobData } from './feed.service';

/** Followers processed per `bulkWrite` — caps the op size for a huge audience. */
const FANOUT_BATCH = 1000;

/**
 * Max fan-out/backfill jobs processed in parallel. Bounds concurrent Mongo
 * `bulkWrite` load (the memory/resource-management contract) while still
 * draining the queue faster than the BullMQ default of one-at-a-time.
 */
const FANOUT_CONCURRENCY = 5;

/**
 * ManekHR Connect — feed fan-out worker (Phase 3 — Feed, B4).
 *
 * Drains the `connect-feed-fanout` queue: for each new post it writes a
 * `FeedEntry` into every follower's feed (the author's own entry was already
 * written inline by `FeedService.createPost`). The write is an idempotent
 * upsert, so a BullMQ retry never duplicates an entry — the `{ ownerId,
 * postId }` unique index is the backstop.
 */
@Processor(FEED_FANOUT_QUEUE, { concurrency: FANOUT_CONCURRENCY })
export class FeedFanoutProcessor extends WorkerHost {
  private readonly logger = new Logger(FeedFanoutProcessor.name);

  constructor(
    @InjectModel(FeedEntry.name) private readonly feedEntryModel: Model<FeedEntry>,
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    private readonly networkService: NetworkService,
    private readonly gateway: ConnectFeedGateway,
  ) {
    super();
  }

  async process(job: Job<FeedFanoutJobData>): Promise<void> {
    if (job.data.kind === 'backfill') {
      await this.backfill(job.data);
      return;
    }
    if (job.data.kind === 'gc') {
      await this.gc(job.data);
      return;
    }
    await this.fanout(job.data);
  }

  /**
   * Unfollow garbage-collect: drop every `FeedEntry` the (now ex-)author placed
   * in the ex-follower's feed, so their posts leave that feed at once instead of
   * lingering until the TTL. Scoped to (ownerId, authorId); the unique
   * `{ownerId, postId}` index is not needed here — this is a bulk delete.
   */
  private async gc(data: GcJobData): Promise<void> {
    const res = await this.feedEntryModel.deleteMany({
      ownerId: new Types.ObjectId(data.ownerId),
      authorId: new Types.ObjectId(data.authorId),
    });
    this.logger.log(
      `GC removed ${res.deletedCount ?? 0} feed entr(ies) from ${data.ownerId} authored by ${data.authorId}.`,
    );
  }

  /**
   * Post-create fan-out: write a `FeedEntry` into every follower's feed PLUS
   * the author's own. The author is always a recipient — idempotent insurance
   * on top of the inline write in `FeedService.createPost`, so a post can never
   * be missing from its own author's feed. The `{ ownerId, postId }` unique
   * index makes a BullMQ retry a no-op.
   */
  private async fanout(data: FanoutJobData): Promise<void> {
    const { postId, authorId, postedAt, companyPageId } = data;
    const post = new Types.ObjectId(postId);
    const author = new Types.ObjectId(authorId);
    const when = new Date(postedAt);
    const pageId = companyPageId ? new Types.ObjectId(companyPageId) : null;

    // A page post fans out to the PAGE's followers; a personal post to the
    // author's. The author (page owner) is always a recipient of their own post.
    const followerIds = companyPageId
      ? await this.networkService.listCompanyPageFollowerIds(companyPageId)
      : await this.networkService.listFollowerIds(authorId);
    let recipients = Array.from(new Set([authorId, ...followerIds]));

    // B1 — write-time visibility gating: a `connections`-only PERSONAL post is
    // fanned out only to followers who are also the author's connections, so a
    // one-way follower never receives a FeedEntry for it (the read-time gate
    // stays as defense-in-depth). Company-page posts have no "connections"
    // concept, so the gate applies to personal posts only.
    if (!companyPageId && data.visibility === 'connections') {
      const connectionIds = new Set(
        (await this.networkService.listConnections(authorId)).map((c) => c.userId),
      );
      recipients = recipients.filter((id) => id === authorId || connectionIds.has(id));
    }

    let written = 0;
    for (let i = 0; i < recipients.length; i += FANOUT_BATCH) {
      const batch = recipients.slice(i, i + FANOUT_BATCH);
      const ops = batch.map((ownerId) => ({
        updateOne: {
          filter: { ownerId: new Types.ObjectId(ownerId), postId: post },
          update: { $setOnInsert: { authorId: author, postedAt: when, companyPageId: pageId } },
          upsert: true,
        },
      }));
      const res = await this.feedEntryModel.bulkWrite(ops, { ordered: false });
      written += res.upsertedCount ?? 0;
    }
    this.logger.log(`Fanned post ${postId} to ${written}/${recipients.length} feed(s).`);

    // Realtime — only the ACTUAL recipients (post-gating) get the "new post"
    // nudge, never the author, and never a non-connection follower of a
    // connections-only post.
    const recipientFollowers = recipients.filter((id) => id !== authorId);
    if (recipientFollowers.length > 0) {
      this.gateway.emitNewPost(recipientFollowers, { postId, authorId });
    }
  }

  /**
   * Connection-accept backfill: copy `authorId`'s most-recent posts into
   * `ownerId`'s feed so a freshly-connected member immediately sees the posts
   * their new connection made BEFORE they connected (write-time fan-out only
   * covers posts made AFTER the follow edge exists). Idempotent upsert.
   */
  private async backfill(data: BackfillJobData): Promise<void> {
    const owner = new Types.ObjectId(data.ownerId);
    const author = new Types.ObjectId(data.authorId);

    const posts = await this.postModel
      .find({ authorId: author, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(BACKFILL_LIMIT)
      .select('_id createdAt')
      .lean<Array<{ _id: Types.ObjectId; createdAt: Date }>>()
      .exec();
    if (posts.length === 0) return;

    const ops = posts.map((p) => ({
      updateOne: {
        filter: { ownerId: owner, postId: p._id },
        update: { $setOnInsert: { authorId: author, postedAt: p.createdAt } },
        upsert: true,
      },
    }));
    const res = await this.feedEntryModel.bulkWrite(ops, { ordered: false });
    this.logger.log(
      `Backfilled ${res.upsertedCount ?? 0}/${posts.length} post(s) from ${data.authorId} into ${data.ownerId}'s feed.`,
    );
  }
}
