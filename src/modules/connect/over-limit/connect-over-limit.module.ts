import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
import { Storefront, StorefrontSchema } from '../entities/schemas/storefront.schema';
import { CompanyPage, CompanyPageSchema } from '../entities/schemas/company-page.schema';
import { Job, JobSchema } from '../jobs/schemas/job.schema';
import {
  ConnectOverLimitState,
  ConnectOverLimitStateSchema,
} from './schemas/connect-over-limit-state.schema';
import { ConnectAllowanceModule } from '../monetization/connect-allowance.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ConnectOverLimitService } from './connect-over-limit.service';
import { ConnectOverLimitReconcileCron } from './connect-over-limit.cron';

/**
 * ManekHR Connect — Over-limit (grandfathering) module.
 *
 * Provides ConnectOverLimitService: computes the read-time suppression sets for
 * public surfaces (hide_newest policy) and maintains the per-(user,kind) grace
 * clock + once-per-episode over-limit notice. Suppression is COMPUTED, never
 * stored — see docs/connect/2026-06-12-connect-over-limit-policy.md.
 *
 * Re-registers the four counted schemas locally (read-only counts; standard Nest
 * — shares the collection). Imports ConnectAllowanceModule (limits + policy) and
 * NotificationsModule (entry notice). SingleFlightService comes from the global
 * SchedulerModule (no import needed).
 *
 * Exports ConnectOverLimitService so the usage endpoint and the public read paths
 * (marketplace / search / storefront / company-page / jobs) can inject it.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Listing.name, schema: ListingSchema },
      { name: Storefront.name, schema: StorefrontSchema },
      { name: CompanyPage.name, schema: CompanyPageSchema },
      { name: Job.name, schema: JobSchema },
      { name: ConnectOverLimitState.name, schema: ConnectOverLimitStateSchema },
    ]),
    ConnectAllowanceModule,
    NotificationsModule,
  ],
  providers: [ConnectOverLimitService, ConnectOverLimitReconcileCron],
  exports: [ConnectOverLimitService],
})
export class ConnectOverLimitModule {}
