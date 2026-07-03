import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PayrollConfig } from './schemas/payroll-config.schema';
import { SalaryAdjustment } from './schemas/salary-adjustment.schema';
import { Salary } from './schemas/salary.schema';
// Salary-standalone safeguard (2026-06-20): cross-module ATTENDANCE entitlement
// check. SubscriptionsModule is @Global() so injecting the service needs no
// import wiring in salary.module.ts.
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * SalaryAbsenceLossService
 *
 * D-03: Converts unregularized absences older than the configured
 * `regularizationWindowDays` (default 45) into a next-calendar-month
 * SalaryAdjustment DEDUCTION for the affected member.
 *
 * Idempotency strategy: uses a deterministic `sourceKey` string on the
 * SalaryAdjustment — `absence-loss:{teamMemberId}:{YYYY-MM-DD}` — so
 * re-runs are safe and never double-post (T-26-09).
 *
 * The Attendance and RegularizationRequest models are injected by string
 * token because the salary module already pulls in AttendanceModule via
 * forwardRef, and those schemas are registered in MongooseModule.forFeature
 * in salary.module.ts (see Plan 03 wiring note).
 */
@Injectable()
export class SalaryAbsenceLossService {
  private readonly logger = new Logger(SalaryAbsenceLossService.name);

  constructor(
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    @InjectModel('Attendance')
    private readonly attendanceModel: Model<any>,
    @InjectModel('RegularizationRequest')
    private readonly regularizationRequestModel: Model<any>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    @InjectModel(SalaryAdjustment.name)
    private readonly salaryAdjustmentModel: Model<SalaryAdjustment>,
    // OQ-S5 cascade (#7): TeamMember by name token (schema registered in
    // salary.module) so we can skip soft-deleted members before posting a loss.
    @InjectModel('TeamMember')
    private readonly teamMemberModel: Model<any>,
    // Salary-standalone safeguard (2026-06-20): this cron has its OWN attendance
    // reads with no `attendancePayModeApplied` gate — only salaryLossEnabled. We
    // add a per-workspace ATTENDANCE-module check so no absence_recovery
    // deductions post off stale/empty attendance when ATTENDANCE is OFF.
    // Optional + null-guarded so legacy positional test mocks (which omit it)
    // keep behaving; missing service fail-safes to ATTENDANCE-OFF → skip.
    private readonly subscriptionsService?: SubscriptionsService,
  ) {}

  // Member-state cache for a single cron run so we resolve each member once.
  private removedMemberCache: Set<string> = new Set();
  private activeMemberCache: Set<string> = new Set();

  /** OQ-S5: true when the member is soft-deleted (skip absence-loss posting). */
  private async isMemberRemoved(memberId: string): Promise<boolean> {
    if (this.activeMemberCache.has(memberId)) return false;
    if (this.removedMemberCache.has(memberId)) return true;
    const member = await this.teamMemberModel
      .findById(memberId)
      .select('_id isDeleted')
      .lean()
      .exec();
    const removed = !member || member.isDeleted === true;
    if (removed) this.removedMemberCache.add(memberId);
    else this.activeMemberCache.add(memberId);
    return removed;
  }

