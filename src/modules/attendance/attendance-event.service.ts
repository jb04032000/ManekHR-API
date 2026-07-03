import {
  Injectable,
  Optional,
  Inject,
  forwardRef,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, FilterQuery } from 'mongoose';
import { AttendanceEvent } from './schemas/attendance-event.schema';
import { Attendance } from './schemas/attendance.schema';
import { AnomalyDetectionService, ShiftSnapshot } from '../anomalies/anomaly-detection.service';

export interface CreateEventInput {
  wsId: string | Types.ObjectId;
  teamMemberId?: string | Types.ObjectId | null;
  deviceSerial?: string | null;
  deviceUserId?: string | null;
  timestamp: Date;
  punchType:
    | 'CHECK_IN'
    | 'CHECK_OUT'
    | 'BREAK_OUT'
    | 'BREAK_IN'
    | 'OT_IN'
    | 'OT_OUT'
    | 'STATUS_SET';
  statusValue?: string | null;
  verifyMethod?: string | null;
  source:
    | 'manual'
    | 'manual_override'
    | 'device_push'
    | 'connector'
    | 'file_upload'
    | 'auto_cron'
    | 'regularization'
    | 'kiosk'
    | 'self'
    | 'leave'
    | 'system_auto_close';
  sourceMeta?: Record<string, unknown> | null;
  markedBy?: string | Types.ObjectId | null;
  note?: string | null;
  correctsEventId?: string | Types.ObjectId | null;
  /** Pre-resolved attendance date. When provided, skips DB lookup in createEvent. */
  attendanceDate?: Date | null;
}

@Injectable()
export class AttendanceEventService {
  constructor(
    @InjectModel(AttendanceEvent.name)
    private readonly eventModel: Model<AttendanceEvent>,
    @InjectModel(Attendance.name)
    private readonly attendanceModel: Model<Attendance>,
    @Optional()
    @Inject(forwardRef(() => AnomalyDetectionService))
    private readonly anomalyDetectionService?: AnomalyDetectionService,
  ) {}

  /**
   * Resolves the attendanceDate for a punch event — the shift-start calendar day,
   * which may differ from the timestamp's calendar day for cross-midnight shifts.
   *
   * Rules (in order):
   * 1. CHECK_IN always uses the timestamp's calendar day.
   * 2. Other types: look for an open attendance session (checkOut=null) on today
   *    or yesterday for this member — inherit its date.
   * 3. Fallback: if timestamp hour < 12 UTC assume overnight → use previous calendar
   *    day. Otherwise use the timestamp's calendar day. Flag for review via sourceMeta.
   */
  private async resolveAttendanceDate(
    wsId: string,
    teamMemberId: string,
    timestamp: Date,
    punchType: string,
  ): Promise<Date> {
    const calendarDay = new Date(timestamp);
    calendarDay.setUTCHours(0, 0, 0, 0);

    if (punchType === 'CHECK_IN') return calendarDay;

    const prevDay = new Date(calendarDay);
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);

