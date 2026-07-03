import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  MaintenanceSchedule,
  MaintenanceScheduleSchema,
} from './schemas/maintenance-schedule.schema';
import { ServiceLog, ServiceLogSchema } from './schemas/service-log.schema';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { ServiceLogsService } from './service-logs.service';
import { MaintenanceController } from './maintenance.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DowntimeModule } from '../downtime/downtime.module';
import { MachineSchema } from '../machines/schemas/machine.schema';
import { WorkspaceSchema } from '../workspaces/schemas/workspace.schema';
import { TeamMemberSchema } from '../team/schemas/team-member.schema';
import { DowntimeEntrySchema } from '../downtime/schemas/downtime-entry.schema';
import { ProductionLogSchema } from '../production-logs/schemas/production-log.schema';
import { ItemSchema } from '../finance/items/item.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  Notification,
  NotificationSchema,
} from '../notifications/schemas/notification.schema';
import { MaintenanceCountersCron } from './maintenance-counters.cron';
import { MaintenanceNotificationsCron } from './maintenance-notifications.cron';

/**
 * MaintenanceModule (Phase 24).
 *
 * Wave 1 (24-02 / 24-03): schema registration only.
 * Wave 2 (24-04): adds MaintenanceSchedulesService + cross-module schema
 *   tokens (Machine / Workspace / TeamMember / DowntimeEntry / ProductionLog)
 *   so the service can query them via @InjectModel string tokens (F-16-02
 *   STATE.md decorator-metadata pattern).
 * Wave 4 (24-06, this plan): adds ServiceLogsService + DowntimeModule import
 *   (provides DowntimeService + DowntimeReasonsService for auto-downtime
 *   create flow per D-05) + Item schema registration (R8 workspace-scoped
 *   part validation).
 *
 * Future plans:
 *   - 24-07  → MaintenanceController (all endpoints from D-08)
 *   - 24-08  → wires NotificationsModule for due-alert cron
 *
 * MongooseModule is re-exported so other modules can register the same
 * schemas via `forFeature` without circular imports — Mongoose dedupes the
 * underlying collection (Phase 22 F-10-05 STATE.md decision).
 *
 * `WorkspacesModule` is imported (not re-registered) for
 * `WorkspaceCounterService` access — counter writes go through the canonical
 * provider so all `findOneAndUpdate $inc` paths share state.
 *
 * `DowntimeModule` is imported (no circular import — DowntimeModule does not
 * depend on MaintenanceModule) so ServiceLogsService can call
 * `DowntimeService.create` for auto-downtime + `DowntimeReasonsService.get`
 * to resolve the system 'maintenance' reason code id.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MaintenanceSchedule.name, schema: MaintenanceScheduleSchema },
      { name: ServiceLog.name, schema: ServiceLogSchema },
      // Cross-module schema tokens needed by MaintenanceSchedulesService +
      // ServiceLogsService. Re-registering is safe — Mongoose dedupes by
      // collection name and the owning modules (MachinesModule,
      // WorkspacesModule, TeamModule, DowntimeModule, ProductionLogsModule,
      // FinanceModule) keep their own forFeature registrations for their own
      // services.
      { name: 'Machine', schema: MachineSchema },
      { name: 'Workspace', schema: WorkspaceSchema },
      { name: 'TeamMember', schema: TeamMemberSchema },
      { name: 'DowntimeEntry', schema: DowntimeEntrySchema },
      { name: 'ProductionLog', schema: ProductionLogSchema },
      { name: 'Item', schema: ItemSchema },
      // 24-08: register Notification schema locally so the notification cron
      // can run dedupe queries (`metadata.scheduleId` + `metadata.dueOn`)
      // directly against the collection. Mongoose dedupes by collection name
      // — NotificationsModule retains its own forFeature for its service.
      { name: Notification.name, schema: NotificationSchema },
    ]),
    WorkspacesModule, // for WorkspaceCounterService
    DowntimeModule, // for DowntimeService + DowntimeReasonsService (24-06)
    NotificationsModule, // 24-08: NotificationsService for due-alert cron
  ],
  providers: [
    MaintenanceSchedulesService,
    ServiceLogsService,
    // 24-08: daily crons (02:00 IST counter refresh, 06:00 IST notifications).
    // ScheduleModule.forRoot() is registered globally in SalaryModule.
    MaintenanceCountersCron,
    MaintenanceNotificationsCron,
  ],
  controllers: [MaintenanceController], // 24-07
  exports: [MaintenanceSchedulesService, ServiceLogsService, MongooseModule],
})
export class MaintenanceModule {}
