import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectionRequest, ConnectionRequestSchema } from './schemas/connection-request.schema';
import { Connection, ConnectionSchema } from './schemas/connection.schema';
import { Follow, FollowSchema } from './schemas/follow.schema';
import { Party, PartySchema } from '../../finance/parties/party.schema';
import { NetworkService } from './network.service';
import { SuggestionService } from './suggestion.service';
import { NetworkController, ConnectNetworkPublicController } from './network.controller';
import { AuditModule } from '../../audit/audit.module';
import { ConnectProfileModule } from '../profile/connect-profile.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { BullModule } from '@nestjs/bullmq';
import { FEED_FANOUT_QUEUE } from '../feed/feed.constants';

/**
 * ManekHR Connect — Network module (Phase 2).
 *
 * Owns the professional-graph collections — `ConnectionRequest`, `Connection`,
 * `Follow` — plus `NetworkService` and the `/me/connect/network` controller.
 * Mongo adjacency, no graph DB (`connect-build-plan.md`).
 *
 * `AuditModule` for write-event logging. `PostHogService` is `@Global()`, so
 * no PostHog import is needed. `NetworkService` + `MongooseModule` are exported
 * so later waves (suggestions, the public-profile relationship state) can read
 * the graph.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ConnectionRequest.name, schema: ConnectionRequestSchema },
      { name: Connection.name, schema: ConnectionSchema },
      { name: Follow.name, schema: FollowSchema },
      // Phase 7c — read-only, for the ERP party-book PYMK signal in
      // SuggestionService (User + Workspace come via ConnectProfileModule).
      { name: Party.name, schema: PartySchema },
    ]),
    AuditModule,
    // `SuggestionService` reads `ConnectProfile` (skills) + `WorkspaceMember`
    // (shared employment); `ConnectProfileModule` re-exports both models.
    ConnectProfileModule,
    // Phase 7a — NetworkService dispatches notifications on send/accept/follow.
    NotificationsModule,
    // Phase 7b — NetworkService enqueues feed-backfill jobs on connect-accept
    // (producer only; the worker/@Processor lives in ConnectFeedModule).
    BullModule.registerQueue({ name: FEED_FANOUT_QUEUE }),
  ],
  controllers: [NetworkController, ConnectNetworkPublicController],
  providers: [NetworkService, SuggestionService],
  exports: [NetworkService, MongooseModule],
})
export class ConnectNetworkModule {}