    // Look back 3 days to handle biometric devices that sync with multi-day delays.
    // Tradeoff: slightly broader scan vs. 1-day which would wrong-day events from
    // delayed devices. 3 days is a practical max before manual correction is warranted.
    const lookbackStart = new Date(calendarDay);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 3);

    const openRecord = await this.attendanceModel
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        teamMemberId: new Types.ObjectId(teamMemberId),
        checkOut: null,
        date: { $gte: lookbackStart },
      })
      .select('date')
      .sort({ date: -1 })
      .lean<{ date: Date }>()
      .exec();

    if (openRecord) return new Date(openRecord.date);

    // Noon heuristic: before 12:00 UTC → assume previous night's shift
    return timestamp.getUTCHours() < 12 ? prevDay : calendarDay;
  }

  async createEvent(input: CreateEventInput): Promise<AttendanceEvent> {
    // Resolve attendanceDate (shift-start day, may differ from timestamp day for overnight shifts)
    let attendanceDate: Date | null = input.attendanceDate ?? null;
    if (!attendanceDate && input.teamMemberId) {
      attendanceDate = await this.resolveAttendanceDate(
        String(input.wsId),
        String(input.teamMemberId),
        input.timestamp,
        input.punchType,
      );
    } else if (!attendanceDate) {
      const d = new Date(input.timestamp);
      d.setUTCHours(0, 0, 0, 0);
      attendanceDate = d;
    }

    const doc = new this.eventModel({
      wsId: new Types.ObjectId(String(input.wsId)),
      teamMemberId: input.teamMemberId ? new Types.ObjectId(String(input.teamMemberId)) : null,
      deviceSerial: input.deviceSerial ?? null,
      deviceUserId: input.deviceUserId ?? null,
      timestamp: input.timestamp,
      punchType: input.punchType,
      statusValue: input.statusValue ?? null,
      verifyMethod: input.verifyMethod ?? null,
      source: input.source,
      sourceMeta: input.sourceMeta ?? null,
      markedBy: input.markedBy ? new Types.ObjectId(String(input.markedBy)) : null,
      note: input.note ?? null,
      correctsEventId: input.correctsEventId
        ? new Types.ObjectId(String(input.correctsEventId))
        : null,
      attendanceDate,
    });
    const saved = await doc.save();

    // Phase I synchronous-rule hook — fire-and-forget, MUST NOT throw.
    // Mirrors AttendanceIngestService.notifyPendingDevice setImmediate pattern.
    // Skip for manual/manual_override: admin actions are intentional, not biometric anomalies.
    // Time-travel would always fire for past timestamps set by admins.
    if (
      this.anomalyDetectionService &&
      saved.source !== 'manual' &&
      saved.source !== 'manual_override'
    ) {
      const shiftSnapshot: ShiftSnapshot | null = null; // Phase I accepts null — off_shift_punch skips silently
      setImmediate(() => {
        void this.anomalyDetectionService
          .detectOnEvent(
            {
              _id: (saved as any)._id,
              wsId: saved.wsId,
              teamMemberId: saved.teamMemberId,
              deviceSerial: saved.deviceSerial,
              timestamp: saved.timestamp,
              punchType: saved.punchType,
            },
            new Date(),
            shiftSnapshot,
          )
          .catch(() => {});
      });
    }

    return saved;
  }

  /** Find all events for a member on a specific UTC date (day window).
   * By default excludes voided events (voidedAt: null).
   * Pass includeVoided: true to return all events including voided ones (needed by audit view in M-05).
   */
  async findByMemberDate(
    wsId: string,
    teamMemberId: string,
    date: Date,
    includeVoided = false,
  ): Promise<AttendanceEvent[]> {
    const dayStart = new Date(date);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    // Query by attendanceDate (set on all new events) OR fall back to the
    // timestamp window for legacy events created before this field was introduced.
    // This dual-path ensures cross-midnight checkouts (attendanceDate = Day 1)
    // are correctly found when projecting Day 1, even if their timestamp is on Day 2.
    const baseFilter: Record<string, unknown> = {
      wsId: new Types.ObjectId(wsId),
      teamMemberId: new Types.ObjectId(teamMemberId),
      $or: [
        { attendanceDate: dayStart },
        { attendanceDate: null, timestamp: { $gte: dayStart, $lt: dayEnd } },
      ],
    };
    if (!includeVoided) {
      baseFilter.voidedAt = null;
    }
    return this.eventModel.find(baseFilter).sort({ timestamp: 1 }).lean<AttendanceEvent[]>().exec();
  }

  /** Find events by device pair (dedupe / Phase B use). */
  async findByDevicePair(
    wsId: string,
    deviceSerial: string,
    deviceUserId: string,
    timestamp: Date,
  ): Promise<AttendanceEvent | null> {
    return this.eventModel
      .findOne({
        wsId: new Types.ObjectId(wsId),
        deviceSerial,
        deviceUserId,
        timestamp,
      })
      .lean<AttendanceEvent>()
      .exec();
  }

  /** Paginated event query for a workspace (Plan 06 list-events endpoint). */
  async queryEvents(
    wsId: string,
    filter: { memberId?: string; from?: Date; to?: Date },
    page = 1,
    limit = 50,
  ): Promise<{
    items: AttendanceEvent[];
    total: number;
    page: number;
    limit: number;
  }> {
    const q: FilterQuery<AttendanceEvent> = { wsId: new Types.ObjectId(wsId) };
    if (filter.memberId) q.teamMemberId = new Types.ObjectId(filter.memberId);
    if (filter.from || filter.to) {
      q.timestamp = {};
      if (filter.from) (q.timestamp as Record<string, Date>).$gte = filter.from;
      if (filter.to) (q.timestamp as Record<string, Date>).$lte = filter.to;
    }
    const [items, total] = await Promise.all([
      this.eventModel
        .find(q)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('markedBy', 'name email')
        .populate('teamMemberId', 'name')
        .lean<AttendanceEvent[]>()
        .exec(),
      this.eventModel.countDocuments(q).exec(),
    ]);
    return { items, total, page, limit };
  }

  /**
   * Find all events for a member over a date range (inclusive).
   * Used by AttendancePoliciesService.dryRun to batch-load events per member.
   */
  async findByMemberDateRange(
    wsId: string,
    memberId: string,
    from: Date,
    to: Date,
  ): Promise<AttendanceEvent[]> {
    const dayStart = new Date(from);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(to);
    dayEnd.setUTCHours(23, 59, 59, 999);
    return this.eventModel
      .find({
        wsId: new Types.ObjectId(wsId),
        teamMemberId: new Types.ObjectId(memberId),
        $or: [
          { attendanceDate: { $gte: dayStart, $lte: dayEnd } },
          { attendanceDate: null, timestamp: { $gte: dayStart, $lte: dayEnd } },
        ],
      })
      .sort({ timestamp: 1 })
      .lean<AttendanceEvent[]>()
      .exec();
  }

  /**
   * Soft-delete (void) an event.
   * Sets voidedAt, voidedBy, voidReason on the event.
   * Returns (wsId, teamMemberId, day) so the caller can trigger projection recompute.
   *
   * Security: filter includes wsId to prevent cross-workspace void (T-M01-01, T-M01-03).
   * Reason validation: 3-280 chars (T-M01-02 — audit trail min length).
   */
  async voidEvent(
    wsId: string,
    eventId: string,
    userId: string,
    reason: string,
    // Attendance hardening: optional MEMBER_OFFBOARDED guard. The controller
    // passes AttendanceWriteGuardService.assertMemberWritable so a removed
    // member's events cannot be voided. Resolved here (after the event lookup)
    // because the event row is where the target teamMemberId becomes known.
    guard?: (teamMemberId: string) => Promise<void>,
  ): Promise<{ wsId: Types.ObjectId; teamMemberId: Types.ObjectId | null; date: Date }> {
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 280) {
      throw new BadRequestException('Reason must be 3-280 characters');
    }
    const evt = await this.eventModel
      .findOne({
        _id: new Types.ObjectId(String(eventId)),
        wsId: new Types.ObjectId(String(wsId)),
      })
      .exec();
    if (!evt) throw new NotFoundException('Event not found');
    if (evt.voidedAt) throw new BadRequestException('Event already voided');

    // MEMBER_OFFBOARDED gate (OQ-A5) — fired BEFORE the void mutation so a
    // removed member's event is never altered. No-op when the guard is absent
    // (e.g. internal callers) or the event has no resolvable member.
    if (guard && evt.teamMemberId) {
      await guard(String(evt.teamMemberId));
    }

    evt.voidedAt = new Date();
    evt.voidedBy = new Types.ObjectId(String(userId));
    evt.voidReason = trimmed;
    await evt.save();

    // Return (wsId, teamMemberId, day) for projection recompute.
    // Prefer attendanceDate (shift-start day) over timestamp calendar day so that
    // voiding a cross-midnight checkout correctly triggers Day 1's projection.
    const day = evt.attendanceDate
      ? new Date(evt.attendanceDate)
      : new Date(
          Date.UTC(
            evt.timestamp.getUTCFullYear(),
            evt.timestamp.getUTCMonth(),
            evt.timestamp.getUTCDate(),
          ),
        );
    return { wsId: evt.wsId, teamMemberId: evt.teamMemberId, date: day };
  }

  /**
   * Void all non-voided events of a specific punch type for a member on a given day.
   * Used by admin "Set Times" to replace accumulated events rather than appending.
   * Security: filter scoped to wsId + memberId + day window.
   */
  async voidAllByPunchTypeForMemberDay(
    wsId: string,
    memberId: string,
    date: Date,
    punchType: 'CHECK_IN' | 'CHECK_OUT',
    voidedBy: string,
  ): Promise<void> {
    const dayStart = new Date(date);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    await this.eventModel.updateMany(
      {
        wsId: new Types.ObjectId(wsId),
        teamMemberId: new Types.ObjectId(memberId),
        $or: [
          { attendanceDate: dayStart },
          { attendanceDate: null, timestamp: { $gte: dayStart, $lt: dayEnd } },
        ],
        punchType,
        voidedAt: null,
      },
      {
        $set: {
          voidedAt: new Date(),
          voidedBy: new Types.ObjectId(voidedBy),
          voidReason: 'Replaced by admin manual time override',
        },
      },
    );
  }

  /**
   * Bulk insert events in a single round-trip.
   * Skips anomaly detection hook (performance-sensitive on bulk).
   * Uses ordered:false so a duplicate-key error on one doc does not abort the batch.
   * T-M01-04: single insertMany round-trip prevents N+1 on bulk attendance mark.
   */
  async bulkInsertEvents(docs: CreateEventInput[]): Promise<void> {
    if (docs.length === 0) return;
    const prepared = docs.map((input) => ({
      wsId: new Types.ObjectId(String(input.wsId)),
      teamMemberId: input.teamMemberId ? new Types.ObjectId(String(input.teamMemberId)) : null,
      deviceSerial: input.deviceSerial ?? null,
      deviceUserId: input.deviceUserId ?? null,
      timestamp: input.timestamp,
      punchType: input.punchType,
      statusValue: input.statusValue ?? null,
      verifyMethod: input.verifyMethod ?? null,
      source: input.source,
      sourceMeta: input.sourceMeta ?? null,
      markedBy: input.markedBy ? new Types.ObjectId(String(input.markedBy)) : null,
      note: input.note ?? null,
      correctsEventId: input.correctsEventId
        ? new Types.ObjectId(String(input.correctsEventId))
        : null,
      attendanceDate: input.attendanceDate ?? null,
    }));
    await this.eventModel.insertMany(prepared, { ordered: false });
  }

  /**
   * Find distinct (teamMemberId, day) pairs that have events in a date range.
   * Used by AttendanceProjectionService.recomputeRange for fan-out over all members.
   */
  async findDistinctMemberDatePairs(
    wsId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ teamMemberId: Types.ObjectId; day: Date }>> {
    const result = await this.eventModel
      .aggregate([
        {
          $match: {
            wsId: new Types.ObjectId(wsId),
            teamMemberId: { $ne: null },
            timestamp: { $gte: from, $lte: to },
          },
        },
        {
          $group: {
            _id: {
              teamMemberId: '$teamMemberId',
              // Use attendanceDate (shift-start day) when set; fall back to
              // timestamp-truncated day for legacy events without the field.
              day: {
                $cond: {
                  if: { $ne: ['$attendanceDate', null] },
                  then: '$attendanceDate',
                  else: { $dateTrunc: { date: '$timestamp', unit: 'day', timezone: 'UTC' } },
                },
              },
            },
          },
        },
      ])
      .exec();
    return (result as Array<{ _id: { teamMemberId: Types.ObjectId; day: Date } }>).map((r) => ({
      teamMemberId: r._id.teamMemberId,
      day: r._id.day,
    }));
  }
}
