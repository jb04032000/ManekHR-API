import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import dayjs from 'dayjs';
import {
  MaintenanceSchedule,
  CadenceMode,
} from './schemas/maintenance-schedule.schema';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';
import { UpdateMaintenanceScheduleDto } from './dto/update-maintenance-schedule.dto';
import { PauseScheduleDto } from './dto/pause-schedule.dto';
import { SetMaintenanceLeadTimeDto } from './dto/set-maintenance-lead-time.dto';
import { WorkspaceCounterService } from '../workspaces/workspace-counter.service';

/**
 * MaintenanceSchedulesService (Phase 24, Plan 24-04).
 *
 * Brain of the maintenance scheduling subsystem:
 *  - CRUD over `MaintenanceSchedule`
 *  - Cadence engine — `computeNextDue` covers all 5 modes (D-03)
 *  - Workspace lead-time setter (D-10) + per-schedule override resolver
 *  - `listDue` aggregator powering dashboard widget + machine-list badge
 *    (D-04), ResourceScope-aware via `ctx.scopedMachineIds`
 *  - `recomputeAfterService` hook called by ServiceLogsService (Plan 24-06)
 *  - `refreshDerivedCounters` cron entry-point (Plan 24-05 fills body;
 *    here a structured stub — D-03 hours/output derivation)
 *
 * All read filters wrap workspaceId / machineId / scheduleId / userId with
 * `new Types.ObjectId(...)` per MACH-P2-XC-06 (Mongoose 8.23 autocast bug;
 * memory: project_attendance_module_session_2026-04-22.md).
 *
 * Cross-module schemas (`Machine`, `Workspace`, `TeamMember`, `DowntimeEntry`,
 * `ProductionLog`) are injected via `@InjectModel('Name')` string tokens —
 * matches F-16-02 STATE.md decorator-metadata pattern + the precedent set by
 * `production-logs.service.ts`.
 */
export type ScheduleCtx = {
  workspaceId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  scopedMachineIds?: Array<string | Types.ObjectId>;
};

export interface DueRow {
  scheduleId: string;
  scheduleCode: string;
  scheduleName: string;
  machineId: string;
  machineCode: string;
  machineName: string;
  technicianId: string | null;
  nextDueAt: Date;
  daysRemaining: number;
}

const FAR_FUTURE = '9999-12-31T00:00:00Z';
const MS_PER_DAY = 86_400_000;
const DEFAULT_LEAD_TIME_DAYS = 7;
const MAX_DUE_LIMIT = 200;
const DEFAULT_DUE_LIMIT = 25;

@Injectable()
export class MaintenanceSchedulesService {
  private readonly logger = new Logger(MaintenanceSchedulesService.name);

