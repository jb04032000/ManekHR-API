import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { InvitesController, MyInvitesController } from './invites.controller';
import { WorkspaceCounterService } from './workspace-counter.service';
import { Workspace, WorkspaceSchema } from './schemas/workspace.schema';
import { WorkspaceMember, WorkspaceMemberSchema } from './schemas/workspace-member.schema';
import { WorkspaceCounter, WorkspaceCounterSchema } from './schemas/workspace-counter.schema';
import { UsersModule } from '../users/users.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SmsModule } from '../sms/sms.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserDevicesModule } from '../user-devices/user-devices.module';
import { AuditModule } from '../audit/audit.module';
import { InviteNotificationDispatcher } from './invite-notification.dispatcher';
import { InviteExpiryCron } from './invite-expiry.cron';
import { WorkspaceRetentionPurgeCron } from './crons/workspace-retention-purge.cron';

// Note: FirmsModule is intentionally NOT imported here. Importing it would
// trigger a transitive require cycle (FirmsModule → LedgerModule → WorkspacesModule)
// that fires before this module's class is defined. Instead, WorkspacesService
// resolves FirmsService lazily via ModuleRef at call time.

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      { name: WorkspaceCounter.name, schema: WorkspaceCounterSchema },
    ]),
    ConfigModule,
    UsersModule,
    SubscriptionsModule,
    SmsModule,
    MailModule,
    NotificationsModule,
    UserDevicesModule,
    AuditModule,
    // ScheduleModule.forRoot() is registered ONCE (SalaryModule). Calling it per
    // feature module is NOT idempotent in @nestjs/schedule v6 — each call spins up
    // its own scheduler that re-scans every @Cron in the app, so N registrations
    // fire every cron N times per tick. Do not re-add it here.
  ],
  controllers: [WorkspacesController, InvitesController, MyInvitesController],
  providers: [
    WorkspacesService,
    WorkspaceCounterService,
    InviteNotificationDispatcher,
    InviteExpiryCron,
    // Workspaces hardening §3e — Bucket-C scrub of soft-deleted workspaces past
    // the grace window. OFF by default (RUN_RETENTION_PURGE_ON_SCHEDULE). Uses
    // the @Global SingleFlightService + the Workspace model registered above.
    WorkspaceRetentionPurgeCron,
  ],
  exports: [WorkspacesService, WorkspaceCounterService, MongooseModule],
})
export class WorkspacesModule {}
