import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AttendanceModule } from '../attendance/attendance.module';
import { LeaveType, LeaveTypeSchema } from './schemas/leave-type.schema';
import { LeaveBalance, LeaveBalanceSchema } from './schemas/leave-balance.schema';
import { LeaveLedger, LeaveLedgerSchema } from './schemas/leave-ledger.schema';
import { LeaveRequest, LeaveRequestSchema } from './schemas/leave-request.schema';
import { CompOffRequest, CompOffRequestSchema } from './schemas/comp-off-request.schema';
import {
  LeaveApproverDelegation,
  LeaveApproverDelegationSchema,
} from './schemas/leave-approver-delegation.schema';
import { EncashmentRecord, EncashmentRecordSchema } from './schemas/encashment-record.schema';
import {
  LeaveRequestSettings,
  LeaveRequestSettingsSchema,
} from './schemas/leave-request-settings.schema';
import { TeamMember, TeamMemberSchema } from '../team/schemas/team-member.schema';
import { Workspace, WorkspaceSchema } from '../workspaces/schemas/workspace.schema';
import { Holiday, HolidaySchema } from '../holidays/schemas/holiday.schema';
import { Salary, SalarySchema } from '../salary/schemas/salary.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { LeaveService } from './leave.service';
import { LeaveTypeSeederService } from './leave-type-seeder.service';
import { LeaveLedgerService } from './leave-ledger.service';
import { LeaveAccrualService } from './leave-accrual.service';
import { LeaveAccrualCron } from './leave-accrual.cron';
import { CompOffService } from './comp-off.service';
import { LeaveYearEndService } from './leave-year-end.service';
import { LeaveMaintenanceCron } from './leave-maintenance.cron';
import { LeaveSettingsService } from './leave-settings.service';
import { LeaveRequestService } from './leave-request.service';
import { CompOffRequestService } from './comp-off-request.service';
import { LeaveDelegationService } from './leave-delegation.service';
import { LeaveNotificationService } from './leave-notification.service';
import { LeaveController } from './leave.controller';
import { CompOffRequestController } from './comp-off-request.controller';
import { LeaveDelegationController } from './leave-delegation.controller';

/**
 * Leave Management module — Leave epic L1 + L2 + L3a.
 *
 * L1 shipped the data spine (5 schemas, preset seeding). L2 added the accrual
 * engine (`LeaveLedgerService`, `LeaveAccrualService`, `CompOffService`,
 * `LeaveYearEndService` + crons). L3a added the apply path; L3b the approval
 * lifecycle; L3c1 the comp-off earning workflow; L3c2 payroll-lock routing +
 * team-conflict; L3c3 approver delegation; L3c4 lifecycle notifications
 * (`LeaveNotificationService` — in-app + email fan-out, needs MailModule +
 * NotificationsModule).
 *
 * `TeamMember` / `Workspace` / `Holiday` are registered by name (pattern from
 * `RegularizationModule`). `AttendanceModule` (forwardRef) grants
 * `AttendanceEventService` + `AttendanceProjectionService` — leave approval
 * projects each charged day as an `on_leave` attendance status event.
 * `ScheduleModule.forRoot()` is global (SalaryModule) — not imported here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LeaveType.name, schema: LeaveTypeSchema },
      { name: LeaveBalance.name, schema: LeaveBalanceSchema },
      { name: LeaveLedger.name, schema: LeaveLedgerSchema },
      { name: LeaveRequest.name, schema: LeaveRequestSchema },
      { name: CompOffRequest.name, schema: CompOffRequestSchema },
      { name: LeaveApproverDelegation.name, schema: LeaveApproverDelegationSchema },
      { name: EncashmentRecord.name, schema: EncashmentRecordSchema },
      { name: LeaveRequestSettings.name, schema: LeaveRequestSettingsSchema },
      { name: TeamMember.name, schema: TeamMemberSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: Holiday.name, schema: HolidaySchema },
      // Salary by name — payroll-lock check; avoids a SalaryModule cycle.
      { name: Salary.name, schema: SalarySchema },
      // User by name — notification recipient email lookup.
      { name: User.name, schema: UserSchema },
    ]),
    // grants AttendanceEventService + AttendanceProjectionService
    forwardRef(() => AttendanceModule),
    // leave / comp-off lifecycle notification fan-out (L3c4)
    MailModule,
    NotificationsModule,
    // Phase 5 W4 — AuditService for leave write-op audit-event logging.
    AuditModule,
  ],
  controllers: [LeaveController, CompOffRequestController, LeaveDelegationController],
  providers: [
    LeaveService,
    LeaveTypeSeederService,
    LeaveLedgerService,
    LeaveAccrualService,
    LeaveAccrualCron,
    CompOffService,
    LeaveYearEndService,
    LeaveMaintenanceCron,
    LeaveSettingsService,
    LeaveRequestService,
    CompOffRequestService,
    LeaveDelegationService,
    LeaveNotificationService,
  ],
  exports: [
    LeaveService,
    LeaveTypeSeederService,
    LeaveLedgerService,
    LeaveAccrualService,
    CompOffService,
    LeaveYearEndService,
    LeaveSettingsService,
    LeaveRequestService,
    CompOffRequestService,
    LeaveDelegationService,
    MongooseModule,
  ],
})
export class LeaveModule {}
