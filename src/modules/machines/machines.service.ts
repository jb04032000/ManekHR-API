import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  Machine,
  MachineStatus,
  PrimaryMetric,
} from './schemas/machine.schema';
import { MachineShiftAssignment } from './schemas/machine-shift-assignment.schema';
import { DowntimeEntry } from '../downtime/schemas/downtime-entry.schema';
import { Location } from '../locations/schemas/location.schema';
import { LocationsService } from '../locations/locations.service';
import { TeamMember } from '../team/schemas/team-member.schema';
import { CreateMachineDto, UpdateMachineDto } from './dto/machine.dto';
import {
  CreateMachineAssignmentDto,
  UpdateMachineAssignmentDto,
} from './dto/machine-assignment.dto';
import { WorkspaceCounterService } from '../workspaces/workspace-counter.service';
import { EMBROIDERY_PRESET } from './constants/embroidery-preset';

@Injectable()
export class MachinesService {
  constructor(
    @InjectModel(Machine.name)
    private readonly machineModel: Model<Machine>,
    @InjectModel(MachineShiftAssignment.name)
    private readonly assignmentModel: Model<MachineShiftAssignment>,
    @InjectModel(Location.name)
    private readonly locationModel: Model<Location>,
    @InjectModel(TeamMember.name)
    private readonly teamMemberModel: Model<TeamMember>,
    @InjectModel(DowntimeEntry.name)
    private readonly downtimeModel: Model<DowntimeEntry>,
    private readonly counterService: WorkspaceCounterService,
    private readonly locationsService: LocationsService,
  ) {}

  /** "09:00" -> 540. Defensive against malformed input. */
  private timeStringToMinutes(t: string | undefined | null): number | null {
    if (!t || typeof t !== 'string') return null;
    const match = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
  }

  /**
   * Convert a customSchedule into one or two same-day intervals in
   * minutes-of-day. Overnight schedules (start >= end) split into two.
   * Returns [] when the schedule is missing / malformed (caller treats
   * as full-day coverage).
   */
  private scheduleToIntervals(
    schedule: { startTime?: string; endTime?: string } | null | undefined,
  ): [number, number][] {
    if (!schedule) return [];
    const s = this.timeStringToMinutes(schedule.startTime);
    const e = this.timeStringToMinutes(schedule.endTime);
    if (s === null || e === null) return [];
    if (s === e) return [[0, 24 * 60]]; // zero-duration => treat as full-day
    if (s < e) return [[s, e]];
    // Overnight — wraps midnight.
    return [
      [s, 24 * 60],
      [0, e],
    ];
  }

  /**
   * Does daily schedule A overlap schedule B in the minute domain?
   * Missing / invalid schedule => treat as full-day => always overlaps.
   */
  private schedulesOverlap(
    a: { startTime?: string; endTime?: string } | null | undefined,
    b: { startTime?: string; endTime?: string } | null | undefined,
  ): boolean {
    const ai = this.scheduleToIntervals(a);
    const bi = this.scheduleToIntervals(b);
    // Empty intervals = full-day fallback => overlap with anything.
    if (ai.length === 0 || bi.length === 0) return true;
    for (const [as, ae] of ai) {
      for (const [bs, be] of bi) {
        if (as < be && bs < ae) return true;
      }
    }
    return false;
  }

  private formatSchedule(
    schedule: { startTime?: string; endTime?: string } | null | undefined,
  ): string {
    if (!schedule?.startTime || !schedule?.endTime) return 'full-day';
    return `${schedule.startTime}-${schedule.endTime}`;
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return typeof id === 'string' ? new Types.ObjectId(id) : id;
  }

  private toApi(machine: Machine) {
    const obj = machine.toObject();
    return { ...obj, id: obj._id.toString() };
  }

  private toAssignmentApi(a: MachineShiftAssignment) {
    const obj = a.toObject();
    return { ...obj, id: obj._id.toString() };
  }

