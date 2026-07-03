/**
 * Phase 25 Plan 05 — ShiftClipperService.
 *
 * Provides the shift-window calculation primitives consumed by KPI / Trend /
 * Heatmap services (Plans 06/07/08).
 *
 *   - scheduledMinutesByMachine() — sum of shift durations × matching weekdays
 *     in range, excluding shiftType==='break' (Decision A2). Falls back to
 *     24h × days when a machine has no shift assignments (Decision D-06).
 *
 *   - clipDowntimeToShifts()      — intersect each downtime entry with the
 *     union of shift windows for the entry's machine within the range.
 *     Open-ended entries (endAt:null) clip to min(now, rangeEnd). Overnight
 *     shifts split at midnight per Decision D-15.
 *
 * Multi-tenancy: every Mongo query includes `workspaceId` (T-25-05-02).
 *
 * Pure compute service — no controller, no HTTP exposure.
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

export interface ShiftDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  startTime: string; // 'HH:mm'
  endTime: string; // 'HH:mm'
  workingDays: number[]; // 0=Sun..6=Sat
  shiftType: 'fixed' | 'flexi' | 'split' | 'break';
}

export interface DateRangeYmd {
  fromYmd: string;
  toYmd: string;
}

export interface DowntimeIntervalDoc {
  startAt: Date;
  endAt: Date | null;
  machineId: Types.ObjectId;
}

@Injectable()
export class ShiftClipperService {
  constructor(
    @InjectModel('Shift') private readonly shiftModel: Model<ShiftDoc>,
    @InjectModel('MachineShiftAssignment')
    private readonly assignmentModel: Model<any>,
  ) {}

  /**
   * Resolve which shifts apply to which machines for the given workspace.
   * If selectedShiftIds is non-empty: only those shifts (intersect with
   * assignments). Otherwise: all non-break shifts assigned to the machine.
   *
   * Returns Map<machineIdHex, ShiftDoc[]>.
   */
  async resolveMachineShifts(
    workspaceId: string,
    machineIds: Types.ObjectId[],
    selectedShiftIds?: string[],
  ): Promise<Map<string, ShiftDoc[]>> {
    const wsObj = new Types.ObjectId(workspaceId);
    const assignments = await this.assignmentModel
      .find({
        workspaceId: wsObj,
        machineId: { $in: machineIds },
        isDeleted: false,
      })
      .lean();

    const shiftIdsFromAssignments = [
      ...new Set(
        assignments
          .map((a: any) => (a.shiftId ? String(a.shiftId) : null))
          .filter((id): id is string => id !== null),
      ),
    ];

    let shiftIdsToQuery = shiftIdsFromAssignments;
    if (selectedShiftIds && selectedShiftIds.length > 0) {
      const selected = new Set(selectedShiftIds);
      shiftIdsToQuery = shiftIdsFromAssignments.filter((id) =>
        selected.has(id),
      );
    }

    const shiftFilter: any = {
      workspaceId: wsObj,
      _id: {
        $in: shiftIdsToQuery.map((id) => new Types.ObjectId(id)),
      },
      shiftType: { $ne: 'break' }, // A2: production shifts only
    };

    const shifts = shiftIdsToQuery.length
      ? await this.shiftModel.find(shiftFilter).lean<ShiftDoc[]>()
      : [];
    const shiftById = new Map(shifts.map((s) => [String(s._id), s]));

    const map = new Map<string, ShiftDoc[]>();
    for (const a of assignments as any[]) {
      if (!a.shiftId) continue;
      const s = shiftById.get(String(a.shiftId));
      if (!s) continue;
      const key = String(a.machineId);
      if (!map.has(key)) map.set(key, []);
      // De-dupe shift refs per machine (multiple assignments may share shift).
      const list = map.get(key)!;
      if (!list.some((x) => String(x._id) === String(s._id))) list.push(s);
    }
    return map;
  }

  /**
   * Returns Map<machineIdHex, scheduledMinutes> for the given range.
   *
   * scheduledMinutes = sum across days in range of:
   *   for each shift assigned to the machine, if shift.workingDays includes
   *   the weekday (in workspace tz), add shift duration. Overnight shifts
   *   (endTime <= startTime) are clipped within a 24h frame per D-15.
   *
   * Fallback per D-06: if a machine has zero scheduled minutes (no shifts
   * configured), denominator = 24h × days so uptime % stays computable.
   */
  async scheduledMinutesByMachine(
    workspaceId: string,
    machineIds: Types.ObjectId[],
    range: DateRangeYmd,
    tz: string,
    selectedShiftIds?: string[],
  ): Promise<Map<string, number>> {
    const machineShifts = await this.resolveMachineShifts(
      workspaceId,
      machineIds,
      selectedShiftIds,
    );
    return this.scheduledMinutesByMachineWithShifts(
      machineIds,
      range,
      tz,
      machineShifts,
    );
  }

  /**
   * WR-01 fix — pure variant that accepts a precomputed
   * `Map<machineIdHex, ShiftDoc[]>` so callers iterating over many
   * (machine, day) cells can resolve assignments + shifts ONCE per request
   * and reuse the same map for every iteration.
   */
  scheduledMinutesByMachineWithShifts(
    machineIds: Types.ObjectId[],
    range: DateRangeYmd,
    tz: string,
    machineShifts: Map<string, ShiftDoc[]>,
  ): Map<string, number> {
    const days = enumerateDaysInRange(range.fromYmd, range.toYmd);
    const result = new Map<string, number>();
    for (const m of machineIds) {
      const key = m.toHexString();
      const shifts = machineShifts.get(key) ?? [];
      let total = 0;
      for (const day of days) {
        const weekday = weekdayOfYmdInTz(day, tz);
        for (const s of shifts) {
          if (!s.workingDays.includes(weekday)) continue;
          total += shiftDurationMinutes(s.startTime, s.endTime);
        }
      }
      result.set(key, total);
    }
    // D-06 fallback: 24h × days when no shifts configured.
    const fallbackMin = days.length * 24 * 60;
    for (const m of machineIds) {
      const key = m.toHexString();
      if ((result.get(key) ?? 0) === 0) result.set(key, fallbackMin);
    }
    return result;
  }

  /**
   * Returns Map<machineIdHex, downMinutesClippedToShiftWindows>.
   *
   * Each downtime entry's [startAt, endAt) interval is intersected against
   * the union of shift windows for that machine within the range.
   * Open-ended entries (endAt:null) clip to min(now, rangeEnd).
   * Overnight shift windows are split at midnight per D-15.
   */
  async clipDowntimeToShifts(
    workspaceId: string,
    machineIds: Types.ObjectId[],
    entries: DowntimeIntervalDoc[],
    range: DateRangeYmd,
    tz: string,
    selectedShiftIds?: string[],
  ): Promise<Map<string, number>> {
    const machineShifts = await this.resolveMachineShifts(
      workspaceId,
      machineIds,
      selectedShiftIds,
    );
    return this.clipDowntimeToShiftsWithShifts(
      machineIds,
      entries,
      range,
      tz,
      machineShifts,
    );
  }

  /**
   * WR-01 fix — pure variant that accepts a precomputed `machineShifts` map.
   * Mirror of `clipDowntimeToShifts` but skips the assignment + shift query.
   */
  clipDowntimeToShiftsWithShifts(
    machineIds: Types.ObjectId[],
    entries: DowntimeIntervalDoc[],
    range: DateRangeYmd,
    tz: string,
    machineShifts: Map<string, ShiftDoc[]>,
  ): Map<string, number> {
    const days = enumerateDaysInRange(range.fromYmd, range.toYmd);
    const now = new Date();
    const rangeEndDate = parseLocalEndOfDayUtc(range.toYmd, tz);
    const openEndedClip = new Date(
      Math.min(now.getTime(), rangeEndDate.getTime()),
    );

    const result = new Map<string, number>();
    for (const m of machineIds) result.set(m.toHexString(), 0);

    // Pre-compute shift windows per (machine, day) to avoid redundant work
    // when many entries share the same machine.
    const windowsCache = new Map<
      string,
      { startMs: number; endMs: number }[]
    >();
    const getWindowsForMachine = (machineKey: string) => {
      if (windowsCache.has(machineKey)) return windowsCache.get(machineKey)!;
      const shifts = machineShifts.get(machineKey) ?? [];
      const wins: { startMs: number; endMs: number }[] = [];
      for (const day of days) {
        const weekday = weekdayOfYmdInTz(day, tz);
        for (const s of shifts) {
          if (!s.workingDays.includes(weekday)) continue;
          const ws = shiftWindowsUtc(day, s.startTime, s.endTime, tz);
          for (const w of ws) {
            wins.push({
              startMs: w.startUtc.getTime(),
              endMs: w.endUtc.getTime(),
            });
          }
        }
      }
      windowsCache.set(machineKey, wins);
      return wins;
    };

    for (const e of entries) {
      const key = String(e.machineId);
      if (!result.has(key)) continue; // entry for an out-of-scope machine
      const wins = getWindowsForMachine(key);
      if (wins.length === 0) continue;
      const startMs = e.startAt.getTime();
      const endMs = (e.endAt ?? openEndedClip).getTime();
      if (endMs <= startMs) continue;

      let addedMs = 0;
      for (const w of wins) {
        addedMs += intervalIntersectMs(
          { start: startMs, end: endMs },
          { start: w.startMs, end: w.endMs },
        );
      }
      result.set(key, (result.get(key) ?? 0) + addedMs / 60_000);
    }
    // Round to integer minutes for response stability.
    for (const k of result.keys()) result.set(k, Math.round(result.get(k)!));
    return result;
  }
}

