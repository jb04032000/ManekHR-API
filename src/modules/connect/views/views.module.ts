import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectViewDaily, ConnectViewDailySchema } from './schemas/connect-view-daily.schema';
import { ConnectViewSeen, ConnectViewSeenSchema } from './schemas/connect-view-seen.schema';
import { Storefront, StorefrontSchema } from '../entities/schemas/storefront.schema';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
import { ConnectViewService } from './services/connect-view.service';
import { ConnectViewController } from './controllers/connect-view.controller';

/**
 * Connect view-tracking: records storefront / product views and rolls them up
 * for the storefront analytics dashboard. Registers the Storefront + Listing
 * schemas read-only (owner verification + per-listing tally); the canonical
 * writers stay in their own modules.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ConnectViewDaily.name, schema: ConnectViewDailySchema },
      { name: ConnectViewSeen.name, schema: ConnectViewSeenSchema },
      { name: Storefront.name, schema: StorefrontSchema },
      { name: Listing.name, schema: ListingSchema },
    ]),
  ],
  controllers: [ConnectViewController],
  providers: [ConnectViewService],
  exports: [ConnectViewService],
})
export class ConnectViewsModule {}
