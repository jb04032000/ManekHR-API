import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Rfq, RfqSchema } from './schemas/rfq.schema';
import { Quote, QuoteSchema } from './schemas/quote.schema';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
// User registered READ-ONLY: createRfq/createQuote read author.isDemo to stamp
// the denormalized isDemo flag at create (demo/sample disclosure + down-rank).
import { User, UserSchema } from '../../users/schemas/user.schema';
import { RfqService } from './rfq.service';
import { RfqController } from './rfq.controller';
import { AuditModule } from '../../audit/audit.module';
import { ConnectTagsModule } from '../tags/connect-tags.module';
// Shared media-URL ownership guard (validates quote sampleUrls[] belong to the
// caller's uploads). Self-contained module, no UploadsService allowance cycle.
import { MediaOwnershipModule } from '../../uploads/media-ownership.module';

/**
 * ManekHR Connect Marketplace -- Request-for-Quote module (Phase 4, W4).
 * Board-only RFQ + structured quotes (no chat, no seller notifications).
 * Person-centric. (`PostHogService` is `@Global`.) The marketplace `Listing`
 * model is registered READ-ONLY: the viewer's active listing categories drive
 * the board's "Matched to my work" scope (see RfqService.supplyCategories).
 * `ConnectTagsModule` provides `TagService`, which folds a custom RFQ category
 * into the shared ConnectTag pool (same as jobs / listings). `User` is
 * registered READ-ONLY to stamp the denormalized `isDemo` flag at create.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Rfq.name, schema: RfqSchema },
      { name: Quote.name, schema: QuoteSchema },
      { name: Listing.name, schema: ListingSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuditModule,
    ConnectTagsModule,
    MediaOwnershipModule,
  ],
  controllers: [RfqController],
  providers: [RfqService],
  exports: [RfqService],
})
export class ConnectRfqModule {}