// ---------------- internal helpers ----------------

function enumerateDaysInRange(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  const f = new Date(fromYmd + 'T00:00:00Z');
  const t = new Date(toYmd + 'T00:00:00Z');
  for (
    let d = new Date(f);
    d.getTime() <= t.getTime();
    d = new Date(d.getTime() + 86_400_000)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function weekdayOfYmdInTz(ymd: string, tz: string): number {
  const probe = new Date(ymd + 'T12:00:00Z');
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  });
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[dtf.format(probe)] ?? 0;
}

function shiftDurationMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  let endMin = eh * 60 + em;
  if (end <= start) endMin += 24 * 60; // overnight, clipped within a 24h frame
  return Math.max(0, endMin - startMin);
}

function getTzOffsetMin(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function parseLocalEndOfDayUtc(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const tzOffsetMin = getTzOffsetMin(probe, tz);
  return new Date(
    Date.UTC(y, m - 1, d, 23, 59, 59, 999) - tzOffsetMin * 60 * 1000,
  );
}

function parseLocalHourMinUtc(ymd: string, hm: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mn] = hm.split(':').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const tzOffsetMin = getTzOffsetMin(probe, tz);
  return new Date(
    Date.UTC(y, m - 1, d, h, mn, 0, 0) - tzOffsetMin * 60 * 1000,
  );
}