  async findAll(
    workspaceId: string,
    filters: {
      locationId?: string;
      status?: string;
      search?: string;
      scopedMachineIds?: Types.ObjectId[];
    } = {},
  ) {
    const wsId = this.toObjectId(workspaceId);
    const query: Record<string, unknown> = {
      workspaceId: wsId,
      isDeleted: false,
    };
    if (filters.locationId) {
      query.locationId = this.toObjectId(filters.locationId);
    }
    if (filters.status) {
      query.status = filters.status;
    }
    if (filters.search) {
      const rx = new RegExp(this.escapeRegex(filters.search.trim()), 'i');
      query.$or = [{ name: rx }, { machineCode: rx }, { serialNumber: rx }];
    }
    if (filters.scopedMachineIds) {
      query._id = { $in: filters.scopedMachineIds };
    }

    const rows = await this.machineModel.find(query).sort({ name: 1 }).exec();
    return rows.map((r) => this.toApi(r));
  }

  async findById(workspaceId: string, machineId: string) {
    const m = await this.machineModel
      .findOne({
        _id: this.toObjectId(machineId),
        workspaceId: this.toObjectId(workspaceId),
        isDeleted: false,
      })
      .exec();
    if (!m) throw new NotFoundException('Machine not found');
    return this.toApi(m);
  }

  async create(workspaceId: string, userId: string, dto: CreateMachineDto) {
    const wsId = this.toObjectId(workspaceId);
    // Defense-in-depth: make sure a Location exists so direct API callers
    // who skipped the frontend's /locations GET don't hit an empty state.
    await this.locationsService.ensureDefaultLocation(workspaceId);
    const locationId = this.toObjectId(dto.locationId);

    const location = await this.locationModel
      .findOne({ _id: locationId, workspaceId: wsId, isDeleted: false })
      .exec();
    if (!location) {
      throw new BadRequestException('Invalid locationId for this workspace');
    }

    let machineCode = dto.machineCode?.trim();
    if (!machineCode) {
      const seq = await this.counterService.reserveNextMachineCode(wsId);
      machineCode = `M-${String(seq).padStart(3, '0')}`;
    } else {
      const clash = await this.machineModel
        .findOne({ workspaceId: wsId, machineCode, isDeleted: false })
        .exec();
      if (clash) {
        throw new ConflictException(
          `Machine code "${machineCode}" is already in use.`,
        );
      }
    }

    const isEmbroidery =
      (dto.type ?? EMBROIDERY_PRESET.type).toLowerCase() === 'embroidery';
    const attributes = {
      ...(isEmbroidery ? EMBROIDERY_PRESET.attributes : {}),
      ...(dto.attributes ?? {}),
    };

    const created = await this.machineModel.create({
      workspaceId: wsId,
      locationId,
      name: dto.name.trim(),
      machineCode,
      type: dto.type?.trim() || EMBROIDERY_PRESET.type,
      model: dto.model,
      manufacturer: dto.manufacturer,
      serialNumber: dto.serialNumber,
      status: dto.status ?? 'active',
      floorTag: dto.floorTag,
      attributes,
      installedOn: dto.installedOn ? new Date(dto.installedOn) : undefined,
      notes: dto.notes,
      isActive: dto.isActive ?? true,
      createdBy: userId ? this.toObjectId(userId) : undefined,
    });

    return this.toApi(created);
  }

