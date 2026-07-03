import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { DowntimeEntry } from './schemas/downtime-entry.schema';
import { CreateDowntimeDto } from './dto/create-downtime.dto';
import { UpdateDowntimeDto } from './dto/update-downtime.dto';
import { CloseDowntimeDto } from './dto/close-downtime.dto';
import { ListDowntimeQueryDto } from './dto/list-downtime.query.dto';
import { DowntimeReasonsService } from './downtime-reasons.service';
import { MachinesService } from '../machines/machines.service';
import { SalaryService } from '../salary/salary.service';
import { WorkspaceCounterService } from '../workspaces/workspace-counter.service';

/**
 * Sentinel "open downtime" upper bound used in the overlap query (§5).
 * Any open entry is treated as ending at +infinity for range comparison.
 */
const FAR_FUTURE = new Date('9999-12-31T23:59:59Z');

interface DowntimeContext {
  workspaceId: string;
  userId: string;
  /** Optional ResourceScope filter applied at workspace-list path. */
  scopedMachineIds?: Types.ObjectId[];
}

interface ListResult {
  items: DowntimeEntry[];
  total: number;
}

/**
 * DowntimeService — entry CRUD + status auto-derivation (Phase 22 brain).
 *
 * Responsibilities:
 *   - create / list / getActive / update / close / softDelete / peekNextCode
 *   - Service-level overlap guard (D-05) + DB partial unique fallback
 *   - 7-day edit window + payroll-lock hard stop (D-07)
 *   - Counter-driven DT-NNN codes (D-12)
 *   - Session-aware MachinesService.recomputeStatus (D-04, MACH-P2-02c)
 *   - Mongoose 8.23 autocast workaround at every filter site (D-15, MACH-P2-XC-06)
 *   - Transaction-with-fallback for single-node Mongo (D-04 §6 RESEARCH)
 *
 * Memory: project_attendance_module_session_2026-04-22.md (autocast workaround).
 */
@Injectable()
export class DowntimeService {
  private readonly logger = new Logger(DowntimeService.name);

