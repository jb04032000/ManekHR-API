import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type Redis from 'ioredis';
import { Attendance } from './schemas/attendance.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Salary } from '../salary/schemas/salary.schema';
import {
  MarkAttendanceDto,
  BulkMarkAttendanceDto,
  UpdateAttendanceDto,
} from './dto/attendance.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { QueryHelper } from '../../common/helpers/query.helper';
import { AttendanceEventService, CreateEventInput } from './attendance-event.service';
import { AttendanceProjectionService } from './attendance-projection.service';
import { AttendanceWriteGuardService } from './attendance-write-guard.service';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';
import { CallerScopeService } from '../../common/services/caller-scope.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
// Phase 6 (member-cap read filter): read-time grandfathering of an over-limit
// workspace's roster. Injected to scope the ORG-scoped attendance reports
// (getSummary stats + findAll records list) to the allowed member set. Optional
// (appended LAST in the constructor) so positional unit-test construction keeps
// it undefined and the cap is a no-op there.
import { ErpMemberCapService } from '../subscriptions/member-cap/erp-member-cap.service';

// ── Live presence cache ──────────────────────────────────────────────────
// All managers in a workspace polling /live-presence share one underlying
// aggregation per TTL window. Keeps the rollup query cost flat regardless
// of viewer count. 30s feels live for a textile floor (shift boundaries
// are the only high-change windows) and absorbs the FE 90s poll cadence
// across multiple managers cleanly. Cache busts on every punch / mark via
// `invalidateLivePresence` (called from event creation and bulk mark).
const LIVE_PRESENCE_CACHE_TTL_SEC = 30;
const livePresenceCacheKey = (workspaceId: string): string =>
  `attendance:live-presence:${workspaceId}`;

// ── Audit timeline types (D-28, D-29, M-05 Task 2) ──────────────────────────

