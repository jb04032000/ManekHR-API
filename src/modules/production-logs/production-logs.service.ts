import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { ProductionLog, PRIMARY_METRICS, PrimaryMetric } from './schemas/production-log.schema';
import { CreateProductionLogDto } from './dto/create-production-log.dto';
import { UpdateProductionLogDto } from './dto/update-production-log.dto';
import { BulkCreateProductionLogDto } from './dto/bulk-create-production-log.dto';
import { ListProductionLogsQueryDto } from './dto/list-production-logs.query.dto';
import { MachinesService } from '../machines/machines.service';
import { SalaryService } from '../salary/salary.service';
import { WorkspaceCounterService } from '../workspaces/workspace-counter.service';

// Re-export for callers who need the type (Plan 07 controller)
export { PRIMARY_METRICS, PrimaryMetric };

interface CreateContext {
  workspaceId: string;
  userId: string;
  workspaceTimezone: string;
  scopedMachineIds?: Types.ObjectId[];
  /** (year-month) -> isLocked — avoids N+1 payroll queries in bulk loop (Pitfall 6) */
  lockCache?: Map<string, boolean>;
  /**
   * Plan 23-07 — when true, skip the markPieceRateStale fire-and-forget call
   * inside create(). bulkCreate() sets this so it can dedupe stale-marks per
   * (teamMemberId, year-month) at the batch level (avoids N stale-marks for
   * a 30-day backfill of a single worker).
   */
  skipStaleMark?: boolean;
}

@Injectable()
export class ProductionLogsService {
  private readonly logger = new Logger(ProductionLogsService.name);

