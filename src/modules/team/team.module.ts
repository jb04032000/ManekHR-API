import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { SalaryModule } from '../salary/salary.module';
import { TeamService } from './team.service';
import { MobileOtpService } from './mobile-otp.service';
import { TeamController, TeamPublicController } from './team.controller';
import { TeamMember, TeamMemberSchema } from './schemas/team-member.schema';
import {
  TeamMemberDocument,
  TeamMemberDocumentSchema,
} from './schemas/team-member-document.schema';
// Relocated stub (Machines module removed 2026-07-04) — only backs the
// unreachable piece-rate machine-override validation in team.service.ts.
import { Machine, MachineSchema } from '../salary/schemas/machine.schema';
import { TeamMobileOtp, TeamMobileOtpSchema } from './schemas/team-mobile-otp.schema';
import { TeamMemberDocumentsService } from './team-member-documents.service';
import { UploadsModule } from '../uploads/uploads.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
// Phase 6 (member-cap read filter): read-time grandfathering of an over-limit
// workspace's roster. Imported so TeamService can inject ErpMemberCapService to
// scope the org-scoped Team list + surface the cap notice. ErpMemberCapModule
// imports none of Team/Salary/Attendance, so the dependency direction is acyclic.
import { ErpMemberCapModule } from '../subscriptions/member-cap/erp-member-cap.module';
// LocationsModule is imported so TeamService can validate `dto.locationId`
// against the workspace Locations master list. Locations is a standalone
// module (2026-07-04) — no longer part of Machines. Re-exports
// LocationsService (ensureDefaultLocation) + the MongooseModule Location
// model. No circular import: LocationsModule only depends on
// Workspaces/Subscriptions, neither of which imports TeamModule.
import { LocationsModule } from '../locations/locations.module';
import { MailModule } from '../mail/mail.module';
import { SmsModule } from '../sms/sms.module';
import { OffboardCron } from './offboard.cron';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserDevicesModule } from '../user-devices/user-devices.module';
import { PermissionNotificationDispatcher } from './permission-notification.dispatcher';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TeamMember.name, schema: TeamMemberSchema },
      { name: TeamMemberDocument.name, schema: TeamMemberDocumentSchema },
      { name: Machine.name, schema: MachineSchema },
      { name: TeamMobileOtp.name, schema: TeamMobileOtpSchema },
    ]),
    ConfigModule,
    // JwtModule wired for the mobile-OTP proof token (15 min TTL).
    // Uses the same access-token secret as the auth module so the signing key
    // is consistent across the application. MobileOtpService signs with
    // expiresIn: '15m' (overrides the default at signAsync call-site).
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.accessSecret'),
        signOptions: {
          expiresIn: configService.get<string>('jwt.accessExpiry') as JwtSignOptions['expiresIn'],
        },
      }),
      inject: [ConfigService],
    }),
    UploadsModule,
    SubscriptionsModule,
    WorkspacesModule,
    ErpMemberCapModule, // Phase 6: ErpMemberCapService for the org-scoped roster cap.
    // Provides LocationsService + Location model for locationId validation.
    LocationsModule,
    MailModule,
    SmsModule,
    AuditModule,
    NotificationsModule,
    UserDevicesModule,
    // @Cron jobs in this module are registered by the single
    // ScheduleModule.forRoot() in SalaryModule. forRoot() is NOT idempotent in
    // @nestjs/schedule v6 — re-registering it here duplicated every cron. Removed.
    forwardRef(() => SalaryModule),
  ],
  controllers: [TeamController, TeamPublicController],
  providers: [
    TeamService,
    MobileOtpService,
    TeamMemberDocumentsService,
    OffboardCron,
    PermissionNotificationDispatcher,
  ],
  exports: [TeamService, MongooseModule],
})
export class TeamModule {}
