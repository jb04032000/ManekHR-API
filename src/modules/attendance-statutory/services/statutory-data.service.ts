import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OtRateResolver } from './ot-rate-resolver.service';
import { computeWorkingDaysInMonth, DEFAULT_WORKING_DAYS_MON_SAT } from '../utils/working-days.util';
import type {
  StatutoryMeta,
  AttendanceSummaryRow,
  AttendanceDailyRow,
  OtSummaryRow,
  OtSummaryRowDay,
  LopSummaryRow,
  LopDayRow,
  PfEsiWageRow,
} from '../types/statutory.types';

// Statutory ceilings (per G-RESEARCH.md §Assumptions A2)
const PF_WAGE_CEILING = 15000;
const ESI_WAGE_CEILING = 21000;
const STANDARD_SHIFT_MINUTES = 480; // 8 hrs default when member has no shift assigned

@Injectable()
export class StatutoryDataService {
  constructor(
    @InjectModel('Attendance') private readonly attendanceModel: Model<any>,
    @InjectModel('Salary') private readonly salaryModel: Model<any>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
    @InjectModel('Shift') private readonly shiftModel: Model<any>,
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    private readonly otRateResolver: OtRateResolver,
  ) {}

  async loadWorkspaceMeta(
    workspaceId: string,
    from: string,
    to: string,
    generatedByName?: string,
  ): Promise<StatutoryMeta> {
    const ws = (await this.workspaceModel
      .findById(workspaceId)
      .select('name address')
      .lean()) as { name?: string; address?: string } | null;
    if (!ws) throw new NotFoundException(`Workspace ${workspaceId} not found`);
    return {
      workspaceId,
      workspaceName: ws.name ?? 'Workspace',
      workspaceAddress: ws.address,
      from,
      to,
      generatedAt: new Date(),
      generatedByName,
    };
  }

  /**
   * Query active, non-deleted members in the workspace, optionally filtered to memberScope.
   * Returns a sorted list (by name asc) with fields generators need.
   */
  private async loadMembers(workspaceId: string, memberScope?: string[]) {
    const filter: any = { workspaceId, isActive: true, isDeleted: false };
    if (memberScope?.length) {
      filter._id = { $in: memberScope.map((id) => new Types.ObjectId(id)) };
    }
    return this.teamMemberModel
      .find(filter)
      .select('name employeeCode designation uan esiIpNumber ctcAmount shiftId')
      .sort({ name: 1 })
      .lean();
  }

  /**
   * Compute shift duration in minutes, honouring midnight-crossing shifts
   * (parity with attendance/projection/compute.ts parseShiftTime logic).
   * Returns STANDARD_SHIFT_MINUTES when the shift doc is null / malformed.
   * H3-04 — closes GAP-3.3-B.
   */
  private shiftDurationMinutesFor(
    shift: { startTime?: string; endTime?: string } | null,
  ): number {
    if (!shift?.startTime || !shift?.endTime) return STANDARD_SHIFT_MINUTES;
    const [sh, sm] = shift.startTime.split(':').map(Number);
    const [eh, em] = shift.endTime.split(':').map(Number);
    if (
      Number.isNaN(sh) || Number.isNaN(sm) ||
      Number.isNaN(eh) || Number.isNaN(em)
    ) {
      return STANDARD_SHIFT_MINUTES;
    }
    const startMin = sh * 60 + sm;
    let endMin = eh * 60 + em;
    if (endMin <= startMin) endMin += 1440; // midnight-cross
    const duration = endMin - startMin;
    return duration > 0 ? duration : STANDARD_SHIFT_MINUTES;
  }

  /**
   * Batch-load shifts for a set of members and return a
   * Map<memberId, shiftDurationMinutes>.
   * Members without a shiftId default to STANDARD_SHIFT_MINUTES.
   */
  private async loadShiftDurationMap(
    members: Array<{ _id: any; shiftId?: any }>,
  ): Promise<Map<string, number>> {
    const shiftIds = members
      .map((m) => m.shiftId)
      .filter((s): s is any => !!s)
      .map((s) => new Types.ObjectId(String(s)));
    const shifts = shiftIds.length
      ? await this.shiftModel
          .find({ _id: { $in: shiftIds } })
          .select('_id startTime endTime')
          .lean()
          .exec()
      : [];
    const byShiftId = new Map<string, any>();
    for (const s of shifts as any[]) byShiftId.set(String(s._id), s);
    const byMember = new Map<string, number>();
    for (const m of members) {
      const shiftDoc = m.shiftId ? (byShiftId.get(String(m.shiftId)) ?? null) : null;
      // shiftDurationMinutesFor returns STANDARD_SHIFT_MINUTES when shiftDoc is null
      byMember.set(String(m._id), this.shiftDurationMinutesFor(shiftDoc));
    }
    return byMember;
  }