  constructor(
    @InjectModel(ProductionLog.name)
    private readonly productionLogModel: Model<ProductionLog>,
    // String token — avoids vitest decorator-metadata trip on Mongoose autocast resolver;
    // resolves identically to MachinesModule's forFeature token at build time (see STATE.md F-16-02).
    @InjectModel('Machine')
    private readonly machineModel: Model<any>,
    @InjectModel('MachineShiftAssignment')
    private readonly assignmentModel: Model<any>,
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<any>,
    private readonly machinesService: MachinesService,
    private readonly salaryService: SalaryService,
    private readonly counterService: WorkspaceCounterService,
    // Phase 25 Plan 03 — emit cache-invalidation event for UtilisationService
    // LRU (Plan 04) per D-05 / RESEARCH Pitfall 8.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ============================================================
  // PUBLIC API
  // ============================================================

  /**
   * Create a single production log for a specific machine (from URL path).
   */
  async create(
    ctx: CreateContext,
    machineIdFromPath: string,
    dto: CreateProductionLogDto,
  ): Promise<ProductionLog> {
    // 1) ResourceScope check — operator may only log for machines in their scope
    if (
      ctx.scopedMachineIds &&
      !ctx.scopedMachineIds.some((id) => id.toString() === machineIdFromPath)
    ) {
      throw new ForbiddenException({
        code: 'PRODUCTION_LOG_OUT_OF_SCOPE',
        message: 'Machine is outside your resource scope.',
      });
    }

    // 2) Edit-window guard + payroll-lock guard (D-03)
    await this.assertEditable(
      ctx.workspaceId,
      dto.date,
      ctx.workspaceTimezone,
      ctx.lockCache,
    );

    // 3) Resolve machine + snapshot primaryMetric at create time (Pitfall 5)
    const machine = await this.machineModel
      .findOne({
        _id: new Types.ObjectId(machineIdFromPath),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        isDeleted: false,
      })
      .lean()
      .exec();
    if (!machine) {
      throw new NotFoundException({
        code: 'MACHINE_NOT_FOUND',
        message: 'Machine not found or not in this workspace.',
      });
    }
    const primaryMetric = this.machinesService.resolvePrimaryMetric(machine);

    // 4) Validate primary metric value is present (D-02)
    this.assertPrimaryMetricProvided(dto, primaryMetric);

    // 5) Auto-resolve assignment (D-06)
    const assignmentId = await this.resolveAssignmentId(
      ctx.workspaceId,
      machineIdFromPath,
      dto,
    );

    // 6) Reserve PROD-NNN code atomically (D-04)
    const seq = await this.counterService.reserveNextProductionLogCode(
      ctx.workspaceId,
    );
    const logCode = this.formatProductionLogCode(seq);

    // 7) Persist
    const created = await this.productionLogModel.create({
      workspaceId: new Types.ObjectId(ctx.workspaceId),
      assignmentId: new Types.ObjectId(assignmentId),
      machineId: new Types.ObjectId(machineIdFromPath),
      teamMemberId: new Types.ObjectId(dto.teamMemberId),
      shiftId: dto.shiftId ? new Types.ObjectId(dto.shiftId) : undefined,
      date: dto.date,
      logCode,
      primaryMetric,
      stitchCount: dto.stitchCount ?? null,
      pieceCount: dto.pieceCount ?? null,
      hoursLogged:
        dto.hoursLogged != null
          ? Math.round(dto.hoursLogged * 100) / 100
          : null,
      notes: dto.notes,
      createdBy: new Types.ObjectId(ctx.userId),
    });

    this.logger.log(
      `Created production log ${logCode} for machine ${machineIdFromPath} in workspace ${ctx.workspaceId}`,
    );

    // Plan 23-07 D-07 — fire-and-forget stale flag for the affected piece-rate
    // Salary row. bulkCreate() sets skipStaleMark and dedupes at batch level.
    if (!ctx.skipStaleMark) {
      await this.safeMarkPieceRateStale(
        ctx.workspaceId,
        dto.teamMemberId,
        dto.date,
      );
    }

    // Phase 25 Plan 03 — invalidate UtilisationService LRU (Plan 04, D-05).
    this.eventEmitter.emit('production_log.changed', {
      workspaceId: String(created.workspaceId),
      machineId: String(created.machineId),
    });

    return created.toObject() as ProductionLog;
  }

  /**
   * Plan 23-07 — wrap SalaryService.markPieceRateStale so a hook failure never
   * blocks the production-log write (eventually consistent per RESEARCH §6).
   */
  private async safeMarkPieceRateStale(
    workspaceId: string | Types.ObjectId,
    teamMemberId: string | Types.ObjectId,
    date: string,
  ): Promise<void> {
    try {
      await this.salaryService.markPieceRateStale(
        workspaceId,
        teamMemberId,
        date,
      );
    } catch (err) {
      this.logger.warn(
        `markPieceRateStale failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Bulk create production logs — partial-success per D-05.
   * Returns { created[], failed[] }; individual failures do NOT abort the batch.
   *
   * Scope violations within bulk are treated as individual failures (Pitfall 7)
   * rather than a 403 that aborts the entire batch.
   */
  async bulkCreate(
    ctx: CreateContext,
    dto: BulkCreateProductionLogDto,
  ): Promise<{
    created: ProductionLog[];
    failed: { index: number; error: string; code?: string }[];
  }> {
    const created: ProductionLog[] = [];
    const failed: { index: number; error: string; code?: string }[] = [];

    // Shared payroll-lock cache across the batch to avoid N+1 Salary queries (Pitfall 6)
    const lockCache = new Map<string, boolean>();

    // Plan 23-07 — dedupe stale-marks per (teamMemberId, year-month). A 30-day
    // backfill for one worker should mark stale exactly once, not 30 times.
    const stalenessMarked = new Set<string>();
    const staleTargets: { teamMemberId: string; date: string }[] = [];

    for (let i = 0; i < dto.entries.length; i++) {
      const item = dto.entries[i];
      try {
        const log = await this.create(
          { ...ctx, lockCache, skipStaleMark: true },
          item.machineId!, // BulkProductionLogItemDto overrides machineId to required
          item,
        );
        created.push(log);

        // Record one stale-mark per (worker, year-month) for post-loop dispatch.
        const ym = (item.date || '').slice(0, 7); // YYYY-MM
        const key = `${item.teamMemberId}:${ym}`;
        if (!stalenessMarked.has(key)) {
          stalenessMarked.add(key);
          staleTargets.push({
            teamMemberId: item.teamMemberId,
            date: item.date,
          });
        }
      } catch (err: any) {
        const errResponse = err?.response;
        const errCode: string | undefined = errResponse?.code ?? err?.code;
        const errMsg: string =
          errResponse?.message ?? err?.message ?? 'Unknown error';
        failed.push({ index: i, error: errMsg, code: errCode });
        this.logger.warn(`Bulk create entry[${i}] failed: ${errCode} — ${errMsg}`);
      }
    }

    // Fire-and-forget stale-marks (one per worker/month). Use Promise.allSettled
    // so one failure cannot reject the batch.
    if (staleTargets.length > 0) {
      await Promise.allSettled(
        staleTargets.map((t) =>
          this.safeMarkPieceRateStale(ctx.workspaceId, t.teamMemberId, t.date),
        ),
      );
    }

    // Phase 25 Plan 03 — single workspace-wide cache invalidation per bulk
    // (machineId:null because bulk spans many machines). UtilisationService
    // listener drops all cache entries for this workspace.
    if (created.length > 0) {
      this.eventEmitter.emit('production_log.changed', {
        workspaceId: String(ctx.workspaceId),
        machineId: null,
      });
    }

    return { created, failed };
  }

  /**
   * List production logs with optional filters.
   * If machineIdFromPath is provided, scoped to that machine.
   */
  async list(
    ctx: { workspaceId: string; scopedMachineIds?: Types.ObjectId[] },
    filters: ListProductionLogsQueryDto,
    machineIdFromPath?: string,
  ): Promise<{ items: ProductionLog[]; total: number }> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(ctx.workspaceId),
      isDeleted: filters.includeDeleted === 'true' ? { $in: [true, false] } : false,
    };

    if (machineIdFromPath) {
      // Scope check for path-scoped machine
      if (
        ctx.scopedMachineIds &&
        !ctx.scopedMachineIds.some((id) => id.toString() === machineIdFromPath)
      ) {
        throw new ForbiddenException({ code: 'PRODUCTION_LOG_OUT_OF_SCOPE' });
      }
      filter.machineId = new Types.ObjectId(machineIdFromPath);
    } else if (ctx.scopedMachineIds) {
      // Row-level filter: only logs for machines in scope
      filter.machineId = { $in: ctx.scopedMachineIds };
    }

    // Query-param filters (override path if both present — controller should not allow this)
    if (filters.machineId) {
      filter.machineId = new Types.ObjectId(filters.machineId);
    }
    if (filters.operatorId) {
      filter.teamMemberId = new Types.ObjectId(filters.operatorId);
    }
    if (filters.shiftId) {
      filter.shiftId = new Types.ObjectId(filters.shiftId);
    }
    if (filters.from || filters.to) {
      filter.date = {};
      if (filters.from) filter.date.$gte = filters.from;
      if (filters.to) filter.date.$lte = filters.to;
    }

    const limit = Math.min(filters.limit ?? 50, 500);
    const offset = filters.offset ?? 0;

    // Populate operator (teamMember) name + employeeCode and shift name so the
    // web UI can render human-readable values instead of raw ObjectIds (WR-03).
    // Populate is best-effort: if either ref model is unavailable, the field
    // stays as the original ObjectId and the UI falls back to the ID display.
    const [items, total] = await Promise.all([
      this.productionLogModel
        .find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate({ path: 'teamMemberId', select: 'name employeeCode' })
        .populate({ path: 'shiftId', select: 'name' })
        .lean()
        .exec(),
      this.productionLogModel.countDocuments(filter).exec(),
    ]);

    return { items: items as any, total };
  }

  /**
   * Get a single production log by ID, verifying machine + workspace ownership.
   */
  async get(
    workspaceId: string,
    machineId: string,
    logId: string,
    scopedMachineIds?: Types.ObjectId[],
  ): Promise<ProductionLog> {
    if (
      scopedMachineIds &&
      !scopedMachineIds.some((id) => id.toString() === machineId)
    ) {
      throw new ForbiddenException({ code: 'PRODUCTION_LOG_OUT_OF_SCOPE' });
    }

    const log = await this.productionLogModel
      .findOne({
        _id: new Types.ObjectId(logId),
        workspaceId: new Types.ObjectId(workspaceId),
        machineId: new Types.ObjectId(machineId),
        isDeleted: false,
      })
      .lean()
      .exec();

    if (!log) {
      throw new NotFoundException({ code: 'PRODUCTION_LOG_NOT_FOUND', message: 'Production log not found.' });
    }

    return log as any;
  }

  /**
   * Update mutable metric fields on a production log.
   * Immutable fields (workspaceId, machineId, teamMemberId, assignmentId,
   * shiftId, date, logCode, primaryMetric) are protected by UpdateProductionLogDto.
   */
  async update(
    ctx: CreateContext,
    machineId: string,
    logId: string,
    dto: UpdateProductionLogDto,
  ): Promise<ProductionLog> {
    const log = await this.get(
      ctx.workspaceId,
      machineId,
      logId,
      ctx.scopedMachineIds,
    );

    // Re-check edit window on the log's original date (not today)
    await this.assertEditable(
      ctx.workspaceId,
      log.date,
      ctx.workspaceTimezone,
      ctx.lockCache,
    );

    const $set: Record<string, any> = {
      updatedBy: new Types.ObjectId(ctx.userId),
    };

    if (dto.stitchCount !== undefined) $set.stitchCount = dto.stitchCount;
    if (dto.pieceCount !== undefined) $set.pieceCount = dto.pieceCount;
    if (dto.hoursLogged !== undefined) {
      $set.hoursLogged =
        dto.hoursLogged != null
          ? Math.round(dto.hoursLogged * 100) / 100
          : null;
    }
    if (dto.notes !== undefined) $set.notes = dto.notes;

    // Validate that the primary metric value is still present after patch (D-02).
    // Construct an explicit metric snapshot rather than spreading `log` + `$set`
    // (which leaks unrelated fields like `updatedBy` into the merged shape).
    const merged = {
      stitchCount:
        dto.stitchCount !== undefined ? dto.stitchCount : log.stitchCount,
      pieceCount:
        dto.pieceCount !== undefined ? dto.pieceCount : log.pieceCount,
      hoursLogged:
        dto.hoursLogged !== undefined
          ? dto.hoursLogged != null
            ? Math.round(dto.hoursLogged * 100) / 100
            : null
          : log.hoursLogged,
    };
    this.assertPrimaryMetricProvided(merged, log.primaryMetric);

    const updated = await this.productionLogModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(logId),
          workspaceId: new Types.ObjectId(ctx.workspaceId),
          machineId: new Types.ObjectId(machineId),
          isDeleted: false,
        },
        { $set },
        { new: true },
      )
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException({ code: 'PRODUCTION_LOG_NOT_FOUND' });
    }

    // Plan 23-07 D-07 — fire-and-forget stale flag on the affected piece-rate
    // Salary row. teamMemberId + date are immutable, so log.* is authoritative.
    await this.safeMarkPieceRateStale(
      ctx.workspaceId,
      String((updated as any).teamMemberId ?? log.teamMemberId),
      (updated as any).date ?? log.date,
    );

    // Phase 25 Plan 03 — invalidate UtilisationService LRU (Plan 04, D-05).
    this.eventEmitter.emit('production_log.changed', {
      workspaceId: String((updated as any).workspaceId ?? ctx.workspaceId),
      machineId: String((updated as any).machineId ?? machineId),
    });

    return updated as any;
  }

  /**
   * Soft-delete a production log (isDeleted + deletedAt).
   * Edit-window + payroll-lock still apply to deletion.
   */
  async softDelete(
    ctx: CreateContext,
    machineId: string,
    logId: string,
  ): Promise<{ deleted: true; logCode: string }> {
    const log = await this.get(
      ctx.workspaceId,
      machineId,
      logId,
      ctx.scopedMachineIds,
    );

    await this.assertEditable(
      ctx.workspaceId,
      log.date,
      ctx.workspaceTimezone,
      ctx.lockCache,
    );

    await this.productionLogModel
      .updateOne(
        {
          _id: new Types.ObjectId(logId),
          workspaceId: new Types.ObjectId(ctx.workspaceId),
          machineId: new Types.ObjectId(machineId),
          isDeleted: false,
        },
        {
          $set: {
            isDeleted: true,
            deletedAt: new Date(),
            updatedBy: new Types.ObjectId(ctx.userId),
          },
        },
      )
      .exec();

    this.logger.log(`Soft-deleted production log ${log.logCode} (${logId})`);

    // Plan 23-07 D-07 — fire-and-forget stale flag for the affected piece-rate
    // Salary row. Soft-delete reduces the worker's earnings for the month.
    await this.safeMarkPieceRateStale(
      ctx.workspaceId,
      String(log.teamMemberId),
      log.date,
    );

    // Phase 25 Plan 03 — invalidate UtilisationService LRU (Plan 04, D-05).
    this.eventEmitter.emit('production_log.changed', {
      workspaceId: String(ctx.workspaceId),
      machineId: String((log as any).machineId ?? machineId),
    });

    return { deleted: true, logCode: log.logCode };
  }

  /**
   * Preview the next PROD-NNN code without reserving it.
   */
  async peekNextCode(workspaceId: string): Promise<{ nextCode: string }> {
    const seq = await this.counterService.peekNextProductionLogCode(workspaceId);
    return { nextCode: this.formatProductionLogCode(seq) };
  }

  /**
   * Fetch the workspace's IANA timezone (used by controllers to populate ctx).
   * Falls back to 'Asia/Kolkata' per RESEARCH Assumption A3.
   */
  async getWorkspaceTimezone(workspaceId: string): Promise<string> {
    // Defensive guard: a malformed :workspaceId path param would otherwise bubble
    // a 500 from the ObjectId cast. Fall back to default tz so callers don't crash;
    // workspace-level RBAC/scope guards downstream will reject the request properly.
    if (!Types.ObjectId.isValid(workspaceId)) {
      return 'Asia/Kolkata';
    }
    const ws = await this.workspaceModel
      .findOne({ _id: new Types.ObjectId(workspaceId) })
      .select('timezone')
      .lean()
      .exec();
    return (ws as any)?.timezone || 'Asia/Kolkata';
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Format a sequence number into the canonical PROD-001 code.
   * padStart(3) satisfies PROD-001 through PROD-999; grows naturally for ≥1000.
   */
  private formatProductionLogCode(seq: number): string {
    return `PROD-${String(seq).padStart(3, '0')}`;
  }

  /**
   * Assert that the DTO provides a value for the machine's primary metric (D-02).
   * Throws PRODUCTION_LOG_PRIMARY_METRIC_REQUIRED if the field is null/undefined.
   */
  private assertPrimaryMetricProvided(
    dto: {
      stitchCount?: number | null;
      pieceCount?: number | null;
      hoursLogged?: number | null;
    },
    primaryMetric: PrimaryMetric,
  ): void {
    const valueByMetric: Record<PrimaryMetric, number | null | undefined> = {
      stitches: dto.stitchCount,
      pieces: dto.pieceCount,
      hours: dto.hoursLogged,
    };
    const v = valueByMetric[primaryMetric];
    if (v === null || v === undefined) {
      throw new BadRequestException({
        code: 'PRODUCTION_LOG_PRIMARY_METRIC_REQUIRED',
        message: `Primary metric (${primaryMetric}) is required and must be provided for this machine.`,
      });
    }
  }

  /**
   * Resolve assignmentId from an explicit value (D-06 fast path) or by querying
   * assignments active on the log date for (machineId, teamMemberId).
   *
   * Auto-resolution rules:
   *   - 0 matches → ASSIGNMENT_MISSING (no active assignment)
   *   - 1 match   → use that assignment's _id
   *   - >1 match  → ASSIGNMENT_AMBIGUOUS (caller must provide assignmentId explicitly)
   *
   * MachineShiftAssignment uses effectiveFrom / effectiveTo date ranges (not a
   * single `date` field). Active on `logDate` means:
   *   effectiveFrom <= logDate < effectiveTo (or effectiveTo is null/absent)
   *
   * Note: Pitfall 9 — never silently pick one from multiple matches.
   */
  private async resolveAssignmentId(
    workspaceId: string,
    machineId: string,
    dto: CreateProductionLogDto,
  ): Promise<string> {
    // Convert YYYY-MM-DD date string to a Date object at midnight UTC for range comparison.
    // We compare against effectiveFrom (Date) and effectiveTo (Date | null).
    // Using ISO midnight ensures consistent boundary comparisons.
    const logDateStart = new Date(`${dto.date}T00:00:00.000Z`);
    const logDateEnd = new Date(`${dto.date}T23:59:59.999Z`);

    if (dto.assignmentId) {
      // Explicit assignmentId provided — validate it belongs to this workspace,
      // machine, operator, and is active on the log date (CR-02). Without this
      // check, a caller could supply an assignmentId from another workspace,
      // machine, or operator and contaminate the assignment linkage that
      // downstream payroll (Phase 23) and dashboards (Phase 25) rely on.
      if (!Types.ObjectId.isValid(dto.assignmentId)) {
        throw new BadRequestException({
          code: 'ASSIGNMENT_INVALID',
          message: 'Provided assignmentId is not a valid identifier.',
        });
      }
      const a = await this.assignmentModel
        .findOne({
          _id: new Types.ObjectId(dto.assignmentId),
          workspaceId: new Types.ObjectId(workspaceId),
          machineId: new Types.ObjectId(machineId),
          teamMemberId: new Types.ObjectId(dto.teamMemberId),
          isDeleted: false,
          effectiveFrom: { $lte: logDateEnd },
          $or: [
            { effectiveTo: null },
            { effectiveTo: { $exists: false } },
            { effectiveTo: { $gte: logDateStart } },
          ],
        })
        .select('_id')
        .lean()
        .exec();
      if (!a) {
        throw new BadRequestException({
          code: 'ASSIGNMENT_INVALID',
          message:
            'Provided assignmentId does not match this workspace, machine, operator, or date.',
        });
      }
      return dto.assignmentId;
    }

    const matches = await this.assignmentModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        machineId: new Types.ObjectId(machineId),
        teamMemberId: new Types.ObjectId(dto.teamMemberId),
        isDeleted: false,
        effectiveFrom: { $lte: logDateEnd },
        $or: [
          { effectiveTo: null },
          { effectiveTo: { $exists: false } },
          { effectiveTo: { $gte: logDateStart } },
        ],
      })
      .select('_id')
      .lean()
      .exec();

    if (matches.length === 0) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_MISSING',
        message: `No active assignment found for this operator on ${dto.date}. Create an assignment first.`,
      });
    }
    if (matches.length > 1) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_AMBIGUOUS',
        message: `Multiple active assignments found for this operator on ${dto.date}. Provide assignmentId explicitly.`,
      });
    }

    return String(matches[0]._id);
  }

  /**
   * Guard: assert a log date is within the editable window and not payroll-locked.
   *
   * Edit window (D-03 / Pitfall 3 + 10):
   *   - Today (workspace-tz) and yesterday are editable.
   *   - Dates before yesterday (workspace-tz) throw PRODUCTION_LOG_EDIT_WINDOW_EXPIRED.
   *
   * Payroll lock (D-03 / Pitfall 6):
   *   - Uses SalaryService.isMonthPayrollLocked (single source of truth).
   *   - lockCache keyed by "${year}-${month}" avoids N+1 queries in bulk loops.
   *
   * Timezone pattern: Intl.DateTimeFormat('en-CA') in workspace timezone returns
   * "YYYY-MM-DD" format natively — no moment/date-fns dependency (Pattern 4).
   */
  private async assertEditable(
    workspaceId: string,
    logDate: string,
    workspaceTimezone: string,
    lockCache?: Map<string, boolean>,
  ): Promise<void> {
    // Parse and validate date format
    const m = logDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
      throw new BadRequestException({
        code: 'PRODUCTION_LOG_INVALID_DATE',
        message: 'Invalid date format — expected YYYY-MM-DD.',
      });
    }
    const [, yyyy, mm] = m;
    const month = Number(mm);
    const year = Number(yyyy);

    // Current date in workspace timezone (Pitfall 3 — UTC wall-clock is wrong)
    // Intl.DateTimeFormat('en-CA') → "YYYY-MM-DD" natively (Pitfall 10)
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: workspaceTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    // Yesterday = today − 86400 seconds (UTC arithmetic is safe here because
    // we are computing a 24h delta, not converting a local wall-clock time)
    const todayLocal = new Date(`${todayStr}T00:00:00Z`);
    const yesterdayLocal = new Date(todayLocal.getTime() - 24 * 60 * 60 * 1000);
    const cutoffStr = yesterdayLocal.toISOString().slice(0, 10); // YYYY-MM-DD

    if (logDate < cutoffStr) {
      throw new BadRequestException({
        code: 'PRODUCTION_LOG_EDIT_WINDOW_EXPIRED',
        message: `Production logs older than ${cutoffStr} (workspace time) cannot be created or edited.`,
      });
    }

    // Payroll lock check — cached by (year, month) to avoid N+1 in bulk (Pitfall 6)
    const cacheKey = `${year}-${month}`;
    let locked: boolean;

    if (lockCache?.has(cacheKey)) {
      locked = lockCache.get(cacheKey)!;
    } else {
      locked = await this.salaryService.isMonthPayrollLocked(
        workspaceId,
        month,
        year,
      );
      lockCache?.set(cacheKey, locked);
    }

    if (locked) {
      throw new BadRequestException({
        code: 'PRODUCTION_LOG_PAYROLL_LOCKED',
        message: `Payroll for ${yyyy}-${mm} is locked. Production logs for this month cannot be created or modified.`,
      });
    }
  }
}
