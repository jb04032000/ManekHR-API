import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Listing, ListingSchema } from './schemas/listing.schema';
import { Inquiry, InquirySchema } from './schemas/inquiry.schema';
import { Collection, CollectionSchema } from './schemas/collection.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { ListingService } from './services/listing.service';
import { InquiryService } from './services/inquiry.service';
import { CollectionService } from './services/collection.service';
import { ListingController } from './controllers/listing.controller';
import { ListingPublicController } from './controllers/listing-public.controller';
import { ListingAdminController } from './controllers/listing-admin.controller';
import { InquiryController } from './controllers/inquiry.controller';
import { CollectionController } from './controllers/collection.controller';
import { CollectionPublicController } from './controllers/collection-public.controller';
import { ListingModerationService } from './services/listing-moderation.service';
import { ConnectMonetizationModule } from '../monetization/connect-monetization.module';
import { ConnectOverLimitModule } from '../over-limit/connect-over-limit.module';
import { ConnectEntitiesModule } from '../entities/entities.module';
import { AuditModule } from '../../audit/audit.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ConnectInboxModule } from '../inbox/inbox.module';
import { ConnectTagsModule } from '../tags/connect-tags.module';
import { ConnectReviewsModule } from '../reviews/connect-reviews.module';
// Shared media-URL ownership guard: lets listing/collection writes assert the
// caller actually uploaded each attached image (IDOR-proof, batched lookup).
import { MediaOwnershipModule } from '../../uploads/media-ownership.module';

/**
 * ManekHR Connect -- Marketplace module (Phase M1).
 *
 * Owns the `Listing` collection + the listing CRUD service / controllers (the
 * Road A mediator marketplace). Person-centric throughout (ownerUserId from the
 * JWT, never a workspace).
 *
 * Imports:
 *  - `ConnectMonetizationModule` for `ConnectAllowanceService` (M0.5) -- the
 *    person-centric listing cap that create() enforces.
 *  - `AuditModule` for write audit logging.
 *  (`PostHogService` is `@Global`, so no import is needed.)
 *
 * Moderation (M1.3), search (M1.4), and the inquiry / lead flow (M1.5) land in
 * this module next. Exports `MongooseModule` + `ListingService` for them to reuse.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Listing.name, schema: ListingSchema },
      { name: Inquiry.name, schema: InquirySchema },
      { name: Collection.name, schema: CollectionSchema },
      { name: User.name, schema: UserSchema },
    ]),
    ConnectMonetizationModule,
    ConnectEntitiesModule,
    AuditModule,
    NotificationsModule,
    // The unified Inbox: a sent inquiry is seeded as an inbox thread (no cycle
    // -- inbox does not import marketplace).
    ConnectInboxModule,
    // Tag normalization + usage recording for listing tags.
    ConnectTagsModule,
    // Seller rating aggregate on public listing reads (marketplace Phase C, R2).
    ConnectReviewsModule,
    // Provides MediaOwnershipService for listing/collection image ownership checks.
    MediaOwnershipModule,
    // Over-limit suppression (hide_newest policy) folded onto public listing
    // reads. No-op under the default freeze policy.
    ConnectOverLimitModule,
  ],
  controllers: [
    ListingController,
    ListingPublicController,
    ListingAdminController,
    InquiryController,
    CollectionController,
    CollectionPublicController,
  ],
  providers: [ListingService, ListingModerationService, InquiryService, CollectionService],
  exports: [MongooseModule, ListingService, InquiryService, CollectionService],
})
export class MarketplaceModule {}