  /**
   * Query raw Attendance projection rows for a date range + member scope.
   * Uses AttendanceModel directly (no dedicated service method — per G-RESEARCH.md §5).
   * Returns Map<memberId, AttendanceDailyRow[]> sorted by date ascending per member.
   * Per-member chunked queries — prevents unbounded result set when range spans
   * multiple months × many members (Phase G row 2 — BUG-07). H3-04.
   */
  private async loadAttendanceRows(
    workspaceId: string,
    memberIds: Types.ObjectId[],
    fromDate: Date,
    toDate: Date,
  ): Promise<Map<string, AttendanceDailyRow[]>> {
    const byMember = new Map<string, AttendanceDailyRow[]>();
    // Chunked per-member query — prevents unbounded result set when range spans
    // multiple months × many members (Phase G row 2 — BUG-07).
    for (const mid of memberIds) {
      const rows = await this.attendanceModel
        .find({
          workspaceId,
          date: { $gte: fromDate, $lte: toDate },
          teamMemberId: mid,
        })
        .select(
          'teamMemberId date status checkIn checkOut workedMinutes lateMinutes otMinutes computeReason',
        )
        .sort({ date: 1 })
        .lean();
      const list: AttendanceDailyRow[] = [];
      for (const r of rows as any[]) {
        const d: Date = r.date;
        list.push({
          date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
          status: r.status,
          checkIn: r.checkIn ?? null,
          checkOut: r.checkOut ?? null,
          workedMinutes: r.workedMinutes ?? null,
          lateMinutes: r.lateMinutes ?? null,
          otMinutes: r.otMinutes ?? null,
          computeReason: r.computeReason ?? null,
        });
      }
      byMember.set(String(mid), list);
    }
    return byMember;
  }

  async buildAttendanceSummaries(
    workspaceId: string,
    from: string,
    to: string,
    memberScope?: string[],
  ): Promise<AttendanceSummaryRow[]> {
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);
    const members = await this.loadMembers(workspaceId, memberScope);
    const memberIds = members.map((m: any) => m._id as Types.ObjectId);
    const byMember = await this.loadAttendanceRows(workspaceId, memberIds, fromDate, toDate);

