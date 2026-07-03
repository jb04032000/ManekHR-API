import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PolicyDeniedException } from '../../../common/exceptions/policy-denied.exception';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { AttendanceEvent } from '../schemas/attendance-event.schema';
import { Attendance } from '../schemas/attendance.schema';
import { Salary } from '../../salary/schemas/salary.schema';
import { AttendanceEventService } from '../attendance-event.service';
import { AttendanceProjectionService } from '../attendance-projection.service';
import { AttendanceWriteGuardService } from '../attendance-write-guard.service';
import { CallerScopeService } from '../../../common/services/caller-scope.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { pairSessions } from '../projection/compute';

/**
 * The caller's own attendance for a single day. Powers the live "today" clock
 * (state, hours-so-far, punch count, session log) and the calendar day-detail.
 * Carries the first-in/last-out projection summary PLUS the full paired session
 * list, since the projection persists only the day summary, not each session.
 */
export interface MeAttendanceDay {
  date: string; // YYYY-MM-DD (UTC)
  status: string | null;
  checkIn: string | null; // ISO
  checkOut: string | null; // ISO
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyMinutes: number | null;
  otMinutes: number | null;
  /** True when the last punch of the day was a CHECK_IN (an open session). */
  currentlyIn: boolean;
  lastPunchType: 'CHECK_IN' | 'CHECK_OUT' | null;
  lastPunchAt: string | null; // ISO
  /** Total CHECK_IN + CHECK_OUT punches recorded for the day. */
  punchCount: number;
  sessions: Array<{ in: string; out: string | null }>;
}

/**
 * Self-service attendance — the caller acting on their OWN attendance.
 *
 * Access Control Initiative §8 Part B. Distinct from the admin
 * `AttendanceService.mark` flow in two ways:
 *   1. The target is always the caller's own directory row, resolved
 *      server-side via `CallerScopeService` — never trusted from the
 *      request body, so a self-scoped worker cannot punch for anyone else.
 *   2. The action is additionally gated by the workspace
 *      `selfServiceConfig.selfPunch` policy toggle (owner opt-in).
 */
@Injectable()
export class MeAttendanceService {
  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(AttendanceEvent.name)
    private readonly eventModel: Model<AttendanceEvent>,
    @InjectModel(Attendance.name)
    private readonly attendanceModel: Model<Attendance>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    private readonly eventService: AttendanceEventService,
    private readonly projectionService: AttendanceProjectionService,
    // Attendance hardening: MEMBER_OFFBOARDED write-lock on self-punch (OQ-A5).
    private readonly writeGuard: AttendanceWriteGuardService,
    private readonly callerScope: CallerScopeService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Record the caller's own punch. Auto-toggles CHECK_IN / CHECK_OUT from
   * the last punch event today (same rule the kiosk uses), so a single
   * action covers both directions. Returns the punch type recorded so the
   * client can confirm it to the user.
   */
  async punch(
    workspaceId: string,
    userId: string,
  ): Promise<{ punchType: 'CHECK_IN' | 'CHECK_OUT'; time: Date }> {
    // 1. Resolve the caller's own directory row — the only member they may act on.
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException(
        'Your account has no team-directory record, so attendance cannot be recorded for you.',
      );
    }
    const teamMemberId = ctx.teamMemberId;

    // Attendance hardening: MEMBER_OFFBOARDED write-lock (OQ-A5). A removed
    // member cannot self-punch even if a stale session reaches here. The SoD
    // self-edit block does NOT apply — self-punch is BY DESIGN the caller acting
    // on their own record, gated by the workspace policy below, not by SoD.
    await this.writeGuard.assertMemberWritable(workspaceId, teamMemberId);

    // 2. Workspace policy — self check-in must be enabled by the owner.
    const ws = await this.workspaceModel
      .findById(new Types.ObjectId(workspaceId))
      .select('selfServiceConfig')
      .lean()
      .exec();
    const selfPunchEnabled = !!(ws as { selfServiceConfig?: { selfPunch?: boolean } } | null)
      ?.selfServiceConfig?.selfPunch;
    if (!selfPunchEnabled) {
      throw new PolicyDeniedException(
        'SELF_PUNCH_DISABLED',
        'Self check-in is turned off for this workspace. Ask an admin to enable it.',
      );
    }