  constructor(
    @InjectModel(MaintenanceSchedule.name)
    private readonly scheduleModel: Model<MaintenanceSchedule>,
    @InjectModel('Machine') private readonly machineModel: Model<any>,
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
    @InjectModel('DowntimeEntry') private readonly downtimeModel: Model<any>,
    @InjectModel('ProductionLog')
    private readonly productionLogModel: Model<any>,
    private readonly counterService: WorkspaceCounterService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // CRUD
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Create a new maintenance schedule on a machine.
   *
   * 1. Reserve `MS-NNN` code via WorkspaceCounter
   * 2. Default `anchorDate` to now if omitted
   * 3. Compute `nextDueAt` from cadence + anchor (D-03)
   * 4. Persist with audit fields populated
   */
  async create(
    ctx: ScheduleCtx,
    machineId: string,
    dto: CreateMaintenanceScheduleDto,
  ): Promise<MaintenanceSchedule> {
    const seq = await this.counterService.reserveNextMaintenanceScheduleCode(
      ctx.workspaceId,
    );
    const scheduleCode = `MS-${String(seq).padStart(3, '0')}`;
    const anchorDate = dto.anchorDate ? new Date(dto.anchorDate) : new Date();

    const skeleton: Partial<MaintenanceSchedule> = {
      workspaceId: new Types.ObjectId(ctx.workspaceId as string),
      machineId: new Types.ObjectId(machineId),
      scheduleCode,
      name: dto.name,
      cadenceMode: dto.cadenceMode,
      cadenceInterval: dto.cadenceInterval,
      technicianId: dto.technicianId
        ? new Types.ObjectId(dto.technicianId)
        : null,
      checklistItems: dto.checklistItems ?? [],
      leadTimeDays: dto.leadTimeDays ?? null,
      estimatedDurationMinutes: dto.estimatedDurationMinutes ?? 60,
      defaultDowntimeReasonCodeId: dto.defaultDowntimeReasonCodeId
        ? new Types.ObjectId(dto.defaultDowntimeReasonCodeId)
        : null,
      anchorDate,
      hoursAccumulated: 0,
      outputAccumulated: 0,
      lastServicedAt: null,
      isActive: true,
      isDeleted: false,
      createdBy: new Types.ObjectId(ctx.userId as string),
      updatedBy: new Types.ObjectId(ctx.userId as string),
    };

    const nextDueAt = this.computeNextDue(skeleton as MaintenanceSchedule);

    const [created] = await this.scheduleModel.create([
      { ...skeleton, nextDueAt },
    ]);
    return created;
  }

  /**
   * List all non-deleted schedules for a machine. Includes paused (inactive)
   * rows so the UI can surface them with a paused badge.
   */
  async list(
    ctx: ScheduleCtx,
    machineId: string,
  ): Promise<MaintenanceSchedule[]> {
    return this.scheduleModel
      .find({
        workspaceId: new Types.ObjectId(ctx.workspaceId as string),
        machineId: new Types.ObjectId(machineId),
        isDeleted: false,
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec() as unknown as Promise<MaintenanceSchedule[]>;
  }

  /** Single-row read; throws SCHEDULE_NOT_FOUND if missing or soft-deleted. */
  async get(
    ctx: ScheduleCtx,
    machineId: string,
    scheduleId: string,
  ): Promise<MaintenanceSchedule> {
    const doc = await this.scheduleModel
      .findOne({
        _id: new Types.ObjectId(scheduleId),
        workspaceId: new Types.ObjectId(ctx.workspaceId as string),
        machineId: new Types.ObjectId(machineId),
        isDeleted: false,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException({
        code: 'SCHEDULE_NOT_FOUND',
        message: 'Maintenance schedule not found.',
      });
    }
    return doc;
  }

  /**
   * Patch schedule fields. Recomputes `nextDueAt` whenever cadence inputs
   * (cadenceMode / cadenceInterval / anchorDate) move.
   */
  async update(
    ctx: ScheduleCtx,
    machineId: string,
    scheduleId: string,
    dto: UpdateMaintenanceScheduleDto,
  ): Promise<MaintenanceSchedule> {
    const schedule = await this.get(ctx, machineId, scheduleId);

    const patch: Record<string, any> = {
      updatedBy: new Types.ObjectId(ctx.userId as string),
    };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.cadenceMode !== undefined) patch.cadenceMode = dto.cadenceMode;
    if (dto.cadenceInterval !== undefined)
      patch.cadenceInterval = dto.cadenceInterval;
    if (dto.technicianId !== undefined) {
      patch.technicianId = dto.technicianId
        ? new Types.ObjectId(dto.technicianId)
        : null;
    }
    if (dto.checklistItems !== undefined)
      patch.checklistItems = dto.checklistItems;
    if (dto.leadTimeDays !== undefined)
      patch.leadTimeDays = dto.leadTimeDays ?? null;
    if (dto.estimatedDurationMinutes !== undefined)
      patch.estimatedDurationMinutes = dto.estimatedDurationMinutes;
    if (dto.defaultDowntimeReasonCodeId !== undefined) {
      patch.defaultDowntimeReasonCodeId = dto.defaultDowntimeReasonCodeId
        ? new Types.ObjectId(dto.defaultDowntimeReasonCodeId)
        : null;
    }
    if (dto.anchorDate !== undefined)
      patch.anchorDate = new Date(dto.anchorDate);

    const cadenceTouched =
      dto.cadenceMode !== undefined ||
      dto.cadenceInterval !== undefined ||
      dto.anchorDate !== undefined;

    if (cadenceTouched) {
      const merged: MaintenanceSchedule = {
        ...(schedule.toObject ? schedule.toObject() : (schedule as any)),
        ...patch,
      } as MaintenanceSchedule;
      patch.nextDueAt = this.computeNextDue(merged);
    }

    await this.scheduleModel
      .updateOne(
        { _id: new Types.ObjectId(scheduleId) },
        { $set: patch },
      )
      .exec();

    return this.get(ctx, machineId, scheduleId);
  }

  /**
   * Toggle `isActive` (pause / resume). Resuming recomputes `nextDueAt` so an
   * alert does not fire stale.
   */
  async pause(
    ctx: ScheduleCtx,
    machineId: string,
    scheduleId: string,
    dto: PauseScheduleDto,
  ): Promise<MaintenanceSchedule> {
    const schedule = await this.get(ctx, machineId, scheduleId);
    const patch: Record<string, any> = {
      isActive: dto.isActive,
      updatedBy: new Types.ObjectId(ctx.userId as string),
    };
    if (dto.isActive) {
      // Recompute on resume so stale due-date does not surface.
      patch.nextDueAt = this.computeNextDue(schedule);
    }
    await this.scheduleModel
      .updateOne(
        { _id: new Types.ObjectId(scheduleId) },
        { $set: patch },
      )
      .exec();
    return this.get(ctx, machineId, scheduleId);
  }

  /** Soft-delete; preserves history but hides from all reads. */
  async softDelete(
    ctx: ScheduleCtx,
    machineId: string,
    scheduleId: string,
  ): Promise<{ deleted: true; scheduleCode: string }> {
    const schedule = await this.get(ctx, machineId, scheduleId);
    await this.scheduleModel
      .updateOne(
        { _id: new Types.ObjectId(scheduleId) },
        {
          $set: {
            isDeleted: true,
            deletedAt: new Date(),
            updatedBy: new Types.ObjectId(ctx.userId as string),
          },
        },
      )
      .exec();
    return { deleted: true, scheduleCode: schedule.scheduleCode };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Workspace-level
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Schedules due within their effective lead-time. Powers the dashboard
   * widget + machine-list badge (D-04).
   *
   * Per-schedule lead-time may differ → fetch all live schedules in scope
   * then filter in-memory using `resolveLeadTime(s, ws)`.
   */
  async listDue(
    ctx: ScheduleCtx,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ items: DueRow[]; total: number }> {
    const limit = Math.min(opts.limit ?? DEFAULT_DUE_LIMIT, MAX_DUE_LIMIT);
    const offset = Math.max(opts.offset ?? 0, 0);

    const ws = await this.workspaceModel
      .findOne({
        _id: new Types.ObjectId(ctx.workspaceId as string),
      })
      .select('maintenanceLeadTimeDays')
      .lean()
      .exec();

    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(ctx.workspaceId as string),
      isActive: true,
      isDeleted: false,
    };
    if (
      Array.isArray(ctx.scopedMachineIds) &&
      ctx.scopedMachineIds.length > 0
    ) {
      filter.machineId = {
        $in: ctx.scopedMachineIds.map((id) => new Types.ObjectId(id as string)),
      };
    }

    const candidates = (await this.scheduleModel
      .find(filter)
      .lean()
      .exec()) as any[];
    const now = Date.now();
    const due = candidates.filter((s) => {
      const leadDays = this.resolveLeadTime(s, ws);
      return (
        s.nextDueAt &&
        new Date(s.nextDueAt).getTime() <= now + leadDays * MS_PER_DAY
      );
    });

    if (due.length === 0) return { items: [], total: 0 };

    // Hydrate machine display fields in one shot.
    const machineIds = Array.from(
      new Set(due.map((s) => String(s.machineId))),
    );
    const machines = (await this.machineModel
      .find({
        _id: { $in: machineIds.map((id) => new Types.ObjectId(id)) },
      })
      .select('machineCode name')
      .lean()
      .exec()) as any[];
    const machineMap = new Map<
      string,
      { machineCode: string; name: string }
    >();
    for (const m of machines) {
      machineMap.set(String(m._id), {
        machineCode: m.machineCode ?? '',
        name: m.name ?? '',
      });
    }

    const rows: DueRow[] = due.map((s) => {
      const m = machineMap.get(String(s.machineId));
      const dueAt = new Date(s.nextDueAt).getTime();
      const daysRemaining = Math.ceil((dueAt - now) / MS_PER_DAY);
      return {
        scheduleId: String(s._id),
        scheduleCode: s.scheduleCode,
        scheduleName: s.name,
        machineId: String(s.machineId),
        machineCode: m?.machineCode ?? '',
        machineName: m?.name ?? '',
        technicianId: s.technicianId ? String(s.technicianId) : null,
        nextDueAt: new Date(s.nextDueAt),
        daysRemaining,
      };
    });

    rows.sort((a, b) => a.daysRemaining - b.daysRemaining);
    const items = rows.slice(offset, offset + limit);
    return { items, total: rows.length };
  }

  /** Read workspace default lead-time (D-10). Falls back to 7 if unset. */
  async getLeadTime(
    workspaceId: string | Types.ObjectId,
  ): Promise<{ leadTimeDays: number }> {
    const ws = await this.workspaceModel
      .findOne({ _id: new Types.ObjectId(workspaceId as string) })
      .select('maintenanceLeadTimeDays')
      .lean()
      .exec();
    return {
      leadTimeDays:
        (ws as any)?.maintenanceLeadTimeDays ?? DEFAULT_LEAD_TIME_DAYS,
    };
  }

  /** Owner-only setter; defensive 1..30 bound matches DTO + schema. */
  async setLeadTime(
    workspaceId: string | Types.ObjectId,
    dto: SetMaintenanceLeadTimeDto,
  ): Promise<{ leadTimeDays: number }> {
    if (dto.leadTimeDays < 1 || dto.leadTimeDays > 30) {
      throw new BadRequestException({
        code: 'MAINTENANCE_LEAD_TIME_OUT_OF_RANGE',
        message: 'Lead-time must be between 1 and 30 days.',
      });
    }
    await this.workspaceModel
      .updateOne(
        { _id: new Types.ObjectId(workspaceId as string) },
        { $set: { maintenanceLeadTimeDays: dto.leadTimeDays } },
      )
      .exec();
    return { leadTimeDays: dto.leadTimeDays };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internal hooks
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Called by ServiceLogsService (Plan 24-06) immediately after persisting a
   * ServiceLog. Resets accumulated counters and re-anchors `nextDueAt` from
   * the new `lastServicedAt`.
   *
   * Internal call → no scope check; caller has already scoped the machine.
   */
  async recomputeAfterService(
    scheduleId: string | Types.ObjectId,
    servicedAt: Date,
    session?: ClientSession,
  ): Promise<void> {
    const schedule = await this.scheduleModel
      .findOne({ _id: new Types.ObjectId(scheduleId as string) })
      .session(session ?? null)
      .exec();
    if (!schedule) {
      // Defensive: schedule may have been soft-deleted between log create and
      // this call; nothing to recompute.
      this.logger.warn(
        `recomputeAfterService: schedule ${String(scheduleId)} not found`,
      );
      return;
    }

    schedule.lastServicedAt = servicedAt;
    schedule.hoursAccumulated = 0;
    schedule.outputAccumulated = 0;
    const nextDueAt = this.computeNextDue(schedule);

    await this.scheduleModel
      .updateOne(
        { _id: schedule._id },
        {
          $set: {
            lastServicedAt: servicedAt,
            hoursAccumulated: 0,
            outputAccumulated: 0,
            nextDueAt,
          },
        },
        { session: session ?? null },
      )
      .exec();
  }

  /**
   * Cron entry-point (02:00 workspace tz) — refreshes hours/output derived
   * counters for ALL active hours_based + output_based schedules in the
   * workspace, then recomputes `nextDueAt` per D-03.
   *
   * Per-schedule failure is logged and skipped — never aborts the batch.
   * Derivation logic per 24-RESEARCH.md §8.
   */
  async refreshDerivedCounters(
    workspaceId: string | Types.ObjectId,
  ): Promise<void> {
    const wsId = new Types.ObjectId(workspaceId as string);
    const schedules = await this.scheduleModel
      .find({
        workspaceId: wsId,
        isActive: true,
        isDeleted: false,
        cadenceMode: { $in: ['hours_based', 'output_based'] },
      })
      .exec();

    this.logger.log(
      `refreshDerivedCounters: workspace ${String(workspaceId)} — ${schedules.length} hours/output schedule(s) to refresh`,
    );

    for (const s of schedules) {
      try {
        if (s.cadenceMode === 'hours_based') {
          const hours = await this.deriveHoursAccumulated(s);
          s.hoursAccumulated = hours;
        } else if (s.cadenceMode === 'output_based') {
          const output = await this.deriveOutputAccumulated(s);
          s.outputAccumulated = output;
        }
        const nextDueAt = this.computeNextDue(s);
        await this.scheduleModel
          .updateOne(
            { _id: s._id },
            {
              $set: {
                hoursAccumulated: s.hoursAccumulated,
                outputAccumulated: s.outputAccumulated,
                nextDueAt,
              },
            },
          )
          .exec();
      } catch (err) {
        this.logger.error(
          `refreshDerivedCounters: failed for schedule ${String(s._id)}`,
          err as any,
        );
        // continue — single schedule failure should not abort batch
      }
    }
  }

  /**
   * Cron-friendly fan-out wrapper — refresh derived counters for one
   * workspace (when `workspaceId` provided) or for ALL workspaces that own
   * at least one active hours/output schedule (when omitted). The 02:00
   * cron (Plan 24-08) calls this without args; admin-triggered refresh of a
   * single workspace passes the id.
   */
  async refreshAllDerivedCounters(
    workspaceId?: string | Types.ObjectId,
  ): Promise<{ workspacesProcessed: number }> {
    if (workspaceId) {
      await this.refreshDerivedCounters(workspaceId);
      return { workspacesProcessed: 1 };
    }
    // Distinct workspaces that own at least one active hours/output
    // schedule. Avoids hitting workspaces with nothing to do.
    const workspaceIds = (await this.scheduleModel
      .distinct('workspaceId', {
        isActive: true,
        isDeleted: false,
        cadenceMode: { $in: ['hours_based', 'output_based'] },
      })
      .exec()) as Types.ObjectId[];

    this.logger.log(
      `refreshAllDerivedCounters: ${workspaceIds.length} workspace(s) to process`,
    );
    for (const wsId of workspaceIds) {
      try {
        await this.refreshDerivedCounters(wsId);
      } catch (err) {
        this.logger.error(
          `refreshAllDerivedCounters: workspace ${String(wsId)} failed`,
          err as any,
        );
        // continue with next workspace
      }
    }
    return { workspacesProcessed: workspaceIds.length };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Cadence engine — D-03, §7 of 24-RESEARCH.md (verbatim).
   *
   * For hours_based / output_based, returns "now" once the accumulated
   * counter crosses the interval, else the FAR_FUTURE sentinel
   * (9999-12-31) so the row falls outside any practical lead-time window.
   */
  private computeNextDue(s: MaintenanceSchedule): Date {
    const anchor = s.lastServicedAt ?? s.anchorDate;
    const mode: CadenceMode = s.cadenceMode;
    // HI-01 catch-up semantic (REVIEW 24-REVIEW.md HI-01): for time-based
    // cadences, advance `nextDueAt` in `cadenceInterval` strides until it
    // falls strictly in the future. This skips stale missed cycles (no
    // backlog spam) and surfaces only the next-future cycle. Calendar-aware
    // for monthly via dayjs (Jan 31 + 1 month → Feb 28/29).
    switch (mode) {
      case 'daily':
      case 'weekly':
      case 'monthly': {
        const unit: 'day' | 'week' | 'month' =
          mode === 'daily' ? 'day' : mode === 'weekly' ? 'week' : 'month';
        const interval = s.cadenceInterval;
        const now = dayjs();
        let next = dayjs(anchor).add(interval, unit);
        // Hard cap on iterations to defend against pathological inputs
        // (interval=0 would loop forever). Schema validators forbid <1 but
        // belt-and-braces here; bail after 10000 strides (~27 years daily).
        let guard = 0;
        while (next.isBefore(now) && guard++ < 10000) {
          next = next.add(interval, unit);
        }
        return next.toDate();
      }
      case 'hours_based':
        return s.hoursAccumulated >= s.cadenceInterval
          ? new Date()
          : new Date(FAR_FUTURE);
      case 'output_based':
        return s.outputAccumulated >= s.cadenceInterval
          ? new Date()
          : new Date(FAR_FUTURE);
      default: {
        // Defensive — DTO + schema enum should prevent reaching this.
        throw new BadRequestException({
          code: 'SCHEDULE_INVALID_CADENCE_INTERVAL',
          message: `Unknown cadence mode: ${String(mode)}`,
        });
      }
    }
  }

  /**
   * Derive output accumulated since `lastServicedAt ?? anchorDate` for an
   * `output_based` schedule. Resolves the metric from `machine.primaryMetric`
   * (per project critical rule + objective) and sums the matching field on
   * ProductionLog:
   *   - 'stitches' → sum `$stitchCount`
   *   - 'pieces'   → sum `$pieceCount`
   *   - 'hours'    → sum `$hoursLogged`
   *
   * NOTE: ProductionLog has no `loggedAt` field — schema uses `date` (string)
   * + Mongoose timestamps `createdAt`. We use `createdAt >= since` so the
   * cutoff is real-time accurate (mid-day service won't double-count).
   *
   * Returns 0 if machine missing / metric absent / no logs.
   */
  private async deriveOutputAccumulated(
    s: MaintenanceSchedule,
  ): Promise<number> {
    const since = s.lastServicedAt ?? s.anchorDate;
    const machine = (await this.machineModel
      .findOne({ _id: new Types.ObjectId(s.machineId as any) })
      .select('primaryMetric')
      .lean()
      .exec()) as { primaryMetric?: 'stitches' | 'pieces' | 'hours' } | null;
    const primaryMetric = machine?.primaryMetric;
    if (!primaryMetric) {
      // Machine deleted or primary metric unset — cannot derive output.
      return s.outputAccumulated ?? 0;
    }
    const fieldByMetric: Record<string, string> = {
      stitches: '$stitchCount',
      pieces: '$pieceCount',
      hours: '$hoursLogged',
    };
    const sumField = fieldByMetric[primaryMetric];
    if (!sumField) return s.outputAccumulated ?? 0;

    const result = await this.productionLogModel.aggregate([
      {
        $match: {
          workspaceId: new Types.ObjectId(s.workspaceId as any),
          machineId: new Types.ObjectId(s.machineId as any),
          isDeleted: false,
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: null, total: { $sum: sumField } } },
    ]);
    return result[0]?.total ?? 0;
  }

  /**
   * Derive machine running hours since `lastServicedAt ?? anchorDate` for an
   * `hours_based` schedule. Best-effort v1 (D-03):
   *
   *   running_hours = elapsed_real_hours - sum(downtime.durationMinutes / 60)
   *
   * Only closed downtime entries (`durationMinutes != null`) within the
   * window are counted. Open entries are ignored — they'll be picked up on
   * the next refresh after they're closed.
   *
   * Returns max(0, …) to guard against clock skew / future-dated downtime.
   */
  private async deriveHoursAccumulated(
    s: MaintenanceSchedule,
  ): Promise<number> {
    const since = s.lastServicedAt ?? s.anchorDate;
    const downtimeAgg = await this.downtimeModel.aggregate([
      {
        $match: {
          workspaceId: new Types.ObjectId(s.workspaceId as any),
          machineId: new Types.ObjectId(s.machineId as any),
          isDeleted: false,
          startAt: { $gte: since },
          durationMinutes: { $ne: null },
        },
      },
      { $group: { _id: null, totalMinutes: { $sum: '$durationMinutes' } } },
    ]);
    const totalElapsedHours =
      (Date.now() - new Date(since).getTime()) / 3_600_000;
    const downtimeHours = (downtimeAgg[0]?.totalMinutes ?? 0) / 60;
    return Math.max(0, totalElapsedHours - downtimeHours);
  }

  /** Schedule override → workspace default → 7 days. */
  private resolveLeadTime(
    s: { leadTimeDays?: number | null },
    ws: { maintenanceLeadTimeDays?: number | null } | null | undefined,
  ): number {
    return (
      s.leadTimeDays ?? ws?.maintenanceLeadTimeDays ?? DEFAULT_LEAD_TIME_DAYS
    );
  }
}
