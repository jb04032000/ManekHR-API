import type { HalfDaySession } from './schemas/leave-request.schema';

/** Day-name → weekday index (0 = Sunday). Accepts full + 3-letter forms. */
const WEEKDAY_BY_NAME: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** Parse a `TeamMember.weeklyOff` string list into a set of weekday indices. */
export function parseWeeklyOff(weeklyOff: string[] | undefined): Set<number> {
  const out = new Set<number>();
  for (const raw of weeklyOff ?? []) {
    const idx = WEEKDAY_BY_NAME[raw.trim().toLowerCase()];
    if (idx !== undefined) out.add(idx);
  }
  return out;
}

/** `YYYY-MM-DD` (UTC) key for a date. */
export function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** A single approval-chain step on a leave / comp-off request. */
export interface ApprovalChainStep<TId> {
  level: number;
  approverUserId: TId;
  decision: null;
  decidedAt: null;
  note: null;
}

/**
 * Build a leave / comp-off approval chain from the workspace's configured
 * approver list, EXCLUDING the requesting member's own user (SoD: a member can
 * never approve their own request). When the member was the only configured
 * approver the chain comes back empty, which the caller treats as auto-approve.
 * Generic over the id type so it works with Mongoose `ObjectId`s (compared by
 * `toString()`) and with plain strings in unit tests.
 */
export function buildApproverChainExcludingSelf<TId extends { toString(): string }>(
  approverUserIds: TId[],
  selfUserId: string | null,
): ApprovalChainStep<TId>[] {
  return approverUserIds
    .filter((uid) => selfUserId === null || uid.toString() !== selfUserId)
    .map((uid, i) => ({
      level: i + 1,
      approverUserId: uid,
      decision: null,
      decidedAt: null,
      note: null,
    }));
}

/**
 * A candidate Tier-1 leave approver, the applicant's direct reporting manager,
 * loaded just enough to decide whether they can hold the request. Fields mirror
 * the `TeamMember` columns the resolver reads.
 */
export interface ManagerApproverCandidate {
  /** The manager's linked app user, null/absent when they are not an app user. */
  linkedUserId?: { toString(): string } | null;
  /** Soft-deactivated members never receive routing. */
  isActive?: boolean;
  /** Soft-deleted members never receive routing. */
  isDeleted?: boolean;
}

/**
 * Decide whether a reporting manager can hold the Tier-1 approval: returns their
 * user id, or null when they cannot be one: not an app user, inactive, soft-deleted,
 * or the applicant themselves (SoD self-exclusion, which also covers a circular
 * self-`reportsTo` where the manager doc IS the applicant).
 */
function pickManagerApprover(
  manager: ManagerApproverCandidate | null,
  selfUserId: string | null,
): string | null {
  if (!manager || manager.isDeleted === true || manager.isActive === false) return null;
  if (!manager.linkedUserId) return null;
  const managerUserId = manager.linkedUserId.toString();
  if (selfUserId !== null && managerUserId === selfUserId) return null;
  return managerUserId;
}

/**
 * Resolve a member's leave / comp-off approval chain, manager-first (industry
 * norm, per Keka / Zoho / BambooHR / Deel). Precedence, first non-empty tier wins:
 *
 *   1. Direct reporting manager (`reportsTo` -> that member's `linkedUserId`),
 *      a SINGLE level, no auto walk-up.
 *   2. Workspace-configured `approverUserIds` chain (admin default, multi-level).
 *   3. Workspace owner, the final oversight backstop.
 *
 * Self is excluded at every tier (SoD: a member can never approve their own
 * request). An empty result means the applicant is the sole authority (e.g. the
 * owner applying their own leave) and the caller auto-approves. Strings in /
 * strings out. Mongoose casts them to `ObjectId` on persist.
 */
export function resolveApproverChainForMember(args: {
  selfUserId: string | null;
  manager: ManagerApproverCandidate | null;
  settingsApproverUserIds: Array<{ toString(): string }>;
  ownerUserId: string | null;
}): ApprovalChainStep<string>[] {
  const { selfUserId, manager, settingsApproverUserIds, ownerUserId } = args;

  const managerUserId = pickManagerApprover(manager, selfUserId);
  if (managerUserId !== null) {
    return buildApproverChainExcludingSelf([managerUserId], selfUserId);
  }

  const settingsChain = buildApproverChainExcludingSelf(
    settingsApproverUserIds.map((id) => id.toString()),
    selfUserId,
  );
  if (settingsChain.length > 0) return settingsChain;

  return buildApproverChainExcludingSelf(ownerUserId ? [ownerUserId] : [], selfUserId);
}

export interface WorkingDay {
  /** UTC midnight of the day. */
  date: Date;
  /** 1 = full day, 0.5 = half day. */
  quantity: number;
}

/**
 * Expand a leave date range into the days actually charged.
 *
 * Holidays and the member's weekly-off days are excluded — unless `sandwich`
 * is set, in which case every calendar day in the span is charged. A half-day
 * session on the first / last day reduces that day to 0.5.
 */