  constructor(
    @InjectModel(DowntimeEntry.name)
    private readonly downtimeModel: Model<DowntimeEntry>,
    // String tokens — avoid SWC decorator-metadata trip on Mongoose autocast
    // resolver; resolve identically at build time (STATE.md F-16-02).
    @InjectModel('Machine')
    private readonly machineModel: Model<any>,
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<any>,
    private readonly machinesService: MachinesService,
    private readonly reasonsService: DowntimeReasonsService,
    private readonly salaryService: SalaryService,
    private readonly counterService: WorkspaceCounterService,
    @InjectConnection() private readonly connection: Connection,
    // Phase 25 Plan 03 — emit cache-invalidation event for UtilisationService
    // LRU (Plan 04) per D-05 / RESEARCH Pitfall 8.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ============================================================
  // PUBLIC API
  // ============================================================

  /**
   * Create a downtime entry. `endAt` absent ⇒ open downtime.
   *
   * Order of operations:
   *   1) Validate range / resolve reason snapshot.
   *   2) Reject retired machines.
   *   3) assertEditable (7d window + payroll-lock hard stop).
   *   4) assertNoOverlap service pre-check.
   *   5) Reserve DT-NNN code.
   *   6) Insert entry + recomputeStatus inside session/txn (with fallback).
   *
   * Throws (RESEARCH §16):
   *   400 DOWNTIME_INVALID_TIME_RANGE     | 400 DOWNTIME_MACHINE_RETIRED
   *   400 DOWNTIME_EDIT_WINDOW_EXPIRED    | 400 DOWNTIME_PAYROLL_LOCKED
   *   404 DOWNTIME_REASON_NOT_FOUND       | 400 DOWNTIME_REASON_DISABLED
   *   409 DOWNTIME_OVERLAP                | 409 DOWNTIME_OVERLAP_RACE
   */
  async create(
    ctx: DowntimeContext,
    machineId: string,
    dto: CreateDowntimeDto,
  ): Promise<DowntimeEntry> {
    const startAt = new Date(dto.startAt);
    const endAt = dto.endAt ? new Date(dto.endAt) : null;
    if (endAt && endAt <= startAt) {
      throw new BadRequestException({
        code: 'DOWNTIME_INVALID_TIME_RANGE',
        message: 'endAt must be greater than startAt.',
      });
    }

    const reason = await this.reasonsService.resolveForEntry(
      ctx.workspaceId,
      dto.reasonCodeId,
    );

    await this.assertMachineNotRetired(ctx.workspaceId, machineId);

    const tz = await this.getWorkspaceTimezone(ctx.workspaceId);
    await this.assertEditable(ctx.workspaceId, startAt, tz, /* isOpen */ !endAt);
    await this.assertNoOverlap(ctx.workspaceId, machineId, startAt, endAt);

    const seq = await this.counterService.reserveNextDowntimeCode(
      ctx.workspaceId,
    );
    const downtimeCode = this.formatDowntimeCode(seq);

    const doc = {
      workspaceId: new Types.ObjectId(ctx.workspaceId),
      machineId: new Types.ObjectId(machineId),
      reasonCodeId: new Types.ObjectId(dto.reasonCodeId),
      reasonCodeSnapshot: reason.key,
      reasonLabelSnapshot: reason.label,
      reasonCategory: reason.category,
      startAt,
      endAt,
      durationMinutes: endAt
        ? this.computeDurationMinutes(startAt, endAt)
        : null,
      notes: dto.notes,
      loggedByUserId: new Types.ObjectId(ctx.userId),
      closedByUserId: null,
      downtimeCode,
      isDeleted: false,
    };

    let created: DowntimeEntry;
    try {
      created = await this.runWithTransactionFallback(async (session) => {
        // Array form propagates session through Mongoose `create()` (F-10-01).
        const [inserted] = await this.downtimeModel.create([doc], { session });
        await this.machinesService.recomputeStatus(machineId, session);
        return inserted as DowntimeEntry;
      });
    } catch (err: any) {
      // E11000 from open-downtime partial unique (DB backstop, D-05).
      if (err?.code === 11000) {
        throw new ConflictException({
          code: 'DOWNTIME_OVERLAP_RACE',
          message:
            'Another open downtime exists for this machine (race detected).',
        });
      }
      throw err;
    }

    this.logger.log(
      `DowntimeService: opened ${downtimeCode} on machine ${machineId} ` +
        `(reason=${reason.key}, category=${reason.category})`,
    );

    // Phase 25 Plan 03 — invalidate UtilisationService LRU (Plan 04, D-05).
    // Emit AFTER transaction commit (runWithTransactionFallback resolved).
    this.eventEmitter.emit('downtime.changed', {
      workspaceId: String(ctx.workspaceId),
      machineId: String(machineId),
    });

    return created;
  }

  /**
   * List downtime entries. Filters:
   *   - machineIdFromPath  : machine-scoped path (controller passes when present)
   *   - ctx.scopedMachineIds: workspace-list path with ResourceScope restriction
   *   - from / to          : workspace-local YYYY-MM-DD → UTC range
   *   - reasonCodeId       : exact match
   *   - status             : 'open' (endAt:null) | 'closed' (endAt:{$ne:null})
   *   - includeDeleted='true': widens isDeleted filter to include soft-deleted
   *
   * Returns `{ items, total }` with sort `{ startAt: -1 }`, default limit 25,
   * cap 500.
   */
  async list(
    ctx: DowntimeContext,
    filters: ListDowntimeQueryDto,
    machineIdFromPath?: string,
  ): Promise<ListResult> {
    const filter: any = {
      workspaceId: new Types.ObjectId(ctx.workspaceId),
    };

    if (filters.includeDeleted === 'true') {
      filter.isDeleted = { $in: [true, false] };
    } else {
      filter.isDeleted = false;
    }

    if (machineIdFromPath) {
      filter.machineId = new Types.ObjectId(machineIdFromPath);
    } else if (filters.machineId) {
      filter.machineId = new Types.ObjectId(filters.machineId);
    } else if (ctx.scopedMachineIds && ctx.scopedMachineIds.length > 0) {
      filter.machineId = {
        $in: ctx.scopedMachineIds.map((id) => new Types.ObjectId(id)),
      };
    }

    if (filters.reasonCodeId) {
      filter.reasonCodeId = new Types.ObjectId(filters.reasonCodeId);
    }

    if (filters.status === 'open') {
      filter.endAt = null;
    } else if (filters.status === 'closed') {
      filter.endAt = { $ne: null };
    }

    if (filters.from || filters.to) {
      const tz = await this.getWorkspaceTimezone(ctx.workspaceId);
      const range: any = {};
      if (filters.from) range.$gte = this.parseLocalDateToUtc(filters.from, tz);
      if (filters.to) {
        // Inclusive end-of-day: add 24h - 1ms.
        const end = this.parseLocalDateToUtc(filters.to, tz);
        end.setUTCHours(23, 59, 59, 999);
        range.$lte = end;
      }
      filter.startAt = { ...(filter.startAt ?? {}), ...range };
    }

    const limit = Math.min(filters.limit ?? 25, 500);
    const offset = filters.offset ?? 0;

    const [items, total] = await Promise.all([
      this.downtimeModel
        .find(filter)
        .sort({ startAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec() as unknown as Promise<DowntimeEntry[]>,
      this.downtimeModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  /**
   * Get the current open downtime for a machine (RESEARCH §17 Q4: 200 + null
   * body when none, NOT 404 — controller surfaces accordingly).
   */
  async getActive(
    ctx: DowntimeContext,
    machineId: string,
  ): Promise<DowntimeEntry | null> {
    return this.downtimeModel
      .findOne({
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        machineId: new Types.ObjectId(machineId),
        endAt: null,
        isDeleted: false,
      })
      .lean()
      .exec() as unknown as Promise<DowntimeEntry | null>;
  }

  /**
   * Edit a downtime entry within the editable window.
   * Re-runs overlap check excluding self when start/end change.
   * Re-runs recomputeStatus only when reasonCategory or endAt-nullness flips.
   */
  async update(
    ctx: DowntimeContext,
    machineId: string,
    entryId: string,
    dto: UpdateDowntimeDto,
  ): Promise<DowntimeEntry> {
    const entry = await this.downtimeModel
      .findOne({
        _id: new Types.ObjectId(entryId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        machineId: new Types.ObjectId(machineId),
        isDeleted: false,
      })
      .exec();
    if (!entry) {
      throw new NotFoundException({
        code: 'DOWNTIME_NOT_FOUND',
        message: 'Downtime entry not found.',
      });
    }

    const tz = await this.getWorkspaceTimezone(ctx.workspaceId);
    await this.assertEditable(
      ctx.workspaceId,
      entry.startAt,
      tz,
      /* isOpen */ entry.endAt === null,
    );

    const patch: any = {};
    let categoryChanged = false;

    if (dto.reasonCodeId && dto.reasonCodeId !== entry.reasonCodeId.toString()) {
      const reason = await this.reasonsService.resolveForEntry(
        ctx.workspaceId,
        dto.reasonCodeId,
      );
      patch.reasonCodeId = new Types.ObjectId(dto.reasonCodeId);
      patch.reasonCodeSnapshot = reason.key;
      patch.reasonLabelSnapshot = reason.label;
      patch.reasonCategory = reason.category;
      categoryChanged = reason.category !== entry.reasonCategory;
    }

    const newStart = dto.startAt ? new Date(dto.startAt) : entry.startAt;
    // Explicit `null` reopens; absence keeps existing endAt.
    const newEnd =
      dto.endAt === null
        ? null
        : dto.endAt !== undefined
          ? new Date(dto.endAt)
          : entry.endAt;

    const startChanged = dto.startAt !== undefined;
    const endChanged = dto.endAt !== undefined;

    if (startChanged || endChanged) {
      if (newEnd && newEnd <= newStart) {
        throw new BadRequestException({
          code: 'DOWNTIME_INVALID_TIME_RANGE',
          message: 'endAt must be greater than startAt.',
        });
      }
      await this.assertNoOverlap(
        ctx.workspaceId,
        machineId,
        newStart,
        newEnd,
        entryId,
      );
      if (startChanged) patch.startAt = newStart;
      if (endChanged) {
        patch.endAt = newEnd;
        patch.durationMinutes = newEnd
          ? this.computeDurationMinutes(newStart, newEnd)
          : null;
        if (newEnd === null) {
          // Reopening: clear closedByUserId.
          patch.closedByUserId = null;
        }
      }
    }

    if (dto.notes !== undefined) patch.notes = dto.notes;

    if (Object.keys(patch).length === 0) {
      return entry;
    }

    const endNullnessFlipped =
      endChanged && (entry.endAt === null) !== (newEnd === null);
    const shouldRecompute = categoryChanged || endNullnessFlipped;

    try {
      await this.runWithTransactionFallback(async (session) => {
        await this.downtimeModel
          .updateOne(
            { _id: new Types.ObjectId(entryId) },
            { $set: patch },
            { session },
          )
          .exec();
        if (shouldRecompute) {
          await this.machinesService.recomputeStatus(machineId, session);
        }
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException({
          code: 'DOWNTIME_OVERLAP_RACE',
          message:
            'Another open downtime exists for this machine (race detected).',
        });
      }
      throw err;
    }

    const updated = await this.downtimeModel
      .findById(new Types.ObjectId(entryId))
      .lean()
      .exec();

    // Phase 25 Plan 03 — invalidate UtilisationService LRU (Plan 04, D-05).
    // WR-05 fix: emit AFTER `runWithTransactionFallback` resolves AND after
    // the post-commit re-read settles, guaranteeing any downstream cache
    // repopulation reads post-commit data (no stale-then-fresh-then-re-stale
    // window).
    this.eventEmitter.emit('downtime.changed', {
      workspaceId: String(ctx.workspaceId),
      machineId: String(machineId),
    });

    return updated as unknown as DowntimeEntry;
  }

  /**
   * Close an open downtime entry (D-06).
   * Uses optimistic-concurrency filter `{ endAt: null }` to lose the race
   * cleanly when a concurrent close wins (R-5 / RESEARCH §6).
   */
  async close(
    ctx: DowntimeContext,
    machineId: string,
    entryId: string,
    dto: CloseDowntimeDto,
  ): Promise<DowntimeEntry> {
    const entry = await this.downtimeModel
      .findOne({
        _id: new Types.ObjectId(entryId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        machineId: new Types.ObjectId(machineId),
        isDeleted: false,
      })
      .exec();
    if (!entry) {
      throw new NotFoundException({
        code: 'DOWNTIME_NOT_FOUND',
        message: 'Downtime entry not found.',
      });
    }
    if (entry.endAt !== null) {
      throw new BadRequestException({
        code: 'DOWNTIME_ALREADY_CLOSED',
        message: 'Downtime entry is already closed.',
      });
    }

    const endAt = dto.endAt ? new Date(dto.endAt) : new Date();
    if (endAt <= entry.startAt) {
      throw new BadRequestException({
        code: 'DOWNTIME_INVALID_TIME_RANGE',
        message: 'endAt must be greater than startAt.',
      });
    }

    const tz = await this.getWorkspaceTimezone(ctx.workspaceId);
    await this.assertEditable(
      ctx.workspaceId,
      entry.startAt,
      tz,
      /* isOpen */ true,
    );

    await this.runWithTransactionFallback(async (session) => {
      const result = await this.downtimeModel
        .updateOne(
          {
            _id: new Types.ObjectId(entryId),
            endAt: null,
          },
          {
            $set: {
              endAt,
              durationMinutes: this.computeDurationMinutes(
                entry.startAt,
                endAt,
              ),
              closedByUserId: new Types.ObjectId(ctx.userId),
            },
          },
          { session },
        )
        .exec();
      if (result.modifiedCount === 0) {
        // Optimistic-concurrency: another writer closed the entry first.
        throw new BadRequestException({
          code: 'DOWNTIME_ALREADY_CLOSED',
          message: 'Downtime entry is already closed.',
        });
      }
      await this.machinesService.recomputeStatus(machineId, session);
    });

    const refreshed = await this.downtimeModel
      .findById(new Types.ObjectId(entryId))
      .lean()
      .exec();
    this.logger.log(
      `DowntimeService: closed ${entry.downtimeCode} on machine ${machineId}`,
    );

    // Phase 25 Plan 03 — invalidate UtilisationService LRU (Plan 04, D-05).
    this.eventEmitter.emit('downtime.changed', {
      workspaceId: String(ctx.workspaceId),
      machineId: String(machineId),
    });

    return refreshed as unknown as DowntimeEntry;
  }

  /**
   * Soft-delete an entry. Releases the open-downtime slot (partial unique on
   * endAt:null filters by isDeleted:false, so flipping isDeleted frees the slot).
   */
  async softDelete(
    ctx: DowntimeContext,
    machineId: string,
    entryId: string,
  ): Promise<{ deleted: true; downtimeCode: string }> {
    const entry = await this.downtimeModel
      .findOne({
        _id: new Types.ObjectId(entryId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        machineId: new Types.ObjectId(machineId),
        isDeleted: false,
      })
      .exec();
    if (!entry) {
      throw new NotFoundException({
        code: 'DOWNTIME_NOT_FOUND',
        message: 'Downtime entry not found.',
      });
    }

    const tz = await this.getWorkspaceTimezone(ctx.workspaceId);
    await this.assertEditable(
      ctx.workspaceId,
      entry.startAt,
      tz,
      /* isOpen */ entry.endAt === null,
    );

    await this.runWithTransactionFallback(async (session) => {
      await this.downtimeModel
        .updateOne(
          { _id: new Types.ObjectId(entryId) },
          { $set: { isDeleted: true, deletedAt: new Date() } },
          { session },
        )
        .exec();
      await this.machinesService.recomputeStatus(machineId, session);
    });

    this.logger.log(
      `DowntimeService: soft-deleted ${entry.downtimeCode} on machine ${machineId}`,
    );

    // Phase 25 Plan 03 — invalidate UtilisationService LRU (Plan 04, D-05).
    this.eventEmitter.emit('downtime.changed', {
      workspaceId: String(ctx.workspaceId),
      machineId: String(machineId),
    });

    return { deleted: true, downtimeCode: entry.downtimeCode };
  }

  /**
   * Preview the next DT-NNN code without reserving it.
   */
  async peekNextCode(workspaceId: string): Promise<{ nextCode: string }> {
    const next = await this.counterService.peekNextDowntimeCode(workspaceId);
    return { nextCode: this.formatDowntimeCode(next) };
  }

  /**
   * Fetch the workspace's IANA timezone (fallback 'Asia/Kolkata').
   * Public so controllers can populate context if needed.
   */
  async getWorkspaceTimezone(workspaceId: string): Promise<string> {
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
   * Service-level overlap pre-check (D-05, RESEARCH §5). Implements the EXACT
   * two-branch $or:
   *   - Branch A: any open entry whose startAt < incoming.endAt (or +∞).
   *   - Branch B: any closed entry whose interval intersects [startAt, endAt).
   *
   * The DB partial-unique index on (workspaceId, machineId, endAt:null) is the
   * last-line-of-defence backstop (D-05); this method delivers the precise
   * 409 error before the write even runs.
   */
  private async assertNoOverlap(
    workspaceId: string,
    machineId: string,
    startAt: Date,
    endAt: Date | null,
    excludeEntryId?: string,
    session?: ClientSession,
  ): Promise<void> {
    const incomingEnd = endAt ?? FAR_FUTURE;
    const filter: any = {
      workspaceId: new Types.ObjectId(workspaceId),
      machineId: new Types.ObjectId(machineId),
      isDeleted: false,
      $or: [
        { endAt: null, startAt: { $lt: incomingEnd } },
        {
          endAt: { $ne: null, $gt: startAt },
          startAt: { $lt: incomingEnd },
        },
      ],
    };
    if (excludeEntryId) {
      filter._id = { $ne: new Types.ObjectId(excludeEntryId) };
    }

    const conflict = await this.downtimeModel
      .findOne(filter)
      .session(session ?? null)
      .select('_id startAt endAt downtimeCode')
      .lean()
      .exec();

    if (conflict) {
      throw new ConflictException({
        code: 'DOWNTIME_OVERLAP',
        message: `Downtime interval conflicts with ${(conflict as any).downtimeCode}.`,
        conflictingEntryId: (conflict as any)._id?.toString(),
        conflictRange: {
          startAt: (conflict as any).startAt,
          endAt: (conflict as any).endAt,
        },
      });
    }
  }

  /**
   * Edit-window guard (D-07):
   *   - 7-day rolling window in workspace tz; OR
   *   - entry is still open (caller passes isOpen=true to skip window check).
   *   - Hard stop: payroll-locked month rejects regardless of window.
   *
   * Reuses SalaryService.isMonthPayrollLocked (Phase 21 D-03 pattern).
   */
  private async assertEditable(
    workspaceId: string,
    startAt: Date,
    workspaceTimezone: string,
    isOpen: boolean,
  ): Promise<void> {
    // Today (workspace-local YYYY-MM-DD).
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: workspaceTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const todayLocal = new Date(`${todayStr}T00:00:00Z`);
    const windowStart = new Date(
      todayLocal.getTime() - 7 * 24 * 60 * 60 * 1000,
    );

    if (!isOpen && startAt < windowStart) {
      throw new BadRequestException({
        code: 'DOWNTIME_EDIT_WINDOW_EXPIRED',
        message: 'Downtime older than 7 days cannot be edited.',
      });
    }

    // Payroll-lock hard stop — compute month/year in workspace tz.
    const startStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: workspaceTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(startAt);
    const [yyyy, mm] = startStr.split('-');
    const year = Number(yyyy);
    const month = Number(mm);

    const locked = await this.salaryService.isMonthPayrollLocked(
      workspaceId,
      month,
      year,
    );
    if (locked) {
      throw new BadRequestException({
        code: 'DOWNTIME_PAYROLL_LOCKED',
        message: `Payroll for ${yyyy}-${mm} is locked. Downtime for this month cannot be modified.`,
      });
    }
  }

  /**
   * Reject downtime ops on retired machines (D-04 §3).
   */
  private async assertMachineNotRetired(
    workspaceId: string,
    machineId: string,
    session?: ClientSession,
  ): Promise<void> {
    const machine = await this.machineModel
      .findOne({
        _id: new Types.ObjectId(machineId),
        workspaceId: new Types.ObjectId(workspaceId),
        isDeleted: false,
      })
      .session(session ?? null)
      .select('status')
      .lean()
      .exec();
    if (!machine) {
      throw new NotFoundException({
        code: 'DOWNTIME_NOT_FOUND',
        message: 'Machine not found.',
      });
    }
    if ((machine as any).status === 'retired') {
      throw new BadRequestException({
        code: 'DOWNTIME_MACHINE_RETIRED',
        message: 'Cannot log downtime on a retired machine.',
      });
    }
  }

  /**
   * Format a sequence number into the canonical DT-NNN code (D-12).
   */
  private formatDowntimeCode(seq: number): string {
    return `DT-${String(seq).padStart(3, '0')}`;
  }

  /**
   * Compute durationMinutes = ceil((endAt - startAt) / 60_000).
   */
  private computeDurationMinutes(startAt: Date, endAt: Date): number {
    return Math.ceil((endAt.getTime() - startAt.getTime()) / 60000);
  }

  /**
   * Parse a workspace-local YYYY-MM-DD into the UTC instant of that day's
   * start in the given timezone. Used by list() date-range filters.
   */
  private parseLocalDateToUtc(localDate: string, _tz: string): Date {
    // Approximation: treat the local date as UTC midnight. For India (UTC+5:30)
    // the +/- 5.5h skew at boundary is acceptable for list filters; tighter
    // conversion can be added later via an Intl-based offset lookup.
    return new Date(`${localDate}T00:00:00Z`);
  }

  /**
   * Run a unit of work inside a Mongo transaction when the deployment supports
   * replica-set sessions; otherwise fall back to sessionless sequential writes.
   *
   * Detection is reactive: try startTransaction, catch the well-known
   * "Transaction numbers are only allowed on a replica set member" error
   * (Mongo code 20 / errorLabels including 'TransientTransactionError') and
   * retry without a session. Production deployments MUST run a replica set.
   *
   * TODO(prod): RS required for full atomicity; single-node fallback is for
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
        // Single-node Mongo: retry without session.
        this.logger.warn(
          'DowntimeService: transaction unsupported (single-node Mongo); ' +
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
