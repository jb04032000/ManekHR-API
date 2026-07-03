import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Attendance } from './schemas/attendance.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Shift } from '../shifts/schemas/shift.schema';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { dayBucket, minuteBucket } from '../../common/scheduler/period-key';
import { AttendanceEventService } from './attendance-event.service';
import { AttendanceProjectionService } from './attendance-projection.service';
import { HolidaysService } from '../holidays/holidays.service';

@Injectable()
export class AutoPresentCron {
  private readonly logger = new Logger(AutoPresentCron.name);

  constructor(
    @InjectModel(Attendance.name) private attendanceModel: Model<Attendance>,
    @InjectModel(TeamMember.name) private teamMemberModel: Model<TeamMember>,
    @InjectModel(Shift.name) private shiftModel: Model<Shift>,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
    @InjectModel(Workspace.name) private workspaceModel: Model<Workspace>,
    private readonly eventService: AttendanceEventService,
    private readonly projectionService: AttendanceProjectionService,
    private readonly singleFlight: SingleFlightService,
    // (B) holiday-aware auto-mark: resolve declared holidays per workspace/day.
    private readonly holidaysService: HolidaysService,
  ) {}

  /**
   * CRON CONTRACT - Attendance auto-present
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per 15-min bucket. See docs/architecture/scheduler-contract.md.
   * Schedule:    every 15 minutes (UTC); per-timezone window match marks members
   *              present as their shift starts (auto_present entitlement only).
   * Idempotent:  YES (predicate) - before marking, it loads existing attendance for
   *              the local date and skips any member already present
   *              (existingMemberIds guard), and the event store is the source of
   *              truth. A re-run within the same tick marks nobody twice. Tier B.
   * Precedence:  (B) existing manual/leave/present row (any status already written —
   *              skipped by existingMemberIds, so a manual_override or approved leave
   *              always wins) > week_off (weeklyOff members filtered out before
   *              marking; they keep week_off and are NOT double-classified as holiday)
   *              > declared holiday (auto_cron STATUS_SET 'holiday') > present
   *              (auto_cron STATUS_SET 'present'). The holiday lookup runs ONCE per
   *              workspace per tick (resolveHolidayWorkspaces), never per member.
   * Reads:       subscriptions, workspaces, shifts, team_members, attendance, holidays
   * Writes:      attendance events (STATUS_SET present|holiday) + attendance projection +
   *              autoMarked/statusHistory on the Attendance row
   * Missed run:  A skipped tick means members whose shift started in that 15-min
   *              window are not auto-marked until they punch or are marked manually
   *              (no catch-up; the window has passed).
   * Owner:       attendance
   */
  @Cron(CRON_SCHEDULES.EVERY_15_MINUTES, {
    timeZone: CRON_TIMEZONES.UTC,
    name: CronJobKey.AUTO_PRESENT,
  })
  async handleCron(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.AUTO_PRESENT, minuteBucket(), () =>
      this.processAutoPresent(),
    );
  }

  private async processAutoPresent(): Promise<void> {
    this.logger.log('Running auto-present cron job...');

    const now = new Date();

    try {
      const subscriptions = await this.subscriptionModel
        .find({
          $or: [
            { status: { $in: ['active', 'trial'] } },
            { status: 'cancelled', currentPeriodEnd: { $gt: now } },
          ],
          'appliedEntitlements.moduleAccess': {
            $elemMatch: {
              module: 'attendance',
              enabled: true,
              subFeatures: {
                $elemMatch: { key: 'auto_present', access: { $ne: 'locked' } },
              },
            },
          },
        })
        .select('userId');

      if (subscriptions.length === 0) {
        this.logger.log('No subscriptions with auto_present feature enabled');
        return;
      }

      const userIds = subscriptions.map((s) => s.userId);

      const workspaces = await this.workspaceModel
        .find({
          ownerId: { $in: userIds },
          isActive: true,
        })
        .select('_id timezone');

      if (workspaces.length === 0) {
        this.logger.log('No active workspaces found');
        return;
      }

      const workspacesByTimezone: Record<string, typeof workspaces> = {};
      for (const ws of workspaces) {
        const tz = ws.timezone || 'Asia/Kolkata';
        if (!workspacesByTimezone[tz]) {
          workspacesByTimezone[tz] = [];
        }
        workspacesByTimezone[tz].push(ws);
      }

      for (const [timezone, tzWorkspaces] of Object.entries(workspacesByTimezone)) {
        try {
          await this.processTimezoneGroup(timezone, tzWorkspaces as any[], now);
        } catch (err) {
          this.logger.error(`Failed processing timezone group ${timezone}`, err);
        }
      }

      this.logger.log('Auto-present cron job completed');
    } catch (error) {
      this.logger.error('Auto-present cron job failed:', error?.message);
    }
  }

  private async processTimezoneGroup(timezone: string, workspaces: Workspace[], now: Date) {
    const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const hours = localTime.getHours();
    const minutes = localTime.getMinutes();

    const windowEndMinutes = hours * 60 + minutes;
    const windowStartMinutes = windowEndMinutes - 15;

    const formatMinutes = (mins: number): string => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    let startTimeMin: string;
    let startTimeMax: string;

    if (windowStartMinutes < 0) {
      startTimeMin = formatMinutes(1440 + windowStartMinutes);
      startTimeMax = formatMinutes(windowEndMinutes);
    } else {
      startTimeMin = formatMinutes(windowStartMinutes);
      startTimeMax = formatMinutes(windowEndMinutes);
    }

    const dayOfWeek = localTime.getDay();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = dayNames[dayOfWeek];

    const localDate = new Date(localTime.toISOString().split('T')[0] + 'T00:00:00');

    const workspaceIds = workspaces.map((w) => w._id);

    const shifts = await this.shiftModel
      .find({
        workspaceId: { $in: workspaceIds },
        workingDays: { $in: [dayOfWeek] },
      })
      .lean();

    if (shifts.length === 0) {
      return;
    }

    // Window match is done inline below via Array.filter; the prior shiftIds /
    // shiftStartTimes / shiftStartTimeQuery locals were dead (never read) and were
    // removed when this file was touched for the scheduler-hardening pass.
    const matchingShifts = shifts.filter((s) => {
      if (windowStartMinutes < 0) {
        return s.startTime >= startTimeMin || s.startTime < startTimeMax;
      }
      return s.startTime >= startTimeMin && s.startTime < startTimeMax;
    });

    if (matchingShifts.length === 0) {
      return;
    }

    const matchingShiftIds = matchingShifts.map((s) => s._id);

    const teamMembers = await this.teamMemberModel
      .find({
        workspaceId: { $in: workspaceIds },
        isActive: true,
        isDeleted: { $ne: true },
        $or: [{ shiftId: { $in: matchingShiftIds } }, { scheduleType: 'custom' }],
      })
      .lean();

    if (teamMembers.length === 0) {
      return;
    }

    const membersToMark: {
      teamMemberId: any;
      workspaceId: any;
      shiftStartTime: string;
    }[] = [];

    for (const member of teamMembers) {
      let shouldMark = false;
      let shiftStartTime: string | undefined;

      if (member.scheduleType === 'custom' && member.customSchedule?.startTime) {
        shiftStartTime = member.customSchedule.startTime;

        if (windowStartMinutes < 0) {
          shouldMark = shiftStartTime >= startTimeMin || shiftStartTime < startTimeMax;
        } else {
          shouldMark = shiftStartTime >= startTimeMin && shiftStartTime < startTimeMax;
        }
      } else if (member.shiftId) {
        const memberShift = matchingShifts.find(
          (s) => s._id.toString() === member.shiftId?.toString(),
        );
        if (memberShift) {
          shiftStartTime = memberShift.startTime;
          shouldMark = true;
        }
      }

      if (shouldMark && shiftStartTime) {
        const isWeeklyOff = member.weeklyOff?.includes(dayName);
        if (!isWeeklyOff) {
          membersToMark.push({
            teamMemberId: member._id,
            workspaceId: member.workspaceId,
            shiftStartTime,
          });
        }
      }
    }

    if (membersToMark.length === 0) {
      return;
    }

    const existingAttendance = await this.attendanceModel
      .find({
        workspaceId: { $in: workspaceIds },
        teamMemberId: { $in: membersToMark.map((m) => m.teamMemberId) },
        date: localDate,
      })
      .lean();

    const existingMemberIds = new Set(existingAttendance.map((a) => a.teamMemberId.toString()));

    // (B) Resolve declared holidays ONCE per workspace for this local date — not
    // per member. Only the workspaces that actually have unmarked members to mark
    // are queried, so the holiday lookup stays O(#workspaces) per tick. The result
    // map is workspaceId -> isHoliday(localDate).
    const holidayByWorkspace = await this.resolveHolidayWorkspaces(
      membersToMark
        .filter((m) => !existingMemberIds.has(m.teamMemberId.toString()))
        .map((m) => String(m.workspaceId)),
      localDate,
    );

    // NEW: event-first loop replacing the old newRecords + bulkWrite block.
    const cronRunId = `autopresent-${now.toISOString()}`;
    let markedCount = 0;

    for (const m of membersToMark) {
      if (existingMemberIds.has(m.teamMemberId.toString())) continue;

      // (B) If this member's workspace has declared localDate a holiday, auto-mark
      // 'holiday' instead of 'present'. Week-off members never reach here (filtered
      // out above), so this never double-classifies a week_off as holiday. Salary
      // excludes BOTH holiday and week_off from payable days, so the distinction is
      // purely informational — but we keep them separate to avoid clobbering the
      // week_off classification. A later manual_override / approved leave still wins
      // because it carries a higher source priority on its own STATUS_SET event.
      const isHoliday = holidayByWorkspace.get(String(m.workspaceId)) === true;
      const statusValue = isHoliday ? 'holiday' : 'present';

      await this.eventService.createEvent({
        wsId: String(m.workspaceId),
        teamMemberId: String(m.teamMemberId),
        timestamp: now,
        punchType: 'STATUS_SET',
        statusValue,
        source: 'auto_cron',
        sourceMeta: { cronRunId, shiftStartTime: m.shiftStartTime, isHoliday },
        verifyMethod: 'auto',
      });
      await this.projectionService.recompute(
        String(m.workspaceId),
        String(m.teamMemberId),
        localDate,
      );
      markedCount += 1;

      // Preserve autoMarked + statusHistory flag on the Attendance row for existing UI.
      await this.attendanceModel
        .updateOne(
          {
            workspaceId: m.workspaceId,
            teamMemberId: m.teamMemberId,
            date: localDate,
          },
          {
            $set: { autoMarked: true },
            $push: {
              statusHistory: {
                status: statusValue,
                changedAt: now,
                changedBy: null,
              },
            },
          },
        )
        .exec();
    }

    if (markedCount > 0) {
      this.logger.log(
        `Auto-marked ${markedCount} attendance records for timezone ${timezone} via event store`,
      );
    }
  }

  /**
   * (B) Resolve whether `localDate` is a declared holiday for each distinct
   * workspace in `workspaceIds`. One HolidaysService.isHolidayOn call per distinct
   * workspace (deduped) — the marking loop reads from the returned map so the
   * holiday lookup is O(#workspaces), never O(#members). A lookup failure for one
   * workspace defaults to "not a holiday" (false) so a transient holidays-collection
   * error degrades to normal present-marking rather than aborting the whole tick.
   */
  private async resolveHolidayWorkspaces(
    workspaceIds: string[],
    localDate: Date,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    const distinct = [...new Set(workspaceIds)];
    await Promise.all(
      distinct.map(async (wsId) => {
        try {
          result.set(wsId, await this.holidaysService.isHolidayOn(wsId, localDate));
        } catch (err) {
          this.logger.error(
            `Holiday resolution failed for workspace ${wsId}; defaulting to non-holiday`,
            err,
          );
          result.set(wsId, false);
        }
      }),
    );
    return result;
  }

  /**
   * CRON CONTRACT - Attendance auto-close stale sessions
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 02:30 UTC - close sessions left open >36h using shift end
   *              time (or checkIn+8h fallback), capped 5 min before now.
   * Idempotent:  YES (predicate) - selects only { checkIn != null, checkIn < cutoff,
   *              checkOut: null }; emitting the CHECK_OUT event sets checkOut, so the
   *              row no longer matches and a re-run closes nothing again. Tier B.
   * Reads:       attendance (stale open sessions), team_members, shifts
   * Writes:      attendance events (CHECK_OUT) + attendance projection
   * Missed run:  Self-heals - the next daily run picks up every session still open
   *              past the 36h cutoff (the predicate is time-bounded, not date-keyed).
   * Owner:       attendance
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_2_30_UTC, {
    timeZone: CRON_TIMEZONES.UTC,
    name: CronJobKey.AUTO_CLOSE_STALE,
  })
  async handleAutoCloseStale(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.AUTO_CLOSE_STALE, dayBucket(), () =>
      this.processAutoCloseStale(),
    );
  }

  private async processAutoCloseStale(): Promise<void> {
    this.logger.log('Running auto-close stale sessions cron...');
    const now = new Date();
    const cutoff = new Date(now.getTime() - 36 * 60 * 60 * 1000);

    try {
      const staleRecords = await this.attendanceModel
        .find({ checkIn: { $ne: null, $lt: cutoff }, checkOut: null })
        .lean()
        .exec();

      if (staleRecords.length === 0) {
        this.logger.log('No stale sessions to close');
        return;
      }

      // Batch-load members to resolve shiftId. Gap ATTEND-1 (attendance
      // hardening): also pull `isDeleted` so we can SKIP closing stale sessions
      // for removed members — their attendance is read-only after offboarding, so
      // the cron must not emit a fresh CHECK_OUT event onto a removed-member
      // record. A removed member missing from this map (or flagged isDeleted) is
      // skipped in the loop below.
      const memberIds = [...new Set(staleRecords.map((r) => r.teamMemberId.toString()))];
      const members = await this.teamMemberModel
        .find({ _id: { $in: memberIds } })
        .select('_id shiftId isDeleted')
        .lean()
        .exec();
      const memberShiftMap = new Map(members.map((m) => [m._id.toString(), m.shiftId?.toString()]));
      const removedMemberIds = new Set(
        members.filter((m) => m.isDeleted === true).map((m) => m._id.toString()),
      );

      // Batch-load shifts
      const shiftIds = [...new Set(members.map((m) => m.shiftId?.toString()).filter(Boolean))];
      const shifts = shiftIds.length
        ? await this.shiftModel
            .find({ _id: { $in: shiftIds } })
            .select('_id endTime')
            .lean()
            .exec()
        : [];
      const shiftEndMap = new Map(shifts.map((s) => [s._id.toString(), s.endTime]));

      const cap = new Date(now.getTime() - 5 * 60 * 1000);
      const cronRunId = `auto-close-${now.toISOString()}`;
      let closedCount = 0;

      for (const rec of staleRecords) {
        // Gap ATTEND-1: skip removed members — never emit a new event onto a
        // removed-member record (their attendance is read-only post-offboard).
        if (removedMemberIds.has(rec.teamMemberId.toString())) continue;

        const checkInTime = rec.checkIn;
        const shiftId = memberShiftMap.get(rec.teamMemberId.toString());
        const endTime = shiftId ? shiftEndMap.get(shiftId) : undefined;

        let checkOutTime: Date;
        if (endTime) {
          const [h, m] = endTime.split(':').map(Number);
          checkOutTime = new Date(rec.date);
          checkOutTime.setUTCHours(h, m, 0, 0);
          // If endTime resolves before checkIn (overnight shift), push to next calendar day
          if (checkOutTime <= checkInTime) {
            checkOutTime = new Date(checkOutTime.getTime() + 24 * 60 * 60 * 1000);
          }
        } else {
          checkOutTime = new Date(checkInTime.getTime() + 8 * 60 * 60 * 1000);
        }

        if (checkOutTime > cap) checkOutTime = cap;

        await this.eventService.createEvent({
          wsId: String(rec.workspaceId),
          teamMemberId: String(rec.teamMemberId),
          timestamp: checkOutTime,
          punchType: 'CHECK_OUT',
          source: 'system_auto_close',
          sourceMeta: { cronRunId },
          attendanceDate: rec.date,
        });
        await this.projectionService.recompute(
          String(rec.workspaceId),
          String(rec.teamMemberId),
          rec.date,
        );
        closedCount++;
      }

      this.logger.log(`Auto-closed ${closedCount} stale sessions`);
    } catch (error) {
      this.logger.error('Auto-close stale sessions cron failed:', error?.message);
    }
  }
}
