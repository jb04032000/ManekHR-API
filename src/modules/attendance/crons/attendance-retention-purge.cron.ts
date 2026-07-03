import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditService } from '../../audit/audit.service';
import { buildRetentionPurgeAuditEvent } from '../../audit/retention-purge-audit';
import { AppModule } from '../../../common/enums/modules.enum';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { Attendance } from '../schemas/attendance.schema';
import { AttendanceEvent } from '../schemas/attendance-event.schema';
import { DefaulterAlertDispatch } from '../schemas/defaulter-alert-dispatch.schema';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CRON_TIMEZONES } from '../../../common/constants/cron.constants';
import { env } from '../../../config/env';

/**
 * HARD statutory retention floors (Attendance hardening, OQ-A4 → A).
 *
 * These are the LEGAL MINIMUM windows for a destructive, irreversible purge and
 * are CODE CONSTANTS, not env knobs — neither the `ATTENDANCE_RETENTION_*` env
 * values nor a per-workspace override can ever drop a window below these. An env
 * value or workspace override can only EXTEND retention, never shorten it.
 *
 *   - 10 years — the Gujarat muster-cum-wages register (Form A) is the strictest
 *                Indian attendance-retention rule, and attendance is the DIRECT
 *                input to that register. OQ-A4 → A applies this single strict
 *                floor to ALL Attendance + AttendanceEvent rows (no 8y/10y split),
 *                which both honours Gujarat and avoids a per-record join at purge
 *                time. The general ESI/attendance floor is 5-8 years; 10y dominates.
 *   - 1 year   — DefaulterAlertDispatch is Bucket D (operational idempotency, NO
 *                personal data), so it follows the audit/log tier, NOT the muster
 *                floor (see DATA-MAP §2 and the attendance data map).
 *
 * See docs/compliance/DATA-MAP-AND-RETENTION.md §2.
 */
export const STATUTORY_MUSTER_FLOOR_YEARS = 10;
export const DISPATCH_LOG_FLOOR_YEARS = 1;

/**
 * AttendanceRetentionPurgeCron — Attendance hardening Pillar 1 (OQ-A4).
 *
 * The SYSTEM-ONLY permanent-purge path (DATA-MAP §1b / §3 step 6). Hard-erases
 * Attendance / AttendanceEvent muster rows ONLY after the retention window has
 * lapsed — never as a user action. This is the only place in the attendance
 * module that physically deletes Bucket-B data. Mirrors the salary retention
 * purge cron shape exactly.
 *
 * Safety rails:
 *   - OFF by default (env.attendanceRetention.enabled, sharing the master
 *     RUN_RETENTION_PURGE_ON_SCHEDULE switch, default false). With the flag off
 *     the cron logs and exits — prod never auto-purges until the owner + CA
 *     enable it.
 *   - Per-workspace window = max(workspace override, env value, HARD floor
 *     constant). A workspace OR the env can keep records LONGER, never shorter
 *     than the 10-year muster floor.
 *   - Attendance cutoff is computed on `updatedAt` (the Attendance schema has
 *     timestamps:true), so a recently-recomputed 9-year-old row (a fresh
 *     regularization, void, or correction) keeps a full window and is NOT erased
 *     while still live/dispute-relevant. A row updated < window ago is always
 *     retained, fail-safe.
 *   - AttendanceEvent has no `updatedAt` (append-only, createdAt only), so its
 *     cutoff is anchored on `timestamp` — the punch/muster-proof time, which is
 *     exactly the field that determines statutory relevance and is indexed.
 *   - DefaulterAlertDispatch purges on its own 1-year `createdAt` window — it is
 *     Bucket-D operational data with no personal content.
 *   - Single-flight (Redis) so a multi-worker deploy purges once per day.
 *
 * Reuses the audit-module retention philosophy (window-years → cutoff date)
 * adapted to per-workspace year windows, identical to SalaryRetentionPurgeCron.
 *
 * Dependency note: reads workspaces; hard-deletes the attendance collections it
 * owns (attendances, attendanceevents, defaulteralertdispatches). No
 * cross-module write.
 */
@Injectable()
export class AttendanceRetentionPurgeCron {
  private readonly logger = new Logger(AttendanceRetentionPurgeCron.name);

