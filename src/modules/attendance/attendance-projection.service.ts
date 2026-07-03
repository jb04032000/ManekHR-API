import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import pLimit from 'p-limit';
import { Attendance } from './schemas/attendance.schema';
import { AttendanceEventService } from './attendance-event.service';
import { Shift } from '../shifts/schemas/shift.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { AttendancePoliciesService } from '../attendance-policies/attendance-policies.service';
import { Salary } from '../salary/schemas/salary.schema';
import {
  computeDailySummary,
  type EventInput,
  type ShiftSnapshot,
  DEFAULT_SHIFT_SNAPSHOT,
  DEFAULT_POLICY_SNAPSHOT,
} from './projection/compute';

/**
 * Bounded concurrency for bulk (member, day) recompute. 8 parallel workers is the
 * starting point per H6-CONTEXT D-01. Exported so attendance-ingest.service.ts can
 * reuse the same limit for _recomputeProjections (D-02) and so tuning is one-line.
 */
export const RECOMPUTE_CONCURRENCY = 8;

interface MemberContext {
  shiftSnapshot: ShiftSnapshot;
  policySnapshot: ReturnType<AttendancePoliciesService['toPolicySnapshot']>;
}

@Injectable()
export class AttendanceProjectionService {
  constructor(
    @InjectModel(Attendance.name)
    private readonly attendanceModel: Model<Attendance>,
    @InjectModel(Shift.name)
    private readonly shiftModel: Model<Shift>,
    @InjectModel(TeamMember.name)
    private readonly memberModel: Model<TeamMember>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    private readonly eventService: AttendanceEventService,
    private readonly policiesService: AttendancePoliciesService,
  ) {}

