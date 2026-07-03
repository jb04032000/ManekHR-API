export type AttendanceEventSource =
  | 'manual'
  | 'manual_override'
  | 'device_push'
  | 'connector'
  | 'file_upload'
  | 'auto_cron'
  | 'regularization'
  | 'kiosk'
  | 'self'
  | 'leave';

export type AttendancePunchType =
  | 'CHECK_IN'
  | 'CHECK_OUT'
  | 'BREAK_OUT'
  | 'BREAK_IN'
  | 'OT_IN'
  | 'OT_OUT'
  | 'STATUS_SET';

export interface EventInput {
  timestamp: Date;
  punchType: AttendancePunchType;
  statusValue: string | null;
  source: AttendanceEventSource;
}

export interface PhaseAProjection {
  status: string;
  dominantSource: AttendanceEventSource;
}

/**
 * Phase A simplified projection (D7 LOCKED).
 * Phase C will replace this body with the full policy engine.
 *
 * Rules:
 * 1. If any event has source=manual_override AND punchType=STATUS_SET → use its statusValue (latest wins on tie).
 * 2. Else find events with punchType=STATUS_SET and pick the most recent by timestamp.
 * 3. Else return null (caller keeps the existing Attendance row untouched).
 */
export function computeProjectionForPhaseA(events: EventInput[]): PhaseAProjection | null {
  if (!events || events.length === 0) return null;

  const statusSetters = events.filter((e) => e.punchType === 'STATUS_SET' && e.statusValue != null);
  if (statusSetters.length === 0) return null;

  const overrides = statusSetters.filter((e) => e.source === 'manual_override');
  const pool = overrides.length > 0 ? overrides : statusSetters;

  // Pick the latest by timestamp
  const latest = pool.reduce((acc, e) =>
    e.timestamp.getTime() > acc.timestamp.getTime() ? e : acc,
  );

  return {
    status: latest.statusValue,
    dominantSource: latest.source,
  };
}

// ── Phase C: Policy engine types ─────────────────────────────────────────────

export interface ShiftSnapshot {
  startTime: string; // HH:mm (e.g. "09:00") — UTC-based
  endTime: string; // HH:mm (e.g. "18:00") — UTC-based
  gracePeriodMinutes: number;
  halfDayAfterLateMinutes: number;
  shiftType: 'fixed' | 'flexi' | 'split' | 'break';
  requiredHoursPerDay: number | null; // for flexi; null = default 8h
}

export interface PolicySnapshot {
  lateArrival: {
    countAsLop: boolean;
    lopAfterNLateDays: number | null;
  };
  earlyDeparture: {
    enabled: boolean;
    thresholdMinutes: number;
    countAsHalfDay: boolean;
  };
  ot: {
    enabled: boolean;
    thresholdMinutes: number;
    capMinutes: number | null;
  };
  compOff: {
    enabled: boolean;
  };
}

export interface DailySummary {
  status: string;
  checkIn: Date | null;
  checkOut: Date | null;
  workedMinutes: number | null;
  lateMinutes: number;
  /** Minutes the member left before shift end, past the policy tolerance.
   *  Always 0 when `earlyDeparture` is disabled or N/A (flexi). */
  earlyMinutes: number;
  otMinutes: number;
  computeReason: string;
  dominantSource: AttendanceEventSource;
}

export const DEFAULT_SHIFT_SNAPSHOT: ShiftSnapshot = {
  startTime: '09:00',
  endTime: '18:00',
  gracePeriodMinutes: 0,
  halfDayAfterLateMinutes: 60,
  shiftType: 'fixed',
  requiredHoursPerDay: null,
};

