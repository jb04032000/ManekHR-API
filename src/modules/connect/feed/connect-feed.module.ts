import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Post, PostSchema } from './schemas/post.schema';
import { Reaction, ReactionSchema } from './schemas/reaction.schema';
import { Comment, CommentSchema } from './schemas/comment.schema';
import { FeedEntry, FeedEntrySchema } from './schemas/feed-entry.schema';
import { EngagementEdge, EngagementEdgeSchema } from './schemas/engagement-edge.schema';
import { SeenPost, SeenPostSchema } from './schemas/seen-post.schema';
import { SavedPost, SavedPostSchema } from './schemas/saved-post.schema';
import {
  FeedNegativeSignal,
  FeedNegativeSignalSchema,
} from './schemas/feed-negative-signal.schema';
import { UserBlock, UserBlockSchema } from '../inbox/schemas/user-block.schema';
import { TrendingPost, TrendingPostSchema } from './schemas/trending-post.schema';
import { TrendingRefreshService } from './discovery/trending-refresh.service';
import { FEED_FANOUT_QUEUE } from './feed.constants';
import { FeedService } from './feed.service';
import { ReactionService } from './reaction.service';
import { CommentService } from './comment.service';
import { PostVisibilityService } from './post-visibility.service';
import { FeedFanoutProcessor } from './feed-fanout.processor';
import { ConnectFeedGateway } from './connect-feed.gateway';
import { FeedController, FeedPublicController } from './feed.controller';
import { ConnectProfileActivityPublicController } from './connect-profile-activity.controller';
import { ConnectCompanyPageActivityPublicController } from './connect-company-page-activity.controller';
import { feedRankingProviders } from './ranking/feed-ranking.providers';
import { CANDIDATE_SOURCES } from './discovery/candidate-source.interface';
import { TrendingSource } from './discovery/trending.source';
import { TopicMatchSource } from './discovery/topic-match.source';
import { NetworkOutSource } from './discovery/network-out.source';
import { GeoLocalSource } from './discovery/geo-local.source';
import { FeedDiscoveryService } from './discovery/feed-discovery.service';
import { AuditModule } from '../../audit/audit.module';
import { ConnectProfileModule } from '../profile/connect-profile.module';
import { ConnectNetworkModule } from '../network/connect-network.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ConnectTagsModule } from '../tags/connect-tags.module';
import { ConnectEntitiesModule } from '../entities/entities.module';
import { MediaOwnershipModule } from '../../uploads/media-ownership.module';
import { MentionModule } from '../mention/mention.module';

/**
 * ManekHR Connect — Feed module (Phase 3).
 *
 * Owns the feed collections — `Post`, `Reaction`, `Comment`, `FeedEntry` — the
 * feed / reaction / comment services, the `connect-feed-fanout` BullMQ worker,
 * the `ConnectFeedGateway` (Socket.IO realtime), and the `/me/connect/feed` +
 * public `/connect/posts` controllers.
 *
 * `JwtModule` (the access secret, no default sign options) is registered for
 * the gateway's socket-ticket verification + the `realtime/ticket` mint.
 * `BullModule.registerQueue` binds the fan-out queue to the global Bull
 * connection (`BullModule.forRootAsync` in `app.module.ts`).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Post.name, schema: PostSchema },
      { name: Reaction.name, schema: ReactionSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: FeedEntry.name, schema: FeedEntrySchema },
      { name: EngagementEdge.name, schema: EngagementEdgeSchema },
      { name: SeenPost.name, schema: SeenPostSchema },
      { name: SavedPost.name, schema: SavedPostSchema },
      { name: FeedNegativeSignal.name, schema: FeedNegativeSignalSchema },
      // Read-only here — the feed consults user blocks so a blocked viewer never
      // sees the blocker's posts (the model is owned/written by the inbox module).
      { name: UserBlock.name, schema: UserBlockSchema },
      // Materialized trending set (B2) — written by TrendingRefreshService, read
      // by TrendingSource.
      { name: TrendingPost.name, schema: TrendingPostSchema },
    ]),
    BullModule.registerQueue({ name: FEED_FANOUT_QUEUE }),
    // The ranking-strategy provider factory injects ConfigService to read
    // `connectFeed.rankingStrategy`.
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
      }),
      inject: [ConfigService],
    }),
    AuditModule,
    ConnectProfileModule,
    ConnectNetworkModule,
    // Page posts: createPost verifies page ownership via CompanyPageService.
    ConnectEntitiesModule,
    // Phase 7a — reaction + comment services dispatch notifications to post author.
    NotificationsModule,
    // S1.3: FeedService normalizes hashtags through TagService.
    ConnectTagsModule,
    // createPost enforces media-URL ownership via the shared MediaOwnershipService.
    MediaOwnershipModule,
    // createPost/editPost resolve + gate @mentions (tags) via MentionService.
    MentionModule,
  ],
  controllers: [
    FeedController,
    FeedPublicController,
    ConnectProfileActivityPublicController,
    ConnectCompanyPageActivityPublicController,
  ],
  providers: [
    FeedService,
    ReactionService,
    CommentService,
    // Shared abstraction #1 (feed harden Bucket 1) — the single can-view/engage
    // gate reused by feed/comment/reaction/gateway. Reads UserBlock (inbox) +
    // NetworkService (network), both already provided to this module.
    PostVisibilityService,
    FeedFanoutProcessor,
    ConnectFeedGateway,
    ...feedRankingProviders,
    // Phase 7c — discovery candidate sources + orchestrator. The
    // CANDIDATE_SOURCES array is the registry the orchestrator fans out to;
    // new sources (topic, geo, sponsored…) append here with no read-path change.
    TrendingSource,
    TrendingRefreshService,
    TopicMatchSource,
    NetworkOutSource,
    GeoLocalSource,
    {
      provide: CANDIDATE_SOURCES,
      useFactory: (
        trending: TrendingSource,
        topic: TopicMatchSource,
        networkOut: NetworkOutSource,
        geo: GeoLocalSource,
      ) => [trending, topic, networkOut, geo],
      inject: [TrendingSource, TopicMatchSource, NetworkOutSource, GeoLocalSource],
    },
    FeedDiscoveryService,
  ],
  exports: [MongooseModule],
})
export class ConnectFeedModule {}