  private roundCurrency(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * processExpiredAbsences
   *
   * For a given workspace, finds all ABSENT attendance records older than the
   * configured regularization window, skips those that have an approved
   * RegularizationRequest, and creates a next-month SalaryAdjustment deduction
   * for each un-regularized absence (idempotent via sourceKey).
   *
   * @returns count of newly posted deductions
   */
  async processExpiredAbsences(workspaceId: string): Promise<{ processed: number }> {
    const wsOid = new Types.ObjectId(workspaceId);
    // Reset the per-run member-state cache (the cron reuses this service across
    // workspaces in one tick).
    this.removedMemberCache = new Set();
    this.activeMemberCache = new Set();

    // Load PayrollConfig for workspace
    const config = await this.payrollConfigModel.findOne({ workspaceId: wsOid }).lean().exec();

    const regularizationWindowDays = config?.salaryLossConfig?.regularizationWindowDays ?? 45;
    const salaryLossEnabled = config?.salaryLossConfig?.salaryLossEnabled ?? true;

    // D-03: if salaryLossEnabled === false, skip entirely
    if (salaryLossEnabled === false) {
      return { processed: 0 };
    }

    // Salary-standalone safeguard (2026-06-20): absence-recovery is derived
    // entirely from Attendance ABSENT rows. If the ATTENDANCE module is OFF for
    // this workspace, those rows are stale/absent and must NOT drive new
    // deductions. Resolve the live entitlement once per workspace (request-
    // independent `hasModule`, usable from this cron). Fail-safe: a missing
    // service or a lookup failure → treat ATTENDANCE as OFF → skip.
    let attendanceModuleEnabled = false;
    try {
      attendanceModuleEnabled =
        (await this.subscriptionsService?.hasModule(workspaceId, AppModule.ATTENDANCE)) ?? false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `ATTENDANCE entitlement lookup failed for workspace ${workspaceId}; skipping absence-loss. ${msg}`,
      );
      attendanceModuleEnabled = false;
    }
    if (!attendanceModuleEnabled) {
      return { processed: 0 };
    }

    const cutoff = new Date(Date.now() - regularizationWindowDays * 24 * 60 * 60 * 1000);

    // Query all ABSENT attendance records older than the cutoff for this workspace
    const absentRecords = await this.attendanceModel
      .find({
        workspaceId: wsOid,
        status: 'absent',
        date: { $lt: cutoff },
      })
      .lean()
      .exec();

    if (absentRecords.length === 0) {
      return { processed: 0 };
    }

    let processed = 0;

    for (const absent of absentRecords) {
      try {
        const memberOid = new Types.ObjectId(String(absent.teamMemberId));
        const absenceDate = absent.date as Date;

        // OQ-S5 cascade (#7): never post a new salary loss against a removed
        // member's record (their records are read-only once offboarded).
        if (await this.isMemberRemoved(String(memberOid))) {
          continue;
        }

        // Determine the date string for the idempotency sourceKey
        const dateStr = absenceDate.toISOString().slice(0, 10); // YYYY-MM-DD
        const sourceKey = `absence-loss:${String(memberOid)}:${dateStr}`;

        // Idempotency check: skip if a SalaryAdjustment with this sourceKey already exists
        const existingAdjustment = await this.salaryAdjustmentModel
          .findOne({ workspaceId: wsOid, note: sourceKey })
          .lean()
          .exec();

        if (existingAdjustment) {
          continue;
        }

        // Skip if an approved RegularizationRequest exists for this (member, date).
        // Note: RegularizationRequest uses wsId (not workspaceId) and memberId (not teamMemberId).
        const regularized = await this.regularizationRequestModel
          .findOne({
            wsId: wsOid,
            memberId: memberOid,
            date: absenceDate,
            status: 'approved',
          })
          .lean()
          .exec();

        if (regularized) {
          continue;
        }

        // Compute target month/year: NEXT calendar month from "now"
        const now = new Date();
        let targetMonth = now.getMonth() + 2; // getMonth() is 0-based; +2 = next month 1-based
        let targetYear = now.getFullYear();
        if (targetMonth > 12) {
          targetMonth = 1;
          targetYear += 1;
        }

        // Compute per-day salary loss amount.
        // Find or build the next-month salary record to attach the deduction to.
        const targetSalary = await this.salaryModel
          .findOne({
            workspaceId: wsOid,
            teamMemberId: memberOid,
            month: targetMonth,
            year: targetYear,
          })
          .exec();

        // If the next-month salary record does not yet exist, we cannot attach
        // the adjustment — skip and let the cron retry the next day when the
        // record may have been generated.
        if (!targetSalary) {
          this.logger.debug(
            `No salary record for member ${String(memberOid)} in ${targetMonth}/${targetYear}; deferring absence-loss for ${dateStr}`,
          );
          continue;
        }

        // Per-day rate: baseSalary / totalDays (mirrors calculateNetSalary logic)
        const perDayAmount =
          targetSalary.totalDays > 0
            ? this.roundCurrency(targetSalary.baseSalary / targetSalary.totalDays)
            : 0;

        if (perDayAmount <= 0) {
          continue;
        }

        // Convert to paise (amounts in the system are stored in their native unit;
        // SalaryAdjustment.amount mirrors salaryAmount units — rupees with 2 decimal places).
        // The sourceKey is stored in the `note` field for idempotency.
        const adjustment = new this.salaryAdjustmentModel({
          workspaceId: wsOid,
          salaryId: new Types.ObjectId(String(targetSalary._id)),
          teamMemberId: memberOid,
          month: targetMonth,
          year: targetYear,
          type: 'deduction',
          category: 'absence_recovery',
          amount: perDayAmount,
          source: 'system',
          reasonTitle: `Unregularized absence on ${dateStr}`,
          note: sourceKey, // idempotency marker — absence-loss:{memberId}:{YYYY-MM-DD}
          attachments: [],
          status: 'active',
          createdBy: memberOid,
        });

        await adjustment.save();
        processed++;

        this.logger.debug(
          `Posted absence-loss deduction for member ${String(memberOid)} on ${dateStr} → ${targetMonth}/${targetYear}, amount=${perDayAmount}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to process absence-loss for record ${String(absent._id)}: ${msg}`,
        );
      }
    }

    return { processed };
  }
}
