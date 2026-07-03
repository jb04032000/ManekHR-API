import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JobWorkLot, JobWorkLotSchema } from '../jw-lot/jw-lot.schema';
import { MailModule } from '../../../mail/mail.module';
import { NotificationsModule } from '../../../notifications/notifications.module';
import { JwPendingAlarmCron } from './jw-pending-alarm.cron';
import { WorkspacesModule } from '../../../workspaces/workspaces.module';

/**
 * JwPendingAlarmModule — registers the daily 06:00 IST deemed-supply alarm cron.
 *
 * NOTE: ScheduleModule.forRoot() is NOT imported here — it is already registered
 * globally by SalaryModule and SubscriptionsModule. The @Cron decorator works
 * as long as ScheduleModule.forRoot() is present anywhere in the application.
 * (Same pattern as DepreciationModule, LoanAccountsModule, RecurringModule.)
 *
 * WorkspacesModule is imported to gain the 'Workspace' model token
 * (WorkspacesModule exports MongooseModule which includes Workspace schema).
 * Used by the cron to resolve workspace.ownerId for in-app notification recipientId.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobWorkLot.name, schema: JobWorkLotSchema },
    ]),
    MailModule,
    NotificationsModule,
    WorkspacesModule,
  ],
  providers: [JwPendingAlarmCron],
})
export class JwPendingAlarmModule {}
