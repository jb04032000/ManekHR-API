import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  RegularizationRequest,
  RegularizationRequestSchema,
} from './schemas/regularization-request.schema';
import { TeamMember, TeamMemberSchema } from '../team/schemas/team-member.schema';
import { Salary, SalarySchema } from '../salary/schemas/salary.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { AttendanceModule } from '../attendance/attendance.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { RegularizationResolverService } from './regularization-resolver.service';
import { RegularizationService } from './regularization.service';
import { RegularizationSettingsService } from './regularization-settings.service';
import { RegularizationController } from './regularization.controller';
import { RegularizationSettingsController } from './regularization-settings.controller';

/**
 * Phase D regularization module.
 * D-03 adds RegularizationResolverService.
 * D-04 adds RegularizationService + AttendanceModule (forwardRef) + salary/user models.
 * D-05 adds controllers + notification wiring (MailModule + NotificationsModule) + settings service.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RegularizationRequest.name, schema: RegularizationRequestSchema },
      // TeamMember registered by name — avoids TeamModule import/forwardRef.
      // Pattern from attendance-devices.module.ts and D-03.
      { name: TeamMember.name, schema: TeamMemberSchema },
      // Salary by name — avoids SalaryModule circular dep (Pattern: attendance-devices.service.ts)
      { name: Salary.name, schema: SalarySchema },
      // User by name — for recipient email lookup and approvalChain populate
      { name: User.name, schema: UserSchema },
    ]),
    // grants AttendanceEventService + AttendanceProjectionService + Attendance/AttendanceEvent models
    forwardRef(() => AttendanceModule),
    // grants Workspace model + WorkspacesService
    WorkspacesModule,
    // notification fan-out (DD-14)
    MailModule,
    NotificationsModule,
    // audit trail for regularization writes (who raised / approved / rejected)
    AuditModule,
  ],
  // Settings controller first — more specific path wins over :id param (route specificity)
  controllers: [RegularizationSettingsController, RegularizationController],
  providers: [RegularizationResolverService, RegularizationService, RegularizationSettingsService],
  exports: [
    RegularizationService,
    RegularizationResolverService,
    RegularizationSettingsService,
    MongooseModule,
  ],
})
export class RegularizationModule {}