function shiftWindowsUtc(
  ymd: string,
  start: string,
  end: string,
  tz: string,
): { startUtc: Date; endUtc: Date }[] {
  const dayStart = parseLocalHourMinUtc(ymd, start, tz);
  if (end > start) {
    const dayEnd = parseLocalHourMinUtc(ymd, end, tz);
    return [{ startUtc: dayStart, endUtc: dayEnd }];
  }
  // Overnight (D-15): split at midnight.
  // Window 1 = [start, 24:00) on this day. Window 2 = [00:00, end) on next day.
  // Use 23:59:59.999 as the inclusive upper bound for window 1.
  const midnightToday = parseLocalHourMinUtc(ymd, '23:59', tz);
  midnightToday.setUTCSeconds(59, 999);
  const nextYmd = addDaysYmd(ymd, 1);
  const nextStart = parseLocalHourMinUtc(nextYmd, '00:00', tz);
  const nextEnd = parseLocalHourMinUtc(nextYmd, end, tz);
  return [
    { startUtc: dayStart, endUtc: midnightToday },
    { startUtc: nextStart, endUtc: nextEnd },
  ];
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function intervalIntersectMs(
  a: { start: number; end: number },
  b: { start: number; end: number },
): number {
  const s = Math.max(a.start, b.start);
  const e = Math.min(a.end, b.end);
  return Math.max(0, e - s);
}
