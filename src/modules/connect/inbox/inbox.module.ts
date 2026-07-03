import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Thread, ThreadSchema } from './schemas/thread.schema';
import { Message, MessageSchema } from './schemas/message.schema';
import { UserBlock, UserBlockSchema } from './schemas/user-block.schema';
import { InboxReport, InboxReportSchema } from './schemas/inbox-report.schema';
import { Inquiry, InquirySchema } from '../marketplace/schemas/inquiry.schema';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
import { JobApplication, JobApplicationSchema } from '../jobs/schemas/job-application.schema';
import { Job, JobSchema } from '../jobs/schemas/job.schema';
import { CompanyPage, CompanyPageSchema } from '../entities/schemas/company-page.schema';
import { Quote, QuoteSchema } from '../rfq/schemas/quote.schema';
import { Rfq, RfqSchema } from '../rfq/schemas/rfq.schema';
import { ConnectProfile, ConnectProfileSchema } from '../profile/schemas/connect-profile.schema';
import { Connection, ConnectionSchema } from '../network/schemas/connection.schema';
import {
  CandidateRequest,
  CandidateRequestSchema,
} from '../institutes/schemas/candidate-request.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';
import { InboxGateway } from './inbox.gateway';
import { MessagingRateLimiter } from './messaging-rate-limiter';
import { MessagingSpamGuard } from './messaging-spam-guard';
import { AuditModule } from '../../audit/audit.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ConnectAllowanceModule } from '../monetization/connect-allowance.module';
import { MediaOwnershipModule } from '../../uploads/media-ownership.module';

/**
 * ManekHR Connect -- Inbox module (Phase 7). The unified messaging hub:
 * DMs + inquiry / application / quote context threads + a system channel.
 * Person-centric. Imports `AuditModule` for write audit and
 * `NotificationsModule` for the `connect.message_received` bell
 * (`PostHogService` is `@Global`). Registers `User` so the service can
 * hydrate the other party + resolve the sender name for the notification.
 * `InboxGateway` (I2) serves the `/inbox` Socket.IO namespace; `JwtModule`
 * signs / verifies its short-lived ticket. The Redis-Streams fan-out worker
 * that moves emit off the hot path arrives in wave I6.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Thread.name, schema: ThreadSchema },
      { name: Message.name, schema: MessageSchema },
      { name: UserBlock.name, schema: UserBlockSchema },
      { name: InboxReport.name, schema: InboxReportSchema },
      // Read-only models for context-thread subject-card hydration (no cycle:
      // these register the model tokens, not the owning modules). inquiry->listing
      // is the original product card; application->job(+page) and quote->rfq drive
      // the job / RFQ cards (see InboxService.hydrateContexts).
      { name: Inquiry.name, schema: InquirySchema },
      { name: Listing.name, schema: ListingSchema },
      { name: JobApplication.name, schema: JobApplicationSchema },
      { name: Job.name, schema: JobSchema },
      { name: CompanyPage.name, schema: CompanyPageSchema },
      { name: Quote.name, schema: QuoteSchema },
      { name: Rfq.name, schema: RfqSchema },
      // The applicant's public profile, read only for the employer-only snapshot
      // AND the recipient's `visibility` for the cold-DM gate.
      { name: ConnectProfile.name, schema: ConnectProfileSchema },
      // Read-only `Connection` edge for the cold-DM visibility gate (only a
      // first-degree connection may cold-message a non-public profile). Schema-only
      // token -> no cycle with the network module.
      { name: Connection.name, schema: ConnectionSchema },
      // Institutes hire-lead entity (Institutes Phase 2, Feature 4): read-only token
      // so the inbox can hydrate the candidate_request subject card. Schema-only (the
      // institutes module owns the writes) -> no cycle, mirrors the inquiry/quote
      // read-only registrations above. See InboxService.hydrateCandidateRequestContexts.
      { name: CandidateRequest.name, schema: CandidateRequestSchema },
      { name: User.name, schema: UserSchema },
    ]),
    // The access secret signs + verifies the short-lived `inbox-socket` ticket
    // (the gateway handshake + the ticket-mint endpoint). No default sign opts.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({ secret: config.get<string>('jwt.accessSecret') }),
      inject: [ConfigService],
    }),
    AuditModule,
    NotificationsModule,
    // Open-DM rate-limit tiers (I5): the `verifiedBadge` allowance picks the tier.
    // The Redis client the limiter uses comes from the global RedisModule.
    ConnectAllowanceModule,
    // Shared media-URL ownership guard (assertOwnedMedia) for inbox attachments.
    MediaOwnershipModule,
  ],
  controllers: [InboxController],
  providers: [InboxService, InboxGateway, MessagingRateLimiter, MessagingSpamGuard],
  exports: [InboxService],
})
export class ConnectInboxModule {}
