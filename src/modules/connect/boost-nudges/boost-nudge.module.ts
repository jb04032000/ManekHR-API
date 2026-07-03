import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
import { Job, JobSchema } from '../jobs/schemas/job.schema';
import { Post, PostSchema } from '../feed/schemas/post.schema';
import {
  ConnectViewDaily,
  ConnectViewDailySchema,
} from '../views/schemas/connect-view-daily.schema';
import { EngagementEdge, EngagementEdgeSchema } from '../feed/schemas/engagement-edge.schema';
import { JobView, JobViewSchema } from '../jobs/schemas/job-view.schema';
import { AdCampaign, AdCampaignSchema } from '../ads/schemas/ad-campaign.schema';
import { ConnectOverLimitModule } from '../over-limit/connect-over-limit.module';
import {
  ConnectBoostNudgeDismissal,
  ConnectBoostNudgeDismissalSchema,
} from './schemas/connect-boost-nudge-dismissal.schema';
import {
  ConnectBoostNudgeShown,
  ConnectBoostNudgeShownSchema,
} from './schemas/connect-boost-nudge-shown.schema';
import { BoostNudgeController } from './boost-nudge.controller';
import { BoostNudgeService } from './boost-nudge.service';

/**
 * ManekHR Connect -- Boost-nudge module. Exposes me/connect/boost-nudges
 * (traction-based "boost it" prompts: read candidates, mark shown, dismiss).
 *
 * Re-registers the read-only entity + view schemas locally (standard Nest --
 * shares the underlying collections; no new tracking) and owns the two tiny
 * nudge-state collections. Imports ConnectOverLimitModule for the suppression
 * check (a hidden listing/job must never be nudged).
 *
 * No import cycle: this module is a leaf -- nothing imports it back.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Listing.name, schema: ListingSchema },
      { name: Job.name, schema: JobSchema },
      { name: Post.name, schema: PostSchema },
      { name: ConnectViewDaily.name, schema: ConnectViewDailySchema },
      { name: EngagementEdge.name, schema: EngagementEdgeSchema },
      { name: JobView.name, schema: JobViewSchema },
      { name: AdCampaign.name, schema: AdCampaignSchema },
      { name: ConnectBoostNudgeDismissal.name, schema: ConnectBoostNudgeDismissalSchema },
      { name: ConnectBoostNudgeShown.name, schema: ConnectBoostNudgeShownSchema },
    ]),
    ConnectOverLimitModule,
  ],
  controllers: [BoostNudgeController],
  providers: [BoostNudgeService],
  exports: [BoostNudgeService],
})
export class BoostNudgeModule {}
