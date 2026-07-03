import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Job, JobSchema } from './schemas/job.schema';
import { JobApplication, JobApplicationSchema } from './schemas/job-application.schema';
import { JobView, JobViewSchema } from './schemas/job-view.schema';
import { SavedJob, SavedJobSchema } from './schemas/saved-job.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { AuditModule } from '../../audit/audit.module';
import { ConnectAllowanceModule } from '../monetization/connect-allowance.module';
import { ConnectEntitiesModule } from '../entities/entities.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ConnectTagsModule } from '../tags/connect-tags.module';
import { AdsModule } from '../ads/ads.module';
// Shared media-URL ownership guard: enforces apply-path voice-note / resume URLs
// are real files on our storage uploaded by the applicant (IDOR-proof attach).
import { MediaOwnershipModule } from '../../uploads/media-ownership.module';
import { ConnectOverLimitModule } from '../over-limit/connect-over-limit.module';

/**
 * ManekHR Connect -- Jobs module (Phase 5). A company posts jobs; karigars apply.
 * Person-centric. Imports:
 *  - `ConnectAllowanceModule` for the per-person open-job cap.
 *  - `ConnectEntitiesModule` for `CompanyPageService` (post-AS-a-page ownership gate).
 *  - `NotificationsModule` for the hiring-funnel notifications.
 *  - `ConnectTagsModule` for `TagService` (folds custom category / role into the
 *    shared ConnectTag pool so they self-register + become searchable).
 *  - `AdsModule` for `JobBoostResolverService` (read-only promoted-jobs resolver
 *    that powers the board's "Promoted" block; no cycle - AdsModule does not
 *    import this module).
 *  - `AuditModule` for write audit. (`PostHogService` is `@Global`.)
 * Registers `User` so the service can resolve the applicant name for the
 * company's "new application" notification.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Job.name, schema: JobSchema },
      { name: JobApplication.name, schema: JobApplicationSchema },
      // JobView dedups the employer's views stat to distinct non-owner viewers.
      { name: JobView.name, schema: JobViewSchema },
      // SavedJob = the candidate's private job bookmarks (mirrors SavedPost).
      { name: SavedJob.name, schema: SavedJobSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuditModule,
    ConnectAllowanceModule,
    ConnectEntitiesModule,
    NotificationsModule,
    ConnectTagsModule,
    AdsModule,
    MediaOwnershipModule,
    // Over-limit suppression folded onto public job-board reads. No-op under freeze.
    ConnectOverLimitModule,
  ],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class ConnectJobsModule {}
