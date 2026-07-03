import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsController } from './notifications.controller';
import { MeNotificationsController } from './me-notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { InPlatformChannel } from './channels/in-platform.channel';
import { MobilePushChannel } from './channels/mobile-push.channel';
import { BrowserPushChannel } from './channels/browser-push.channel';
import { Notification, NotificationSchema } from './schemas/notification.schema';
import {
  NotificationPreferences,
  NotificationPreferencesSchema,
} from './schemas/notification-preferences.schema';
import { Role, RoleSchema } from '../rbac/schemas/role.schema';
import {
  WorkspaceMember,
  WorkspaceMemberSchema,
} from '../workspaces/schemas/workspace-member.schema';
import { Workspace, WorkspaceSchema } from '../workspaces/schemas/workspace.schema';
import { UserDevicesModule } from '../user-devices/user-devices.module';

/**
 * Phase 7a (2026-05-21) — extended into a layered pipeline:
 *  - `NotificationsService.dispatch` — central entry; persists envelope +
 *    fans out across channel adapters.
 *  - `NotificationPreferencesService` — per-user × per-category × per-channel
 *    opt-in.
 *  - `NotificationsGateway` — `/notifications` Socket.IO namespace + ticket
 *    auth (same shape as the Connect feed gateway).
 *  - Channels — `InPlatformChannel` (live), `MobilePushChannel` +
 *    `BrowserPushChannel` (interface-locked scaffolds — `isAvailable`
 *    returns false until their providers land).
 *
 * `JwtModule` is registered for socket-ticket verify on the gateway + mint
 * on the `me/notifications/socket-ticket` endpoint.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: NotificationPreferences.name, schema: NotificationPreferencesSchema },
      { name: Role.name, schema: RoleSchema },
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
      }),
      inject: [ConfigService],
    }),
    UserDevicesModule,
  ],
  controllers: [NotificationsController, MeNotificationsController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    NotificationsGateway,
    InPlatformChannel,
    MobilePushChannel,
    BrowserPushChannel,
  ],
  exports: [NotificationsService, NotificationPreferencesService, MongooseModule],
})
export class NotificationsModule {}