  constructor(
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
    @InjectModel(Attendance.name) private readonly attendanceModel: Model<Attendance>,
    @InjectModel(AttendanceEvent.name) private readonly eventModel: Model<AttendanceEvent>,
    @InjectModel(DefaulterAlertDispatch.name)
    private readonly dispatchModel: Model<DefaulterAlertDispatch>,
    private readonly singleFlight: SingleFlightService,
    // Phase 7 audit-at-purge (plan §8): the grievance-trail record. @Optional so
    // the positional unit tests keep compiling; DI supplies it (AttendanceModule
    // imports AuditModule). Best-effort — never aborts a purge.
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /**
   * CRON CONTRACT — Attendance retention purge (OQ-A4)
   * Execution:   @Cron + Redis single-flight per day. Disabled unless
   *              RUN_RETENTION_PURGE_ON_SCHEDULE=true.
   * Schedule:    daily 03:45 UTC (clear of the salary retention purge 03:30, the
   *              auto-close-stale 02:30, and the auto-present 15-min cron).
   * Idempotent:  YES — deletes only rows already past the window; a second run
   *              finds nothing new for the same day.
   * Reads:       workspaces
   * Writes:      HARD-DELETE of expired attendance + attendance-event muster rows
   *              (Bucket B) and stale defaulter-alert dispatch rows (Bucket D).
   * Owner:       attendance
   */
  @Cron('45 3 * * *', { timeZone: CRON_TIMEZONES.UTC })
  async handlePurge(): Promise<void> {
    if (!env.attendanceRetention.enabled) {
      this.logger.debug(
        'Attendance retention purge disabled (RUN_RETENTION_PURGE_ON_SCHEDULE != true); skipping.',
      );
      return;
    }
    await this.singleFlight.runExclusive('attendance.retention_purge', dayBucket(), () =>
      this.process(),
    );
  }

  private cutoff(years: number): Date {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d;
  }

  private async process(): Promise<void> {
    this.logger.log('Attendance retention purge starting...');

    // Window = max(env value, HARD floor constant). The HARD floor is the legal
    // minimum: an env knob set below the floor cannot shorten the window. There
    // is currently no per-workspace attendance retention override surface (the
    // Gujarat 10y muster rule is uniform), so the window is workspace-independent;
    // the per-workspace loop is kept for symmetry with the salary purge and so a
    // future per-workspace override slots in here without restructuring.
    const musterYears = Math.max(env.attendanceRetention.musterYears, STATUTORY_MUSTER_FLOOR_YEARS);
    const dispatchYears = Math.max(env.attendanceRetention.dispatchYears, DISPATCH_LOG_FLOOR_YEARS);

    const musterCutoff = this.cutoff(musterYears);
    const dispatchCutoff = this.cutoff(dispatchYears);

    const workspaces = await this.workspaceModel.find({}).select('_id name').lean().exec();

    let totalDeleted = 0;

    for (const ws of workspaces) {
      const workspaceId = String(ws._id);
      try {
        const wsOid = new Types.ObjectId(workspaceId);

        const [attendanceRes, eventRes, dispatchRes] = await Promise.all([
          // 10y muster window. Anchored on `updatedAt` so a recently-corrected old
          // row keeps a fresh window (mirrors the salary purge MEDIUM-1 fix).
          this.attendanceModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: musterCutoff },
          }),
          // 10y muster window for raw events. No `updatedAt` on this append-only
          // schema → anchor on `timestamp` (the punch/muster-proof time).
          this.eventModel.deleteMany({
            wsId: wsOid,
            timestamp: { $lt: musterCutoff },
          }),
          // 1y Bucket-D window for operational dispatch idempotency rows.
          this.dispatchModel.deleteMany({
            workspaceId: wsOid,
            createdAt: { $lt: dispatchCutoff },
          }),
        ]);

        const deleted =
          (attendanceRes.deletedCount ?? 0) +
          (eventRes.deletedCount ?? 0) +
          (dispatchRes.deletedCount ?? 0);

        if (deleted > 0) {
          totalDeleted += deleted;
          this.logger.log(
            `Attendance retention purge ws="${ws.name ?? workspaceId}" deleted=${deleted} ` +
              `(attendance=${attendanceRes.deletedCount ?? 0} events=${eventRes.deletedCount ?? 0} ` +
              `dispatches=${dispatchRes.deletedCount ?? 0}; musterYears=${musterYears} dispatchYears=${dispatchYears})`,
          );
          // Phase 7 grievance trail — record the muster/event/dispatch counts, the
          // basis, and the elapsed-window cutoffs. Best-effort; never aborts.
          await this.auditPurge(
            workspaceId,
            deleted,
            {
              attendance: attendanceRes.deletedCount ?? 0,
              attendanceEvent: eventRes.deletedCount ?? 0,
              defaulterAlertDispatch: dispatchRes.deletedCount ?? 0,
            },
            { muster: musterYears, dispatch: dispatchYears },
            { muster: musterCutoff.toISOString(), dispatch: dispatchCutoff.toISOString() },
          );
        }
      } catch (err) {
        this.logger.error(
          `Attendance retention purge failed for workspace ${workspaceId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }

    this.logger.log(`Attendance retention purge complete. Total rows deleted=${totalDeleted}.`);
  }

  /**
   * Best-effort grievance-trail audit of one workspace's purge (plan §8). No-op
   * when AuditService is not wired (positional unit tests). An audit failure is
   * logged but never thrown — the purge has already committed.
   */
  private async auditPurge(
    workspaceId: string,
    totalDeleted: number,
    collections: Record<string, number>,
    windowYears: Record<string, number>,
    cutoffs: Record<string, string>,
  ): Promise<void> {
    if (!this.auditService) return;
    try {
      await this.auditService.logEvent(
        buildRetentionPurgeAuditEvent({
          module: AppModule.ATTENDANCE,
          systemUserId: env.systemUserId,
          workspaceId,
          totalDeleted,
          collections,
          windowYears,
          cutoffs,
          basis: 'statutory-muster-floor',
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Attendance retention purge audit failed for workspace ${workspaceId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
}
