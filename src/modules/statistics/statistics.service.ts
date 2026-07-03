import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Attendance } from '../attendance/schemas/attendance.schema';
import { Salary } from '../salary/schemas/salary.schema';
import { Payment } from '../salary/schemas/payment.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Shift } from '../shifts/schemas/shift.schema';

// Shape of the active-member projection reused across the enrichment blocks
// (attendance week-off, previous-headcount, workforce, people radar). Kept lean
// so the dashboard stays a single cheap read.
interface ActiveMemberLean {
  _id: Types.ObjectId;
  name?: string;
  weeklyOff?: string[];
  designation?: string;
  employmentType?: string;
  shiftId?: Types.ObjectId;
  gender?: string;
  dateOfBirth?: Date;
  dateOfJoining?: Date;
}

// Minimal member shape the salary roll-up reads (current + previous month).
interface SalaryMemberLike {
  _id: Types.ObjectId;
  salaryAmount?: number;
}
interface SalaryRecordLike {
  teamMemberId: Types.ObjectId;
  baseSalary: number;
  netSalary: number;
}
interface PaymentLike {
  teamMemberId: Types.ObjectId;
  amount: number;
}

type Bucket = { label: string | null; count: number };

@Injectable()
export class StatisticsService {
  constructor(
    @InjectModel(Attendance.name) private attendanceModel: Model<Attendance>,
    @InjectModel(Salary.name) private salaryModel: Model<Salary>,
    @InjectModel(Payment.name) private paymentModel: Model<Payment>,
    @InjectModel(TeamMember.name) private teamModel: Model<TeamMember>,
    @InjectModel(Shift.name) private shiftModel: Model<Shift>,
  ) {}

  /**
   * Aggregate workforce dashboard read. Returns headline KPIs (attendance,
   * salary, headcount) PLUS enrichment blocks added in the 2026-06 rebuild:
   * previous-period comparisons (to light the trend arrows), a workforce
   * breakdown, and a "people radar" (joiners / birthdays / anniversaries).
   *
   * `now` is injectable purely for deterministic tests; production callers pass
   * nothing. Cross-module: FE `getDashboardStats` (lib/actions/stats.actions.ts)
   * + the dashboard widgets read every field here. Keep the FE `DashboardStats`
   * type in sync when adding fields.
   */
  async getDashboardStats(workspaceId: string, now: Date = new Date()) {
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);

