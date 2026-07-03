import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Anomaly, AnomalySchema } from './schemas/anomaly.schema';
import { AnomalyRule, AnomalyRuleSchema } from './schemas/anomaly-rule.schema';
import { AnomaliesService } from './anomalies.service';
import { AnomalyNotifyService } from './anomaly-notify.service';
import { AnomalyDetectionService } from './anomaly-detection.service';
import { AnomalyStreakCron } from './anomaly-streak.cron';
import { AnomaliesController } from './anomalies.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailModule } from '../mail/mail.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { UsersModule } from '../users/users.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { TeamModule } from '../team/team.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { Attendance, AttendanceSchema } from '../attendance/schemas/attendance.schema';

/**
 * Phase I — Anomaly Alerts module.
 *
 * Plans 03-06 fill out this module progressively. Final shape after plan 06:
 *   providers: [AnomaliesService, AnomalyDetectionService, AnomalyNotifyService, AnomalyStreakCron]
 *   controllers: [AnomaliesController]
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Anomaly.name, schema: AnomalySchema },
      { name: AnomalyRule.name, schema: AnomalyRuleSchema },
      // AttendanceEvent is NOT imported here to avoid circular dep (research §Pitfall 5);
      // rapid_dup uses in-memory LRU. Attendance (projection) is needed for missed_streak.
      { name: Attendance.name, schema: AttendanceSchema },
    ]),
    NotificationsModule,
    MailModule,
    WorkspacesModule,
    UsersModule,
    HolidaysModule,
    forwardRef(() => TeamModule),           // exports MongooseModule with 'TeamMember' schema — needed by AnomalyStreakCron
    forwardRef(() => ShiftsModule),         // exports MongooseModule with 'Shift' schema — needed by AnomalyStreakCron
  ],
  providers: [AnomaliesService, AnomalyNotifyService, AnomalyDetectionService, AnomalyStreakCron],
  controllers: [AnomaliesController],
  exports: [AnomaliesService, AnomalyNotifyService, AnomalyDetectionService, MongooseModule],
})
export class AnomaliesModule {}