  async update(
    workspaceId: string,
    machineId: string,
    dto: UpdateMachineDto,
  ) {
    const wsId = this.toObjectId(workspaceId);
    const id = this.toObjectId(machineId);

    const current = await this.machineModel
      .findOne({ _id: id, workspaceId: wsId, isDeleted: false })
      .exec();
    if (!current) throw new NotFoundException('Machine not found');

    if (dto.locationId) {
      const newLocationId = this.toObjectId(dto.locationId);
      const location = await this.locationModel
        .findOne({
          _id: newLocationId,
          workspaceId: wsId,
          isDeleted: false,
        })
        .exec();
      if (!location) {
        throw new BadRequestException('Invalid locationId for this workspace');
      }
    }

    const updated = await this.machineModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            ...(dto.locationId && {
              locationId: this.toObjectId(dto.locationId),
            }),
            ...(dto.name && { name: dto.name.trim() }),
            ...(dto.type && { type: dto.type.trim() }),
            ...(dto.model !== undefined && { model: dto.model }),
            ...(dto.manufacturer !== undefined && {
              manufacturer: dto.manufacturer,
            }),
            ...(dto.serialNumber !== undefined && {
              serialNumber: dto.serialNumber,
            }),
            ...(dto.status && { status: dto.status }),
            ...(dto.floorTag !== undefined && { floorTag: dto.floorTag }),
            ...(dto.attributes && {
              attributes: { ...current.attributes, ...dto.attributes },
            }),
            ...(dto.installedOn !== undefined && {
              installedOn: dto.installedOn
                ? new Date(dto.installedOn)
                : undefined,
            }),
            ...(dto.notes !== undefined && { notes: dto.notes }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          },
        },
        { new: true },
      )
      .exec();

    return this.toApi(updated!);
  }

  async remove(workspaceId: string, machineId: string) {
    const wsId = this.toObjectId(workspaceId);
    const id = this.toObjectId(machineId);
    const result = await this.machineModel
      .findOneAndUpdate(
        { _id: id, workspaceId: wsId, isDeleted: false },
        {
          $set: {
            isDeleted: true,
            deletedAt: new Date(),
            isActive: false,
            status: 'retired',
          },
        },
        { new: true },
      )
      .exec();
    if (!result) throw new NotFoundException('Machine not found');
    // Soft-close open assignments on this machine.
    await this.assignmentModel
      .updateMany(
        {
          workspaceId: wsId,
          machineId: id,
          isDeleted: false,
          $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }],
        },
        { $set: { effectiveTo: new Date() } },
      )
      .exec();
    return { success: true };
  }

  async statusCounts(workspaceId: string) {
    const wsId = this.toObjectId(workspaceId);
    const rows = await this.machineModel.aggregate([
      { $match: { workspaceId: wsId, isDeleted: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const counts: Record<string, number> = {
      active: 0,
      idle: 0,
      maintenance: 0,
      retired: 0,
      total: 0,
    };
    for (const r of rows) {
      counts[r._id] = r.count;
      counts.total += r.count;
    }
    return counts;
  }

  async peekNextCode(workspaceId: string): Promise<string> {
    const n = await this.counterService.peekNextMachineCode(workspaceId);
    return `M-${String(n).padStart(3, '0')}`;
  }

  // ============================================================
  // Assignments
  // ============================================================

  async listAssignments(
    workspaceId: string,
    machineId: string,
    options: { activeOnly?: boolean } = {},
  ) {
    const wsId = this.toObjectId(workspaceId);
    const mId = this.toObjectId(machineId);
    const query: Record<string, unknown> = {
      workspaceId: wsId,
      machineId: mId,
      isDeleted: false,
    };
    if (options.activeOnly) {
      const now = new Date();
      query.effectiveFrom = { $lte: now };
      query.$or = [{ effectiveTo: null }, { effectiveTo: { $gt: now } }];
    }
    const rows = await this.assignmentModel
      .find(query)
      .sort({ effectiveFrom: -1 })
      .exec();
    return rows.map((r) => this.toAssignmentApi(r));
  }

  async listAssignmentsForMember(workspaceId: string, memberId: string) {
    const wsId = this.toObjectId(workspaceId);
    const mId = this.toObjectId(memberId);
    const now = new Date();
    const rows = await this.assignmentModel
      .find({
        workspaceId: wsId,
        teamMemberId: mId,
        isDeleted: false,
        effectiveFrom: { $lte: now },
        $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
      })
      .populate('machineId', 'name machineCode status locationId')
      .populate('shiftId', 'name startTime endTime')
      .sort({ effectiveFrom: -1 })
      .exec();
    return rows.map((r) => {
      const obj = r.toObject();
      return { ...obj, id: obj._id.toString() };
    });
  }

  async createAssignment(
    workspaceId: string,
    machineId: string,
    userId: string,
    dto: CreateMachineAssignmentDto,
  ) {
    const wsId = this.toObjectId(workspaceId);
    const mId = this.toObjectId(machineId);

    const machine = await this.machineModel
      .findOne({ _id: mId, workspaceId: wsId, isDeleted: false })
      .exec();
    if (!machine) throw new NotFoundException('Machine not found');

    const effectiveFrom = new Date(dto.effectiveFrom);
    const effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : undefined;
    if (effectiveTo && effectiveTo <= effectiveFrom) {
      throw new BadRequestException(
        'effectiveTo must be after effectiveFrom',
      );
    }

    const isPrimary = dto.isPrimary ?? true;
    const shiftOid = dto.shiftId ? this.toObjectId(dto.shiftId) : undefined;

    // Overlap guard: if primary, no other primary assignment on
    // (machine, shift) with overlapping date range. `shiftId=null` is
    // its own bucket (single-shift workspaces).
    if (isPrimary) {
      const baseOverlapFilter: Record<string, unknown> = {
        workspaceId: wsId,
        machineId: mId,
        shiftId: shiftOid ?? null,
        isPrimary: true,
        isDeleted: false,
        effectiveFrom: effectiveTo ? { $lt: effectiveTo } : { $exists: true },
        $or: [
          { effectiveTo: null },
          { effectiveTo: { $gt: effectiveFrom } },
        ],
      };

      if (shiftOid) {
        // Shift-based: one primary per (machine, shift, overlapping dates).
        const clash = await this.assignmentModel
          .findOne(baseOverlapFilter)
          .exec();
        if (clash) {
          throw new ConflictException(
            'Another primary assignment already covers this machine + shift in the requested date range.',
          );
        }
      } else {
        // No-shift: compare worker daily schedules (customSchedule) so two
        // workers with non-overlapping hours can share a machine.
        const newWorker = await this.teamMemberModel
          .findOne({
            _id: this.toObjectId(dto.teamMemberId),
            workspaceId: wsId,
          })
          .exec();
        // Resolve the new assignment's daily hours: assignment-level
        // (startTime/endTime) wins; else fall back to the worker's
        // customSchedule; else null (→ full-day in the overlap check).
        const newAssignmentSchedule =
          dto.startTime && dto.endTime
            ? { startTime: dto.startTime, endTime: dto.endTime }
            : newWorker?.scheduleType === 'custom'
              ? newWorker?.customSchedule
              : null;

        const candidates = await this.assignmentModel
          .find(baseOverlapFilter)
          .exec();
        for (const existing of candidates) {
          const existingWorker = await this.teamMemberModel
            .findOne({
              _id: existing.teamMemberId,
              workspaceId: wsId,
            })
            .exec();
          const existingSchedule =
            existing.startTime && existing.endTime
              ? { startTime: existing.startTime, endTime: existing.endTime }
              : existingWorker?.scheduleType === 'custom'
                ? existingWorker?.customSchedule
                : null;

          if (
            this.schedulesOverlap(newAssignmentSchedule, existingSchedule)
          ) {
            const who = existingWorker?.name ?? 'another worker';
            throw new ConflictException(
              `Machine already assigned to ${who} (${this.formatSchedule(existingSchedule)}) in this date range. ` +
                `Either pick hours that don't overlap, or end the existing assignment first.`,
            );
          }
        }
      }
    }

    // Validate assignment-level hours make sense when provided.
    if ((dto.startTime || dto.endTime) && !(dto.startTime && dto.endTime)) {
      throw new BadRequestException(
        'Provide both startTime and endTime, or neither.',
      );
    }

    const created = await this.assignmentModel.create({
      workspaceId: wsId,
      machineId: mId,
      shiftId: shiftOid,
      teamMemberId: this.toObjectId(dto.teamMemberId),
      effectiveFrom,
      effectiveTo,
      isPrimary,
      startTime: dto.startTime,
      endTime: dto.endTime,
      notes: dto.notes,
      createdBy: userId ? this.toObjectId(userId) : undefined,
    });

    return this.toAssignmentApi(created);
  }

  async updateAssignment(
    workspaceId: string,
    machineId: string,
    assignmentId: string,
    dto: UpdateMachineAssignmentDto,
  ) {
    const wsId = this.toObjectId(workspaceId);
    const mId = this.toObjectId(machineId);
    const aId = this.toObjectId(assignmentId);

    const current = await this.assignmentModel
      .findOne({
        _id: aId,
        workspaceId: wsId,
        machineId: mId,
        isDeleted: false,
      })
      .exec();
    if (!current) throw new NotFoundException('Assignment not found');

    const patch: Record<string, unknown> = {};
    if (dto.effectiveFrom !== undefined) {
      patch.effectiveFrom = new Date(dto.effectiveFrom);
    }
    if (dto.effectiveTo !== undefined) {
      patch.effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : null;
    }
    if (dto.isPrimary !== undefined) patch.isPrimary = dto.isPrimary;
    if (dto.notes !== undefined) patch.notes = dto.notes;
    if (dto.startTime !== undefined) patch.startTime = dto.startTime || null;
    if (dto.endTime !== undefined) patch.endTime = dto.endTime || null;

    const nextFrom = (patch.effectiveFrom as Date) ?? current.effectiveFrom;
    const nextTo =
      (patch.effectiveTo as Date | null | undefined) ?? current.effectiveTo;
    if (nextTo && nextTo <= nextFrom) {
      throw new BadRequestException(
        'effectiveTo must be after effectiveFrom',
      );
    }

    const updated = await this.assignmentModel
      .findByIdAndUpdate(aId, { $set: patch }, { new: true })
      .exec();
    return this.toAssignmentApi(updated!);
  }

  async removeAssignment(
    workspaceId: string,
    machineId: string,
    assignmentId: string,
  ) {
    const wsId = this.toObjectId(workspaceId);
    const mId = this.toObjectId(machineId);
    const aId = this.toObjectId(assignmentId);
    const result = await this.assignmentModel
      .findOneAndUpdate(
        { _id: aId, workspaceId: wsId, machineId: mId, isDeleted: false },
        { $set: { isDeleted: true, deletedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!result) throw new NotFoundException('Assignment not found');
    return { success: true };
  }

  /**
   * Resolves the primary production metric for a machine (D-02).
   * Returns explicit machine.primaryMetric if set, else type-default:
   *   embroidery -> stitches
   *   cutting    -> pieces
   *   pressing   -> hours
   *   other      -> pieces
   */
  resolvePrimaryMetric(
    machine: Pick<Machine, 'type' | 'primaryMetric'>,
  ): PrimaryMetric {
    if (machine.primaryMetric) return machine.primaryMetric;
    switch (machine.type) {
      case 'embroidery':
        return 'stitches';
      case 'cutting':
        return 'pieces';
      case 'pressing':
        return 'hours';
      default:
        return 'pieces';
    }
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Recomputes machine.status from currently-open downtime entries
   * (Phase 22 D-04, MACH-P2-02c).
   *
   * Priority:
   *   any open mechanical downtime → 'maintenance'
   *   else any open operational downtime → 'idle'
   *   else → 'active'
   *   'retired' is NEVER overridden (manual terminal state)
   *
   * Idempotent. Caller MUST pass `session` if invoked inside a transaction so
   * the read-modify-write happens atomically with the entry mutation.
   *
   * TODO(Phase 25): assignment-driven idle (no active assignment → idle) — out
   * of scope per CONTEXT D-04 final paragraph. Phase 22 only handles the
   * downtime branch.
   */
  async recomputeStatus(
    machineId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<MachineStatus> {
    const mId =
      typeof machineId === 'string'
        ? new Types.ObjectId(machineId)
        : machineId;
    const machine = await this.machineModel
      .findOne({ _id: mId, isDeleted: false })
      .session(session ?? null)
      .exec();
    if (!machine) {
      throw new NotFoundException({
        code: 'MACHINE_NOT_FOUND',
        message: 'Machine not found.',
      });
    }
    if (machine.status === 'retired') return 'retired';

    const open = await this.downtimeModel
      .find({
        workspaceId: new Types.ObjectId(machine.workspaceId),
        machineId: new Types.ObjectId(mId),
        endAt: null,
        isDeleted: false,
      })
      .session(session ?? null)
      .lean()
      .exec();

    let next: MachineStatus;
    if (open.some((e: any) => e.reasonCategory === 'mechanical')) {
      next = 'maintenance';
    } else if (open.length > 0) {
      next = 'idle';
    } else {
      next = 'active';
    }

    if (next !== machine.status) {
      await this.machineModel
        .updateOne({ _id: mId }, { $set: { status: next } })
        .session(session ?? null)
        .exec();
    }
    return next;
  }
}