    const currentMonth = now.getMonth() + 1; // 1-12
    const currentYear = now.getFullYear();
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const startOfMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1, 0, 0, 0, 0));

    const workspaceFilter = {
      $in: [workspaceId, new Types.ObjectId(workspaceId)],
    };

    // 1. Team Stats — the ACTIVE, non-deleted members are the universe for every
    // attendance count below. We also pull the fields the workforce + people-radar
    // blocks need so the whole dashboard stays one cheap query for the roster.
    const activeMembers = await this.teamModel
      .find({
        workspaceId: workspaceFilter,
        isActive: true,
        isDeleted: { $ne: true },
      })
      .select(
        '_id name weeklyOff designation employmentType shiftId gender dateOfBirth dateOfJoining',
      )
      .lean<ActiveMemberLean[]>();
    const totalMembers = activeMembers.length;
    const activeMemberIds = activeMembers.map((m) => m._id);

    // Staff trend baseline: headcount excluding members who joined THIS month
    // (missing join date counts as "already here"). Lights the staff trend arrow.
    const previousTotalMembers = activeMembers.filter((m) => {
      if (!m.dateOfJoining) return true;
      return new Date(m.dateOfJoining) < startOfMonth;
    }).length;

    // 2. Attendance Stats (Today)
    // BUGFIX: previously this counted EVERY attendance row for `today` regardless
    // of whether the member is still active/non-deleted. Orphan or inactive
    // members' rows inflated the count (e.g. "101 present" for a 50-person team).
    // Scope strictly to active members so present <= headcount.
    const attendanceRecords = await this.attendanceModel.find({
      workspaceId: workspaceFilter,
      date: today,
      teamMemberId: { $in: activeMemberIds },
    });

    const attendance = {
      present: 0,
      absent: 0,
      half_day: 0,
      late: 0,
      on_leave: 0,
      holiday: 0,
      week_off: 0,
      unmarked: 0,
      total: totalMembers,
    };

    const markedMemberIds = new Set<string>();
    attendanceRecords.forEach((r) => {
      if (attendance[r.status] !== undefined) {
        attendance[r.status]++;
      }
      markedMemberIds.add(String(r.teamMemberId));
    });

    // Week-off derivation: a member with NO record today whose weekly-off covers
    // today (Sunday is always treated as a week-off per product rule, plus any
    // configured weeklyOff day) is reported as week_off rather than unmarked.
    // UTC day index is used so the bucket matches the UTC-midnight stored dates.
    const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const todayAbbr = WEEKDAY_ABBR[today.getUTCDay()];
    let derivedWeekOff = 0;
    for (const m of activeMembers) {
      if (markedMemberIds.has(String(m._id))) continue;
      const off = todayAbbr === 'Sun' || (m.weeklyOff ?? []).includes(todayAbbr);
      if (off) derivedWeekOff++;
    }
    attendance.week_off += derivedWeekOff;
    attendance.unmarked = Math.max(0, totalMembers - markedMemberIds.size - derivedWeekOff);

    // Present-today trend baseline: present count on the MOST RECENT prior day
    // (look back up to 7 days) that has any attendance — skips weekend/holiday
    // zero-days so the trend compares like working days.
    const previousPresent = await this.computePreviousPresent(
      workspaceFilter,
      activeMemberIds,
      today,
    );

    // 3. Salary Stats (Current Month) — and the previous month for the trend.
    const members = await this.teamModel
      .find({ workspaceId: workspaceFilter, isActive: true })
      .lean<SalaryMemberLike[]>();

    const [current, previous] = await Promise.all([
      this.computeSalaryTotals(workspaceFilter, members, currentMonth, currentYear),
      this.computeSalaryTotals(workspaceFilter, members, prevMonth, prevYear),
    ]);

    const salary = {
      totalPayable: current.totalPayable,
      totalPaid: current.totalPaid,
      totalRemaining: Math.max(0, current.totalPayable - current.totalPaid),
      employeesCount: members.length,
      paidEmployeesCount: current.paidEmployeesCount,
      monthLabel: now.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
      }),
      previousTotalPaid: previous.totalPaid,
      previousTotalRemaining: Math.max(0, previous.totalPayable - previous.totalPaid),
    };

    // 4. Workforce breakdown + people radar (team-scoped, derived from the roster
    // already in memory; only shift names need an extra lookup).
    const workforce = await this.buildWorkforce(workspaceFilter, activeMembers, totalMembers);
    const peopleRadar = this.buildPeopleRadar(
      activeMembers,
      today,
      startOfMonth,
      currentMonth,
      currentYear,
    );

    return {
      success: true,
      data: {
        attendance: { ...attendance, previousPresent },
        salary,
        teamView: {
          totalMembers,
          previousTotalMembers,
        },
        workforce,
        peopleRadar,
      },
    };
  }

  /** Present count on the most recent prior day (<= 7 days back) that has records. */
  private async computePreviousPresent(
    workspaceFilter: Record<string, unknown>,
    activeMemberIds: Types.ObjectId[],
    today: Date,
  ): Promise<number> {
    const weekAgo = new Date(today);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const rows = await this.attendanceModel
      .find({
        workspaceId: workspaceFilter,
        date: { $lt: today, $gte: weekAgo },
        teamMemberId: { $in: activeMemberIds },
      })
      .select('date status')
      .lean<Array<{ date: Date; status: string }>>();
    if (rows.length === 0) return 0;
    let maxTime = -Infinity;
    for (const r of rows) {
      const t = new Date(r.date).getTime();
      if (t > maxTime) maxTime = t;
    }
    return rows.filter((r) => new Date(r.date).getTime() === maxTime && r.status === 'present')
      .length;
  }

  /**
   * Payable / paid roll-up for one month, mirroring the original inline logic
   * (fallback to member.salaryAmount when a salary record is absent / zero) so
   * the current-month numbers are byte-identical to before the refactor.
   */
  private async computeSalaryTotals(
    workspaceFilter: Record<string, unknown>,
    members: SalaryMemberLike[],
    month: number,
    year: number,
  ): Promise<{ totalPayable: number; totalPaid: number; paidEmployeesCount: number }> {
    const salaryRecords = await this.salaryModel
      .find({ workspaceId: workspaceFilter, month, year })
      .lean<Array<SalaryRecordLike & { _id: Types.ObjectId }>>();
    const salaryIds = salaryRecords.map((s) => s._id);
    const salaryIdsStr = salaryIds.map((id) => id.toString());
    const payments = await this.paymentModel
      .find({ workspaceId: workspaceFilter, salaryId: { $in: [...salaryIds, ...salaryIdsStr] } })
      .lean<PaymentLike[]>();

    let totalPayable = 0;
    let totalPaid = 0;
    let paidEmployeesCount = 0;
    members.forEach((member) => {
      const memberId = member._id.toString();
      const record = salaryRecords.find((r) => r.teamMemberId.toString() === memberId);
      const memberPayments = payments.filter((p) => p.teamMemberId.toString() === memberId);
      const memberPaid = memberPayments.reduce((sum, p) => sum + p.amount, 0);
      const baseSalary =
        record && record.baseSalary > 0 ? record.baseSalary : member.salaryAmount || 0;
      const netSalary = record && record.netSalary > 0 ? record.netSalary : baseSalary;
      totalPayable += netSalary;
      totalPaid += memberPaid;
      if (netSalary > 0 && memberPaid >= netSalary) paidEmployeesCount++;
    });
    return { totalPayable, totalPaid, paidEmployeesCount };
  }

  /** Headcount grouped by designation, employment type and shift (desc by count). */
  private async buildWorkforce(
    workspaceFilter: Record<string, unknown>,
    members: ActiveMemberLean[],
    total: number,
  ): Promise<{
    total: number;
    byDesignation: Bucket[];
    byEmploymentType: Bucket[];
    byShift: Bucket[];
  }> {
    const shiftIds = [
      ...new Set(
        members
          .map((m) => m.shiftId)
          .filter(Boolean)
          .map(String),
      ),
    ];
    const shifts = shiftIds.length
      ? await this.shiftModel
          .find({ workspaceId: workspaceFilter, _id: { $in: shiftIds } })
          .select('name')
          .lean<Array<{ _id: Types.ObjectId; name: string }>>()
      : [];
    const shiftNameById = new Map(shifts.map((s) => [String(s._id), s.name]));

    const tally = (keyFn: (m: ActiveMemberLean) => string | null): Bucket[] => {
      const map = new Map<string | null, number>();
      for (const m of members) {
        const k = keyFn(m);
        map.set(k, (map.get(k) ?? 0) + 1);
      }
      return [...map.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
    };

    return {
      total,
      byDesignation: tally((m) => m.designation || null),
      byEmploymentType: tally((m) => m.employmentType || null),
      byShift: tally((m) => (m.shiftId ? (shiftNameById.get(String(m.shiftId)) ?? null) : null)),
    };
  }

  /**
   * People radar: members who joined this calendar month, plus upcoming birthdays
   * and work anniversaries within the next 30 days. Each list is capped at 8 and
   * sorted by soonest. Birthday/anniversary matching is month+day based; an
   * occurrence already past this year rolls to next year before the window check.
   */
  private buildPeopleRadar(
    members: ActiveMemberLean[],
    today: Date,
    startOfMonth: Date,
    currentMonth: number,
    currentYear: number,
  ): {
    newJoiners: Array<{ name: string; designation: string | null; date: string }>;
    birthdays: Array<{ name: string; date: string }>;
    anniversaries: Array<{ name: string; years: number; date: string }>;
  } {
    const monthEnd = new Date(Date.UTC(currentYear, currentMonth, 1, 0, 0, 0, 0)); // first of next month
    const in30 = new Date(today);
    in30.setUTCDate(in30.getUTCDate() + 30);

    const nextOccurrence = (src: Date): Date => {
      const mo = src.getUTCMonth();
      const day = src.getUTCDate();
      let occ = new Date(Date.UTC(currentYear, mo, day, 0, 0, 0, 0));
      if (occ < today) occ = new Date(Date.UTC(currentYear + 1, mo, day, 0, 0, 0, 0));
      return occ;
    };

    const newJoiners = members
      .filter((m) => {
        if (!m.dateOfJoining) return false;
        const doj = new Date(m.dateOfJoining);
        return doj >= startOfMonth && doj < monthEnd;
      })
      .sort((a, b) => new Date(b.dateOfJoining).getTime() - new Date(a.dateOfJoining).getTime())
      .slice(0, 8)
      .map((m) => ({
        name: m.name ?? '',
        designation: m.designation || null,
        date: new Date(m.dateOfJoining).toISOString(),
      }));

    const birthdays = members
      .filter((m) => m.dateOfBirth)
      .map((m) => ({ m, occ: nextOccurrence(new Date(m.dateOfBirth)) }))
      .filter((x) => x.occ >= today && x.occ <= in30)
      .sort((a, b) => a.occ.getTime() - b.occ.getTime())
      .slice(0, 8)
      .map((x) => ({ name: x.m.name ?? '', date: x.occ.toISOString() }));

    const anniversaries = members
      .filter((m) => m.dateOfJoining)
      .map((m) => {
        const doj = new Date(m.dateOfJoining);
        const occ = nextOccurrence(doj);
        return { m, occ, years: occ.getUTCFullYear() - doj.getUTCFullYear() };
      })
      .filter((x) => x.years >= 1 && x.occ >= today && x.occ <= in30)
      .sort((a, b) => a.occ.getTime() - b.occ.getTime())
      .slice(0, 8)
      .map((x) => ({ name: x.m.name ?? '', years: x.years, date: x.occ.toISOString() }));

    return { newJoiners, birthdays, anniversaries };
  }
}
