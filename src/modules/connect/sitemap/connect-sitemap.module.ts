import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
import { Storefront, StorefrontSchema } from '../entities/schemas/storefront.schema';
import { CompanyPage, CompanyPageSchema } from '../entities/schemas/company-page.schema';
import { Job, JobSchema } from '../jobs/schemas/job.schema';
import { ConnectProfile, ConnectProfileSchema } from '../profile/schemas/connect-profile.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { ConnectOverLimitModule } from '../over-limit/connect-over-limit.module';
import { ConnectSitemapService } from './connect-sitemap.service';
import { ConnectSitemapController } from './connect-sitemap.controller';

/**
 * ManekHR Connect -- Sitemap module.
 *
 * Public, projection-only read endpoints for the web app's dynamic sitemap index
 * (the web app cannot query Mongo directly). Re-registers the five indexable
 * entity schemas (+ User for the profile-handle join) locally for read-only
 * counts / projections (standard Nest -- shares the underlying collection).
 * Imports ConnectOverLimitModule for ConnectOverLimitService, so listing
 * suppression in the sitemap uses the SAME mechanism as the public detail route
 * (no drift). Registered in app.module alongside the other Connect modules.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Listing.name, schema: ListingSchema },
      { name: Storefront.name, schema: StorefrontSchema },
      { name: CompanyPage.name, schema: CompanyPageSchema },
      { name: Job.name, schema: JobSchema },
      { name: ConnectProfile.name, schema: ConnectProfileSchema },
      { name: User.name, schema: UserSchema },
    ]),
    ConnectOverLimitModule,
  ],
  controllers: [ConnectSitemapController],
  providers: [ConnectSitemapService],
  exports: [ConnectSitemapService],
})
export class ConnectSitemapModule {}