export function expandWorkingDays(
  fromDate: Date,
  toDate: Date,
  firstDayHalf: HalfDaySession,
  lastDayHalf: HalfDaySession,
  holidayKeys: Set<string>,
  weeklyOffDays: Set<number>,
  sandwich: boolean,
): WorkingDay[] {
  const days: WorkingDay[] = [];
  const cursor = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()),
  );
  const end = new Date(
    Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate()),
  );

  let isFirstCalendarDay = true;
  while (cursor.getTime() <= end.getTime()) {
    const off = holidayKeys.has(dayKey(cursor)) || weeklyOffDays.has(cursor.getUTCDay());
    if (sandwich || !off) {
      let quantity = 1;
      if (isFirstCalendarDay && firstDayHalf !== 'none') quantity = 0.5;
      if (cursor.getTime() === end.getTime() && lastDayHalf !== 'none') {
        quantity = 0.5;
      }
      days.push({ date: new Date(cursor.getTime()), quantity });
    }
    isFirstCalendarDay = false;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export interface LeaveDaySegmentDraft {
  date: Date;
  leaveTypeId: string;
  quantity: number;
}

export interface LeaveDecomposition {
  segments: LeaveDaySegmentDraft[];
  paidDays: number;
  lwpDays: number;
  totalDays: number;
}

/**
 * Split charged working days against a paid balance: days are assigned to the
 * paid leave type until `availablePaid` is exhausted, then overflow to LWP.
 * A part-day is never split across types — it lands wholly on whichever side
 * its running total falls.
 */
export function decomposePaidLwp(
  workingDays: WorkingDay[],
  availablePaid: number,
  paidLeaveTypeId: string,
  lwpLeaveTypeId: string,
): LeaveDecomposition {
  const segments: LeaveDaySegmentDraft[] = [];
  let paidDays = 0;
  let lwpDays = 0;
  for (const day of workingDays) {
    const fitsPaid = paidDays + day.quantity <= availablePaid;
    if (fitsPaid) {
      segments.push({ date: day.date, leaveTypeId: paidLeaveTypeId, quantity: day.quantity });
      paidDays += day.quantity;
    } else {
      segments.push({ date: day.date, leaveTypeId: lwpLeaveTypeId, quantity: day.quantity });
      lwpDays += day.quantity;
    }
  }
  return { segments, paidDays, lwpDays, totalDays: paidDays + lwpDays };
}

/** All working days charged wholly to one leave type (entitlement / LWP types). */
export function chargeAllToType(
  workingDays: WorkingDay[],
  leaveTypeId: string,
): LeaveDaySegmentDraft[] {
  return workingDays.map((d) => ({
    date: d.date,
    leaveTypeId,
    quantity: d.quantity,
  }));
}

export interface LeaveTypeClassInput {
  /** `LeaveType.code` — the system Loss-of-Pay type is `'LWP'`. */
  code: string;
  /** `LeaveType.accrualRule.mode` — `'upfront'` / `'periodic'` / `'none'`. */
  accrualMode: string;
  /** `LeaveType.compOff.isCompOff`. */
  isCompOff: boolean;
}

export interface LeaveTypeClass {
  /** The system unpaid Loss-of-Pay type. */
  isLwp: boolean;
  /** A comp-off type — consumed FIFO from earned lots. */
  isCompOff: boolean;
  /** A fixed-entitlement type (Maternity / Paternity / Bereavement) — no accrued balance. */
  isEntitlement: boolean;
  /**
   * Draws from a `LeaveBalance` (accrual CL/SL/EL or comp-off) — reserves
   * `pending` at apply time, posts a `usage` ledger entry on approval.
   */
  balanceTracked: boolean;
}

/**
 * Classify a leave type into the four behaviour classes the request lifecycle
 * branches on. Balance-tracked types reserve `pending` and post `usage` /
 * `usage_reversal` ledger entries; LWP + entitlement types do neither — the
 * `LeaveRequest` record itself is their audit trail.
 */
export function classifyLeaveType(t: LeaveTypeClassInput): LeaveTypeClass {
  const isLwp = t.code === 'LWP';
  const isCompOff = !isLwp && t.isCompOff;
  const isEntitlement = !isLwp && !isCompOff && t.accrualMode === 'none';
  const balanceTracked = !isLwp && !isEntitlement;
  return { isLwp, isCompOff, isEntitlement, balanceTracked };
}

/** Attendance status a charged leave day projects: a part-day → `half_day`, else `on_leave`. */
export function leaveDayStatusValue(quantity: number): 'on_leave' | 'half_day' {
  return quantity >= 1 ? 'on_leave' : 'half_day';
}

export interface AffectedMonth {
  /** 1-indexed calendar month. */
  month: number;
  year: number;
}

/**
 * Every distinct calendar month a UTC date range touches, inclusive — drives
 * the payroll-lock check (a leave span may cross a month boundary).
 */
export function affectedMonths(from: Date, to: Date): AffectedMonth[] {
  const out: AffectedMonth[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor.getTime() <= end.getTime()) {
    out.push({ month: cursor.getUTCMonth() + 1, year: cursor.getUTCFullYear() });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/** Two inclusive date ranges overlap iff each starts on or before the other ends. */
export function rangesOverlap(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): boolean {
  return aFrom.getTime() <= bTo.getTime() && bFrom.getTime() <= aTo.getTime();
}