export const DEFAULT_POLICY_SNAPSHOT: PolicySnapshot = {
  lateArrival: { countAsLop: false, lopAfterNLateDays: null },
  earlyDeparture: { enabled: false, thresholdMinutes: 30, countAsHalfDay: false },
  ot: { enabled: false, thresholdMinutes: 30, capMinutes: null },
  compOff: { enabled: false },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Parse HH:mm into an absolute Date on the given UTC day.
 * If endTime < startTime string-compare, add 24h (handles midnight-crossing shifts).
 */
function parseShiftTime(hhmm: string, date: Date): Date {
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const result = new Date(date);
  result.setUTCHours(h, m, 0, 0);
  return result;
}

/** Returns { status, source } if any STATUS_SET events exist, else null. */
function resolveFromStatusSet(
  events: EventInput[],
): { status: string; source: AttendanceEventSource } | null {
  const statusSetters = events.filter((e) => e.punchType === 'STATUS_SET' && e.statusValue != null);
  if (statusSetters.length === 0) return null;
  const overrides = statusSetters.filter((e) => e.source === 'manual_override');
  const pool = overrides.length > 0 ? overrides : statusSetters;
  const latest = pool.reduce((acc, e) =>
    e.timestamp.getTime() > acc.timestamp.getTime() ? e : acc,
  );
  return { status: latest.statusValue, source: latest.source };
}

/**
 * OT calculation shared across shiftTypes.
 * otMinutes = max(0, (checkOut - shiftEnd) / 60000 - policy.thresholdMinutes)
 * Capped by policy.capMinutes if non-null.
 */
function calcOtMinutes(checkOut: Date, shiftEnd: Date, otPolicy: PolicySnapshot['ot']): number {
  if (!otPolicy.enabled) return 0;
  const rawOt = (checkOut.getTime() - shiftEnd.getTime()) / 60000 - otPolicy.thresholdMinutes;
  if (rawOt <= 0) return 0;
  return otPolicy.capMinutes !== null ? Math.min(rawOt, otPolicy.capMinutes) : rawOt;
}

/**
 * Early-departure calculation shared across fixed/split/break shiftTypes.
 * earlyMinutes = max(0, (shiftEnd - checkOut) / 60000 - policy.thresholdMinutes)
 * Mirrors `lateMinutes` (amount past tolerance). 0 when disabled or N/A.
 */
function calcEarlyMinutes(
  checkOut: Date,
  shiftEnd: Date,
  edPolicy: PolicySnapshot['earlyDeparture'],
): number {
  if (!edPolicy.enabled) return 0;
  const rawEarly = (shiftEnd.getTime() - checkOut.getTime()) / 60000 - edPolicy.thresholdMinutes;
  return rawEarly > 0 ? rawEarly : 0;
}

/**
 * Grace-credited check-in. Within the grace window a slightly-late punch
 * counts as on-time AND the worked time is credited from shift start — so a
 * punch at 08:08 on an 08:00 shift with a 10-min grace is not pay-docked for
 * those 8 minutes. Beyond grace every minute counts from the actual punch; an
 * early punch (before shift start) is never clamped.
 */
function graceCreditedCheckIn(checkIn: Date, shiftStart: Date, gracePeriodMinutes: number): Date {
  const lateMs = checkIn.getTime() - shiftStart.getTime();
  return lateMs > 0 && lateMs <= gracePeriodMinutes * 60000 ? shiftStart : checkIn;
}

/** Pick the dominant source from a pool of events (source priority from D1). */
const SOURCE_PRIORITY: Record<AttendanceEventSource, number> = {
  manual_override: 8,
  regularization: 7,
  // Approved leave is an authoritative workflow status-set, peer to
  // regularization — both lose only to an explicit `manual_override`.
  leave: 7,
  device_push: 6,
  kiosk: 5,
  self: 4,
  connector: 3,
  file_upload: 2,
  auto_cron: 1,
  manual: 0,
};
export function dominantSource(events: EventInput[]): AttendanceEventSource {
  if (events.length === 0) return 'manual';
  return events.reduce((acc, e) =>
    (SOURCE_PRIORITY[e.source] ?? 0) > (SOURCE_PRIORITY[acc.source] ?? 0) ? e : acc,
  ).source;
}

/** One check-in -> check-out work block. `out` is null while a session is open. */
export interface AttendanceSession {
  in: Date;
  out: Date | null;
}

/**
 * Pair raw punch events into [check-in -> check-out] sessions, ordered by time.
 * Greedy: each CHECK_IN claims the immediately-following CHECK_OUT as its close;
 * an unmatched CHECK_IN stays open (out = null). Non-punch event types are
 * ignored. Shared by the split-shift projection (computeSplit) and the
 * self-service day endpoint so both pair punches identically.
 */
export function pairSessions(
  events: { timestamp: Date; punchType: string }[],
): AttendanceSession[] {
  const punches = events
    .filter((e) => e.punchType === 'CHECK_IN' || e.punchType === 'CHECK_OUT')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const sessions: AttendanceSession[] = [];
  for (let i = 0; i < punches.length; i++) {
    if (punches[i].punchType === 'CHECK_IN') {
      const nextOut = punches[i + 1]?.punchType === 'CHECK_OUT' ? punches[i + 1].timestamp : null;
      sessions.push({ in: punches[i].timestamp, out: nextOut });
      if (nextOut) i++; // skip the matched CHECK_OUT
    }
  }
  return sessions;
}

// ── Phase C: computeDailySummary ──────────────────────────────────────────────

/**
 * Derives daily attendance summary from raw events, shift config, and policy rules.
 * Replaces computeProjectionForPhaseA (kept for Phase A test compat).
 *
 * DC-3: branches on shiftType (fixed|flexi|split|break)
 * DC-4: workedMinutes=null when checkout missing
 * DC-5: OT auto-calc from checkout past shiftEnd minus threshold
 */
export function computeDailySummary(
  events: EventInput[],
  shift: ShiftSnapshot,
  policy: PolicySnapshot,
  date: Date,
): DailySummary {
  const src = dominantSource(events);

  // STATUS_SET short-circuit applies to all shiftTypes (DC-3 step 1).
  // Preserve checkIn/checkOut from any CHECK_IN/CHECK_OUT events that exist alongside the override.
  const statusOverride = resolveFromStatusSet(events);
  if (statusOverride) {
    const checkInEvents = events.filter((e) => e.punchType === 'CHECK_IN');
    const checkOutEvents = events.filter((e) => e.punchType === 'CHECK_OUT');
    const checkIn = checkInEvents.length
      ? new Date(Math.min(...checkInEvents.map((e) => e.timestamp.getTime())))
      : null;
    const checkOut = checkOutEvents.length
      ? new Date(Math.max(...checkOutEvents.map((e) => e.timestamp.getTime())))
      : null;
    const workedMinutes =
      checkIn && checkOut ? (checkOut.getTime() - checkIn.getTime()) / 60000 : null;
    return {
      status: statusOverride.status,
      checkIn,
      checkOut,
      workedMinutes,
      lateMinutes: 0,
      earlyMinutes: 0,
      otMinutes: 0,
      computeReason: `Status set manually: ${statusOverride.status}.`,
      dominantSource: statusOverride.source,
    };
  }

  switch (shift.shiftType) {
    case 'fixed':
      return computeFixed(events, shift, policy, date, src);
    case 'flexi':
      return computeFlexi(events, shift, policy, date, src);
    case 'split':
      return computeSplit(events, shift, policy, date, src);
    case 'break':
      return computeBreak(events, shift, policy, date, src);
    default:
      return computeFixed(events, shift, policy, date, src);
  }
}

function computeFixed(
  events: EventInput[],
  shift: ShiftSnapshot,
  policy: PolicySnapshot,
  date: Date,
  src: AttendanceEventSource,
): DailySummary {
  const checkIns = events.filter((e) => e.punchType === 'CHECK_IN');
  const checkOuts = events.filter((e) => e.punchType === 'CHECK_OUT');

  const checkIn = checkIns.length
    ? new Date(Math.min(...checkIns.map((e) => e.timestamp.getTime())))
    : null;
  const checkOut = checkOuts.length
    ? new Date(Math.max(...checkOuts.map((e) => e.timestamp.getTime())))
    : null;

  if (!checkIn) {
    return {
      status: 'absent',
      checkIn: null,
      checkOut: null,
      workedMinutes: null,
      lateMinutes: 0,
      earlyMinutes: 0,
      otMinutes: 0,
      computeReason: 'No check-in recorded. Marked absent.',
      dominantSource: src,
    };
  }

  const shiftStart = parseShiftTime(shift.startTime, date);
  const shiftEnd = parseShiftTime(shift.endTime, date);
  // Handle overnight shift: if endTime string <= startTime string, add 24h to shiftEnd
  if (shift.endTime <= shift.startTime) {
    shiftEnd.setUTCDate(shiftEnd.getUTCDate() + 1);
  }

  const lateMs = Math.max(
    0,
    checkIn.getTime() - shiftStart.getTime() - shift.gracePeriodMinutes * 60000,
  );
  const lateMinutes = lateMs / 60000;

  let status: string;
  if (lateMinutes === 0) {
    status = 'present';
  } else if (lateMinutes < shift.halfDayAfterLateMinutes) {
    status = 'late';
  } else {
    status = 'half_day';
  }

  // Grace-credit the check-in: within the grace window worked time is
  // credited from shift start, so a slightly-late punch is not pay-docked.
  const effectiveCheckIn = graceCreditedCheckIn(checkIn, shiftStart, shift.gracePeriodMinutes);
  const workedMinutes = checkOut ? (checkOut.getTime() - effectiveCheckIn.getTime()) / 60000 : null;

  const otMinutes =
    policy.ot.enabled && checkOut ? calcOtMinutes(checkOut, shiftEnd, policy.ot) : 0;

  // Early departure — flag (and optionally downgrade to half-day) when the
  // member left more than the policy tolerance before shift end.
  const earlyMinutes = checkOut ? calcEarlyMinutes(checkOut, shiftEnd, policy.earlyDeparture) : 0;
  if (
    earlyMinutes > 0 &&
    policy.earlyDeparture.countAsHalfDay &&
    (status === 'present' || status === 'late')
  ) {
    status = 'half_day';
  }

  const checkInFmt = checkIn.toISOString().slice(11, 16);
  const baseReason = checkOut
    ? `Check-in at ${checkInFmt}${lateMinutes > 0 ? ` (${Math.round(lateMinutes)} min late)` : ''}. Worked ${Math.round(workedMinutes ?? 0)} min.`
    : `Check-in at ${checkInFmt}${lateMinutes > 0 ? ` (${Math.round(lateMinutes)} min late)` : ''}. No checkout recorded — worked time unavailable.`;
  const reason =
    earlyMinutes > 0 ? `${baseReason} Left ${Math.round(earlyMinutes)} min early.` : baseReason;

  return {
    status,
    checkIn,
    checkOut,
    workedMinutes,
    lateMinutes,
    earlyMinutes,
    otMinutes,
    computeReason: reason,
    dominantSource: src,
  };
}

function computeFlexi(
  events: EventInput[],
  shift: ShiftSnapshot,
  policy: PolicySnapshot,
  date: Date,
  src: AttendanceEventSource,
): DailySummary {
  const checkIns = events.filter((e) => e.punchType === 'CHECK_IN');
  const checkOuts = events.filter((e) => e.punchType === 'CHECK_OUT');

  const checkIn = checkIns.length
    ? new Date(Math.min(...checkIns.map((e) => e.timestamp.getTime())))
    : null;
  const checkOut = checkOuts.length
    ? new Date(Math.max(...checkOuts.map((e) => e.timestamp.getTime())))
    : null;

  if (!checkIn) {
    return {
      status: 'absent',
      checkIn: null,
      checkOut: null,
      workedMinutes: null,
      lateMinutes: 0,
      earlyMinutes: 0,
      otMinutes: 0,
      computeReason: 'No check-in recorded. Marked absent.',
      dominantSource: src,
    };
  }

  const workedMinutes = checkOut ? (checkOut.getTime() - checkIn.getTime()) / 60000 : null;
  const requiredMinutes = (shift.requiredHoursPerDay ?? 8) * 60;

  let status: string;
  if (workedMinutes === null || workedMinutes < requiredMinutes) {
    status = 'half_day';
  } else {
    status = 'present';
  }

  let otMinutes = 0;
  if (policy.ot.enabled && workedMinutes !== null && workedMinutes > requiredMinutes) {
    const raw = workedMinutes - requiredMinutes - policy.ot.thresholdMinutes;
    if (raw > 0) {
      otMinutes = policy.ot.capMinutes !== null ? Math.min(raw, policy.ot.capMinutes) : raw;
    }
  }

  const reason =
    workedMinutes !== null
      ? `Flexi shift. Worked ${Math.round(workedMinutes)} min (required ${requiredMinutes} min).`
      : 'Flexi shift. No checkout recorded — worked time unavailable.';

  return {
    status,
    checkIn,
    checkOut,
    workedMinutes,
    lateMinutes: 0,
    earlyMinutes: 0,
    otMinutes,
    computeReason: reason,
    dominantSource: src,
  };
}

function computeSplit(
  events: EventInput[],
  shift: ShiftSnapshot,
  policy: PolicySnapshot,
  date: Date,
  src: AttendanceEventSource,
): DailySummary {
  // Pair check-in/out punches into work blocks (CI0+CO0, CI1+CO1, ...) via the
  // shared helper, so the split projection and the self-service day endpoint
  // pair punches identically.
  const blocks = pairSessions(events);

  if (blocks.length === 0 || !blocks[0]) {
    return {
      status: 'absent',
      checkIn: null,
      checkOut: null,
      workedMinutes: null,
      lateMinutes: 0,
      earlyMinutes: 0,
      otMinutes: 0,
      computeReason: 'No check-in recorded. Marked absent.',
      dominantSource: src,
    };
  }

  const checkIn = blocks[0].in;
  const lastBlock = blocks[blocks.length - 1];
  const checkOut = lastBlock.out ?? null;

  const shiftStart = parseShiftTime(shift.startTime, date);
  const shiftEnd = parseShiftTime(shift.endTime, date);
  if (shift.endTime <= shift.startTime) shiftEnd.setUTCDate(shiftEnd.getUTCDate() + 1);

  // Grace-credit the first block's check-in (see graceCreditedCheckIn).
  const effectiveFirstIn = graceCreditedCheckIn(checkIn, shiftStart, shift.gracePeriodMinutes);

  // If any block lacks a checkout, workedMinutes is null
  const anyMissingOut = blocks.some((b) => b.out === null);
  const workedMinutes = anyMissingOut
    ? null
    : blocks.reduce(
        (sum, b, idx) =>
          sum + (b.out.getTime() - (idx === 0 ? effectiveFirstIn : b.in).getTime()) / 60000,
        0,
      );

  const lateMs = Math.max(
    0,
    checkIn.getTime() - shiftStart.getTime() - shift.gracePeriodMinutes * 60000,
  );
  const lateMinutes = lateMs / 60000;
  let status =
    lateMinutes === 0
      ? 'present'
      : lateMinutes < shift.halfDayAfterLateMinutes
        ? 'late'
        : 'half_day';

  const otMinutes =
    policy.ot.enabled && checkOut ? calcOtMinutes(checkOut, shiftEnd, policy.ot) : 0;

  const earlyMinutes = checkOut ? calcEarlyMinutes(checkOut, shiftEnd, policy.earlyDeparture) : 0;
  if (
    earlyMinutes > 0 &&
    policy.earlyDeparture.countAsHalfDay &&
    (status === 'present' || status === 'late')
  ) {
    status = 'half_day';
  }

  const baseReason =
    workedMinutes !== null
      ? `Split shift: ${blocks.length} block(s). Total worked: ${Math.round(workedMinutes)} min.`
      : `Split shift: ${blocks.length} block(s). Some blocks missing checkout — worked time unavailable.`;
  const reason =
    earlyMinutes > 0 ? `${baseReason} Left ${Math.round(earlyMinutes)} min early.` : baseReason;

  return {
    status,
    checkIn,
    checkOut,
    workedMinutes,
    lateMinutes,
    earlyMinutes,
    otMinutes,
    computeReason: reason,
    dominantSource: src,
  };
}

function computeBreak(
  events: EventInput[],
  shift: ShiftSnapshot,
  policy: PolicySnapshot,
  date: Date,
  src: AttendanceEventSource,
): DailySummary {
  const checkIns = events.filter((e) => e.punchType === 'CHECK_IN');
  const checkOuts = events.filter((e) => e.punchType === 'CHECK_OUT');
  const breakOuts = events
    .filter((e) => e.punchType === 'BREAK_OUT')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const breakIns = events
    .filter((e) => e.punchType === 'BREAK_IN')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const checkIn = checkIns.length
    ? new Date(Math.min(...checkIns.map((e) => e.timestamp.getTime())))
    : null;
  const checkOut = checkOuts.length
    ? new Date(Math.max(...checkOuts.map((e) => e.timestamp.getTime())))
    : null;

  if (!checkIn) {
    return {
      status: 'absent',
      checkIn: null,
      checkOut: null,
      workedMinutes: null,
      lateMinutes: 0,
      earlyMinutes: 0,
      otMinutes: 0,
      computeReason: 'No check-in recorded. Marked absent.',
      dominantSource: src,
    };
  }

  // Pair BREAK_OUT with subsequent BREAK_IN; unclosed break = 0 duration (conservative)
  let totalBreakMinutes = 0;
  for (let i = 0; i < breakOuts.length; i++) {
    const correspondingIn = breakIns[i];
    if (correspondingIn) {
      totalBreakMinutes +=
        (correspondingIn.timestamp.getTime() - breakOuts[i].timestamp.getTime()) / 60000;
    }
    // Unclosed BREAK_OUT: ignore (conservative — no deduction)
  }

  const shiftStart = parseShiftTime(shift.startTime, date);
  const shiftEnd = parseShiftTime(shift.endTime, date);
  if (shift.endTime <= shift.startTime) shiftEnd.setUTCDate(shiftEnd.getUTCDate() + 1);

  // Grace-credit the check-in (see graceCreditedCheckIn).
  const effectiveCheckIn = graceCreditedCheckIn(checkIn, shiftStart, shift.gracePeriodMinutes);
  const workedMinutes = checkOut
    ? (checkOut.getTime() - effectiveCheckIn.getTime()) / 60000 - totalBreakMinutes
    : null;

  const lateMs = Math.max(
    0,
    checkIn.getTime() - shiftStart.getTime() - shift.gracePeriodMinutes * 60000,
  );
  const lateMinutes = lateMs / 60000;
  let status =
    lateMinutes === 0
      ? 'present'
      : lateMinutes < shift.halfDayAfterLateMinutes
        ? 'late'
        : 'half_day';

  const otMinutes =
    policy.ot.enabled && checkOut ? calcOtMinutes(checkOut, shiftEnd, policy.ot) : 0;

  const earlyMinutes = checkOut ? calcEarlyMinutes(checkOut, shiftEnd, policy.earlyDeparture) : 0;
  if (
    earlyMinutes > 0 &&
    policy.earlyDeparture.countAsHalfDay &&
    (status === 'present' || status === 'late')
  ) {
    status = 'half_day';
  }

  const baseReason =
    workedMinutes !== null
      ? `Break shift. Net worked: ${Math.round(workedMinutes)} min (break: ${Math.round(totalBreakMinutes)} min).`
      : 'Break shift. No checkout recorded — worked time unavailable.';
  const reason =
    earlyMinutes > 0 ? `${baseReason} Left ${Math.round(earlyMinutes)} min early.` : baseReason;

  return {
    status,
    checkIn,
    checkOut,
    workedMinutes,
    lateMinutes,
    earlyMinutes,
    otMinutes,
    computeReason: reason,
    dominantSource: src,
  };
}
