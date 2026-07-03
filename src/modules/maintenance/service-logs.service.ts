import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { ServiceLog } from './schemas/service-log.schema';
import { MaintenanceSchedule } from './schemas/maintenance-schedule.schema';
import { CreateServiceLogDto } from './dto/create-service-log.dto';
import { UpdateServiceLogDto } from './dto/update-service-log.dto';
import { ListServiceLogsQueryDto } from './dto/list-service-logs.query.dto';
import { ServicePartDto } from './dto/service-part.dto';
import { WorkspaceCounterService } from '../workspaces/workspace-counter.service';
import { DowntimeService } from '../downtime/downtime.service';
import { DowntimeReasonsService } from '../downtime/downtime-reasons.service';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

/**
 * ServiceLogCtx — request context (workspace + actor).
 *
 * `workspaceId` and `userId` are passed from the controller (Plan 24-07).
 * Both fields accept string or ObjectId; service layer wraps every read /
 * write filter site with `new Types.ObjectId(...)` per MACH-P2-XC-06
 * (Mongoose 8.23 autocast bug; memory:
 * `project_attendance_module_session_2026-04-22.md`).
 */
export type ServiceLogCtx = {
  workspaceId: string;
  userId: string;
};

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
const PARTS_LIMIT = 30;
const ALLOWED_UPDATE_FIELDS = ['notes', 'costPaise'] as const;

/**
 * ServiceLogsService (Phase 24, Plan 24-06).
 *
 * Heart of MACH-P2-04b (permanent log) + MACH-P2-04c (auto-downtime).
 *
 * Public surface:
 *   - create  → reserves MAINT-NNN code, snapshots parts (R8 workspace-scoped
 *               Item lookup) + technician name, opens Mongo session, inserts
 *               ServiceLog, calls DowntimeService.create with reason
 *               'maintenance', back-fills linkedDowntimeId, recomputes the
 *               schedule. Transactional via runWithTransactionFallback.
 *   - list    → workspace + machine scoped, supports scheduleId / technicianId
 *               / from / to filters and standard limit / offset paging.
 *   - get     → single-row read, throws SERVICE_LOG_NOT_FOUND when missing.
 *   - update  → 7-day edit window for `notes` + `costPaise` ONLY. Any other
 *               field surfaces SERVICE_LOG_FROZEN_FIELD 400. After 7 days,
 *               SERVICE_LOG_EDIT_WINDOW_EXPIRED 400. (D-15)
 *
 * Pitfall R2 (24-RESEARCH.md §11): `DowntimeService.create` opens its OWN
 * Mongo session via `runWithTransactionFallback` — passing our outer session
 * into it would deadlock. Strategy:
 *   1) outer session inserts ServiceLog (without linkedDowntimeId)
 *   2) call `downtimeService.create` WITHOUT outer session (it self-manages)
 *   3) on inner error → throw inside outer callback → outer rolls back
 *      ServiceLog insert
 *   4) on inner success → patch linkedDowntimeId via outer session, recompute
 *      the schedule, commit.
 *
 * Pitfall R8 (24-RESEARCH.md §10): every `partsReplaced.itemId` MUST be
 * validated as workspace-scoped before snapshotting `itemNameSnapshot` —
 * prevents cross-tenant snapshot leak (Phase 23 critical-fix learning).
 */
@Injectable()
export class ServiceLogsService {
  private readonly logger = new Logger(ServiceLogsService.name);

