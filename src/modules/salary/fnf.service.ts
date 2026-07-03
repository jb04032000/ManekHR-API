import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FnfSettlement } from './schemas/fnf-settlement.schema';
import { GratuityService } from './gratuity.service';
import { Salary } from './schemas/salary.schema';
import { SalaryAdjustment } from './schemas/salary-adjustment.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { LeaveBalance } from '../leave/schemas/leave-balance.schema';
import { LeaveType } from '../leave/schemas/leave-type.schema';
import { EncashmentRecord } from '../leave/schemas/encashment-record.schema';
import {
  AdvanceRecoveryPlan,
  AdvanceRecoveryPlanDocument,
} from './schemas/advance-recovery-plan.schema';
import { EmployerLoan, EmployerLoanDocument } from './schemas/employer-loan.schema';
import { PayrollConfig } from './schemas/payroll-config.schema';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';

type FnfLineItem = {
  description: string;
  amount: number;
};

type InitiateFnfDto = {
  lastWorkingDate: string;
  noticePeriodDays: number;
  noticeServedDays: number;
  /** Omitted → auto-computed from the leave balance; an explicit value (incl. 0) is a manual override. */
  leaveBalanceDays?: number;
  otherAdditions?: FnfLineItem[];
  otherDeductions?: FnfLineItem[];
  notes?: string;
  resignationReason?: string;
};

@Injectable()
export class FnfService {
  constructor(
    @InjectModel(FnfSettlement.name)
    private fnfModel: Model<FnfSettlement>,
    @InjectModel(Salary.name)
    private salaryModel: Model<Salary>,
    @InjectModel(SalaryAdjustment.name)
    private adjustmentModel: Model<SalaryAdjustment>,
    @InjectModel(TeamMember.name)
    private teamModel: Model<TeamMember>,
    @InjectModel(LeaveBalance.name)
    private leaveBalanceModel: Model<LeaveBalance>,
    @InjectModel(LeaveType.name)
    private leaveTypeModel: Model<LeaveType>,
    @InjectModel(EncashmentRecord.name)
    private encashmentModel: Model<EncashmentRecord>,
    @InjectModel(AdvanceRecoveryPlan.name)
    private advancePlanModel: Model<AdvanceRecoveryPlanDocument>,
    // EmployerLoan is injected directly (not via LoanService) to avoid a
    // circular dependency: SalaryService -> FnfService -> LoanService ->
    // SalaryService. The same pattern is used for AdvanceRecoveryPlan above.
    @InjectModel(EmployerLoan.name)
    private employerLoanModel: Model<EmployerLoanDocument>,
    // PayrollConfig is injected to read bonusConfig.clawbackMonthsDefault for
    // bonus clawback calculation at F&F time. No circular dependency: PayrollConfig
    // is a plain schema model with no service injection.
    @InjectModel(PayrollConfig.name)
    private payrollConfigModel: Model<PayrollConfig>,
    private gratuityService: GratuityService,
    private auditService: AuditService,
  ) {}

  computeLeaveEncashment(lastBasicSalary: number, leaveBalanceDays: number): number {
    return Math.round((lastBasicSalary / 26) * leaveBalanceDays);
  }

  /**
   * Auto-compute a separating member's encashable leave days — L4b event-based
   * read of the leave module (no FK). Sums `LeaveBalance.available` for
   * encashable leave types in the exit year, plus any still-pending
   * `EncashmentRecord` days (year-end encashments not yet paid out). The two
   * are disjoint — a recorded encashment was already debited from `available`.
   */
  async computeEncashableLeaveDays(
    workspaceId: string,
    teamMemberId: string,
    year: number,
  ): Promise<number> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberId = new Types.ObjectId(teamMemberId);

    const encashableTypes = await this.leaveTypeModel
      .find({ workspaceId: wsId, 'yearEndRule.encashable': true })
      .select('_id')
      .lean()
      .exec();

    let balanceDays = 0;
    if (encashableTypes.length > 0) {
      const balances = await this.leaveBalanceModel
        .find({
          workspaceId: wsId,
          teamMemberId: memberId,
          year,
          leaveTypeId: { $in: encashableTypes.map((t) => t._id) },
        })
        .select('available')
        .lean()
        .exec();
      balanceDays = balances.reduce((sum, b) => sum + Math.max(0, b.available), 0);
    }

