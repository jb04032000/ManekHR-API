import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { Attendance, AttendanceSchema } from './schemas/attendance.schema';
import { AttendanceEvent, AttendanceEventSchema } from './schemas/attendance-event.schema';
import {
  DefaulterAlertDispatch,
  DefaulterAlertDispatchSchema,
} from './schemas/defaulter-alert-dispatch.schema';
import { Shift, ShiftSchema } from '../shifts/schemas/shift.schema';
import { TeamMember, TeamMemberSchema } from '../team/schemas/team-member.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { TeamModule } from '../team/team.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
// Phase 6 (member-cap read filter): ErpMemberCapService for scoping the org-
// scoped attendance reports (getSummary stats + findAll records) to the allowed
// member set. ErpMemberCapModule imports none of Team/Salary/Attendance, so the
// dependency direction stays acyclic.
import { ErpMemberCapModule } from '../subscriptions/member-cap/erp-member-cap.module';
import { AutoPresentCron } from './auto-present.cron';
import { AttendanceEventService } from './attendance-event.service';
import { AttendanceProjectionService } from './attendance-projection.service';
import { AttendancePoliciesModule } from '../attendance-policies/attendance-policies.module';
import { AnomaliesModule } from '../anomalies/anomalies.module';
import { SalaryModule } from '../salary/salary.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { KioskController } from './kiosk/kiosk.controller';
import { KioskService } from './kiosk/kiosk.service';
import { MeAttendanceController } from './me/me-attendance.controller';
import { MeAttendanceService } from './me/me-attendance.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailModule } from '../mail/mail.module';
import { DefaulterAlertService } from './defaulter-alert.service';
import { DefaulterAlertCron } from './crons/defaulter-alert.cron';
// Attendance hardening (2026-06-15): shared write guard (SoD + offboard lock),
// member-removal cascade + history gate, and the system-only retention purge.
import { AttendanceWriteGuardService } from './attendance-write-guard.service';
import { AttendanceLifecycleService } from './attendance-lifecycle.service';
import { AttendanceRetentionPurgeCron } from './crons/attendance-retention-purge.cron';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Attendance.name, schema: AttendanceSchema },
      { name: AttendanceEvent.name, schema: AttendanceEventSchema },
      { name: Shift.name, schema: ShiftSchema },
      { name: TeamMember.name, schema: TeamMemberSchema }, // needed by AttendanceProjectionService.resolveContext + DefaulterAlertService
      { name: User.name, schema: UserSchema }, // needed by DefaulterAlertService for email resolution
      { name: DefaulterAlertDispatch.name, schema: DefaulterAlertDispatchSchema },
    ]),
    forwardRef(() => TeamModule),
    SubscriptionsModule,
    WorkspacesModule,
    ErpMemberCapModule, // Phase 6: ErpMemberCapService for the org-scoped report cap.
    forwardRef(() => AttendancePoliciesModule), // Phase C: policy resolution in projection service
    forwardRef(() => AnomaliesModule), // Phase I: anomaly detection hook in AttendanceEventService
    forwardRef(() => SalaryModule), // H3-05: isSalaryLocked guard in AttendanceProjectionService
    HolidaysModule, // (B) holiday-aware auto-mark: AutoPresentCron resolves declared holidays via HolidaysService. No cycle — HolidaysModule does not depend on AttendanceModule.
    AuditModule, // Phase 5 W6.7: AuditService for write-event logging
    NotificationsModule, // DefaulterAlertService: in-app notification fan-out
    MailModule, // DefaulterAlertService: email channel + quota check
  ],
  controllers: [AttendanceController, KioskController, MeAttendanceController],
  providers: [
    AttendanceService,
    AutoPresentCron,
    AttendanceEventService,
    AttendanceProjectionService,
    KioskService,
    MeAttendanceService,
    DefaulterAlertService,
    DefaulterAlertCron,
    // Attendance hardening providers.
    AttendanceWriteGuardService,
    AttendanceLifecycleService,
    AttendanceRetentionPurgeCron,
  ],
  exports: [
    AttendanceService,
    AttendanceEventService,
    AttendanceProjectionService,
    KioskService,
    DefaulterAlertService, // exported for use by the defaulter-alert cron (Task 11+)
    // Exported so the Team module can drive the member-removal cascade +
    // history gate (TeamService.remove / removePermanent) via moduleRef.
    AttendanceLifecycleService,
    MongooseModule,
  ],
})
export class AttendanceModule {}