export type AuditItem =
  | {
      kind: 'event';
      at: Date;
      eventId: string;
      punchType: string;
      source: string;
      verifyMethod: string | null;
      by: { _id: string; name: string } | null;
      voided: boolean;
      voidReason?: string | null;
    }
  | {
      kind: 'void';
      at: Date;
      eventId: string;
      by: { _id: string; name: string } | null;
      reason: string;
    }
  | {
      kind: 'status_history';
      at: Date;
      status: string;
      by: { _id: string; name: string } | null;
    };

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);
  private readonly tracer = trace.getTracer('attendance');

  constructor(
    @InjectModel(Attendance.name) private attendanceModel: Model<Attendance>,
    @InjectModel(TeamMember.name) private teamMemberModel: Model<TeamMember>,
    @InjectModel(Salary.name) private salaryModel: Model<Salary>,
    private readonly eventService: AttendanceEventService,
    private readonly projectionService: AttendanceProjectionService,
    // Attendance hardening: shared SoD self-edit block + MEMBER_OFFBOARDED
    // write-lock (mirrors SalaryWriteGuardService). Injected so every write path
    // in this service enforces the identical rules.
    private readonly writeGuard: AttendanceWriteGuardService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
    private readonly callerScope: CallerScopeService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    // Phase 6 (member-cap read filter): appended LAST + OPTIONAL so existing
    // positional unit-test construction keeps it undefined. The org-scoped read
    // paths null-guard it, so the cap is a behaviour-preserving no-op when absent
    // (and a transparent pass-through in prod until a workspace is over cap past
    // grace — getAllowedMemberIds returns everyone otherwise).
    private readonly memberCap?: ErpMemberCapService,
  ) {}

  /**
   * Phase 6 (member-cap read filter) — intersect a set of ORG-scoped active
   * member ObjectIds with the workspace's allowed-member set (owner + oldest
   * (limit-1) by join date once over cap past grace). Returns the input
   * unchanged when the cap service is not wired (positional unit tests) or
   * resolving it fails (best-effort: a cap failure must not break the report).
   * `getAllowedMemberIds` returns everyone when unlimited / under cap / in grace,
   * so the intersection is a no-op until the cap actually bites.
   */
  private async capActiveMemberIds(
    workspaceId: string,
    activeMemberIds: Types.ObjectId[],
  ): Promise<Types.ObjectId[]> {
    if (!this.memberCap) return activeMemberIds;
    try {
      const allowed = new Set(await this.memberCap.getAllowedMemberIds(workspaceId));
      return activeMemberIds.filter((id) => allowed.has(String(id)));
    } catch (err) {
      this.logger.warn(
        `member-cap intersect failed for ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return activeMemberIds;
    }
  }

  /**
   * Phase 7 (member-cap report notice) — the 4-field cap STATUS surfaced to the
   * org-scoped attendance REPORT (getSummary) so the web can show the
   * "Showing N of TOTAL — upgrade" notice (mirrors team.service's `memberCap`
   * field on the directory list). Returns the trimmed
   * `{ capped, visibleCount, totalCount, limit }` shape Team uses (drops the
   * grace internals) — or `null` when the cap service is not wired (positional
   * unit tests) or resolving it fails (best-effort: a cap-status failure must
   * never break the report). Like Team, the status is returned regardless of
   * `capped` so the web always has the live counts; the caller attaches it only
   * on the ORG-scoped path. Cross-module: feeds ErpMemberCapService.getCapStatus.
   */
  private async memberCapStatus(
    workspaceId: string,
  ): Promise<{ capped: boolean; visibleCount: number; totalCount: number; limit: number } | null> {
    if (!this.memberCap) return null;
    try {
      const status = await this.memberCap.getCapStatus(workspaceId);
      return {
        capped: status.capped,
        visibleCount: status.visibleCount,
        totalCount: status.totalCount,
        limit: status.limit,
      };
    } catch (err) {
      this.logger.warn(
        `member-cap status resolve failed for ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Phase 6 (member-cap read filter) — the allowed-member ObjectIds for an
   * ORG-scoped attendance records read, but ONLY when the cap is actually biting
   * (over cap past grace). Returns `null` when the cap is not active (so the
   * records query is left unconstrained — a behaviour-preserving no-op) or when
   * the service is not wired / resolving it fails (best-effort). Avoids an
   * unbounded `$in` of the full roster on the common uncapped path.
   */
  private async memberCapAllowedObjectIds(workspaceId: string): Promise<Types.ObjectId[] | null> {
    if (!this.memberCap) return null;
    try {
      const status = await this.memberCap.getCapStatus(workspaceId);
      if (!status.capped) return null;
      const allowed = await this.memberCap.getAllowedMemberIds(workspaceId);
      return allowed.map((id) => new Types.ObjectId(id));
    } catch (err) {
      this.logger.warn(
        `member-cap allowed-ids resolve failed for ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Live-presence cache bust. Called by any flow that changes today's
   * attendance state — punch events, manager bulk marks, regularization
   * approvals — so the next /live-presence read reflects the change
   * within one request instead of waiting for TTL expiry.
   */
  async invalidateLivePresence(workspaceId: string): Promise<void> {
    try {
      await this.redis.del(livePresenceCacheKey(workspaceId));
    } catch (err) {
      // Cache failure is non-fatal — next reader pays the cold-fetch cost.
      this.logger.warn(`live-presence cache del failed: ${(err as Error).message}`);
    }
  }

  /**
   * Phase 5 W6.7 — wrap a handler body with an OpenTelemetry span. Mirrors
   * `TeamService.withTeamSpan` (team.service.ts:242). Empty
   * `OTEL_EXPORTER_OTLP_ENDPOINT` makes the span a safe no-op; the helper
   * still tags errors via `recordException` + sets ERROR status.
   */
  private async withAttendanceSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttributes(attributes);
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        Sentry.captureException(err, { tags: { module: 'attendance', op: name } });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Phase 5 W6.7 — fire-and-forget audit-event helper. Mirrors
   * `TeamService.auditTeamEvent`. Failure here must NEVER break the caller's
   * primary operation; swallow + Sentry-tag for follow-up.
   */
  auditAttendanceEvent(input: {
    action: string;
    workspaceId: string | Types.ObjectId;
    actorId: string | Types.ObjectId;
    memberId?: string | Types.ObjectId;
    attendanceId?: string | Types.ObjectId;
    meta?: Record<string, unknown>;
  }): void {
    const wsId = String(input.workspaceId);
    const actor = String(input.actorId);
    const member = input.memberId != null ? String(input.memberId) : undefined;
    const entityId = input.attendanceId != null ? String(input.attendanceId) : (member ?? wsId);
    void this.auditService
      .logEvent({
        workspaceId: wsId,
        module: AppModuleEnum.ATTENDANCE,
        entityType: 'attendance',
        entityId,
        teamMemberId: member,
        action: input.action,
        actorId: actor,
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for attendance event ${input.action} (workspace ${wsId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'attendance', op: `audit.${input.action}` },
          extra: { workspaceId: wsId, actorId: actor },
        });
      });
  }

  /**
   * Returns true when a Salary row exists for (wsId, memberId, month, year)
   * and is flagged isLocked. Mirrors AttendanceProjectionService.isSalaryLocked.
   * H3-05 / T-M01-05: prevents bypass of payroll lock via direct $set.
   */
  private async isSalaryLocked(
    workspaceId: string,
    memberId: string,
    date: Date,
  ): Promise<boolean> {
    const month = date.getUTCMonth() + 1;
    const year = date.getUTCFullYear();
    const salary = await this.salaryModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(memberId),
        month,
        year,
      })
      .select('isLocked')
      .lean()
      .exec();
    return !!(salary as { isLocked?: boolean } | null)?.isLocked;
  }

  /**
   * Role Taxonomy P1 (2026-05-15) — self-scope write guard.
   *
   * For an attendance write (`mark` / `edit`), if the caller's effective
   * grant on that action is `scope: 'self'`, the `targetTeamMemberId`
   * MUST equal the caller's own directory row. `all`-scoped callers and
   * owners short-circuit (`effectivePathScope` returns `'all'`). A self-scoped
   * caller with no directory row, or one targeting another member, is
   * rejected with `ForbiddenException`.
   *
   * Reads scope from live RBAC (role + overrides) via `CallerScopeService`
   * — nothing about the role set is hardcoded here.
   */
  private async assertSelfWriteAllowed(
    workspaceId: string,
    userId: string,
    action: 'mark' | 'edit',
    targetTeamMemberId: string,
  ): Promise<void> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    const scope = this.callerScope.effectivePathScope(ctx, `attendance.record.${action}`);
    if (scope !== 'self') return; // owner / all-scoped — unrestricted
    if (!ctx.teamMemberId) {
      throw new ForbiddenException(
        'Your role only permits acting on your own attendance, but your account has no team-directory record.',
      );
    }
    if (String(targetTeamMemberId) !== ctx.teamMemberId) {
      throw new ForbiddenException('Your role only permits marking your own attendance.');
    }
  }

  async getSummary(workspaceId: string, dateStr?: string) {
    return this.withAttendanceSpan('attendance.getSummary', { workspaceId }, async () => {
      const date = new Date(dateStr || new Date());
      date.setUTCHours(0, 0, 0, 0);

      // Day-of-week label used to filter members whose weeklyOff array contains today.
      // Use the UTC day index so the abbreviation lines up with the UTC-midnight
      // `date` we match on (avoids an off-by-one when the server tz is behind UTC).
      const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayOfWeek = WEEKDAY_ABBR[date.getUTCDay()];

      // PERF-02 (H6-CONTEXT D-05): project only weeklyOff + use lean() — avoids loading
      // full TeamMember documents (biometricBindings, statusHistory, ctcBreakdown, etc.)
      // just to count weekly-off members. The member query cannot be removed — weeklyOff
      // lives on the member, not on attendance (H6-RESEARCH §Pitfall 3).
      // BUGFIX: also exclude soft-deleted members and capture _id so the status
      // aggregation below can be scoped to active members only (otherwise orphan
      // rows inflate present/absent counts vs the active headcount).
      const allMembersRaw = await this.teamMemberModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          isActive: true,
          isDeleted: { $ne: true },
        })
        .select('_id weeklyOff')
        .lean<Array<{ _id: Types.ObjectId; weeklyOff?: string[] }>>()
        .exec();

      // Phase 6 (member-cap read filter) — ORG-scoped summary. getSummary is gated
      // `attendance.analytics.view` ('all') at the controller, so it is always an
      // org-wide rollup (a self-scoped worker gets /me/dashboard). Narrow the
      // member set to the allowed cap so an over-limit workspace's headcount,
      // weekly-off count, AND status aggregation all behave as if only the
      // grandfathered members exist. A no-op until the cap actually bites (and
      // when the cap service is not wired, capActiveMemberIds returns the input).
      const cappedIds = await this.capActiveMemberIds(
        workspaceId,
        allMembersRaw.map((m) => m._id),
      );
      const allowedSet = new Set(cappedIds.map((id) => String(id)));
      const allMembers = allMembersRaw.filter((m) => allowedSet.has(String(m._id)));

      const activeMemberIds = allMembers.map((m) => m._id);
      const totalMembers = allMembers.length;
      // Sunday is always a week-off (product rule), plus any per-member weeklyOff day.
      const weeklyOffCount = allMembers.filter(
        (member) =>
          dayOfWeek === 'Sun' ||
          (Array.isArray(member.weeklyOff) && member.weeklyOff.includes(dayOfWeek)),
      ).length;
      const effectiveTotal = totalMembers - weeklyOffCount;

      // PERF-02 (H6-CONTEXT D-05): count statuses in MongoDB with $group instead of
      // loading all attendance docs into Node.js heap. Backed by the new
      // { workspaceId: 1, date: 1 } index from Task 1 (IXSCAN on $match).
      // BUGFIX: scope to active members (teamMemberId $in activeMemberIds) so the
      // present/absent/etc. counts can never exceed the active headcount.
      const statusCounts = await this.attendanceModel.aggregate<{ _id: string; count: number }>([
        {
          $match: {
            workspaceId: new Types.ObjectId(workspaceId),
            date,
            teamMemberId: { $in: activeMemberIds },
          },
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]);

      // Initialise output shape — identical keys to previous implementation.
      const stats: Record<string, number> = {
        present: 0,
        absent: 0,
        half_day: 0,
        late: 0,
        on_leave: 0,
        holiday: 0,
        week_off: weeklyOffCount,
        unmarked: 0,
        total: totalMembers,
      };

      // Fold aggregation result into stats. Only overwrite keys that exist in the
      // initial shape — a stored status of 'week_off' (should not occur in practice)
      // would otherwise overwrite the member-derived weeklyOff count.
      let markedCount = 0;
      for (const row of statusCounts) {
        markedCount += row.count;
        if (row._id !== 'week_off' && stats[row._id] !== undefined) {
          stats[row._id] = row.count;
        }
      }

      stats.unmarked = Math.max(0, effectiveTotal - markedCount);

      // Phase 7 (member-cap report notice) — getSummary is the org-scoped
      // attendance ROLL-UP (gated `attendance.analytics.view` scope 'all', so a
      // self-scoped worker never reaches here — their rollup is /me/dashboard).
      // Surface the optional `memberCap` status alongside the counts so the web's
      // attendance report can show "Showing N of TOTAL — upgrade", mirroring the
      // Team directory list. Attached at the top level (sibling of `data`) so the
      // existing `data` stats shape is left untouched. Null when the cap service
      // is not wired (positional unit tests) or resolving it fails (best-effort).
      const memberCap = await this.memberCapStatus(workspaceId);

      return {
        success: true,
        data: stats,
        ...(memberCap ? { memberCap } : {}),
      };
    });
  }

  /**
   * Live presence ("who's in") board for today. Starts from the active-member
   * set (so members with no attendance record yet still appear as
   * `not_punched`), left-joins today's projected `Attendance` record and the
   * member's shift, and derives a presence bucket per member.
   */
  async getLivePresence(workspaceId: string) {
    return this.withAttendanceSpan('attendance.getLivePresence', { workspaceId }, async (span) => {
      // Cache check — every manager polling the workspace shares one
      // underlying aggregation per TTL window. Bust on punch / mark via
      // `invalidateLivePresence`. Tolerant of Redis outages: a cache miss
      // (or read error) just falls through to the cold path.
      const cacheKey = livePresenceCacheKey(workspaceId);
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          span.setAttribute('cache.hit', true);
          return JSON.parse(cached) as Awaited<
            ReturnType<AttendanceService['computeLivePresence']>
          >;
        }
      } catch (err) {
        this.logger.warn(`live-presence cache get failed: ${(err as Error).message}`);
      }
      span.setAttribute('cache.hit', false);

      const result = await this.computeLivePresence(workspaceId);

      try {
        await this.redis.setex(cacheKey, LIVE_PRESENCE_CACHE_TTL_SEC, JSON.stringify(result));
      } catch (err) {
        this.logger.warn(`live-presence cache set failed: ${(err as Error).message}`);
      }
      return result;
    });
  }

  /**
   * Cold-path live-presence aggregation. Extracted so the cached path
   * (`getLivePresence`) can serialise the result without re-entering the
   * span scope. All consumers should call `getLivePresence` — direct
   * calls bypass the cache.
   */
  private async computeLivePresence(workspaceId: string) {
    const wsOid = new Types.ObjectId(workspaceId);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'short' });

    const rows = await this.teamMemberModel.aggregate<{
      memberId: string;
      name: string;
      designation: string;
      shiftName: string;
      weeklyOff: string[];
      status?: string;
      checkIn?: Date;
      checkOut?: Date;
      workedMinutes?: number | null;
      lateMinutes?: number | null;
    }>([
      // Exclude soft-deleted members so the live "who's in" board matches the
      // active roster (consistent with getSummary / getOverview / getAttendanceGrid).
      { $match: { workspaceId: wsOid, isActive: true, isDeleted: { $ne: true } } },
      {
        $lookup: {
          from: 'attendances',
          let: { mid: '$_id' },
          pipeline: [
            {
              $match: {
                workspaceId: wsOid,
                $expr: {
                  $and: [{ $eq: ['$teamMemberId', '$$mid'] }, { $eq: ['$date', today] }],
                },
              },
            },
            {
              $project: {
                status: 1,
                checkIn: 1,
                checkOut: 1,
                workedMinutes: 1,
                lateMinutes: 1,
              },
            },
          ],
          as: 'rec',
        },
      },
      { $unwind: { path: '$rec', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'shifts',
          localField: 'shiftId',
          foreignField: '_id',
          as: 'shift',
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $unwind: { path: '$shift', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          memberId: { $toString: '$_id' },
          name: { $ifNull: ['$name', 'Unknown'] },
          designation: { $ifNull: ['$designation', ''] },
          shiftName: { $ifNull: ['$shift.name', ''] },
          weeklyOff: { $ifNull: ['$weeklyOff', []] },
          status: '$rec.status',
          checkIn: '$rec.checkIn',
          checkOut: '$rec.checkOut',
          workedMinutes: '$rec.workedMinutes',
          lateMinutes: '$rec.lateMinutes',
        },
      },
      { $sort: { name: 1 } },
    ]);

    const counts: Record<string, number> = {
      working: 0,
      done: 0,
      present: 0,
      on_leave: 0,
      absent: 0,
      not_punched: 0,
      week_off: 0,
      holiday: 0,
      late: 0,
      total: rows.length,
    };

    const members = rows.map((r) => {
      const isWeeklyOff = Array.isArray(r.weeklyOff) && r.weeklyOff.includes(dayOfWeek);
      const late = r.status === 'late';
      let presence: string;
      if (r.status === 'on_leave') presence = 'on_leave';
      else if (r.status === 'holiday') presence = 'holiday';
      else if (r.status === 'week_off') presence = 'week_off';
      else if (r.status === 'absent') presence = 'absent';
      else if (r.checkIn && r.checkOut) presence = 'done';
      else if (r.checkIn) presence = 'working';
      else if (r.status === 'present' || r.status === 'late' || r.status === 'half_day')
        presence = 'present';
      else presence = isWeeklyOff ? 'week_off' : 'not_punched';

      if (counts[presence] !== undefined) counts[presence] += 1;
      if (late) counts.late += 1;

      return {
        memberId: r.memberId,
        name: r.name,
        designation: r.designation,
        shiftName: r.shiftName,
        presence,
        late,
        checkIn: r.checkIn ?? null,
        checkOut: r.checkOut ?? null,
        workedMinutes: r.workedMinutes ?? null,
        lateMinutes: r.lateMinutes ?? null,
      };
    });

    return {
      success: true,
      data: {
        date: today.toISOString().slice(0, 10),
        generatedAt: new Date().toISOString(),
        counts,
        members,
      },
    };
  }

  /**
   * Member × day attendance grid for a month — the heatmap / muster view.
   * Members-first so members with no records still get a row; each member
   * carries a `days` map (day-of-month → cell) and a per-status `summary`.
   */
  async getAttendanceGrid(wsId: string, month: number, year: number) {
    return this.withAttendanceSpan(
      'attendance.getAttendanceGrid',
      { workspaceId: wsId, month, year },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        // BUGFIX: build the window in UTC to match the UTC-midnight stored dates
        // (the previous local-date + setUTCHours mix could drift the range and
        // drop the first/last day of the month, leaving the grid empty).
        const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
        const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

        const rows = await this.teamMemberModel.aggregate<{
          memberId: string;
          name: string;
          designation: string;
          shiftName: string;
          weeklyOff: string[];
          recs: Array<{
            date: Date;
            status: string;
            lateMinutes?: number | null;
            workedMinutes?: number | null;
          }>;
        }>([
          // Exclude soft-deleted members so the muster matches the active roster.
          { $match: { workspaceId: wsOid, isActive: true, isDeleted: { $ne: true } } },
          {
            $lookup: {
              from: 'attendances',
              let: { mid: '$_id' },
              pipeline: [
                {
                  $match: {
                    workspaceId: wsOid,
                    $expr: {
                      $and: [
                        { $eq: ['$teamMemberId', '$$mid'] },
                        { $gte: ['$date', startDate] },
                        { $lte: ['$date', endDate] },
                      ],
                    },
                  },
                },
                { $project: { date: 1, status: 1, lateMinutes: 1, workedMinutes: 1 } },
              ],
              as: 'recs',
            },
          },
          {
            $lookup: {
              from: 'shifts',
              localField: 'shiftId',
              foreignField: '_id',
              as: 'shift',
              pipeline: [{ $project: { name: 1 } }],
            },
          },
          { $unwind: { path: '$shift', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              memberId: { $toString: '$_id' },
              name: { $ifNull: ['$name', 'Unknown'] },
              designation: { $ifNull: ['$designation', ''] },
              shiftName: { $ifNull: ['$shift.name', ''] },
              // weeklyOff is needed to render week-off (WO) cells for days with
              // no attendance record (see derivation in the map below).
              weeklyOff: { $ifNull: ['$weeklyOff', []] },
              recs: 1,
            },
          },
          { $sort: { name: 1 } },
        ]);

        // Weekday abbreviation by UTC day index, matching the weeklyOff format
        // ('Sun'..'Sat') and the UTC-midnight stored dates.
        const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        const members = rows.map((r) => {
          const days: Record<
            number,
            { status: string; late: boolean; workedMinutes: number | null }
          > = {};
          const summary: Record<string, number> = {
            present: 0,
            absent: 0,
            late: 0,
            half_day: 0,
            on_leave: 0,
            holiday: 0,
            week_off: 0,
          };
          for (const rec of r.recs) {
            const dayNum = new Date(rec.date).getUTCDate();
            days[dayNum] = {
              status: rec.status,
              late: rec.status === 'late',
              workedMinutes: rec.workedMinutes ?? null,
            };
            if (summary[rec.status] !== undefined) summary[rec.status] += 1;
          }

          // Week-off fill: for every day in the month with NO explicit record,
          // mark it week_off when the weekday is Sunday (always WO per product
          // rule) or is in the member's configured weeklyOff. This makes the
          // grid show "WO" on those days instead of an empty/unmarked cell.
          const weeklyOff = Array.isArray(r.weeklyOff) ? r.weeklyOff : [];
          for (let d = 1; d <= daysInMonth; d++) {
            if (days[d]) continue; // explicit record wins over derived week-off
            const abbr = WEEKDAY_ABBR[new Date(Date.UTC(year, month - 1, d)).getUTCDay()];
            if (abbr === 'Sun' || weeklyOff.includes(abbr)) {
              days[d] = { status: 'week_off', late: false, workedMinutes: null };
              summary.week_off += 1;
            }
          }
          return {
            memberId: r.memberId,
            name: r.name,
            designation: r.designation,
            shiftName: r.shiftName,
            days,
            summary,
          };
        });

        return {
          success: true,
          data: { month, year, daysInMonth, members },
        };
      },
    );
  }

  /**
   * Overtime analytics for a month — OT *worked* visibility, never OT pay.
   * OT pay is never automatic; it enters payroll only as a manual salary
   * adjustment. This rollup surfaces how much OT is being worked, by whom,
   * on which shift / designation, and on which days — so the owner can spot
   * trends. `otMinutes` is only populated when an attendance policy has
   * `ot.enabled`, so a workspace with OT measurement off gets an all-zero
   * result (the web page renders an explanatory empty state). `byShift` /
   * `byDesignation` are folded from `byMember` in JS to keep the pipeline
   * flat. `daily` is zero-filled across every day so the trend chart is
   * continuous.
   */
  async getOvertimeAnalytics(wsId: string, month: number, year: number) {
    return this.withAttendanceSpan(
      'attendance.getOvertimeAnalytics',
      { workspaceId: wsId, month, year },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const startDate = new Date(year, month - 1, 1);
        startDate.setUTCHours(0, 0, 0, 0);
        const endDate = new Date(year, month, 0);
        endDate.setUTCHours(23, 59, 59, 999);
        const daysInMonth = new Date(year, month, 0).getDate();

        const [result] = await this.attendanceModel.aggregate<{
          totals: Array<{
            totalOtMinutes: number;
            otDays: number;
            peakDayMinutes: number;
            members: Types.ObjectId[];
          }>;
          daily: Array<{ _id: string; otMinutes: number; otDays: number }>;
          byMember: Array<{
            memberId: string;
            name: string;
            designation: string;
            shiftName: string;
            otMinutes: number;
            otDays: number;
            peakDayMinutes: number;
          }>;
        }>([
          {
            $match: {
              workspaceId: wsOid,
              date: { $gte: startDate, $lte: endDate },
              otMinutes: { $gt: 0 },
            },
          },
          {
            $facet: {
              // ── Workspace OT totals ──────────────────────────────────────────
              totals: [
                {
                  $group: {
                    _id: null,
                    totalOtMinutes: { $sum: '$otMinutes' },
                    otDays: { $sum: 1 },
                    peakDayMinutes: { $max: '$otMinutes' },
                    members: { $addToSet: '$teamMemberId' },
                  },
                },
              ],

              // ── Daily OT trend ───────────────────────────────────────────────
              daily: [
                {
                  $group: {
                    _id: {
                      $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: 'UTC' },
                    },
                    otMinutes: { $sum: '$otMinutes' },
                    otDays: { $sum: 1 },
                  },
                },
              ],

              // ── Per-member OT breakdown ──────────────────────────────────────
              byMember: [
                {
                  $group: {
                    _id: '$teamMemberId',
                    otMinutes: { $sum: '$otMinutes' },
                    otDays: { $sum: 1 },
                    peakDayMinutes: { $max: '$otMinutes' },
                  },
                },
                {
                  $lookup: {
                    from: 'teammembers',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'member',
                    pipeline: [{ $project: { name: 1, designation: 1, shiftId: 1 } }],
                  },
                },
                { $unwind: { path: '$member', preserveNullAndEmptyArrays: true } },
                {
                  $lookup: {
                    from: 'shifts',
                    localField: 'member.shiftId',
                    foreignField: '_id',
                    as: 'shift',
                    pipeline: [{ $project: { name: 1 } }],
                  },
                },
                { $unwind: { path: '$shift', preserveNullAndEmptyArrays: true } },
                {
                  $project: {
                    _id: 0,
                    memberId: { $toString: '$_id' },
                    name: { $ifNull: ['$member.name', 'Unknown'] },
                    designation: { $ifNull: ['$member.designation', ''] },
                    shiftName: { $ifNull: ['$shift.name', ''] },
                    otMinutes: 1,
                    otDays: 1,
                    peakDayMinutes: 1,
                  },
                },
                { $sort: { otMinutes: -1 } },
              ],
            },
          },
        ]);

        const totalsRow = result?.totals?.[0];
        const totalOtMinutes = totalsRow?.totalOtMinutes ?? 0;
        const otDays = totalsRow?.otDays ?? 0;
        const peakDayMinutes = totalsRow?.peakDayMinutes ?? 0;
        const membersWithOt = totalsRow?.members?.length ?? 0;
        const avgOtMinutesPerMember =
          membersWithOt > 0 ? Math.round(totalOtMinutes / membersWithOt) : 0;

        const byMember = result?.byMember ?? [];

        // Daily trend — zero-fill every calendar day for a continuous chart.
        const dailyMap = new Map<string, { otMinutes: number; otDays: number }>();
        for (const row of result?.daily ?? []) {
          dailyMap.set(row._id, { otMinutes: row.otMinutes, otDays: row.otDays });
        }
        const daily = Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const hit = dailyMap.get(key);
          return { date: key, day, otMinutes: hit?.otMinutes ?? 0, otDays: hit?.otDays ?? 0 };
        });

        // byShift / byDesignation — folded from byMember so the pipeline stays flat.
        const foldBy = (keyOf: (m: (typeof byMember)[number]) => string) => {
          const map = new Map<string, { otMinutes: number; otDays: number; members: number }>();
          for (const m of byMember) {
            const label = keyOf(m) || '—';
            const cur = map.get(label) ?? { otMinutes: 0, otDays: 0, members: 0 };
            cur.otMinutes += m.otMinutes;
            cur.otDays += m.otDays;
            cur.members += 1;
            map.set(label, cur);
          }
          return Array.from(map.entries())
            .map(([label, v]) => ({ label, ...v }))
            .sort((a, b) => b.otMinutes - a.otMinutes);
        };

        return {
          success: true,
          data: {
            month,
            year,
            daysInMonth,
            kpi: {
              totalOtMinutes,
              otDays,
              peakDayMinutes,
              membersWithOt,
              avgOtMinutesPerMember,
            },
            daily,
            byMember,
            byShift: foldBy((m) => m.shiftName),
            byDesignation: foldBy((m) => m.designation),
          },
        };
      },
    );
  }

  /**
   * Attendance-compliance report for a month — defaulters + late / absent
   * leaderboards. Members-first (a member who never punched is the worst
   * defaulter and MUST appear, so this cannot be attendance-first like
   * `getOverview`). Each member's status buckets and late minutes are folded
   * in JS from the month's `Attendance` records. `attendanceRate` is the
   * present-equivalent share of *scheduled* days (present + late + absent +
   * half-day — leave / holiday / week-off are excluded from the denominator,
   * since approved leave is not an attendance violation); it is `null` when a
   * member had no scheduled days at all. The web page applies the % threshold
   * client-side so the owner can tune it without a round-trip.
   */
  async getComplianceReport(wsId: string, month: number, year: number) {
    return this.withAttendanceSpan(
      'attendance.getComplianceReport',
      { workspaceId: wsId, month, year },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const startDate = new Date(year, month - 1, 1);
        startDate.setUTCHours(0, 0, 0, 0);
        const endDate = new Date(year, month, 0);
        endDate.setUTCHours(23, 59, 59, 999);

        const rows = await this.teamMemberModel.aggregate<{
          memberId: string;
          name: string;
          designation: string;
          shiftName: string;
          recs: Array<{ status: string; lateMinutes?: number | null }>;
        }>([
          // OQ-A7 (attendance hardening): add an explicit `isDeleted: { $ne: true }`
          // alongside `isActive: true` so the Gujarat compliance report can NEVER
          // include a removed member, defense-in-depth against any future change to
          // the removal cascade that does not set isActive=false. The defaulter-alert
          // cron consumes this report, so removed members are excluded from alerts too.
          { $match: { workspaceId: wsOid, isActive: true, isDeleted: { $ne: true } } },
          {
            $lookup: {
              from: 'attendances',
              let: { mid: '$_id' },
              pipeline: [
                {
                  $match: {
                    workspaceId: wsOid,
                    $expr: {
                      $and: [
                        { $eq: ['$teamMemberId', '$$mid'] },
                        { $gte: ['$date', startDate] },
                        { $lte: ['$date', endDate] },
                      ],
                    },
                  },
                },
                { $project: { status: 1, lateMinutes: 1 } },
              ],
              as: 'recs',
            },
          },
          {
            $lookup: {
              from: 'shifts',
              localField: 'shiftId',
              foreignField: '_id',
              as: 'shift',
              pipeline: [{ $project: { name: 1 } }],
            },
          },
          { $unwind: { path: '$shift', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              memberId: { $toString: '$_id' },
              name: { $ifNull: ['$name', 'Unknown'] },
              designation: { $ifNull: ['$designation', ''] },
              shiftName: { $ifNull: ['$shift.name', ''] },
              recs: 1,
            },
          },
          { $sort: { name: 1 } },
        ]);

        const members = rows.map((r) => {
          let present = 0;
          let late = 0;
          let absent = 0;
          let halfDay = 0;
          let onLeave = 0;
          let lateMinutes = 0;
          for (const rec of r.recs) {
            switch (rec.status) {
              case 'present':
                present += 1;
                break;
              case 'late':
                late += 1;
                lateMinutes += rec.lateMinutes ?? 0;
                break;
              case 'absent':
                absent += 1;
                break;
              case 'half_day':
                halfDay += 1;
                break;
              case 'on_leave':
                onLeave += 1;
                break;
              default:
                break;
            }
          }
          const scheduledDays = present + late + absent + halfDay;
          const presentEquivalent = present + late + halfDay * 0.5;
          const attendanceRate =
            scheduledDays > 0 ? Math.round((presentEquivalent / scheduledDays) * 100) : null;
          return {
            memberId: r.memberId,
            name: r.name,
            designation: r.designation,
            shiftName: r.shiftName,
            scheduledDays,
            present,
            late,
            absent,
            halfDay,
            onLeave,
            lateMinutes,
            attendanceRate,
          };
        });

        const rated = members.filter((m) => m.attendanceRate !== null);
        const avgAttendanceRate =
          rated.length > 0
            ? Math.round(rated.reduce((s, m) => s + (m.attendanceRate ?? 0), 0) / rated.length)
            : 0;

        return {
          success: true,
          data: {
            month,
            year,
            summary: {
              totalMembers: members.length,
              membersWithRate: rated.length,
              avgAttendanceRate,
              perfectCount: members.filter((m) => m.attendanceRate === 100).length,
              totalLateDays: members.reduce((s, m) => s + m.late, 0),
              totalAbsentDays: members.reduce((s, m) => s + m.absent, 0),
              totalLateMinutes: members.reduce((s, m) => s + m.lateMinutes, 0),
            },
            members,
          },
        };
      },
    );
  }

  /**
   * Absence-pattern analysis over a rolling lookback window (P3f). Surfaces
   * habitual / suspicious absence that a raw monthly count misses: the
   * Bradford Factor (S² × D — penalises many short spells over one long
   * absence) and a per-weekday histogram (catches Monday / Friday clustering).
   * Advisory only — never feeds pay or status. Attendance-first (matches
   * `status:'absent'`): a member with no absences in the window simply does
   * not appear, which is correct for a watch-list. A "spell" is a run of
   * consecutive calendar days — a Fri+Mon absence is two spells (strict;
   * weekend / holiday bridging is a deliberate later refinement).
   */
  async getAbsencePatterns(wsId: string, months: number) {
    return this.withAttendanceSpan(
      'attendance.getAbsencePatterns',
      { workspaceId: wsId, months },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const lookback = Math.min(Math.max(Math.trunc(months) || 6, 1), 12);
        const to = new Date();
        to.setUTCHours(23, 59, 59, 999);
        const from = new Date(to);
        from.setMonth(from.getMonth() - lookback);
        from.setUTCHours(0, 0, 0, 0);

        const rows = await this.attendanceModel.aggregate<{
          memberId: string;
          name: string;
          designation: string;
          shiftName: string;
          dates: Date[];
        }>([
          {
            $match: {
              workspaceId: wsOid,
              status: 'absent',
              date: { $gte: from, $lte: to },
            },
          },
          { $group: { _id: '$teamMemberId', dates: { $push: '$date' } } },
          {
            $lookup: {
              from: 'teammembers',
              localField: '_id',
              foreignField: '_id',
              as: 'member',
              pipeline: [{ $project: { name: 1, designation: 1, shiftId: 1 } }],
            },
          },
          { $unwind: { path: '$member', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'shifts',
              localField: 'member.shiftId',
              foreignField: '_id',
              as: 'shift',
              pipeline: [{ $project: { name: 1 } }],
            },
          },
          { $unwind: { path: '$shift', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              memberId: { $toString: '$_id' },
              name: { $ifNull: ['$member.name', 'Unknown'] },
              designation: { $ifNull: ['$member.designation', ''] },
              shiftName: { $ifNull: ['$shift.name', ''] },
              dates: 1,
            },
          },
        ]);

        const DAY_MS = 86_400_000;
        const members = rows
          .map((r) => {
            // Distinct UTC day-indices, sorted — the unique
            // (workspace, member, date) index guarantees one record per day.
            const dayIdx = r.dates
              .map((d) => Math.floor(new Date(d).getTime() / DAY_MS))
              .sort((a, b) => a - b);
            const weekday = [0, 0, 0, 0, 0, 0, 0];
            for (const d of r.dates) weekday[new Date(d).getUTCDay()] += 1;

            // Spell = run of consecutive day-indices; gap > 1 starts a new one.
            let spells = 0;
            let longestSpell = 0;
            let run = 0;
            let prev: number | null = null;
            for (const idx of dayIdx) {
              if (prev === null || idx - prev > 1) {
                spells += 1;
                run = 1;
              } else {
                run += 1;
              }
              if (run > longestSpell) longestSpell = run;
              prev = idx;
            }

            const absentDays = dayIdx.length;
            return {
              memberId: r.memberId,
              name: r.name,
              designation: r.designation,
              shiftName: r.shiftName,
              absentDays,
              spells,
              longestSpell,
              bradfordScore: spells * spells * absentDays,
              weekday,
            };
          })
          .sort((a, b) => b.bradfordScore - a.bradfordScore);

        const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
        for (const m of members) {
          for (let i = 0; i < 7; i += 1) weekdayTotals[i] += m.weekday[i];
        }

        return {
          success: true,
          data: {
            months: lookback,
            from: from.toISOString(),
            to: to.toISOString(),
            summary: {
              totalMembers: members.length,
              avgBradford:
                members.length > 0
                  ? Math.round(members.reduce((s, m) => s + m.bradfordScore, 0) / members.length)
                  : 0,
              flaggedCount: members.filter((m) => m.bradfordScore >= 125).length,
              totalSpells: members.reduce((s, m) => s + m.spells, 0),
              weekday: weekdayTotals,
            },
            members,
          },
        };
      },
    );
  }

  /**
   * Builds a string key for batched isLocked lookup: `wsId|memberId|YYYY-MM` (UTC month start).
   * Used by findAll to deduplicate salary-lock queries across rows (D-27, T-M05-06 N+1 guard).
   */
  private lockKey(wsId: string, memberId: string, date: Date): string {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(1); // month start
    return `${wsId}|${memberId}|${d.toISOString()}`;
  }

  /**
   * Decorates an array of raw attendance rows with `isLocked: boolean`.
   * Batches the salary-lock query: one DB call per unique (wsId, memberId, month/year)
   * pair — prevents N+1 reads when a daily view returns many rows (T-M05-06).
   */
  private async decorateWithLock(
    wsId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown> & { isLocked: boolean }>> {
    // 1. Collect unique (wsId, memberId, monthStart) keys
    const lockMap = new Map<string, boolean>();
    const uniqueKeys = new Set<string>();
    for (const row of rows) {
      // teamMemberId may be a populated subdocument {_id, name, mobile} or a plain ObjectId.
      // String(populatedObject) = '[object Object]' — extract _id explicitly.
      const rawId = row.teamMemberId as string | { _id?: unknown } | null | undefined;
      const memberId = rawId
        ? typeof rawId === 'string'
          ? rawId
          : String(rawId._id ?? rawId)
        : '';
      const date = new Date((row.date as string | Date) ?? new Date());
      uniqueKeys.add(this.lockKey(wsId, memberId, date));
    }

    // 2. Resolve each unique key — one isSalaryLocked call per key (via projectionService)
    await Promise.all(
      Array.from(uniqueKeys).map(async (key) => {
        const [wId, mId, monthIso] = key.split('|');
        const monthDate = new Date(monthIso);
        const locked = await this.projectionService.isSalaryLocked(wId, mId, monthDate);
        lockMap.set(key, locked);
      }),
    );

    // 3. Map isLocked onto each row
    return rows.map((row) => {
      const memberId = String(row.teamMemberId ?? (row as any)._doc?.teamMemberId ?? '');
      const date = new Date((row.date as string | Date) ?? new Date());
      const key = this.lockKey(wsId, memberId, date);
      return { ...row, isLocked: lockMap.get(key) ?? false };
    });
  }

  async findAll(workspaceId: string, userId: string, options: PaginationDto) {
    return this.withAttendanceSpan('attendance.findAll', { workspaceId, userId }, async () => {
      const baseFilter: Record<string, unknown> = {
        workspaceId: new Types.ObjectId(workspaceId),
      };

      // Role Taxonomy P1 (2026-05-15) — self-scope enforcement. A caller
      // whose effective `attendance.view` grant is `scope: 'self'` may
      // only see their own rows. We resolve the caller's effective scope
      // from the live RBAC state (role + per-member overrides) and, when
      // `self`, force `teamMemberId` to the caller's own directory row —
      // overriding any `memberId` filter they might pass in the query.
      // `'no-self-anchor'` (self-scoped caller with no TeamMember row)
      // yields an impossible filter → empty result, the correct
      // fail-closed behaviour. `all`-scoped callers + owners are
      // unaffected.
      const scopeCtx = await this.callerScope.resolve(workspaceId, userId);
      const selfAnchor = this.callerScope.selfPathFilterValue(scopeCtx, 'attendance.record.view');

      // Widen to unknown first: assigning `any` → `unknown` is exempt from
      // no-unsafe-assignment, and `unknown as T` is a genuinely necessary assertion.
      const rawFilters: unknown = options.filters;
      let cleanFilters: Record<string, unknown> = {};

      // Safely parse filters if it's a string (JSON from query param)
      if (typeof rawFilters === 'string') {
        try {
          const parsed: unknown = JSON.parse(rawFilters);
          cleanFilters = parsed as Record<string, unknown>;
        } catch {
          cleanFilters = {};
        }
      } else if (rawFilters && typeof rawFilters === 'object') {
        cleanFilters = { ...(rawFilters as Record<string, unknown>) };
      }

      if (cleanFilters.memberId) {
        // WR-02: cast to ObjectId so the filter matches the ObjectId-typed schema field
        baseFilter.teamMemberId = new Types.ObjectId(String(cleanFilters.memberId));
        delete cleanFilters.memberId;
      }

      // Handle date filter from both top-level query param and filters JSON
      const dateStr = (cleanFilters.date as string | undefined) ?? options.date;
      if (dateStr) {
        const date = new Date(dateStr);
        date.setUTCHours(0, 0, 0, 0);
        baseFilter.date = date;
        delete cleanFilters.date;
      }

      // Handle dateFrom for range queries
      if (options.dateFrom) {
        const dateFrom = new Date(options.dateFrom);
        dateFrom.setUTCHours(0, 0, 0, 0);
        const existingDateValue = baseFilter.date;
        let existingDate: Record<string, unknown> = {};
        if (
          typeof existingDateValue === 'object' &&
          existingDateValue !== null &&
          !Array.isArray(existingDateValue)
        ) {
          existingDate = existingDateValue as Record<string, unknown>;
        }
        baseFilter.date = { ...existingDate, $gte: dateFrom };
      }

      // Handle month+year for full-month range queries (monthly attendance view).
      // Only applies when no more-specific date/dateFrom filter is already set.
      if (options.month && options.year && !baseFilter.date) {
        const monthNum = parseInt(String(options.month), 10);
        const yearNum = parseInt(String(options.year), 10);
        const startDate = new Date(yearNum, monthNum - 1, 1);
        startDate.setUTCHours(0, 0, 0, 0);
        const endDate = new Date(yearNum, monthNum, 0); // day-0 of next month = last day of this month
        endDate.setUTCHours(23, 59, 59, 999);
        baseFilter.date = { $gte: startDate, $lte: endDate };
      }

      // Apply self-scope last so it overrides any caller-supplied
      // `memberId` filter — a self-scoped worker cannot widen their view
      // by passing someone else's id.
      if (selfAnchor === 'no-self-anchor') {
        baseFilter.teamMemberId = new Types.ObjectId(); // matches nothing
      } else if (selfAnchor) {
        baseFilter.teamMemberId = selfAnchor;
      } else {
        // Phase 6 (member-cap read filter) — ORG-scoped path only (`selfAnchor`
        // is null; self branches handled above). Restrict the records list to
        // the allowed member set so an over-limit workspace lists attendance
        // only for grandfathered members. capActiveMemberIds is a no-op until
        // the cap bites (returns everyone) and when the service is not wired.
        // If a specific `memberId` filter is already present, AND it with the
        // allowed set (a capped-out member yields an empty result) rather than
        // widening it.
        if (this.memberCap !== undefined) {
          const allowedIds = await this.memberCapAllowedObjectIds(workspaceId);
          if (allowedIds) {
            const existing = baseFilter.teamMemberId;
            if (existing !== undefined) {
              delete baseFilter.teamMemberId;
              const andList = Array.isArray(baseFilter.$and)
                ? (baseFilter.$and as Record<string, unknown>[])
                : [];
              andList.push({ teamMemberId: existing });
              andList.push({ teamMemberId: { $in: allowedIds } });
              baseFilter.$and = andList;
            } else {
              baseFilter.teamMemberId = { $in: allowedIds };
            }
          }
        }
      }

      const result = await QueryHelper.paginate(
        this.attendanceModel,
        baseFilter,
        { ...options, filters: cleanFilters },
        [],
        [
          { path: 'teamMemberId', select: 'name mobile' },
          { path: 'statusHistory.changedBy', select: '_id name' },
          { path: 'markedBy', select: 'name email' },
        ],
      );

      // Decorate each row with isLocked (D-27, B2): batched by unique (member, month/year)
      // to avoid N+1 salary-lock queries (T-M05-06).
      const rawRows = (result.data as unknown[]).map((doc) => {
        const d = doc as { toObject?: () => Record<string, unknown> } & Record<string, unknown>;
        return typeof d.toObject === 'function' ? d.toObject() : d;
      });
      const decorated = await this.decorateWithLock(workspaceId, rawRows);
      return { ...result, data: decorated };
    });
  }

  async mark(workspaceId: string, userId: string, dto: MarkAttendanceDto) {
    return this.withAttendanceSpan(
      'attendance.mark',
      { workspaceId, userId, memberId: dto.teamMemberId, status: dto.status },
      async () => {
        // Role Taxonomy P1 (2026-05-15) — self-scope write guard. A caller
        // whose effective `attendance.mark` grant is `scope: 'self'` may
        // only mark their OWN record. Block any attempt to mark another
        // member by passing a different `teamMemberId`. `all`-scoped
        // callers + owners pass through unchanged.
        await this.assertSelfWriteAllowed(workspaceId, userId, 'mark', dto.teamMemberId);

        // Attendance hardening: MEMBER_OFFBOARDED write-lock (OQ-A5) — a removed
        // member's muster is read-only the moment they are soft-deleted. Then the
        // SoD self-edit block (OQ-A3) — a non-owner Manager/HR cannot mark their
        // OWN attendance (conflict of interest in wage determination). Owner
        // bypasses the SoD block.
        await this.writeGuard.assertMemberWritable(workspaceId, dto.teamMemberId);
        await this.writeGuard.assertNotSelfAttendanceEdit(workspaceId, userId, dto.teamMemberId);

        const date = new Date(dto.date);
        date.setUTCHours(0, 0, 0, 0);

        // Future-date guard: attendance is a record of what happened, so it may
        // only be marked for today or a past day. Reject anything after today.
        const todayUtc = new Date();
        todayUtc.setUTCHours(0, 0, 0, 0);
        if (date.getTime() > todayUtc.getTime()) {
          throw new BadRequestException('Cannot mark attendance for a future date');
        }

        // Salary-lock guard (T-M01-05): block writes if payroll is generated for this period.
        if (await this.isSalaryLocked(workspaceId, dto.teamMemberId, date)) {
          throw new BadRequestException('Attendance is locked — payroll generated for this period');
        }

        // 1. Write STATUS_SET event FIRST (manual_override — admin click per D3).
        // Pin timestamp to the attendance date window so findByMemberDate finds it on past dates.
        // Use current ms-of-day to preserve monotonic ordering within the same day.
        const statusTimestamp = new Date(date.getTime() + (Date.now() % 86_400_000));
        await this.eventService.createEvent({
          wsId: workspaceId,
          teamMemberId: dto.teamMemberId,
          timestamp: statusTimestamp,
          punchType: 'STATUS_SET',
          statusValue: dto.status,
          source: 'manual_override',
          markedBy: userId,
          note: dto.note ?? null,
          verifyMethod: 'manual',
        });

        // 2. Handle CHECK_IN — if admin is setting times, void ALL punch events first
        //    so stale biometric events can't override the admin's explicit values.
        if (dto.checkIn) {
          await this.eventService.voidAllByPunchTypeForMemberDay(
            workspaceId,
            dto.teamMemberId,
            date,
            'CHECK_IN',
            userId,
          );
          // Also void CHECK_OUT so old biometric checkouts don't surface when
          // admin sets only check-in and leaves check-out empty.
          await this.eventService.voidAllByPunchTypeForMemberDay(
            workspaceId,
            dto.teamMemberId,
            date,
            'CHECK_OUT',
            userId,
          );
          await this.eventService.createEvent({
            wsId: workspaceId,
            teamMemberId: dto.teamMemberId,
            timestamp: new Date(dto.checkIn),
            punchType: 'CHECK_IN',
            source: 'manual_override',
            verifyMethod: 'manual',
            markedBy: userId,
            note: dto.note ?? null,
          });
        }

        // 3. Emit CHECK_OUT event if provided (re-creates after the void above).
        if (dto.checkOut) {
          if (!dto.checkIn) {
            // checkOut without checkIn — still void old CHECK_OUT events
            await this.eventService.voidAllByPunchTypeForMemberDay(
              workspaceId,
              dto.teamMemberId,
              date,
              'CHECK_OUT',
              userId,
            );
          }
          await this.eventService.createEvent({
            wsId: workspaceId,
            teamMemberId: dto.teamMemberId,
            timestamp: new Date(dto.checkOut),
            punchType: 'CHECK_OUT',
            source: 'manual_override',
            verifyMethod: 'manual',
            markedBy: userId,
            note: dto.note ?? null,
          });
        }

        // 4. Recompute projection (upserts Attendance row with new status + dominantSource).
        await this.projectionService.recompute(workspaceId, dto.teamMemberId, date);

        // 3. Also append to statusHistory + set note (preserves legacy audit trail shape).
        // Use explicit ObjectId conversion to match what recompute() stored — prevents
        // string vs ObjectId type mismatch that causes findOneAndUpdate to miss the record.
        const historyEntry = {
          status: dto.status,
          changedAt: new Date(),
          changedBy: userId,
        };
        const wsOid = new Types.ObjectId(workspaceId);
        const memOid = new Types.ObjectId(dto.teamMemberId);

        let record = await this.attendanceModel
          .findOneAndUpdate(
            { workspaceId: wsOid, teamMemberId: memOid, date },
            {
              $set: { markedBy: userId, note: dto.note },
              $push: { statusHistory: historyEntry },
            },
            { new: true, upsert: false },
          )
          .populate('statusHistory.changedBy', '_id name')
          .populate('teamMemberId', 'name mobile')
          .populate('markedBy', '_id name')
          .exec();

        // Defensive fallback: recompute created the record but the update still missed it.
        // Do a plain find to at least return the record so the frontend can display the status.
        if (!record) {
          record = await this.attendanceModel
            .findOne({ workspaceId: wsOid, teamMemberId: memOid, date })
            .populate('statusHistory.changedBy', '_id name')
            .populate('teamMemberId', 'name mobile')
            .populate('markedBy', '_id name')
            .exec();
        }

        this.auditAttendanceEvent({
          action: 'attendance.marked_attendance',
          workspaceId,
          actorId: userId,
          memberId: dto.teamMemberId,
          attendanceId: record?._id?.toString(),
          meta: {
            status: dto.status,
            date: date.toISOString(),
            hasCheckIn: !!dto.checkIn,
            hasCheckOut: !!dto.checkOut,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'attendance.marked_attendance',
          properties: {
            workspaceId,
            memberId: dto.teamMemberId,
            status: dto.status,
            source: 'manual_override',
          },
        });

        // Live-presence cache bust — manager who just marked switches to the
        // Live view sees the change immediately rather than after TTL expiry.
        await this.invalidateLivePresence(workspaceId);

        return record;
      },
    );
  }

  async markBulk(workspaceId: string, userId: string, bulkDto: BulkMarkAttendanceDto) {
    return this.withAttendanceSpan(
      'attendance.markBulk',
      { workspaceId, userId, recordCount: bulkDto.records.length },
      async () => {
        // T-M01-04: batch all events into a single insertMany round-trip.
        // T-M01-05: skip locked records instead of aborting the entire batch.
        const eventsToInsert: CreateEventInput[] = [];
        let skippedLocked = 0;
        // Future-date guard for bulk: unlike single mark (which throws), a bulk
        // run (e.g. Bulk Month over an entire month) may legitimately include
        // future days — we silently skip those instead of failing the batch.
        let skippedFuture = 0;
        // Attendance hardening: per-record offboard + SoD skip counts. A bulk run
        // must not silently mark a removed member, and a non-owner must not slip
        // their own record into a bulk run to self-mark. Both are SKIPPED (not
        // thrown) to match the existing bulk policy of skipping ineligible rows.
        let skippedOffboarded = 0;
        let skippedSelf = 0;
        const todayUtc = new Date();
        todayUtc.setUTCHours(0, 0, 0, 0);

        // Resolve the caller once: owners bypass the SoD self-skip; everyone else
        // skips their own row. One offboard probe is cached per unique member.
        const callerCtx = await this.callerScope.resolve(workspaceId, userId);
        const offboardedCache = new Map<string, boolean>();
        const isOffboarded = async (memberId: string): Promise<boolean> => {
          if (offboardedCache.has(memberId)) return offboardedCache.get(memberId);
          let blocked = false;
          try {
            await this.writeGuard.assertMemberWritable(workspaceId, memberId);
          } catch {
            blocked = true;
          }
          offboardedCache.set(memberId, blocked);
          return blocked;
        };
        const isSelfBlocked = (memberId: string): boolean =>
          !callerCtx.isOwner &&
          !!callerCtx.teamMemberId &&
          String(callerCtx.teamMemberId) === String(memberId);

        for (const record of bulkDto.records) {
          const date = new Date(record.date);
          date.setUTCHours(0, 0, 0, 0);

          if (date.getTime() > todayUtc.getTime()) {
            skippedFuture++;
            continue;
          }

          // MEMBER_OFFBOARDED (OQ-A5) + SoD self-mark (OQ-A3), per record.
          if (await isOffboarded(record.teamMemberId)) {
            skippedOffboarded++;
            continue;
          }
          if (isSelfBlocked(record.teamMemberId)) {
            skippedSelf++;
            continue;
          }

          if (await this.isSalaryLocked(workspaceId, record.teamMemberId, date)) {
            skippedLocked++;
            continue;
          }

          const bulkDayStart = new Date(date);
          bulkDayStart.setUTCHours(0, 0, 0, 0);
          const bulkStatusTimestamp = new Date(bulkDayStart.getTime() + (Date.now() % 86_400_000));
          eventsToInsert.push({
            wsId: workspaceId,
            teamMemberId: record.teamMemberId,
            timestamp: bulkStatusTimestamp,
            punchType: 'STATUS_SET',
            statusValue: record.status,
            source: 'manual_override',
            markedBy: userId,
            note: record.note ?? null,
            verifyMethod: 'manual',
          });

          if (record.checkIn) {
            eventsToInsert.push({
              wsId: workspaceId,
              teamMemberId: record.teamMemberId,
              timestamp: new Date(record.checkIn),
              punchType: 'CHECK_IN',
              source: 'manual',
              verifyMethod: 'manual',
              markedBy: userId,
              note: record.note ?? null,
            });
          }

          if (record.checkOut) {
            eventsToInsert.push({
              wsId: workspaceId,
              teamMemberId: record.teamMemberId,
              timestamp: new Date(record.checkOut),
              punchType: 'CHECK_OUT',
              source: 'manual',
              verifyMethod: 'manual',
              markedBy: userId,
              note: record.note ?? null,
            });
          }
        }

        // Single round-trip for all events (T-M01-04)
        if (eventsToInsert.length > 0) {
          await this.eventService.bulkInsertEvents(eventsToInsert);
        }

        // Recompute projection for each non-locked, non-future record + preserve statusHistory
        for (const record of bulkDto.records) {
          const date = new Date(record.date);
          date.setUTCHours(0, 0, 0, 0);

          if (date.getTime() > todayUtc.getTime()) {
            continue; // future day — already counted in skippedFuture above
          }

          // Skip the same records the first pass skipped (offboarded / SoD-self /
          // salary-locked) so we never recompute a row we deliberately did not mark.
          if (await isOffboarded(record.teamMemberId)) {
            continue;
          }
          if (isSelfBlocked(record.teamMemberId)) {
            continue;
          }

          if (await this.isSalaryLocked(workspaceId, record.teamMemberId, date)) {
            continue;
          }

          await this.projectionService.recompute(workspaceId, record.teamMemberId, date);

          // Preserve legacy statusHistory append for existing UI.
          // WR-02: wrap ids with new Types.ObjectId() to match ObjectId-typed schema
          // fields — raw strings may silently miss the filter in Mongoose 7/8+ strict mode.
          await this.attendanceModel
            .findOneAndUpdate(
              {
                workspaceId: new Types.ObjectId(workspaceId),
                teamMemberId: new Types.ObjectId(record.teamMemberId),
                date,
              },
              {
                $set: { markedBy: userId, note: record.note },
                $push: {
                  statusHistory: {
                    status: record.status,
                    changedAt: new Date(),
                    changedBy: userId,
                  },
                },
              },
              { upsert: false },
            )
            .exec();
        }

        const marked =
          bulkDto.records.length - skippedLocked - skippedFuture - skippedOffboarded - skippedSelf;

        this.auditAttendanceEvent({
          action: 'attendance.marked_bulk',
          workspaceId,
          actorId: userId,
          meta: {
            recordCount: bulkDto.records.length,
            marked,
            skippedLocked,
            skippedFuture,
            skippedOffboarded,
            skippedSelf,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'attendance.marked_bulk',
          properties: {
            workspaceId,
            recordCount: bulkDto.records.length,
            marked,
            skippedLocked,
            skippedFuture,
            skippedOffboarded,
            skippedSelf,
          },
        });

        // Live-presence cache bust — bulk mark changes today's state across
        // many members at once; ensure the next /live-presence read reflects
        // the full update rather than returning a stale aggregation.
        await this.invalidateLivePresence(workspaceId);

        return {
          message: 'Bulk attendance marked successfully',
          marked,
          skippedLocked,
          skippedFuture,
          skippedOffboarded,
          skippedSelf,
        };
      },
    );
  }

  async update(
    workspaceId: string,
    userId: string,
    recordId: string,
    updateDto: UpdateAttendanceDto,
  ) {
    return this.withAttendanceSpan(
      'attendance.update',
      { workspaceId, userId, recordId },
      async () => {
        // Look up the existing record to know (memberId, date) for the event + recompute.
        const existing = await this.attendanceModel
          .findOne({ _id: recordId, workspaceId: new Types.ObjectId(workspaceId) })
          .lean()
          .exec();
        if (!existing) throw new NotFoundException('Attendance record not found');

        // Role Taxonomy P1 (2026-05-15) — self-scope write guard. A caller
        // whose effective `attendance.edit` grant is `scope: 'self'` may
        // only edit their OWN attendance record.
        await this.assertSelfWriteAllowed(
          workspaceId,
          userId,
          'edit',
          String(existing.teamMemberId),
        );

        // Attendance hardening: MEMBER_OFFBOARDED write-lock (OQ-A5) + SoD
        // self-edit block (OQ-A3). A removed member's record is read-only; a
        // non-owner Manager/HR cannot edit their OWN record.
        await this.writeGuard.assertMemberWritable(workspaceId, String(existing.teamMemberId));
        await this.writeGuard.assertNotSelfAttendanceEdit(
          workspaceId,
          userId,
          String(existing.teamMemberId),
        );

        // Salary-lock guard (T-M01-05): block writes if payroll is generated for this period.
        const dateForLock = new Date(existing.date);
        dateForLock.setUTCHours(0, 0, 0, 0);
        if (await this.isSalaryLocked(workspaceId, String(existing.teamMemberId), dateForLock)) {
          throw new BadRequestException('Attendance is locked — payroll generated for this period');
        }

        let needsRecompute = false;

        // CHECK_IN: void all existing events whenever checkIn is in the payload (even null = clear).
        // Then create a new event only when a time was actually provided.
        // Voiding on null prevents stale device/kiosk events surfacing after a manual clear.
        if (updateDto.checkIn !== undefined) {
          await this.eventService.voidAllByPunchTypeForMemberDay(
            workspaceId,
            String(existing.teamMemberId),
            existing.date,
            'CHECK_IN',
            userId,
          );
          if (updateDto.checkIn) {
            await this.eventService.createEvent({
              wsId: workspaceId,
              teamMemberId: String(existing.teamMemberId),
              timestamp: new Date(updateDto.checkIn),
              punchType: 'CHECK_IN',
              source: 'manual_override',
              verifyMethod: 'manual',
              markedBy: userId,
              note: updateDto.note ?? null,
            });
          }
          needsRecompute = true;
        }

        // CHECK_OUT: same void-then-create pattern.
        if (updateDto.checkOut !== undefined) {
          await this.eventService.voidAllByPunchTypeForMemberDay(
            workspaceId,
            String(existing.teamMemberId),
            existing.date,
            'CHECK_OUT',
            userId,
          );
          if (updateDto.checkOut) {
            await this.eventService.createEvent({
              wsId: workspaceId,
              teamMemberId: String(existing.teamMemberId),
              timestamp: new Date(updateDto.checkOut),
              punchType: 'CHECK_OUT',
              source: 'manual_override',
              verifyMethod: 'manual',
              markedBy: userId,
              note: updateDto.note ?? null,
            });
          }
          needsRecompute = true;
        }

        // If status is changing, emit a manual_override event.
        if (updateDto.status && updateDto.status !== existing.status) {
          // Pin timestamp to attendance date window — past-date edits must fall within [dayStart, dayEnd).
          const existingDayStart = new Date(existing.date);
          existingDayStart.setUTCHours(0, 0, 0, 0);
          const updateStatusTimestamp = new Date(
            existingDayStart.getTime() + (Date.now() % 86_400_000),
          );
          await this.eventService.createEvent({
            wsId: workspaceId,
            teamMemberId: String(existing.teamMemberId),
            timestamp: updateStatusTimestamp,
            punchType: 'STATUS_SET',
            statusValue: updateDto.status,
            source: 'manual_override',
            markedBy: userId,
            note: updateDto.note ?? null,
            verifyMethod: 'manual',
          });
          needsRecompute = true;
        }

        // Trigger recompute ONCE if any time or status field changed.
        if (needsRecompute) {
          await this.projectionService.recompute(
            workspaceId,
            String(existing.teamMemberId),
            existing.date,
          );
        }

        // Build the direct $set for note + time fields.
        // checkIn/checkOut are also written directly so the document reflects
        // the admin's intent immediately — recompute is called above for the
        // event projection, but we don't depend on it for correctness here.
        const updateOp: Record<string, unknown> = {};
        const setFields: Record<string, unknown> = { ...updateDto };
        delete setFields.status;

        // Convert time strings to Date objects; explicit null clears the field.
        // Only include in $set when the key was actually present in the payload
        // (undefined means the field was not sent — leave it untouched).
        if (setFields.checkIn !== undefined) {
          setFields.checkIn = setFields.checkIn ? new Date(setFields.checkIn as string) : null;
        } else {
          delete setFields.checkIn;
        }
        if (setFields.checkOut !== undefined) {
          setFields.checkOut = setFields.checkOut ? new Date(setFields.checkOut as string) : null;
        } else {
          delete setFields.checkOut;
        }

        if (Object.keys(setFields).length > 0) updateOp.$set = setFields;
        if (updateDto.status) {
          updateOp.$push = {
            statusHistory: {
              status: updateDto.status,
              changedAt: new Date(),
              changedBy: userId,
            },
          };
        }

        // Only call findOneAndUpdate when there is something to update (note, statusHistory).
        // An empty updateOp {} would throw "The update {} is not valid" in MongoDB 4+.
        // When nothing needs direct updating (time-only changes go through recompute above),
        // just find the current document which already has the recomputed checkIn/checkOut.
        const filter = { _id: recordId, workspaceId: new Types.ObjectId(workspaceId) };
        const populate = [
          { path: 'statusHistory.changedBy', select: '_id name' },
          { path: 'teamMemberId', select: 'name mobile' },
          { path: 'markedBy', select: '_id name' },
        ] as const;

        let record;
        if (Object.keys(updateOp).length > 0) {
          record = await this.attendanceModel
            .findOneAndUpdate(filter, updateOp, { new: true })
            .populate(populate[0].path, populate[0].select)
            .populate(populate[1].path, populate[1].select)
            .populate(populate[2].path, populate[2].select)
            .exec();
        } else {
          record = await this.attendanceModel
            .findOne(filter)
            .populate(populate[0].path, populate[0].select)
            .populate(populate[1].path, populate[1].select)
            .populate(populate[2].path, populate[2].select)
            .exec();
        }

        if (!record) throw new NotFoundException('Attendance record not found');

        this.auditAttendanceEvent({
          action: 'attendance.updated_record',
          workspaceId,
          actorId: userId,
          memberId: String(existing.teamMemberId),
          attendanceId: recordId,
          meta: {
            statusChanged: !!(updateDto.status && updateDto.status !== existing.status),
            checkInTouched: updateDto.checkIn !== undefined,
            checkOutTouched: updateDto.checkOut !== undefined,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'attendance.updated_record',
          properties: {
            workspaceId,
            memberId: String(existing.teamMemberId),
            recordId,
            statusChanged: !!(updateDto.status && updateDto.status !== existing.status),
          },
        });

        return record;
      },
    );
  }

  /**
   * Sanitize a CSV cell value to prevent CSV injection (formula injection).
   * Prefixes formula-trigger characters with a single quote so spreadsheet
   * applications treat them as plain text rather than executing formulas.
   */
  private sanitizeCsvCell(value: string): string {
    const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];
    if (FORMULA_TRIGGERS.some((c) => value.startsWith(c))) {
      return `'${value}`;
    }
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  async export(workspaceId: string, month: string, year: string, userId?: string) {
    return this.withAttendanceSpan(
      'attendance.export',
      { workspaceId, month, year, userId: userId ?? 'unknown' },
      async () => {
        const monthNum = parseInt(month, 10);
        const yearNum = parseInt(year, 10);

        // Get date range for the month
        const startDate = new Date(yearNum, monthNum - 1, 1);
        startDate.setUTCHours(0, 0, 0, 0);
        const endDate = new Date(yearNum, monthNum, 0);
        endDate.setUTCHours(23, 59, 59, 999);

        const wsOid = new Types.ObjectId(workspaceId);

        // Fetch all team members
        const members = await this.teamMemberModel
          .find({ workspaceId: wsOid, isActive: true })
          .select('name designation')
          .lean();

        // Fetch all attendance records for the month
        const records = await this.attendanceModel
          .find({
            workspaceId: wsOid,
            date: { $gte: startDate, $lte: endDate },
          })
          .populate('teamMemberId', 'name')
          .lean();

        // Create a map: memberId -> date -> record
        const recordMap = new Map<string, Map<string, unknown>>();
        records.forEach((record) => {
          const rawId: unknown = record.teamMemberId;
          const populatedRef = rawId as { _id?: { toString(): string } };
          const memberId =
            typeof rawId === 'string'
              ? rawId
              : (populatedRef._id?.toString() ??
                (typeof rawId === 'object' && rawId !== null ? JSON.stringify(rawId) : 'unknown'));
          if (!recordMap.has(memberId)) {
            recordMap.set(memberId, new Map());
          }
          const dateKey = record.date.toISOString().slice(0, 10);
          recordMap.get(memberId).set(dateKey, record);
        });

        // Generate CSV rows
        const csvRows: string[] = [];
        csvRows.push('Name,Designation,Date,Status,Check In,Check Out,Note');

        const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
        for (let day = 1; day <= daysInMonth; day++) {
          const dateKey = `${yearNum}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

          members.forEach((member) => {
            const memberId = String(member._id);
            const memberRecords = recordMap.get(memberId);
            const record = memberRecords?.get(dateKey) as Record<string, unknown> | undefined;

            const name = member.name || 'N/A';
            const designation = member.designation || 'N/A';
            const status = (record?.status as string) || 'unmarked';
            const checkIn = record?.checkIn
              ? new Date(record.checkIn as Date).toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';
            const checkOut = record?.checkOut
              ? new Date(record.checkOut as Date).toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';
            const note = record?.note ? `"${(record.note as string).replace(/"/g, '""')}"` : '';

            csvRows.push(
              `${this.sanitizeCsvCell(name)},${this.sanitizeCsvCell(designation)},${dateKey},${this.sanitizeCsvCell(status)},${checkIn},${checkOut},${note}`,
            );
          });
        }

        const csvContent = csvRows.join('\n');

        if (userId) {
          this.auditAttendanceEvent({
            action: 'attendance.exported_report',
            workspaceId,
            actorId: userId,
            meta: {
              month: monthNum,
              year: yearNum,
              memberCount: members.length,
              recordCount: records.length,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'attendance.exported_report',
            properties: {
              workspaceId,
              month: monthNum,
              year: yearNum,
              memberCount: members.length,
            },
          });
        }

        // Return CSV content (in production, upload to S3 and return URL)
        return {
          success: true,
          data: csvContent,
          format: 'csv',
          filename: `attendance_${month}_${year}.csv`,
        };
      },
    );
  }

  async getUpcomingLeaves(workspaceId: string, from: string, to: string) {
    return this.withAttendanceSpan('attendance.getUpcomingLeaves', { workspaceId }, async () => {
      const fromDate = new Date(from);
      fromDate.setUTCHours(0, 0, 0, 0);
      const toDate = new Date(to);
      toDate.setUTCHours(23, 59, 59, 999);

      const records = await this.attendanceModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          status: 'on_leave',
          date: { $gte: fromDate, $lte: toDate },
        })
        .populate('teamMemberId', 'name')
        .sort({ date: 1 })
        .lean();

      // Aggregate by member — collect all their leave dates in range
      const memberMap = new Map<string, { memberId: string; memberName: string; dates: Date[] }>();

      records.forEach((record) => {
        const raw = record.teamMemberId as string | { _id: { toString(): string }; name?: string };
        const memberId = typeof raw === 'string' ? raw : raw._id.toString();
        const memberName = typeof raw === 'string' ? 'Unknown' : (raw.name ?? 'Unknown');

        if (!memberMap.has(memberId)) {
          memberMap.set(memberId, { memberId, memberName, dates: [] });
        }
        memberMap.get(memberId).dates.push(record.date);
      });

      const data = Array.from(memberMap.values()).map((entry) => ({
        memberId: entry.memberId,
        memberName: entry.memberName,
        firstDate: entry.dates[0].toISOString().slice(0, 10),
        lastDate: entry.dates[entry.dates.length - 1].toISOString().slice(0, 10),
        totalDays: entry.dates.length,
      }));

      return { success: true, data };
    });
  }

  async remove(workspaceId: string, memberId: string, date: string, userId?: string) {
    return this.withAttendanceSpan(
      'attendance.remove',
      { workspaceId, memberId, date, userId: userId ?? 'unknown' },
      async () => {
        // Attendance hardening: MEMBER_OFFBOARDED write-lock (OQ-A5) — a removed
        // member's muster cannot be deleted. SoD self-delete block (OQ-A3) — a
        // non-owner cannot delete their OWN attendance. Both run before any event
        // emission or deletion so a blocked caller mutates nothing.
        await this.writeGuard.assertMemberWritable(workspaceId, memberId);
        if (userId) {
          await this.writeGuard.assertNotSelfAttendanceEdit(workspaceId, userId, memberId);
        }

        const dateObj = new Date(date);
        dateObj.setUTCHours(0, 0, 0, 0);

        // Audit event for the deletion.
        await this.eventService.createEvent({
          wsId: workspaceId,
          teamMemberId: memberId,
          timestamp: new Date(),
          punchType: 'STATUS_SET',
          statusValue: null, // null signals deletion intent; projection ignores null
          source: 'manual_override',
          markedBy: userId ?? null,
          note: 'Record removed',
          verifyMethod: 'manual',
        });

        // WR-02: wrap ids with new Types.ObjectId() to ensure exact filter match
        // against ObjectId-typed schema fields.
        await this.attendanceModel
          .deleteOne({
            workspaceId: new Types.ObjectId(workspaceId),
            teamMemberId: new Types.ObjectId(memberId),
            date: dateObj,
          })
          .exec();

        if (userId) {
          this.auditAttendanceEvent({
            action: 'attendance.removed_record',
            workspaceId,
            actorId: userId,
            memberId,
            meta: { date: dateObj.toISOString() },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'attendance.removed_record',
            properties: {
              workspaceId,
              memberId,
              date: dateObj.toISOString(),
            },
          });
        }

        return { message: 'Attendance record removed successfully' };
      },
    );
  }

  /** Sessions with a checkIn but no checkOut that are older than yesterday (stale overnight). */
  async findStaleSessions(workspaceId: string) {
    return this.withAttendanceSpan('attendance.findStaleSessions', { workspaceId }, async () => {
      const cutoff = new Date();
      cutoff.setUTCHours(0, 0, 0, 0);
      cutoff.setUTCDate(cutoff.getUTCDate() - 1); // strictly before yesterday midnight

      const records = await this.attendanceModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          checkIn: { $ne: null },
          checkOut: null,
          date: { $lt: cutoff },
        })
        .populate('teamMemberId', 'name designation')
        .lean()
        .exec();

      return records.map((r: any) => ({
        _id: String(r._id),
        memberId: String(r.teamMemberId?._id ?? r.teamMemberId),
        memberName: r.teamMemberId?.name ?? 'Unknown',
        date: (r.date as Date)?.toISOString().slice(0, 10),
        checkIn: (r.checkIn as Date)?.toISOString(),
      }));
    });
  }

  /**
   * Returns pre-aggregated monthly overview data for the Overview page.
   * Single $facet query: KPI totals + daily trend + per-member breakdown.
   * Avoids sending thousands of raw records to the frontend.
   */
  async getOverview(wsId: string, month: number, year: number) {
    return this.withAttendanceSpan(
      'attendance.getOverview',
      { workspaceId: wsId, month, year },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        // BUGFIX: build the month window from UTC so it lines up with the
        // UTC-midnight stored dates. `new Date(year, month-1, 1)` builds a
        // LOCAL-tz date; combined with setUTCHours it could drift the window and
        // drop boundary days. Date.UTC keeps the range exact.
        const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
        const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

        // BUGFIX ("102 members" for a 50-person team): scope the aggregation to
        // ACTIVE, non-deleted members. Without this, attendance rows belonging to
        // inactive/deleted/orphan members were grouped into the members facet and
        // summed into the KPI totals, inflating both the headcount and the rates.
        const activeMemberIds = (
          await this.teamMemberModel
            .find({ workspaceId: wsOid, isActive: true, isDeleted: { $ne: true } })
            .select('_id')
            .lean<Array<{ _id: Types.ObjectId }>>()
        ).map((m) => m._id);

        const [result] = await this.attendanceModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              date: { $gte: startDate, $lte: endDate },
              teamMemberId: { $in: activeMemberIds },
            },
          },
          {
            $facet: {
              // ── KPI totals ────────────────────────────────────────────────────
              totals: [
                {
                  $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    workedMinutes: { $sum: { $ifNull: ['$workedMinutes', 0] } },
                  },
                },
              ],

              // ── Daily trend ───────────────────────────────────────────────────
              daily: [
                {
                  $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: 'UTC' } },
                    present: {
                      $sum: {
                        $cond: [{ $in: ['$status', ['present', 'late']] }, 1, 0],
                      },
                    },
                    late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
                    absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
                  },
                },
                { $sort: { _id: 1 } },
              ],

              // ── Per-member breakdown ──────────────────────────────────────────
              members: [
                {
                  $group: {
                    _id: '$teamMemberId',
                    workingDays: { $sum: 1 },
                    present: { $sum: { $cond: [{ $in: ['$status', ['present', 'late']] }, 1, 0] } },
                    late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
                    absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
                    halfDay: { $sum: { $cond: [{ $eq: ['$status', 'half_day'] }, 1, 0] } },
                    onLeave: { $sum: { $cond: [{ $eq: ['$status', 'on_leave'] }, 1, 0] } },
                    totalWorkedMinutes: { $sum: { $ifNull: ['$workedMinutes', 0] } },
                  },
                },
                {
                  $lookup: {
                    from: 'teammembers',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'member',
                    pipeline: [
                      {
                        $project: {
                          name: 1,
                          designation: 1,
                          shiftId: 1,
                        },
                      },
                    ],
                  },
                },
                { $unwind: { path: '$member', preserveNullAndEmptyArrays: true } },
                {
                  $lookup: {
                    from: 'shifts',
                    localField: 'member.shiftId',
                    foreignField: '_id',
                    as: 'shift',
                    pipeline: [{ $project: { name: 1 } }],
                  },
                },
                { $unwind: { path: '$shift', preserveNullAndEmptyArrays: true } },
                {
                  $addFields: {
                    rate: {
                      $cond: [
                        { $gt: ['$workingDays', 0] },
                        {
                          $round: [
                            { $multiply: [{ $divide: ['$present', '$workingDays'] }, 100] },
                            0,
                          ],
                        },
                        0,
                      ],
                    },
                    name: { $ifNull: ['$member.name', 'Unknown'] },
                    designation: { $ifNull: ['$member.designation', ''] },
                    shiftName: { $ifNull: ['$shift.name', ''] },
                  },
                },
                { $sort: { rate: -1, name: 1 } },
                {
                  $project: {
                    memberId: { $toString: '$_id' },
                    name: 1,
                    designation: 1,
                    shiftName: 1,
                    workingDays: 1,
                    present: 1,
                    late: 1,
                    absent: 1,
                    halfDay: 1,
                    onLeave: 1,
                    totalWorkedMinutes: 1,
                    rate: 1,
                  },
                },
              ],
            },
          },
        ]);

        if (!result) {
          return { totals: [], daily: [], members: [] };
        }

        // ── Shape KPIs from totals array ──────────────────────────────────────────
        const statusMap: Record<string, { count: number; workedMinutes: number }> = {};
        for (const row of result.totals as Array<{
          _id: string;
          count: number;
          workedMinutes: number;
        }>) {
          statusMap[row._id] = { count: row.count, workedMinutes: row.workedMinutes };
        }

        const presentDays = (statusMap.present?.count ?? 0) + (statusMap.late?.count ?? 0);
        const lateDays = statusMap.late?.count ?? 0;
        const absentDays = statusMap.absent?.count ?? 0;
        const halfDays = statusMap.half_day?.count ?? 0;
        const leaveDays = statusMap.on_leave?.count ?? 0;
        const totalDays = presentDays + absentDays + halfDays + leaveDays;
        const totalWorkedMinutes = Object.values(statusMap).reduce(
          (s, v) => s + v.workedMinutes,
          0,
        );

        const avgAttendanceRate = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;
        const onTimeRate =
          presentDays > 0 ? Math.round(((presentDays - lateDays) / presentDays) * 100) : 0;

        return {
          kpi: {
            totalDays,
            presentDays,
            lateDays,
            absentDays,
            halfDays,
            leaveDays,
            totalWorkedMinutes,
            avgAttendanceRate,
            onTimeRate,
          },
          daily: result.daily as Array<{
            _id: string;
            present: number;
            late: number;
            absent: number;
          }>,
          members: result.members as Array<{
            memberId: string;
            name: string;
            designation: string;
            shiftName: string;
            workingDays: number;
            present: number;
            late: number;
            absent: number;
            halfDay: number;
            onLeave: number;
            totalWorkedMinutes: number;
            rate: number;
          }>,
        };
      },
    );
  }

  /**
   * Returns a merged, chronologically-sorted audit timeline for a single attendance record.
   * Merges: AttendanceEvents (including voided), synthetic void items, and statusHistory entries.
   *
   * Security: filter uses BOTH _id AND workspaceId — prevents cross-workspace lookup
   * via guessed attendanceId (T-M05-01).
   * includeVoided: true — audit view must show all events, including voided ones (D-28, D-29).
   */
  async getAuditTimeline(wsId: string, attendanceId: string): Promise<AuditItem[]> {
    return this.withAttendanceSpan(
      'attendance.getAuditTimeline',
      { workspaceId: wsId, attendanceId },
      async () => {
        const att = await this.attendanceModel
          .findOne({
            _id: new Types.ObjectId(attendanceId),
            workspaceId: new Types.ObjectId(wsId),
          })
          .populate('statusHistory.changedBy', '_id name')
          .lean()
          .exec();
        if (!att) throw new NotFoundException('Attendance record not found');

        // Fetch all events including voided ones (includeVoided: true from M-01 Task 1).
        const events = await this.eventService.findByMemberDate(
          wsId,
          String(att.teamMemberId),
          att.date,
          true, // includeVoided: true
        );

        const items: AuditItem[] = [];

        for (const e of events) {
          // Resolve markedBy display name — lean() returns ObjectId or null when not populated.
          // findByMemberDate uses lean() so markedBy is a raw ObjectId; resolve to '(system)' label.
          const markedByRef = (e as any).markedBy;
          const byUser: { _id: string; name: string } | null = markedByRef
            ? typeof markedByRef === 'object' && 'name' in markedByRef
              ? { _id: String(markedByRef._id ?? markedByRef), name: String(markedByRef.name) }
              : { _id: String(markedByRef), name: '(system)' }
            : null;

          items.push({
            kind: 'event',
            at: new Date(e.timestamp),
            eventId: String((e as any)._id),
            punchType: e.punchType,
            source: e.source,
            verifyMethod: e.verifyMethod ?? null,
            by: byUser,
            voided: !!(e as any).voidedAt,
            voidReason: (e as any).voidReason ?? null,
          });

          // Synthetic 'void' item — appears as a separate timeline entry at voidedAt (D-28).
          if ((e as any).voidedAt) {
            const voidedByRef = (e as any).voidedBy;
            const voidedBy: { _id: string; name: string } | null = voidedByRef
              ? typeof voidedByRef === 'object' && 'name' in voidedByRef
                ? { _id: String(voidedByRef._id ?? voidedByRef), name: String(voidedByRef.name) }
                : { _id: String(voidedByRef), name: '(deleted)' }
              : null;

            items.push({
              kind: 'void',
              at: new Date((e as any).voidedAt),
              eventId: String((e as any)._id),
              by: voidedBy,
              reason: String((e as any).voidReason ?? ''),
            });
          }
        }

        for (const sh of att.statusHistory ?? []) {
          const changedByRef = sh.changedBy as unknown;
          const shBy: { _id: string; name: string } | null = changedByRef
            ? typeof changedByRef === 'object' && changedByRef !== null && 'name' in changedByRef
              ? {
                  _id: String((changedByRef as any)._id ?? changedByRef),
                  name: String((changedByRef as any).name ?? '(deleted)'),
                }
              : { _id: String(changedByRef), name: '(deleted)' }
            : null;

          items.push({
            kind: 'status_history',
            at: new Date(sh.changedAt),
            status: sh.status,
            by: shBy,
          });
        }

        // Sort ascending by timestamp (D-28: chronological order).
        items.sort((a, b) => a.at.getTime() - b.at.getTime());
        return items;
      },
    );
  }
}