  /**
   * Recompute the projection for (wsId, memberId, date).
   * - Loads all events for this member+day.
   * - Resolves effective shift + policy.
   * - Runs computeDailySummary (Phase C — replaces Phase A stub).
   * - Upserts Attendance with full projection fields.
   *
   * Security: wsId always comes from JwtGuard+WorkspaceGuard context.
   * All Mongoose queries are scoped by wsId to prevent cross-workspace leakage.
   */
  async recompute(
    wsId: string,
    memberId: string,
    date: Date,
  ): Promise<{ updated: boolean; status: string | null }> {
    const dayStart = new Date(date);
    dayStart.setUTCHours(0, 0, 0, 0);

    if (await this.isSalaryLocked(wsId, memberId, dayStart)) {
      return { updated: false, status: null };
    }

    const events = await this.eventService.findByMemberDate(wsId, memberId, dayStart);
    if (!events.length) return { updated: false, status: null };

    const computeInput: EventInput[] = events.map((e) => ({
      timestamp: new Date(e.timestamp),
      punchType: e.punchType as EventInput['punchType'],
      statusValue: e.statusValue ?? null,
      source: e.source as EventInput['source'],
    }));

    const ctx = await this.resolveContext(wsId, memberId);
    if (!ctx) return { updated: false, status: null };
    const { shiftSnapshot, policySnapshot } = ctx;

    const summary = computeDailySummary(computeInput, shiftSnapshot, policySnapshot, dayStart);

    const now = new Date();
    await this.attendanceModel
      .findOneAndUpdate(
        {
          workspaceId: new Types.ObjectId(wsId),
          teamMemberId: new Types.ObjectId(memberId),
          date: dayStart,
        },
        {
          $set: {
            status: summary.status,
            date: dayStart,
            dominantSource: summary.dominantSource,
            lastComputedAt: now,
            checkIn: summary.checkIn,
            checkOut: summary.checkOut,
            workedMinutes: summary.workedMinutes,
            lateMinutes: summary.lateMinutes,
            earlyMinutes: summary.earlyMinutes,
            otMinutes: summary.otMinutes,
            computeReason: summary.computeReason,
          },
          $inc: { projectionVersion: 1 },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();

    return { updated: true, status: summary.status };
  }

  /** Bulk recompute for a date range. Caches shift+policy per member to avoid N+1. */
  async recomputeRange(
    wsId: string,
    memberId: string | null,
    from: Date,
    to: Date,
  ): Promise<{ recomputed: number }> {
    const dayStart = new Date(from);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(to);
    dayEnd.setUTCHours(0, 0, 0, 0);
    let count = 0;

    // Cache: one resolveContext call per distinct member, not per day
    const contextCache = new Map<string, MemberContext | null>();

    const resolveWithCache = async (mId: string): Promise<MemberContext | null> => {
      if (contextCache.has(mId)) return contextCache.get(mId);
      const ctx = await this.resolveContext(wsId, mId);
      contextCache.set(mId, ctx);
      return ctx;
    };

    if (memberId) {
      const ctx = await resolveWithCache(memberId);
      if (!ctx) return { recomputed: 0 }; // soft-deleted / missing — no-op
      for (let d = new Date(dayStart); d <= dayEnd; d.setUTCDate(d.getUTCDate() + 1)) {
        const res = await this.recomputeWithContext(wsId, memberId, new Date(d), ctx);
        if (res.updated) count += 1;
      }
      return { recomputed: count };
    }

    const rangeEnd = new Date(dayEnd.getTime() + 86_400_000);
    const pairs = await this.eventService.findDistinctMemberDatePairs(wsId, dayStart, rangeEnd);

    // PERF-01 (H6-CONTEXT D-01): parallelise per-pair recompute with bounded concurrency.
    // The contextCache Map is shared across tasks — JS event loop is single-threaded,
    // so Map reads/writes are race-free. Multiple tasks may redundantly call resolveContext
    // for the same mId on cold start; both write the same value (H6-RESEARCH §Pattern 1).
    const limit = pLimit(RECOMPUTE_CONCURRENCY);
    const results = await Promise.all(
      pairs.map((p) =>
        limit(async () => {
          const mId = String(p.teamMemberId);
          const ctx = await resolveWithCache(mId);
          if (!ctx) return 0;
          const r = await this.recomputeWithContext(wsId, mId, p.day, ctx);
          return r.updated ? 1 : 0;
        }),
      ),
    );
    count += results.reduce((a, b) => a + b, 0);
    return { recomputed: count };
  }

  /**
   * Resolve the effective shift and policy for a member.
   * Returns null for soft-deleted or non-existent members (GAP-1.3-A fix).
   * Callers MUST short-circuit and write nothing when null is returned.
   *
   * Security: member query is scoped by wsId AND isDeleted:false — if memberId
   * doesn't belong to wsId, or belongs to an archived member, returns null
   * (no cross-workspace leakage, no projection for soft-deleted members).
   */
  async resolveContext(wsId: string, memberId: string): Promise<MemberContext | null> {
    const member = await this.memberModel
      .findOne({
        _id: new Types.ObjectId(memberId),
        workspaceId: new Types.ObjectId(wsId),
        isDeleted: false,
      })
      .select('shiftId')
      .lean()
      .exec();

    // GAP-1.3-A: soft-deleted or non-existent members produce no projection.
    // Callers MUST short-circuit and write nothing.
    if (!member) return null;

    let shiftSnapshot: ShiftSnapshot = DEFAULT_SHIFT_SNAPSHOT;

    const shift = member.shiftId
      ? await this.shiftModel.findById(member.shiftId).lean().exec()
      : null;

    if (shift) {
      shiftSnapshot = {
        startTime: shift.startTime,
        endTime: shift.endTime,
        gracePeriodMinutes: shift.gracePeriodMinutes ?? 0,
        halfDayAfterLateMinutes: shift.halfDayAfterLateMinutes ?? 60,
        shiftType: shift.shiftType ?? 'fixed',
        requiredHoursPerDay: shift.requiredHoursPerDay ?? null,
      };
    }

    const policyId = shift?.policyId?.toString() ?? null;
    const policy = await this.policiesService.findEffective(wsId, policyId);
    const policySnapshot = policy
      ? this.policiesService.toPolicySnapshot(policy)
      : DEFAULT_POLICY_SNAPSHOT;

    return { shiftSnapshot, policySnapshot };
  }

  /** Internal: recompute one (member, day) pair using a pre-resolved context. */
  private async recomputeWithContext(
    wsId: string,
    memberId: string,
    date: Date,
    ctx: MemberContext,
  ): Promise<{ updated: boolean; status: string | null }> {
    const dayStart = new Date(date);
    dayStart.setUTCHours(0, 0, 0, 0);

    if (await this.isSalaryLocked(wsId, memberId, dayStart)) {
      return { updated: false, status: null };
    }

    const events = await this.eventService.findByMemberDate(wsId, memberId, dayStart);
    if (!events.length) return { updated: false, status: null };

    const computeInput: EventInput[] = events.map((e) => ({
      timestamp: new Date(e.timestamp),
      punchType: e.punchType as EventInput['punchType'],
      statusValue: e.statusValue ?? null,
      source: e.source as EventInput['source'],
    }));

    const summary = computeDailySummary(
      computeInput,
      ctx.shiftSnapshot,
      ctx.policySnapshot,
      dayStart,
    );
    const now = new Date();

    await this.attendanceModel
      .findOneAndUpdate(
        {
          workspaceId: new Types.ObjectId(wsId),
          teamMemberId: new Types.ObjectId(memberId),
          date: dayStart,
        },
        {
          $set: {
            status: summary.status,
            date: dayStart,
            dominantSource: summary.dominantSource,
            lastComputedAt: now,
            checkIn: summary.checkIn,
            checkOut: summary.checkOut,
            workedMinutes: summary.workedMinutes,
            lateMinutes: summary.lateMinutes,
            earlyMinutes: summary.earlyMinutes,
            otMinutes: summary.otMinutes,
            computeReason: summary.computeReason,
          },
          $inc: { projectionVersion: 1 },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();

    return { updated: true, status: summary.status };
  }

  /**
   * Public — used by AttendanceService to decorate read responses with isLocked (D-27, B2).
   * Returns true when a Salary row exists for (wsId, memberId, month(date), year(date))
   * and is flagged isLocked. Returns false when no salary row exists (not yet generated)
   * or when the row is unlocked. Mirrors regularization.service._assertPayrollNotLocked.
   * H3-05 — closes GAP-2.3-A.
   */
  public async isSalaryLocked(wsId: string, memberId: string, date: Date): Promise<boolean> {
    const month = date.getUTCMonth() + 1;
    const year = date.getUTCFullYear();
    const salary = await this.salaryModel
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        teamMemberId: new Types.ObjectId(memberId),
        month,
        year,
      })
      .select('isLocked')
      .lean()
      .exec();
    return !!salary?.isLocked;
  }
}
