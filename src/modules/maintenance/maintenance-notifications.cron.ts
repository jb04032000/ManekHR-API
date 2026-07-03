import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { hourBucket } from '../../common/scheduler/period-key';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Notification } from '../notifications/schemas/notification.schema';

/**
 * MaintenanceNotificationsCron — fires hourly, gated to 06:00 LOCAL time
 * in each workspace's timezone (HI-02 fix).
 *
 * For each workspace that owns at least one active maintenance schedule, list
 * schedules currently within their lead-time window (via
 * `MaintenanceSchedulesService.listDue`) and create one in-app warning
 * Notification per recipient (workspace owner + assigned technician's linked
 * user, when resolvable).
 *
 * Dedupe per RESEARCH §14: skip create if a Notification already exists with
 * matching `metadata.scheduleId` + `metadata.dueOn` (YYYY-MM-DD) for the same
 * workspaceId + recipientId. Prevents daily spam — at most one notification
 * per (recipient, schedule, dueDate).
 *
 * Recipients:
 *  - workspace.ownerId (always notified)
 *  - schedule.technicianId → TeamMember.linkedUserId (when present)
 *
 * Failure isolation:
 *  - per-workspace try/catch (one workspace's failure does not abort batch)
 *  - per-row try/catch (one schedule's failure does not abort the workspace)
 */
const TARGET_LOCAL_HOUR = 6;

@Injectable()
export class MaintenanceNotificationsCron {
  private readonly logger = new Logger(MaintenanceNotificationsCron.name);