  constructor(
    @InjectModel(ServiceLog.name)
    private readonly logModel: Model<ServiceLog>,
    @InjectModel(MaintenanceSchedule.name)
    private readonly scheduleModel: Model<MaintenanceSchedule>,
    @InjectModel('Item') private readonly itemModel: Model<any>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
    private readonly counterService: WorkspaceCounterService,
    private readonly downtimeService: DowntimeService,
    private readonly downtimeReasonsService: DowntimeReasonsService,
    private readonly schedulesService: MaintenanceSchedulesService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Create a ServiceLog + auto-create the linked DowntimeEntry. Full flow per
   * 24-RESEARCH.md §11 (verbatim).
   */
  async create(
    ctx: ServiceLogCtx,
    machineId: string,
    dto: CreateServiceLogDto,
  ): Promise<ServiceLog> {
    // 1. Time-range validation.
    const servicedAt = new Date(dto.servicedAt);
    const serviceEndAt = new Date(dto.serviceEndAt);
    if (serviceEndAt <= servicedAt) {
      throw new BadRequestException({
        code: 'SERVICE_LOG_INVALID_TIME_RANGE',
        message: 'Service end must be after service start.',
      });
    }

    // 2. Parts cap (DoS guard, mirrors schema-layer validator).
    const partsInput = dto.partsReplaced ?? [];
    if (partsInput.length > PARTS_LIMIT) {
      throw new BadRequestException({
        code: 'SERVICE_LOG_PARTS_LIMIT',
        message: `Up to ${PARTS_LIMIT} parts per service log.`,
      });
    }

    // 3. Per-part XOR (defence in depth — schema hook also catches this).
    for (const p of partsInput) {
      const hasItem = !!p.itemId;
      const hasText = !!p.freeTextName?.toString().trim();
      if (hasItem === hasText) {
        throw new BadRequestException({
          code: 'SERVICE_PART_REQUIRES_ITEM_OR_TEXT',
          message:
            'Each replaced part must specify exactly one of itemId or freeTextName.',
        });
      }
    }

    // 4. Schedule scoping (when scheduleId provided). Capture the schedule's
    //    checklistItems for IN-02 server-side mapping below.
    let scheduleChecklistItems: string[] | null = null;
    if (dto.scheduleId) {
      const schedule = await this.scheduleModel
        .findOne({
          _id: new Types.ObjectId(dto.scheduleId),
          workspaceId: new Types.ObjectId(ctx.workspaceId),
          machineId: new Types.ObjectId(machineId),
          isDeleted: false,
        })
        .lean()
        .exec();
      if (!schedule) {
        throw new NotFoundException({
          code: 'SCHEDULE_NOT_FOUND',
          message: 'Maintenance schedule not found for this machine.',
        });
      }
      scheduleChecklistItems = (schedule as any).checklistItems ?? [];
    }

    // 4b. IN-02 (24-REVIEW.md): when scheduleId is provided, build
    //     checklistTicked server-side from `schedule.checklistItems` so the
    //     client cannot inject phantom items (defence in depth — schema
    //     `maxlength: 200` already caps individual entries).
    //
    //     Accepted client shapes:
    //       a) `[{ item, ticked }]` — every `item` MUST appear in the
    //          schedule's checklistItems; otherwise SERVICE_LOG_CHECKLIST_UNKNOWN_ITEM.
    //          Items not supplied default to `ticked: false`.
    //       b) Length-aligned boolean array via `ticked` flag only — when
    //          all entries omit `item` AND length === schedule.checklistItems.length,
    //          map positionally.
    //
    //     Ad-hoc service logs (no scheduleId) keep the legacy passthrough.
    let checklistTickedFinal: Array<{ item: string; ticked: boolean }> = [];
    if (dto.scheduleId && scheduleChecklistItems) {
      const supplied = dto.checklistTicked ?? [];
      const itemSet = new Set(scheduleChecklistItems);
      const tickedByItem = new Map<string, boolean>();
      const allMissingItem =
        supplied.length > 0 && supplied.every((t) => !t.item);

      if (
        allMissingItem &&
        supplied.length === scheduleChecklistItems.length
      ) {
        // Positional mapping (variant b).
        for (let i = 0; i < scheduleChecklistItems.length; i++) {
          tickedByItem.set(scheduleChecklistItems[i], !!supplied[i].ticked);
        }
      } else {
        for (const t of supplied) {
          if (!t.item) {
            throw new BadRequestException({
              code: 'SERVICE_LOG_CHECKLIST_MISSING_ITEM',
              message:
                'Each checklist tick must reference a schedule checklist item by name.',
            });
          }
          if (!itemSet.has(t.item)) {
            throw new BadRequestException({
              code: 'SERVICE_LOG_CHECKLIST_UNKNOWN_ITEM',
              message: `Checklist item "${t.item}" is not part of this schedule.`,
            });
          }
          tickedByItem.set(t.item, !!t.ticked);
        }
      }

      // Server-build final array from schedule order — preserves order,
      // defaults missing items to false.
      checklistTickedFinal = scheduleChecklistItems.map((item) => ({
        item,
        ticked: tickedByItem.get(item) ?? false,
      }));
    } else {
      // Ad-hoc service: trust the client (no schedule to map against).
      checklistTickedFinal = (dto.checklistTicked ?? []).map((t) => ({
        item: String(t.item ?? '').trim(),
        ticked: !!t.ticked,
      }));
    }

    // 5. Snapshots (R8 workspace-scoped Item lookup happens inside).
    const parts = await this.snapshotParts(ctx.workspaceId, partsInput);
    const technicianNameSnapshot = await this.snapshotTechnician(
      ctx.workspaceId,
      dto.technicianId,
    );

    // 6. Resolve workspace 'maintenance' reason code id (auto-seeds catalogue
    //    on first read).
    const maintenanceReasonId = await this.resolveMaintenanceReasonId(
      ctx.workspaceId,
    );

    // 7. Transactional core (per §11).
    return this.runWithTransactionFallback(async (session) => {
      const seq = await this.counterService.reserveNextServiceLogCode(
        ctx.workspaceId,
      );
      const serviceLogCode = `MAINT-${String(seq).padStart(3, '0')}`;
      const durationMinutes = Math.ceil(
        (serviceEndAt.getTime() - servicedAt.getTime()) / 60_000,
      );

      const baseDoc: Record<string, any> = {
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        machineId: new Types.ObjectId(machineId),
        scheduleId: dto.scheduleId
          ? new Types.ObjectId(dto.scheduleId)
          : null,
        serviceLogCode,
        servicedAt,
        serviceEndAt,
        durationMinutes,
        technicianId: dto.technicianId
          ? new Types.ObjectId(dto.technicianId)
          : null,
        technicianNameSnapshot,
        partsReplaced: parts,
        costPaise: dto.costPaise ?? 0,
        notes: dto.notes,
        checklistTicked: checklistTickedFinal,
        linkedDowntimeId: null,
        loggedByUserId: new Types.ObjectId(ctx.userId),
      };

      const [log] = await this.logModel.create([baseDoc], { session });

      // ──────────────────────────────────────────────────────────────────
      // PITFALL R2 (24-RESEARCH.md §11): DowntimeService.create runs its
      // OWN Mongo session via runWithTransactionFallback. We MUST NOT pass
      // our outer session in — nested sessions on the same client deadlock
      // (or Mongoose throws "Cannot use a session that has ended").
      //
      // Strategy: call without our session. On inner failure, throw inside
      // this callback so the outer transaction aborts the ServiceLog
      // insert. On inner success, patch linkedDowntimeId via the outer
      // session and continue.
      //
      // Edge case: if the linkedDowntimeId patch (or schedule recompute)
      // fails AFTER the inner downtime entry is committed, the outer
      // transaction rolls back the ServiceLog but the dangling
      // DowntimeEntry stays. Documented + accepted (cleanup is a manual
      // ops concern; logged below).
      // ──────────────────────────────────────────────────────────────────
      let downtime: any;
      try {
        downtime = await this.downtimeService.create(
          { workspaceId: ctx.workspaceId, userId: ctx.userId },
          machineId,
          {
            reasonCodeId: maintenanceReasonId,
            startAt: servicedAt.toISOString(),
            endAt: serviceEndAt.toISOString(),
            notes: `Auto-generated from service log ${serviceLogCode}`,
          } as any,
        );
      } catch (err: any) {
        const innerCode = err?.response?.code ?? err?.code;
        if (
          innerCode === 'DOWNTIME_OVERLAP' ||
          innerCode === 'DOWNTIME_OVERLAP_RACE'
        ) {
          throw new ConflictException({
            code: 'SERVICE_LOG_DOWNTIME_OVERLAP',
            message:
              'Service window conflicts with existing downtime entry. Resolve overlap first.',
            conflictingDowntimeId: err?.response?.conflictingEntryId,
          });
        }
        if (innerCode === 'DOWNTIME_MACHINE_RETIRED') {
          throw new BadRequestException({
            code: 'SERVICE_LOG_MACHINE_RETIRED',
            message: 'Cannot log service on retired machine.',
          });
        }
        if (innerCode === 'DOWNTIME_INVALID_TIME_RANGE') {
          throw new BadRequestException({
            code: 'SERVICE_LOG_INVALID_TIME_RANGE',
            message: 'Service end must be after service start.',
          });
        }
        // Unknown inner failure — surface verbatim so outer aborts.
        throw err;
      }

      // Patch linkedDowntimeId on the freshly-inserted ServiceLog.
      await this.logModel
        .updateOne(
          { _id: new Types.ObjectId(log._id as any) },
          {
            $set: {
              linkedDowntimeId: new Types.ObjectId(downtime._id as any),
            },
          },
          { session },
        )
        .exec();

      // Recompute schedule cadence + counters when wired.
      if (dto.scheduleId) {
        await this.schedulesService.recomputeAfterService(
          dto.scheduleId,
          servicedAt,
          session,
        );
      }

      this.logger.log(
        `ServiceLog ${serviceLogCode} created on machine ${machineId} ` +
          `→ linkedDowntime=${String(downtime._id)} ` +
          `(scheduleId=${dto.scheduleId ?? 'ad-hoc'})`,
      );

      const fresh = await this.logModel
        .findById(new Types.ObjectId(log._id as any))
        .session(session ?? null)
        .lean()
        .exec();
      return fresh as unknown as ServiceLog;
    });
  }

  /**
   * List service logs scoped by workspace + machine. Supports scheduleId,
   * technicianId, from, to filters per D-08.
   */
  async list(
    ctx: ServiceLogCtx,
    machineId: string,
    query: ListServiceLogsQueryDto,
  ): Promise<{ items: ServiceLog[]; total: number }> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(ctx.workspaceId),
      machineId: new Types.ObjectId(machineId),
    };
    if (query.scheduleId) {
      filter.scheduleId = new Types.ObjectId(query.scheduleId);
    }
    if (query.technicianId) {
      filter.technicianId = new Types.ObjectId(query.technicianId);
    }
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) range.$lte = new Date(query.to);
      filter.servicedAt = { ...(filter.servicedAt ?? {}), ...range };
    }

    const limit = Math.min(query.limit ?? 25, 500);
    const offset = Math.max(query.offset ?? 0, 0);

    const [items, total] = await Promise.all([
      this.logModel
        .find(filter)
        .sort({ servicedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec() as unknown as Promise<ServiceLog[]>,
      this.logModel.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }

  /** Single-row read; throws `SERVICE_LOG_NOT_FOUND` if missing. */
  async get(
    ctx: ServiceLogCtx,
    machineId: string,
    logId: string,
  ): Promise<ServiceLog> {
    const log = await this.logModel
      .findOne({
        _id: new Types.ObjectId(logId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        machineId: new Types.ObjectId(machineId),
      })
      .lean()
      .exec();
    if (!log) {
      throw new NotFoundException({
        code: 'SERVICE_LOG_NOT_FOUND',
        message: 'Service log not found.',
      });
    }
    return log as unknown as ServiceLog;
  }

  /**
   * Patch `notes` and / or `costPaise` within a 7-day window. Verbatim per
   * 24-RESEARCH.md §12 + D-15.
   *
   * Defence-in-depth: the validator (`UpdateServiceLogDto`) is whitelist-only
   * with `forbidNonWhitelisted: true` so unknown fields are rejected at the
   * pipe layer — but we re-check here to surface a clear `SERVICE_LOG_FROZEN_FIELD`
   * code if a future caller bypasses the global pipe.
   */
  async update(
    ctx: ServiceLogCtx,
    machineId: string,
    logId: string,
    dto: UpdateServiceLogDto,
  ): Promise<ServiceLog> {
    for (const key of Object.keys(dto)) {
      if (!ALLOWED_UPDATE_FIELDS.includes(key as any)) {
        throw new BadRequestException({
          code: 'SERVICE_LOG_FROZEN_FIELD',
          message: `Field '${key}' is frozen after creation and cannot be edited.`,
        });
      }
    }

    const log = await this.logModel
      .findOne({
        _id: new Types.ObjectId(logId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        machineId: new Types.ObjectId(machineId),
      })
      .exec();
    if (!log) {
      throw new NotFoundException({
        code: 'SERVICE_LOG_NOT_FOUND',
        message: 'Service log not found.',
      });
    }

    const createdAt = new Date((log as any).createdAt).getTime();
    const ageMs = Date.now() - createdAt;
    if (ageMs > SEVEN_DAYS_MS) {
      throw new BadRequestException({
        code: 'SERVICE_LOG_EDIT_WINDOW_EXPIRED',
        message: 'Service log older than 7 days cannot be edited.',
      });
    }

    const patch: Record<string, any> = {};
    if (dto.notes !== undefined) patch.notes = dto.notes;
    if (dto.costPaise !== undefined) patch.costPaise = dto.costPaise;

    if (Object.keys(patch).length > 0) {
      await this.logModel
        .updateOne(
          { _id: new Types.ObjectId(log._id as any) },
          { $set: patch },
        )
        .exec();
    }

    const fresh = await this.logModel
      .findById(new Types.ObjectId(log._id as any))
      .lean()
      .exec();
    return fresh as unknown as ServiceLog;
  }

  // ────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Snapshot `partsReplaced` rows. R8: each `itemId` is validated as
   * workspace-scoped (`Item.workspaceId === ctx.workspaceId`) BEFORE the name
   * snapshot is taken — prevents cross-tenant leak (Phase 23 critical-fix
   * learning, also documented in 24-CONTEXT.md §R8).
   */
  private async snapshotParts(
    workspaceId: string,
    parts: ServicePartDto[],
  ): Promise<any[]> {
    const out: any[] = [];
    for (const p of parts) {
      const row: any = {
        itemId: p.itemId ? new Types.ObjectId(p.itemId) : null,
        freeTextName: p.freeTextName ?? null,
        itemNameSnapshot: null,
        quantity: p.quantity,
        unitCostPaise: p.unitCostPaise ?? null,
        notes: p.notes,
      };
      if (p.itemId) {
        const item = await this.itemModel
          .findOne({
            _id: new Types.ObjectId(p.itemId),
            workspaceId: new Types.ObjectId(workspaceId),
          })
          .select('name')
          .lean()
          .exec();
        if (!item) {
          throw new BadRequestException({
            code: 'SERVICE_PART_ITEM_NOT_IN_WORKSPACE',
            message: `Item ${p.itemId} not found in workspace.`,
          });
        }
        row.itemNameSnapshot = (item as any).name ?? null;
      }
      out.push(row);
    }
    return out;
  }

  /**
   * Snapshot the technician's display name from `TeamMember.name` at create
   * time — survives rename / offboard. Returns null when no technician.
   */
  private async snapshotTechnician(
    workspaceId: string,
    technicianId: string | undefined,
  ): Promise<string | null> {
    if (!technicianId) return null;
    const tm = await this.teamMemberModel
      .findOne({
        _id: new Types.ObjectId(technicianId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .select('name')
      .lean()
      .exec();
    return (tm as any)?.name ?? null;
  }

  /**
   * Resolve the workspace's system 'maintenance' reason code id. The
   * downtime catalogue lazy-seeds 7 system codes (including 'maintenance')
   * on first read, so this should always succeed. We surface a clear
   * `MAINTENANCE_REASON_NOT_FOUND` 400 if the workspace catalogue has been
   * tampered with so settings can restore.
   */
  private async resolveMaintenanceReasonId(
    workspaceId: string,
  ): Promise<string> {
    const config: any = await this.downtimeReasonsService.get(workspaceId);
    const code = (config?.codes ?? []).find(
      (c: any) => c.key === 'maintenance',
    );
    if (!code) {
      throw new BadRequestException({
        code: 'MAINTENANCE_REASON_NOT_FOUND',
        message:
          'Workspace downtime catalogue missing system "maintenance" reason. Restore via settings.',
      });
    }
    return code._id.toString();
  }

  /**
   * Run a unit of work inside a Mongo transaction when the deployment
   * supports replica-set sessions; otherwise fall back to sessionless
   * sequential writes.
   *
   * Mirrors `DowntimeService.runWithTransactionFallback` (Phase 22 §6) — same
   * detection of Mongo code 20 / IllegalOperation / "replica set" /
   * "Transaction numbers" → retry without session. Production deployments
   * MUST run a replica set for full atomicity; single-node fallback is for
   * local dev only.
   */
  private async runWithTransactionFallback<T>(
    work: (session: ClientSession | undefined) => Promise<T>,
  ): Promise<T> {
    let session: ClientSession | null = null;
    try {
      session = await this.connection.startSession();
    } catch {
      // Driver couldn't even open a session — fall back immediately.
      return work(undefined);
    }

    try {
      session.startTransaction();
      const result = await work(session);
      await session.commitTransaction();
      return result;
    } catch (err: any) {
      try {
        await session.abortTransaction();
      } catch {
        /* ignore */
      }
      const isRsUnsupported =
        err?.code === 20 ||
        err?.codeName === 'IllegalOperation' ||
        /replica set/i.test(err?.message ?? '') ||
        /Transaction numbers/i.test(err?.message ?? '');
      if (isRsUnsupported) {
        this.logger.warn(
          'ServiceLogsService: transaction unsupported (single-node Mongo); ' +
            'falling back to sessionless writes.',
        );
        return work(undefined);
      }
      throw err;
    } finally {
      try {
        await session.endSession();
      } catch {
        /* ignore */
      }
    }
  }
}