    const pending = await this.encashmentModel
      .find({ workspaceId: wsId, teamMemberId: memberId, status: 'pending' })
      .select('days')
      .lean()
      .exec();
    const pendingDays = pending.reduce((sum, r) => sum + r.days, 0);

    return balanceDays + pendingDays;
  }

  computeNoticeRecovery(
    lastBasicSalary: number,
    noticePeriodDays: number,
    noticeServedDays: number,
  ): {
    shortfallDays: number;
    recoveryAmount: number;
  } {
    const shortfallDays = Math.max(noticePeriodDays - noticeServedDays, 0);
    const recoveryAmount = Math.round((lastBasicSalary / 26) * shortfallDays);
    return { shortfallDays, recoveryAmount };
  }

  /**
   * Compute F&F totals with gratuity protection (Rule 5 - Payment of Gratuity
   * Act 1972). Gratuity is legally protected from attachment and therefore
   * cannot be used to recover advance or loan dues.
   *
   * Recovery priority (applied against the non-gratuity pool in order):
   *   1. Notice recovery + misc deductions (first).
   *   2. Outstanding advance recovery (second).
   *   3. Outstanding loan recovery (third - spec section 7.3).
   *
   * Any residual that cannot be recovered from the non-gratuity pool is
   * surfaced via the respective residual fields so the owner can follow up.
   *
   * Edge-case note (spec 6f): getOutstandingAdvances reads active
   * advance_recovery adjustments directly. getOutstandingLoanAmount reads
   * EmployerLoan.remainingAmount. Neither calls refreshPlanProgress to avoid
   * a circular dependency with SalaryService (which injects FnfService).
   */
  computeFnfTotals(settlement: Partial<FnfSettlement>): {
    totalEarnings: number;
    totalDeductions: number;
    netFnfPayable: number;
    advanceRecoverableFromDues: number;
    bonusClawbackRecoverable: number;
    advanceResidualUnrecovered: number;
    loanRecoverableFromDues: number;
    loanResidualUnrecovered: number;
  } {
    // Non-gratuity pool: everything the advance/loan/bonus may be recovered from.
    const nonGratuityEarnings =
      (settlement.lastMonthNetSalary || 0) +
      (settlement.leaveEncashmentAmount || 0) +
      (settlement.otherAdditions || []).reduce((sum, item) => sum + item.amount, 0);

    // Other deductions (notice recovery + misc) are applied first against the
    // non-gratuity pool before advance/loan recovery gets access to it.
    const otherDeductions =
      (settlement.noticeRecoveryAmount || 0) +
      (settlement.otherDeductions || []).reduce((sum, item) => sum + item.amount, 0);

    // Advance recovery is applied second.
    const availableForAdvanceRecovery = Math.max(0, nonGratuityEarnings - otherDeductions);
    const outstandingAdvance = settlement.outstandingAdvanceAmount || 0;
    const advanceRecoverableFromDues = Math.min(outstandingAdvance, availableForAdvanceRecovery);
    const advanceResidualUnrecovered = Math.max(0, outstandingAdvance - advanceRecoverableFromDues);

    // Loan recovery is applied third against whatever remains after advance.
    const availableForLoanRecovery = Math.max(
      0,
      availableForAdvanceRecovery - advanceRecoverableFromDues,
    );
    const outstandingLoan = settlement.outstandingLoanAmount || 0;
    const loanRecoverableFromDues = Math.min(outstandingLoan, availableForLoanRecovery);
    const loanResidualUnrecovered = Math.max(0, outstandingLoan - loanRecoverableFromDues);

    // Bonus clawback is applied fourth (Phase 3A) against whatever remains after
    // advance + loan. Gratuity is always protected (Payment of Gratuity Act 1972).
    const availableForBonusClawback = Math.max(
      0,
      availableForLoanRecovery - loanRecoverableFromDues,
    );
    const bonusClawback = settlement.bonusClawbackAmount || 0;
    const bonusClawbackRecoverable = Math.min(bonusClawback, availableForBonusClawback);

    // Gratuity is added to total earnings but is never part of the recoverable
    // pool (Payment of Gratuity Act 1972 - no override path).
    const totalEarnings = nonGratuityEarnings + (settlement.gratuityAmount || 0);
    const totalDeductions =
      otherDeductions +
      advanceRecoverableFromDues +
      loanRecoverableFromDues +
      bonusClawbackRecoverable;
    const netFnfPayable = Math.max(0, totalEarnings - totalDeductions);

    return {
      totalEarnings,
      totalDeductions,
      netFnfPayable,
      advanceRecoverableFromDues,
      advanceResidualUnrecovered,
      loanRecoverableFromDues,
      loanResidualUnrecovered,
      bonusClawbackRecoverable,
    };
  }

  /**
   * Compute the bonus clawback amount for a member at F&F time.
   *
   * Queries bonus SalaryAdjustments disbursed within the clawback window.
   * No circular dep: adjustmentModel already injected into FnfService.
   * payrollConfigModel injected directly (same as EmployerLoan - no service layer needed).
   *
   * Clawback window: bonusConfig.clawbackMonthsDefault months before lastWorkingDate.
   * 0 = clawback disabled.
   *
   * Gratuity is always protected (this deduction comes from non-gratuity pool).
   * Spec: phase-3-bonus-commission-ledger.md section 4A FnF integration.
   */
  async computeBonusClawbackAmount(
    wsId: Types.ObjectId,
    memberId: Types.ObjectId,
    lastWorkingDate: Date,
  ): Promise<number> {
    // Read the workspace's bonus clawback window from PayrollConfig.
    const config = await this.payrollConfigModel
      .findOne({ workspaceId: wsId })
      .select('bonusConfig')
      .lean()
      .exec();

    const clawbackMonths: number = (config as any)?.bonusConfig?.clawbackMonthsDefault ?? 0;

    if (clawbackMonths <= 0) {
      return 0;
    }

    // Window start: clawbackMonths before lastWorkingDate.
    const windowStart = new Date(lastWorkingDate);
    windowStart.setMonth(windowStart.getMonth() - clawbackMonths);

    const result = await this.adjustmentModel.aggregate([
      {
        $match: {
          workspaceId: wsId,
          teamMemberId: memberId,
          category: 'bonus',
          type: 'addition',
          status: 'active',
          createdAt: { $gte: windowStart, $lte: lastWorkingDate },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    return Math.round((result[0]?.total ?? 0) * 100) / 100;
  }

  /**
   * TRUE, FRESH outstanding advance for a leaver's Full & Final (plan §6.8).
   *
   * outstanding = sum over active|paused plans of (totalAmount - elapsed installments)
   *             + sum of non-plan (legacy lump) advance_recovery deductions whose
   *               target month is current-or-future (an elapsed lump was already
   *               deducted in a closed month, so it is no longer outstanding).
   *
   * We do NOT read plan.remainingAmount: it is only recomputed by
   * SalaryService.refreshPlanProgress on plan EDITS (pause/resume/edit/early-payoff),
   * never on ordinary month roll-over, so it is stale-high between edits and would
   * over-charge the leaver at this money-final moment. Instead we recompute
   * `totalAmount - sum(elapsed active installments)` LIVE (same rule as
   * refreshPlanProgress, run here so it reflects the current month), which also
   * captures any un-schedulable residual (totalAmount minus what was actually
   * recovered). Legacy lumps stay status:'active' forever after recovery, so they
   * MUST be month-filtered or an already-recovered lump is double-deducted.
   *
   * Mirrors the worker-facing SalaryService.getOutstandingAdvances /
   * fetchOutstandingBalanceInternal (future-active-adjustment logic) so F&F nets
   * exactly what the worker sees as outstanding. Kept self-contained (no
   * SalaryService dependency) to avoid the SalaryService <-> FnfService cycle.
   *
   * Links: salary.service.ts refreshPlanProgress (~2610) + createAdvanceRecoveryDeduction
   * (legacy lump, no plan); advance-recovery-plan.schema.ts.
   */
  async getOutstandingAdvances(workspaceId: string, teamMemberId: string): Promise<number> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberId = new Types.ObjectId(teamMemberId);

    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();
    // Strictly-before the current month = already recovered (mirrors refreshPlanProgress).
    const isElapsed = (m: number, y: number): boolean =>
      y < curYear || (y === curYear && m < curMonth);

    // Active/paused recovery plans for the member.
    const plans = (await this.advancePlanModel
      .find({
        workspaceId: wsId,
        teamMemberId: memberId,
        status: { $in: ['active', 'paused'] },
      })
      .select('totalAmount linkedAdjustmentIds')
      .lean()
      .exec()) as Array<{ totalAmount?: number; linkedAdjustmentIds?: Types.ObjectId[] }>;

    // All active advance-recovery deduction rows for the member. Plan installments
    // AND legacy single-month lumps both carry category 'advance_recovery'.
    const adjustments = (await this.adjustmentModel
      .find({
        workspaceId: wsId,
        teamMemberId: memberId,
        category: 'advance_recovery',
        type: 'deduction',
        status: 'active',
      })
      .select('_id month year amount')
      .lean()
      .exec()) as Array<{ _id: Types.ObjectId; month: number; year: number; amount: number }>;

    const adjById = new Map(adjustments.map((a) => [String(a._id), a]));
    const planLinkedIds = new Set<string>();

    // 1. Plan-based outstanding: totalAmount - sum(elapsed active installments),
    //    recomputed live. Includes any un-schedulable residual.
    let planOutstanding = 0;
    for (const plan of plans) {
      let elapsedRecovered = 0;
      for (const id of plan.linkedAdjustmentIds ?? []) {
        const key = String(id);
        planLinkedIds.add(key);
        const adj = adjById.get(key);
        if (adj && isElapsed(adj.month, adj.year)) elapsedRecovered += adj.amount ?? 0;
      }
      planOutstanding += Math.max(0, (plan.totalAmount ?? 0) - elapsedRecovered);
    }

    // 2. Legacy lumps: non-plan advance-recovery deductions not yet recovered
    //    (target month is current or future). Excluding plan-linked ids prevents
    //    double-counting against the plan portion above.
    let legacyOutstanding = 0;
    for (const adj of adjustments) {
      if (planLinkedIds.has(String(adj._id))) continue;
      if (!isElapsed(adj.month, adj.year)) legacyOutstanding += adj.amount ?? 0;
    }

    return Math.round((planOutstanding + legacyOutstanding) * 100) / 100;
  }

  /**
   * Sum of remainingAmount across all active (and paused) employer loans for a
   * member. Used by initiateFnf to populate outstandingLoanAmount.
   *
   * Reads directly from EmployerLoan.remainingAmount (not via LoanService) to
   * avoid a circular dependency: SalaryService -> FnfService -> LoanService ->
   * SalaryService. Same pattern used for AdvanceRecoveryPlan above.
   *
   * Spec: phase-2-loan-module.md section 7.3
   */
  async getOutstandingLoanAmount(workspaceId: string, teamMemberId: string): Promise<number> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberId = new Types.ObjectId(teamMemberId);

    const loans = await this.employerLoanModel
      .find({
        workspaceId: wsId,
        teamMemberId: memberId,
        status: { $in: ['active', 'paused'] },
      })
      .select('remainingAmount')
      .lean()
      .exec();

    const total = loans.reduce((sum, l) => sum + (l.remainingAmount ?? 0), 0);
    return Math.round((total + Number.EPSILON) * 100) / 100;
  }

  async initiateFnf(
    workspaceId: string,
    teamMemberId: string,
    dto: InitiateFnfDto,
    userId: string,
  ): Promise<FnfSettlement> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberId = new Types.ObjectId(teamMemberId);
    const userObjId = new Types.ObjectId(userId);

    const existing = await this.fnfModel
      .findOne({ workspaceId: wsId, teamMemberId: memberId })
      .exec();

    if (existing && existing.status !== 'draft') {
      throw new BadRequestException(
        'FnF settlement has already been finalised and cannot be edited',
      );
    }

    const member = await this.teamModel
      .findById(memberId)
      .select('name dateOfJoining dateOfResignation salaryAmount salaryType')
      .exec();

    if (!member) {
      throw new NotFoundException('Team member not found');
    }

    const lastWorkingDate = new Date(dto.lastWorkingDate);
    if (Number.isNaN(lastWorkingDate.getTime())) {
      throw new BadRequestException('Invalid lastWorkingDate');
    }

    const dateOfJoining = member.dateOfJoining ? new Date(member.dateOfJoining) : null;

    let gratuityEligible = false;
    let gratuityAmount = 0;
    let completedYears = 0;
    let completedMonths = 0;

    if (dateOfJoining) {
      const gratuityResult = this.gratuityService.computeFnfGratuity(
        member.salaryAmount || 0,
        dateOfJoining,
        lastWorkingDate,
      );

      gratuityEligible = gratuityResult.isEligible;
      gratuityAmount = gratuityResult.gratuityAmount;
      completedYears = gratuityResult.completedYears;
      completedMonths = gratuityResult.completedMonths;
    }

    // L4b: an explicit `dto.leaveBalanceDays` (incl. 0) is a manual override;
    // omitted → auto-compute the encashable balance from the leave module.
    const manualLeaveEntry = typeof dto.leaveBalanceDays === 'number';
    const leaveBalanceDays =
      typeof dto.leaveBalanceDays === 'number'
        ? dto.leaveBalanceDays
        : await this.computeEncashableLeaveDays(
            workspaceId,
            teamMemberId,
            lastWorkingDate.getFullYear(),
          );

    const leaveEncashmentAmount = this.computeLeaveEncashment(
      member.salaryAmount || 0,
      leaveBalanceDays,
    );

    const { shortfallDays, recoveryAmount } = this.computeNoticeRecovery(
      member.salaryAmount || 0,
      dto.noticePeriodDays,
      dto.noticeServedDays,
    );

    const [outstandingAdvanceAmount, outstandingLoanAmount] = await Promise.all([
      this.getOutstandingAdvances(workspaceId, teamMemberId),
      this.getOutstandingLoanAmount(workspaceId, teamMemberId),
    ]);

    // Bonus clawback: query bonus SalaryAdjustments disbursed within the clawback
    // window. Reads PayrollConfig.bonusConfig.clawbackMonthsDefault to determine
    // the window. No circular dep: adjustmentModel already injected; payrollConfigModel
    // is injected directly (not via BonusService) for the same reason as EmployerLoan.
    const bonusClawbackAmount = await this.computeBonusClawbackAmount(
      wsId,
      memberId,
      lastWorkingDate,
    );

    const exitMonth = lastWorkingDate.getMonth() + 1;
    const exitYear = lastWorkingDate.getFullYear();

    const lastSalaryRecord = await this.salaryModel
      .findOne({
        workspaceId: wsId,
        teamMemberId: memberId,
        month: exitMonth,
        year: exitYear,
      })
      .exec();

    const lastMonthNetSalary = lastSalaryRecord?.netSalary || 0;

    const settlementData: Partial<FnfSettlement> = {
      workspaceId: wsId,
      teamMemberId: memberId,
      dateOfJoining: dateOfJoining || new Date(),
      lastWorkingDate,
      resignationReason: dto.resignationReason || '',
      completedYears,
      completedMonths,
      lastBasicSalary: member.salaryAmount || 0,
      lastGrossSalary: lastSalaryRecord
        ? (lastSalaryRecord.baseSalary || 0) + (lastSalaryRecord.additions || 0)
        : member.salaryAmount || 0,
      lastSalaryRecordId: lastSalaryRecord?._id || undefined,
      lastMonthNetSalary,
      gratuityEligible,
      gratuityAmount,
      leaveBalanceDays,
      leaveEncashmentAmount,
      leaveBalanceManuallyEntered: manualLeaveEntry,
      noticePeriodDays: dto.noticePeriodDays,
      noticeServedDays: dto.noticeServedDays,
      noticeShortfallDays: shortfallDays,
      noticeRecoveryAmount: recoveryAmount,
      outstandingAdvanceAmount,
      outstandingLoanAmount,
      bonusClawbackAmount,
      otherAdditions: dto.otherAdditions || [],
      otherDeductions: dto.otherDeductions || [],
      notes: dto.notes || '',
      status: 'draft',
      createdBy: existing?.createdBy || userObjId,
      updatedBy: userObjId,
    };

    const totals = this.computeFnfTotals(settlementData);
    settlementData.totalEarnings = totals.totalEarnings;
    settlementData.totalDeductions = totals.totalDeductions;
    settlementData.netFnfPayable = totals.netFnfPayable;
    settlementData.advanceRecoverableFromDues = totals.advanceRecoverableFromDues;
    settlementData.advanceResidualUnrecovered = totals.advanceResidualUnrecovered;
    // Loan residual note: populated when the outstanding loan exceeds what can
    // be recovered from non-gratuity dues. The corresponding loans are
    // written off in finaliseFnf with reason "F&F settlement residual".
    if (totals.loanResidualUnrecovered > 0) {
      settlementData.loanResidualNote =
        `Outstanding loan balance Rs ${outstandingLoanAmount} - ` +
        `Rs ${totals.loanRecoverableFromDues} recovered from final dues, ` +
        `Rs ${totals.loanResidualUnrecovered} residual to be written off.`;
    }

    return this.fnfModel.findOneAndUpdate(
      { workspaceId: wsId, teamMemberId: memberId },
      { $set: settlementData },
      { upsert: true, new: true },
    );
  }

  async finaliseFnf(
    workspaceId: string,
    teamMemberId: string,
    userId: string,
  ): Promise<FnfSettlement> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberId = new Types.ObjectId(teamMemberId);

    const settlement = await this.fnfModel
      .findOne({ workspaceId: wsId, teamMemberId: memberId })
      .exec();

    if (!settlement) {
      throw new NotFoundException('FnF settlement not found');
    }

    // Close all active advance recovery plans for this member so future
    // scheduled advance_recovery deductions do not dangle on salary months that
    // will never be paid. Same approach as Phase 1.
    //
    // Approach: inject AdvanceRecoveryPlan model directly into FnfService
    // (registered in SalaryModule) and close plans here. SalaryService already
    // injects FnfService, so we CANNOT inject SalaryService here without
    // creating a circular dependency. We therefore close plans by mutating
    // their status/closureType directly.
    //
    // Limitation: future scheduled SalaryAdjustment rows are NOT reversed here
    // (that requires SalaryService.reverseAdjustmentDoc which cannot be called
    // without the circular dep). The plans are marked completed so
    // getOutstandingAdvances will still return non-zero until the operator
    // manually reverses or SalaryService reconciles. This is acceptable for the
    // F&F use-case; advanceRecoverableFromDues was already deducted.
    await this.closeActiveAdvancePlansForMember(wsId, memberId, new Types.ObjectId(userId));

    // Close all active employer loans for this member (same pattern as above).
    // Per spec section 7.3: outstanding loans are recovered from non-gratuity
    // dues; any residual is written off with reason "F&F settlement residual".
    await this.closeActiveLoansForMember(wsId, memberId, new Types.ObjectId(userId));

    // Audit: emit residual events when outstanding amounts cannot be fully
    // recovered so the owner has a record of the unrecovered balance.
    if ((settlement.advanceResidualUnrecovered || 0) > 0) {
      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.SALARY,
        entityType: 'fnf_settlement',
        entityId: String(settlement._id),
        action: 'salary.fnf.advance_residual_unrecovered',
        actorId: userId,
        teamMemberId,
        meta: {
          residualAmount: settlement.advanceResidualUnrecovered,
          outstandingAdvanceAmount: settlement.outstandingAdvanceAmount,
          advanceRecoverableFromDues: settlement.advanceRecoverableFromDues,
        },
      });
    }

    if ((settlement.outstandingLoanAmount || 0) > 0) {
      // Compute recoverable from the settlement fields (they were set in
      // initiateFnf via computeFnfTotals).
      const outstandingLoan = settlement.outstandingLoanAmount || 0;
      const loanResidual = settlement.loanResidualNote
        ? Math.max(
            0,
            outstandingLoan -
              (settlement.totalDeductions || 0) +
              (settlement.noticeRecoveryAmount || 0) +
              (settlement.outstandingAdvanceAmount || 0),
          )
        : 0;

      if (loanResidual > 0) {
        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'fnf_settlement',
          entityId: String(settlement._id),
          action: 'salary.fnf.loan_residual_unrecovered',
          actorId: userId,
          teamMemberId,
          meta: {
            residualAmount: loanResidual,
            outstandingLoanAmount: outstandingLoan,
            loanResidualNote: settlement.loanResidualNote,
          },
        });
      }
    }

    settlement.status = 'finalised';
    settlement.finalisedBy = new Types.ObjectId(userId);
    settlement.finalisedAt = new Date();
    settlement.updatedBy = new Types.ObjectId(userId);
    return settlement.save();
  }

  /**
   * Mark all active (and paused) employer loans for a member as written_off
   * with closureReason 'fnf_settled'. Any remaining balance on each loan is
   * treated as a write-off per spec section 7.3 (residual flagged as
   * write-off candidate).
   *
   * Uses closureType 'written_off' when there is a remaining balance, and
   * 'completed' when the loan is fully recovered. In practice at F&F time
   * most loans will have an outstanding balance, so written_off is the
   * default terminal state.
   *
   * Note: future scheduled loan_recovery SalaryAdjustment rows are NOT
   * reversed here (same limitation as closeActiveAdvancePlansForMember - the
   * circular dep prevents calling SalaryService from FnfService). They will
   * be inert since no further payroll months will be processed for the exiting
   * member.
   */
  private async closeActiveLoansForMember(
    workspaceId: Types.ObjectId,
    teamMemberId: Types.ObjectId,
    closedBy: Types.ObjectId,
  ): Promise<void> {
    const activeLoans = await this.employerLoanModel
      .find({ workspaceId, teamMemberId, status: { $in: ['active', 'paused'] } })
      .exec();

    const now = new Date();
    for (const loan of activeLoans) {
      const hasResidual = (loan.remainingAmount ?? 0) > 0.01;
      loan.status = hasResidual ? 'written_off' : 'completed';
      loan.closureType = hasResidual ? 'written_off' : 'completed';
      loan.closureReason = 'fnf_settled';
      loan.writeOffAmount = hasResidual ? loan.remainingAmount : undefined;
      loan.closedBy = closedBy;
      loan.closedAt = now;
      await loan.save();
    }
  }

  /**
   * Mark all active (and paused) advance recovery plans for a member as
   * completed with closureType 'fnf_settled'.
   *
   * Called exclusively from finaliseFnf to prevent dangling future
   * advance_recovery deduction adjustments after exit.
   *
   * Note: the CLOSURE_TYPES enum on the schema is ['completed', 'early_payoff',
   * 'reversed'].  We reuse 'completed' as the status and set closureReason to
   * 'fnf_settled' as a string discriminator so callers can identify the F&F
   * path without a schema migration.  A future pass can extend CLOSURE_TYPES
   * with 'fnf_settled' and migrate existing records.
   */
  private async closeActiveAdvancePlansForMember(
    workspaceId: Types.ObjectId,
    teamMemberId: Types.ObjectId,
    closedBy: Types.ObjectId,
  ): Promise<void> {
    const activePlans = await this.advancePlanModel
      .find({ workspaceId, teamMemberId, status: { $in: ['active', 'paused'] } })
      .exec();

    const now = new Date();
    for (const plan of activePlans) {
      plan.status = 'completed';
      plan.closureType = 'completed';
      plan.closureReason = 'fnf_settled';
      plan.closedBy = closedBy;
      plan.closedAt = now;
      await plan.save();
    }
  }

  async getFnfSettlement(workspaceId: string, teamMemberId: string): Promise<FnfSettlement | null> {
    return this.fnfModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
      })
      .exec();
  }

  async getWorkspaceFnfList(workspaceId: string): Promise<FnfSettlement[]> {
    return this.fnfModel
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ createdAt: -1 })
      .exec();
  }
}