    return members.map((m: any) => {
      const days = byMember.get(String(m._id)) ?? [];
      let totalPresentDays = 0, totalAbsentDays = 0, totalLateDays = 0, totalHalfDays = 0;
      let totalOtMinutes = 0, totalWorkedMinutes = 0;
      for (const d of days) {
        if (d.status === 'present') totalPresentDays++;
        else if (d.status === 'absent') totalAbsentDays++;
        else if (d.status === 'late') { totalPresentDays++; totalLateDays++; }
        else if (d.status === 'half_day') totalHalfDays++;
        totalOtMinutes += d.otMinutes ?? 0;
        totalWorkedMinutes += d.workedMinutes ?? 0;
      }
      return {
        memberId: String(m._id),
        name: m.name ?? '',
        employeeCode: m.employeeCode ?? null,
        designation: m.designation ?? null,
        days,
        totalPresentDays,
        totalAbsentDays,
        totalLateDays,
        totalHalfDays,
        totalOtMinutes,
        totalWorkedMinutes,
      };
    });
  }

  /**
   * Per Factories Act §59: OT amount = ordinaryHourlyRate × 2 × otHours.
   * ordinaryHourlyRate = dailyRate / (shiftDurationMinutes / 60) — per-shift aware (H3-04, GAP-3.3-B).
   * So: otAmount = dailyRate × 2 × (otMinutes / 60) / (shiftDurMin / 60)
   *             = dailyRate × 2 × otMinutes / shiftDurMin
   * STANDARD_SHIFT_MINUTES (480) is the fallback when member has no shift assigned.
   */
  async buildOtSummaries(
    workspaceId: string,
    from: string,
    to: string,
    memberScope?: string[],
    customDailyRate?: number,
  ): Promise<OtSummaryRow[]> {
    const members = await this.loadMembers(workspaceId, memberScope);
    const shiftDurByMember = await this.loadShiftDurationMap(members as any[]);
    const attSummaries = await this.buildAttendanceSummaries(workspaceId, from, to, memberScope);
    // Use the reference month of `from` for OT cascade (simpler than per-day month detection).
    // If the range spans multiple months, we still use `from`'s month — acceptable per DG-4.
    const ref = new Date(`${from}T00:00:00.000Z`);
    const refYear = ref.getUTCFullYear();
    const refMonth = ref.getUTCMonth() + 1;
    const workingDays = computeWorkingDaysInMonth(refYear, refMonth, DEFAULT_WORKING_DAYS_MON_SAT);

    const out: OtSummaryRow[] = [];
    for (const row of attSummaries) {
      const otDaysOnly = row.days.filter((d) => (d.otMinutes ?? 0) > 0);
      if (otDaysOnly.length === 0) {
        out.push({
          memberId: row.memberId, name: row.name,
          employeeCode: row.employeeCode, designation: row.designation,
          days: [], totalOtMinutes: 0, totalOtAmount: 0,
        });
        continue;
      }
      const rate = await this.otRateResolver.resolve(
        workspaceId, row.memberId, refYear, refMonth, workingDays, customDailyRate,
      );
      const shiftDurMin = shiftDurByMember.get(row.memberId) ?? STANDARD_SHIFT_MINUTES;
      const days: OtSummaryRowDay[] = otDaysOnly.map((d) => {
        const otMin = d.otMinutes ?? 0;
        // otAmount = dailyRate × 2 × otMin / shiftDurMin (per-shift-aware Factories Act §59 formula)
        const otAmount = shiftDurMin > 0
          ? Math.round((rate.dailyRate * 2 * otMin) / shiftDurMin * 100) / 100
          : 0;
        return {
          date: d.date, otMinutes: otMin,
          dailyRate: Math.round(rate.dailyRate * 100) / 100,
          otAmount, rateSource: rate.source,
        };
      });
      const totalOtMinutes = days.reduce((s, d) => s + d.otMinutes, 0);
      const totalOtAmount = Math.round(days.reduce((s, d) => s + d.otAmount, 0) * 100) / 100;
      out.push({
        memberId: row.memberId, name: row.name,
        employeeCode: row.employeeCode, designation: row.designation,
        days, totalOtMinutes, totalOtAmount,
      });
    }
    return out;
  }

  async buildLopSummaries(
    workspaceId: string,
    from: string,
    to: string,
    memberScope?: string[],
  ): Promise<LopSummaryRow[]> {
    const attSummaries = await this.buildAttendanceSummaries(workspaceId, from, to, memberScope);
    const ref = new Date(`${from}T00:00:00.000Z`);
    const refYear = ref.getUTCFullYear();
    const refMonth = ref.getUTCMonth() + 1;
    // Load per-member shift durations for accurate LOP math (H3-04, GAP-3.3-B + GAP-2.1-C).
    const shiftDurByMember = await this.loadShiftDurationMap(
      await this.loadMembers(workspaceId, memberScope) as any[],
    );

    const out: LopSummaryRow[] = [];
    for (const row of attSummaries) {
      // Load baseSalary for reference month (nullable)
      const salaryDoc = (await this.salaryModel
        .findOne({ workspaceId, teamMemberId: row.memberId, year: refYear, month: refMonth })
        .select('baseSalary totalDays')
        .lean()) as { baseSalary?: number; totalDays?: number } | null;
      const baseSalary = salaryDoc?.baseSalary ?? null;

      const lopDays: LopDayRow[] = [];
      let totalLopMinutes = 0;
      let totalLopDays = 0;
      for (const d of row.days) {
        const shiftDur = shiftDurByMember.get(row.memberId) ?? STANDARD_SHIFT_MINUTES;
        const worked = d.workedMinutes;
        // GAP-2.1-C: null workedMinutes (no checkout) — record as data-quality row,
        // do NOT inflate LOP. Surfaces in the PDF via computeReason annotation.
        if (worked === null || worked === undefined) {
          const isLopStatus = d.status === 'absent' || d.status === 'half_day' || d.status === 'late';
          if (isLopStatus) {
            lopDays.push({
              date: d.date,
              status: d.status,
              shiftDurationMinutes: shiftDur,
              workedMinutes: null,
              lopMinutes: 0,
              computeReason: d.computeReason
                ? `${d.computeReason}; missing_checkout`
                : 'missing_checkout',
            });
          }
          continue;
        }
        // LOP formula per Phase C (DC-6): lopMinutes = max(0, shiftDur - workedMinutes) only when a workday
        // Count only actual LOP-producing statuses: absent, half_day, or late-with-partial-work
        const isLopStatus = d.status === 'absent' || d.status === 'half_day' ||
          (d.status === 'late' && worked < shiftDur);
        if (!isLopStatus) continue;
        const lopMin = Math.max(0, shiftDur - worked);
        if (lopMin === 0) continue;
        lopDays.push({
          date: d.date, status: d.status,
          shiftDurationMinutes: shiftDur,
          workedMinutes: worked,
          lopMinutes: lopMin,
          computeReason: d.computeReason,
        });
        totalLopMinutes += lopMin;
        if (d.status === 'absent') totalLopDays += 1;
        else if (d.status === 'half_day') totalLopDays += 0.5;
      }

      // Deduction = baseSalary * totalLopMinutes / (totalDays × shiftDur) per-shift-aware (H3-04)
      let deductionAmount: number | null = null;
      if (baseSalary !== null && baseSalary > 0) {
        const perMemberShiftDur = shiftDurByMember.get(row.memberId) ?? STANDARD_SHIFT_MINUTES;
        const totalMonthMinutes = (salaryDoc?.totalDays ?? 30) * perMemberShiftDur;
        deductionAmount = totalMonthMinutes > 0
          ? Math.round((baseSalary * totalLopMinutes / totalMonthMinutes) * 100) / 100
          : 0;
      }

      out.push({
        memberId: row.memberId, name: row.name,
        employeeCode: row.employeeCode, designation: row.designation,
        days: lopDays, totalLopMinutes, totalLopDays,
        baseSalary, deductionAmount,
      });
    }
    return out;
  }

  async buildPfEsiRows(
    workspaceId: string,
    from: string,
    to: string,
    memberScope?: string[],
  ): Promise<PfEsiWageRow[]> {
    const ref = new Date(`${from}T00:00:00.000Z`);
    const refYear = ref.getUTCFullYear();
    const refMonth = ref.getUTCMonth() + 1;
    const members = await this.loadMembers(workspaceId, memberScope);
    const out: PfEsiWageRow[] = [];
    for (const m of members as any[]) {
      const salaryDoc = (await this.salaryModel
        .findOne({ workspaceId, teamMemberId: m._id, year: refYear, month: refMonth })
        .select('baseSalary totalDays presentDays')
        .lean()) as { baseSalary?: number; totalDays?: number; presentDays?: number } | null;
      const grossWages = Number(salaryDoc?.baseSalary ?? m.ctcAmount ?? 0);
      if (grossWages <= 0) continue;

      // PF math — mirrors ComplianceExportService.buildEcrData
      const epfWages = Math.min(grossWages, PF_WAGE_CEILING);
      const epfContrib = Math.round(epfWages * 0.12);
      const epsContrib = Math.min(Math.round(epfWages * 0.0833), 1250);
      const epfDiff = epfContrib - epsContrib;
      const ncpDays = Math.max((salaryDoc?.totalDays ?? 0) - (salaryDoc?.presentDays ?? 0), 0);

      // ESI math — ceiling gate
      const esiApplicable = grossWages <= ESI_WAGE_CEILING;
      const employeeEsi = esiApplicable ? Math.round(grossWages * 0.0075) : 0;
      const employerEsi = esiApplicable ? Math.round(grossWages * 0.0325) : 0;

      out.push({
        memberId: String(m._id),
        name: m.name ?? '',
        employeeCode: m.employeeCode ?? null,
        uan: m.uan ?? null,
        esiIpNumber: m.esiIpNumber ?? null,
        grossWages,
        epfWages, epsWages: epfWages, edliWages: epfWages,
        employeeEpfContribution: epfContrib,
        employerEpsContribution: epsContrib,
        employerEpfDifference: epfDiff,
        ncpDays,
        refundOfAdvances: 0,
        employeeEsiContribution: employeeEsi,
        employerEsiContribution: employerEsi,
        esiApplicable,
      });
    }
    return out;
  }
}