    // 3. Payroll-lock guard — mirrors the kiosk punch: no punches into a
    //    pay period that has already been locked.
    //
    //    ATT-SEC-01 fix: throw the SAME structured { code, message } body the
    //    other attendance write guards use (KioskService.punch →
    //    KIOSK_PERIOD_CLOSED, AttendanceWriteGuardService → MEMBER_OFFBOARDED /
    //    ATTENDANCE_SELF_EDIT_BLOCKED). The web error mapper
    //    (attendance.api.ts → getAttendanceErrorMessage) keys off this `code`
    //    to resolve `attendance.errors.PAYROLL_LOCKED` in all four locales;
    //    without a code a worker self-punching on a locked period saw the raw
    //    English `message` instead of their language. The English string is
    //    kept as the fallback `message` the FE shows when no translator is in
    //    scope. Keep PAYROLL_LOCKED in sync with the FE ATTENDANCE_ERROR_CODES
    //    set + `attendance.errors.*` locale keys.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (await this.isSalaryLocked(workspaceId, teamMemberId, today)) {
      throw new BadRequestException({
        code: 'PAYROLL_LOCKED',
        message: 'Attendance is locked — payroll has been generated for this period.',
      });
    }

    // 4. Auto-toggle CHECK_IN / CHECK_OUT from the last punch event today.
    const dayStart = new Date(today);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const last = await this.eventModel
      .findOne({
        wsId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
        timestamp: { $gte: dayStart, $lt: dayEnd },
        voidedAt: null,
        punchType: { $in: ['CHECK_IN', 'CHECK_OUT'] },
      })
      .sort({ timestamp: -1 })
      .lean()
      .exec();
    const nextType: 'CHECK_IN' | 'CHECK_OUT' =
      last && (last as { punchType?: string }).punchType === 'CHECK_IN' ? 'CHECK_OUT' : 'CHECK_IN';

    // 5. Emit the event + recompute the projection — the same path the
    //    kiosk uses, so the day's attendance record stays consistent.
    const now = new Date();
    await this.eventService.createEvent({
      wsId: workspaceId,
      teamMemberId,
      timestamp: now,
      punchType: nextType,
      source: 'self',
      verifyMethod: 'manual',
      markedBy: userId,
      sourceMeta: { self: true },
    });
    await this.projectionService.recompute(workspaceId, teamMemberId, today);

    // Write-event analytics (fire-and-forget). distinctId = the punching user.
    this.postHog.capture({
      distinctId: userId,
      event: 'attendance.self_punched',
      properties: { workspaceId, teamMemberId, punchType: nextType },
    });

    return { punchType: nextType, time: now };
  }

  /**
   * The caller's own attendance for a single day (defaults to today). Self-
   * scoped: the directory row is resolved server-side, so the `date` query
   * param can never reach another member. Returns the first-in/last-out
   * projection summary PLUS the full paired session list + live punch state,
   * which the persisted projection alone does not carry.
   */
  async getDay(workspaceId: string, userId: string, dateStr?: string): Promise<MeAttendanceDay> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException(
        'Your account has no team-directory record, so attendance cannot be shown for you.',
      );
    }
    const teamMemberId = ctx.teamMemberId;

    // Resolve the requested day to UTC midnight; reject malformed input rather
    // than silently returning the wrong day.
    const day = dateStr ? new Date(dateStr) : new Date();
    if (Number.isNaN(day.getTime())) {
      throw new BadRequestException('Invalid date. Expected an ISO date (YYYY-MM-DD).');
    }
    day.setUTCHours(0, 0, 0, 0);

    const [record, events] = await Promise.all([
      this.attendanceModel
        .findOne({
          workspaceId: new Types.ObjectId(workspaceId),
          teamMemberId: new Types.ObjectId(teamMemberId),
          date: day,
        })
        .lean<{
          status?: string;
          checkIn?: Date | null;
          checkOut?: Date | null;
          workedMinutes?: number | null;
          lateMinutes?: number | null;
          earlyMinutes?: number | null;
          otMinutes?: number | null;
        } | null>()
        .exec(),
      // Non-voided punches for the day (attendanceDate-aware, sorted ascending).
      this.eventService.findByMemberDate(workspaceId, teamMemberId, day),
    ]);

    // Pair raw punches into sessions (shared with the split-shift projection).
    const sessions = pairSessions(events).map((s) => ({
      in: s.in.toISOString(),
      out: s.out ? s.out.toISOString() : null,
    }));
    const punches = events.filter((e) => e.punchType === 'CHECK_IN' || e.punchType === 'CHECK_OUT');
    // events are sorted ascending, so the last punch is the most recent.
    const lastPunch = punches.length ? punches[punches.length - 1] : null;

    return {
      date: day.toISOString().slice(0, 10),
      status: record?.status ?? null,
      checkIn: record?.checkIn ? new Date(record.checkIn).toISOString() : null,
      checkOut: record?.checkOut ? new Date(record.checkOut).toISOString() : null,
      workedMinutes: record?.workedMinutes ?? null,
      lateMinutes: record?.lateMinutes ?? null,
      earlyMinutes: record?.earlyMinutes ?? null,
      otMinutes: record?.otMinutes ?? null,
      currentlyIn: !!lastPunch && lastPunch.punchType === 'CHECK_IN',
      lastPunchType: lastPunch ? (lastPunch.punchType as 'CHECK_IN' | 'CHECK_OUT') : null,
      lastPunchAt: lastPunch ? new Date(lastPunch.timestamp).toISOString() : null,
      punchCount: punches.length,
      sessions,
    };
  }

  /** True when a locked Salary row exists for (workspace, member, month, year). */
  private async isSalaryLocked(
    workspaceId: string,
    memberId: string,
    date: Date,
  ): Promise<boolean> {
    const salary = await this.salaryModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(memberId),
        month: date.getUTCMonth() + 1,
        year: date.getUTCFullYear(),
      })
      .select('isLocked')
      .lean()
      .exec();
    return !!(salary as { isLocked?: boolean } | null)?.isLocked;
  }
}