  constructor(
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
    private readonly schedulesService: MaintenanceSchedulesService,
    private readonly notificationsService: NotificationsService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Maintenance due-notifications
   * Execution:   @Cron gated to worker role + Redis single-flight per hour.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly (IST registration); per-workspace tz gate fires at local 06:00.
   * Idempotent:  YES - dedupes per (workspaceId, recipientId, scheduleId, dueOn)
   *              by checking for an existing Notification before create (RESEARCH §14).
   * Reads:       workspaces, maintenance schedules, team members
   * Writes:      in-app maintenance Notifications
   * Missed run:  Self-heals next hour while local hour is still 06.
   * Owner:       maintenance
   */
  @Cron(CRON_SCHEDULES.EVERY_HOUR, {
    timeZone: CRON_TIMEZONES.IST,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.MAINTENANCE_NOTIFICATIONS, hourBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    // HI-02 fix (24-REVIEW.md): switched from a single 06:00 IST trigger to
    // an hourly cron + per-workspace tz local-hour gate. Mirrors RFM /
    // GREETINGS_DISPATCH pattern (cron.constants.ts §17 Pattern 1).
    const now = new Date();

    // Sentinel system userId — listDue doesn't use ctx.userId for filtering,
    // but ScheduleCtx requires the field; pass a non-persisted ObjectId.
    const SYSTEM_USER_ID = new Types.ObjectId();

    let totalCreated = 0;
    let totalDeduped = 0;
    let workspacesScanned = 0;

    let workspaces: Array<{
      _id: Types.ObjectId;
      ownerId?: Types.ObjectId;
      timezone?: string;
    }>;
    try {
      workspaces = (await this.workspaceModel
        .find({})
        .select('_id ownerId timezone')
        .lean()
        .exec()) as any;
    } catch (err) {
      this.logger.error('MaintenanceNotificationsCron: failed to load workspaces', err);
      return;
    }

    for (const ws of workspaces) {
      const tz = ws.timezone || 'Asia/Kolkata';
      if (!this.shouldRunInWorkspaceNow(now, tz)) continue;
      workspacesScanned++;
      const wsObjId = new Types.ObjectId(String(ws._id));
      try {
        const due = await this.schedulesService.listDue(
          {
            workspaceId: String(ws._id),
            userId: SYSTEM_USER_ID,
          },
          { limit: 500, offset: 0 },
        );

        if (due.items.length === 0) continue;

        for (const row of due.items) {
          try {
            // HI-02: dueOn dedupe key respects workspace timezone so a
            // Sydney workspace and a Mumbai workspace each see "today"
            // boundaries on their own clock. Uses Intl.DateTimeFormat to
            // avoid pulling dayjs/plugin/timezone into the backend (no
            // existing dayjs.extend(timezone) in this codebase).
            const dueOnStr = formatDateInTz(row.nextDueAt, tz);

            // Build recipient set: owner + (technician.linkedUserId, if any).
            const recipients = new Set<string>();
            if (ws.ownerId) {
              recipients.add(String(ws.ownerId));
            }

            if (row.technicianId) {
              const tm = (await this.teamMemberModel
                .findOne({
                  _id: new Types.ObjectId(row.technicianId),
                  workspaceId: wsObjId,
                })
                .select('linkedUserId')
                .lean()
                .exec()) as any;
              if (tm?.linkedUserId) {
                recipients.add(String(tm.linkedUserId));
              }
            }

            if (recipients.size === 0) continue;

            // HI-03 (24-REVIEW.md): always store scheduleId as a string in
            // metadata for consistency, and tolerate any historical
            // ObjectId-typed rows in dedupe via $or.
            const scheduleIdStr = String(row.scheduleId);
            let scheduleIdObj: Types.ObjectId | null = null;
            if (Types.ObjectId.isValid(scheduleIdStr)) {
              scheduleIdObj = new Types.ObjectId(scheduleIdStr);
            }

            for (const recipientId of recipients) {
              // Dedupe key: (workspaceId, recipientId, metadata.scheduleId,
              // metadata.dueOn). RESEARCH §14: in-memory pre-check (no
              // partial unique index v1; acceptable at MVP scale).
              //
              // HI-03: $or covers ObjectId-vs-string drift on
              // metadata.scheduleId so the dedupe gate works regardless of
              // how previous rows were stored.
              const scheduleIdMatchers: any[] = [{ 'metadata.scheduleId': scheduleIdStr }];
              if (scheduleIdObj) {
                scheduleIdMatchers.push({
                  'metadata.scheduleId': scheduleIdObj,
                });
              }
              const existing = await this.notificationModel
                .findOne({
                  workspaceId: wsObjId,
                  recipientId: new Types.ObjectId(recipientId),
                  'metadata.dueOn': dueOnStr,
                  $or: scheduleIdMatchers,
                })
                .lean()
                .exec();

              if (existing) {
                totalDeduped++;
                continue;
              }

              const daysLabel =
                row.daysRemaining <= 0
                  ? 'now'
                  : `in ${row.daysRemaining} day${row.daysRemaining === 1 ? '' : 's'}`;

              try {
                await this.notificationsService.createNotification(String(ws._id), {
                  recipientId,
                  title: 'Maintenance due',
                  message: `${row.machineName || row.machineCode}: ${row.scheduleName} due ${daysLabel}.`,
                  type: 'warning',
                  metadata: {
                    entityType: 'maintenance_schedule',
                    // HI-03: persist scheduleId as a string so future
                    // dedupe lookups always hit on the primary $or
                    // branch.
                    scheduleId: scheduleIdStr,
                    machineId: row.machineId,
                    dueOn: dueOnStr,
                  },
                });
                totalCreated++;
              } catch (createErr: any) {
                // HI-03: defensive swallow of duplicate-key errors. Mongo
                // surfaces dup-key as code === 11000; a future partial
                // unique index on (workspaceId, recipientId,
                // metadata.scheduleId, metadata.dueOn) would surface here
                // when a parallel cron / retry tries the same insert.
                if (createErr?.code === 11000) {
                  totalDeduped++;
                } else {
                  throw createErr;
                }
              }
            }
          } catch (rowErr) {
            this.logger.error(
              `MaintenanceNotificationsCron: row failed (workspace=${String(ws._id)}, scheduleId=${row.scheduleId})`,
              rowErr,
            );
          }
        }
      } catch (wsErr) {
        this.logger.error(
          `MaintenanceNotificationsCron: workspace ${String(ws._id)} failed`,
          wsErr,
        );
      }
    }

    if (workspacesScanned > 0) {
      this.logger.log(
        `MaintenanceNotificationsCron complete: workspacesScanned=${workspacesScanned}, created=${totalCreated}, deduped=${totalDeduped}`,
      );
    }
  }

  /**
   * HI-02 helper — true when workspace's local hour equals 06.
   * Mirrors RfmCron.shouldRunInWorkspaceNow (research §Pattern 1).
   */
  shouldRunInWorkspaceNow(now: Date, tz: string): boolean {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: tz,
    });
    const parts = fmt.formatToParts(now);
    const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '';
    const localHour = parseInt(hourStr, 10) % 24;
    return localHour === TARGET_LOCAL_HOUR;
  }
}

/**
 * HI-02 helper — format a date as `YYYY-MM-DD` in the supplied IANA tz.
 * Uses Intl.DateTimeFormat (no dayjs/plugin/timezone dependency in the
 * backend; see grep evidence in 24-REVIEW-FIX.md).
 */
function formatDateInTz(d: Date | string, tz: string): string {
  const date = d instanceof Date ? d : new Date(d);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: tz,
  });
  // 'en-CA' yields YYYY-MM-DD reliably across Node ICU builds.
  return fmt.format(date);
}
