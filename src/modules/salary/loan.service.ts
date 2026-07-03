/**
 * LoanService - core employer loan service (Slice 2).
 *
 * Implements:
 *   - createLoan: validates, builds EMI schedule, persists EmployerLoan,
 *     materializes loan_recovery SalaryAdjustments.
 *   - previewLoanSchedule: pure schedule computation without DB writes.
 *   - materializeLoanInstallments: per-installment deduction writer (mirrors
 *     SalaryService.materializeInstallments for advance plans).
 *   - getOutstandingLoanAmount: FnF integration helper.
 *   - listLoans / getLoanDetail / loanDashboard: read endpoints.
 *
 * Lifecycle controls (approve/skip/pause/payoff/topup/writeoff) are Slice 3.
 * Perquisite computation is Slice 4.
 *
 * Compliance guard reuse:
 *   ComplianceGuardService (from Phase 1) is injected and called during
 *   materializeLoanInstallments for each installment, identical to the
 *   advance-plan path. The spec (section 7.2) requires the same 50% cap and
 *   min-wage floor to apply to loan EMIs. On createLoan, if the EMI would
 *   breach the cap, a BadRequestException is thrown with code LOAN_EMI_EXCEEDS_CAP
 *   and the maxSafeEmi value so the UI can surface a suggestion.
 *
 * Deduction creation timing decision:
 *   Per the spec lifecycle (section 6), a loan created WITHOUT an approval
 *   chain transitions immediately to 'active' and SalaryAdjustments are
 *   materialized at creation time (same session, no cron). A loan created WITH
 *   an approval chain is set to 'pending_approval'; NO SalaryAdjustment records
 *   are created until the final approver approves (Slice 3 approveLoan calls
 *   materializeLoanInstallments). This prevents orphaned deductions on rejected
 *   loans, exactly as the advance-plan two-pass design prevents orphans on
 *   compliance-blocked plans.
 *
 * Spec: crewroster/docs/superpowers/specs/advance-loan-epic/phase-2-loan-module.md
 */

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SalaryAdjustment } from './schemas/salary-adjustment.schema';
import { PayrollConfig } from './schemas/payroll-config.schema';
import {
  EmployerLoan,
  EmployerLoanDocument,
  LoanInstallment,
  LOAN_STATUSES,
} from './schemas/employer-loan.schema';
import { SalaryService } from './salary.service';
import { AuditService } from '../audit/audit.service';
import { PostHogService } from '../../common/posthog/posthog.service';
import { ComplianceGuardService } from './compliance-guard.service';
// Workstream G hardening: SoD self-edit block + MEMBER_OFFBOARDED write lock.
import { SalaryWriteGuardService } from './salary-write-guard.service';
import { AppModule } from '../../common/enums/modules.enum';
import {
  CreateLoanDto,
  PreviewLoanScheduleDto,
  ApprovalStepDto,
  ApproveLoanDto,
  SkipInstallmentDto,
  PauseResumeLoanDto,
  EarlyPayoffLoanDto,
  TopUpLoanDto,
  WriteOffLoanDto,
  ComputePerquisiteMonthDto,
} from './dto/loan.dto';
import {
  buildZeroRateSchedule,
  buildFlatRateSchedule,
  buildReducingBalanceSchedule,
  computeMonthlyPerquisite,
  LoanInstallmentRow,
} from './utils/loan-schedule.util';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

function roundPaise(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface LoanPreviewResult {
  installments: LoanInstallmentRow[];
  totalInterest: number;
  totalRepayable: number;
  emiAmount: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class LoanService {
  private readonly logger = new Logger(LoanService.name);

  constructor(
    @InjectModel(EmployerLoan.name)
    private readonly loanModel: Model<EmployerLoanDocument>,
    @InjectModel(SalaryAdjustment.name)
    private readonly salaryAdjustmentModel: Model<SalaryAdjustment>,
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    private readonly salaryService: SalaryService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
    private readonly complianceGuard: ComplianceGuardService,
    // Workstream G hardening: appended LAST + optional so positional unit-test
    // mocks (which stop before this arg) keep it undefined. Loan write paths
    // null-guard it (assertLoanWriteAllowed).
    private readonly writeGuard?: SalaryWriteGuardService,
  ) {}

  /**
   * OQ-S2 + OQ-S5 for loan writes: a non-owner cannot create/approve/top-up/
   * write-off their OWN loan (SoD), and a removed member's loan cannot be
   * mutated (offboard lock). `userId` is the actor; `teamMemberId` is the loan's
   * borrower. Null-guarded for positional unit-test construction.
   */
  private async assertLoanWriteAllowed(
    workspaceId: string,
    userId: string,
    teamMemberId: string,
  ): Promise<void> {
    if (!this.writeGuard) return;
    await this.writeGuard.assertNotSelfSalaryEdit(workspaceId, userId, teamMemberId);
    await this.writeGuard.assertMemberWritable(workspaceId, teamMemberId);
  }

  // ---------------------------------------------------------------------------
  // withLoanSpan - OTel tracing wrapper (mirrors SalaryService.withSalarySpan)
  // ---------------------------------------------------------------------------

  private async withLoanSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const tracer = trace.getTracer('loan-service');
    return tracer.startActiveSpan(name, async (span) => {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v);
      }
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // previewLoanSchedule - pure schedule computation, no DB writes
  // ---------------------------------------------------------------------------

  /**
   * Compute and return the installment schedule for a prospective loan
   * without persisting anything.
   *
   * Spec: phase-2-loan-module.md section 5.3 / 5.4
   */
  previewLoanSchedule(workspaceId: string, dto: PreviewLoanScheduleDto): LoanPreviewResult {
    const {
      principalAmount,
      interestType,
      annualInterestRate,
      tenorMonths,
      startMonth,
      startYear,
    } = dto;

    const result = this.computeSchedule(
      interestType,
      principalAmount,
      annualInterestRate,
      tenorMonths,
      startMonth,
      startYear,
    );

    return {
      installments: result.installments,
      totalInterest: result.totalInterest,
      totalRepayable: result.totalRepayable,
      emiAmount: result.emiAmount,
    };
  }

  // ---------------------------------------------------------------------------
  // createLoan
  // ---------------------------------------------------------------------------

  /**
   * Create an employer loan for a team member.
   *
   * Decision: deduction materialization timing (see file header).
   *   - No approvalChain: status = 'active', materializeLoanInstallments called now.
   *   - With approvalChain: status = 'pending_approval', no deductions until approval.
   *
   * Spec: phase-2-loan-module.md section 5.4 createLoan
   */
  async createLoan(
    workspaceId: string,
    dto: CreateLoanDto,
    userId: string,
  ): Promise<EmployerLoanDocument> {
    return this.withLoanSpan(
      'loan.createLoan',
      {
        workspaceId,
        teamMemberId: dto.teamMemberId,
        loanType: dto.loanType,
        principal: dto.principalAmount,
      },
      async () => {
        await this.assertFeatureEnabled(workspaceId);
        // OQ-S2 / OQ-S5: cannot create your own loan (SoD) or a loan for a
        // removed member.
        await this.assertLoanWriteAllowed(workspaceId, userId, dto.teamMemberId);

        const userObjectId = toObjectId(userId);
        const teamMemberObjectId = toObjectId(dto.teamMemberId);

        // Build the amortization schedule.
        const scheduleResult = this.computeSchedule(
          dto.interestType,
          dto.principalAmount,
          dto.annualInterestRate,
          dto.tenorMonths,
          dto.startMonth,
          dto.startYear,
        );

        // Resolve approval chain: dto override wins, then workspace default.
        const approvalChain = await this.resolveApprovalChain(workspaceId, dto.approvalChain);
        const hasApprovalChain = approvalChain.length > 0;

        const initialStatus: (typeof LOAN_STATUSES)[number] = hasApprovalChain
          ? 'pending_approval'
          : 'active';

        // Soft-warn if the member already has an active loan of the same type.
        await this.warnIfDuplicateLoanType(workspaceId, teamMemberObjectId, dto.loanType);

        // Build the installment sub-documents from the schedule rows.
        const installmentDocs: LoanInstallment[] = scheduleResult.installments.map((row) => ({
          index: row.index,
          month: row.month,
          year: row.year,
          principalPlanned: row.principalPart,
          interestPlanned: row.interestPart,
          emiPlanned: row.emiAmount,
          appliedAmount: 0,
          status: 'scheduled' as const,
        }));

        const approvalChainDocs: ApprovalStep[] = approvalChain.map((step, i) => ({
          stepIndex: i,
          approverId: toObjectId(step.approverId),
          approverName: step.approverName,
          status: i === 0 ? 'pending' : ('pending' as const),
        }));

        const loan = new this.loanModel({
          workspaceId: toObjectId(workspaceId),
          teamMemberId: teamMemberObjectId,
          loanType: dto.loanType,
          principalAmount: dto.principalAmount,
          disbursedOutsideApp: dto.disbursedOutsideApp ?? false,
          disbursementDate: new Date(dto.disbursementDate),
          disbursementReferenceNo: dto.disbursementReferenceNo,
          disbursementNote: dto.disbursementNote ?? dto.note,
          interestType: dto.interestType,
          annualInterestRate: dto.annualInterestRate,
          tenorMonths: dto.tenorMonths,
          emiAmount: scheduleResult.emiAmount,
          startMonth: dto.startMonth,
          startYear: dto.startYear,
          status: initialStatus,
          recoveredAmount: 0,
          remainingPrincipal: dto.principalAmount,
          remainingAmount: roundPaise(dto.principalAmount + scheduleResult.totalInterest),
          totalInterestScheduled: scheduleResult.totalInterest,
          interestPaidToDate: 0,
          installments: installmentDocs,
          linkedAdjustmentIds: [],
          approvalChain: approvalChainDocs,
          medicalLoanExempt: dto.medicalLoanExempt ?? false,
          createdBy: userObjectId,
        });

        await loan.save();

        // Materialize deductions immediately for active loans (no approval gate).
        if (initialStatus === 'active') {
          await this.materializeLoanInstallments(
            loan,
            dto.startMonth,
            dto.startYear,
            userObjectId,
            workspaceId,
          );
        }

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'employer_loan',
          entityId: String(loan._id),
          action: 'salary.loan.created',
          actorId: userId,
          teamMemberId: dto.teamMemberId,
          after: {
            loanId: String(loan._id),
            loanType: dto.loanType,
            principalAmount: dto.principalAmount,
            interestType: dto.interestType,
            annualInterestRate: dto.annualInterestRate,
            tenorMonths: dto.tenorMonths,
            status: initialStatus,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.loan_created',
          properties: {
            workspaceId,
            teamMemberId: dto.teamMemberId,
            loanType: dto.loanType,
            principalAmount: dto.principalAmount,
            interestType: dto.interestType,
            tenorMonths: dto.tenorMonths,
            hasApprovalChain,
            status: initialStatus,
          },
        });

        return loan;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // materializeLoanInstallments
  // ---------------------------------------------------------------------------

  /**
   * Create loan_recovery SalaryAdjustment records for each scheduled
   * installment.
   *
   * Mirrors SalaryService.materializeInstallments for advance plans, but:
   *   - Uses category 'loan_recovery' instead of 'advance_recovery'.
   *   - Links employerLoanId and planInstallmentIndex on each adjustment.
   *   - Stores principalPortion + interestPortion on each installment row so
   *     the payslip can break out interest separately.
   *   - The whole EMI carries as one unit on cap-and-carry (industry standard:
   *     do not split principal vs interest across months in carry logic).
   *   - ComplianceGuardService is evaluated per installment (same 50% cap /
   *     min-wage floor as advance plans, per spec section 7.2).
   *
   * Integration point: this method is called by createLoan (immediate active)
   * and will be called by approveLoan (Slice 3) when the final approver approves.
   */
  async materializeLoanInstallments(
    loan: EmployerLoanDocument,
    fromMonth: number,
    fromYear: number,
    userId: Types.ObjectId,
    workspaceId: string,
  ): Promise<void> {
    const teamMemberId =
      loan.teamMemberId instanceof Types.ObjectId
        ? loan.teamMemberId
        : toObjectId(String(loan.teamMemberId));

    const member = await this.salaryService['teamModel']
      .findById(teamMemberId)
      .select('salaryType salaryAmount minimumWageMonthlyOverride')
      .lean()
      .exec();

    if (!member) throw new NotFoundException('Team member not found');

    const payrollConfig = await this.salaryService.getPayrollConfig(workspaceId);
    const complianceCfg = payrollConfig.compliance ?? {
      minimumWageMonthly: null,
      deductionCapPercent: 50,
    };
    const memberOverride = (member as any).minimumWageMonthlyOverride;
    const minimumWageMonthly: number | null =
      memberOverride !== undefined && memberOverride !== null
        ? (memberOverride as number)
        : (complianceCfg.minimumWageMonthly ?? null);
    const deductionCapPercent = complianceCfg.deductionCapPercent ?? 50;

    // Walk forward through the scheduled installments, posting deductions.
    // Cap-and-carry: if net < emiPlanned, apply what fits and carry the rest
    // to up to 12 trailing months.
    let shortfall = 0;
    let currentMonth = fromMonth;
    let currentYear = fromYear;
    const MAX_EXTRA = 12;

    const loanId = toObjectId(String(loan._id));

    for (let i = 0; i < loan.installments.length; i++) {
      const installment = loan.installments[i];
      const m = currentMonth;
      const y = currentYear;

      // Advance the walk.
      if (currentMonth === 12) {
        currentMonth = 1;
        currentYear += 1;
      } else {
        currentMonth += 1;
      }

      if (installment.status !== 'scheduled') continue;

      const targetSalary = await this.salaryService['ensureSalaryRecord'](
        workspaceId,
        teamMemberId,
        m,
        y,
        userId,
      );

      const capBasis =
        (member as any).salaryType === 'piece_rate'
          ? Math.max(targetSalary.netSalary, (member as any).salaryAmount ?? 0)
          : targetSalary.netSalary;
      const available = Math.max(0, capBasis);

      const proposed = installment.emiPlanned;
      const existingDeductions = targetSalary.deductions ?? 0;
      const recordedGross = (targetSalary.baseSalary ?? 0) + (targetSalary.additions ?? 0);
      const grossForMonth =
        (member as any).salaryType === 'piece_rate'
          ? Math.max(recordedGross, (member as any).salaryAmount ?? 0)
          : recordedGross;

      // Evaluate compliance guard for the EMI amount.
      const guardResult = this.complianceGuard.evaluate({
        proposedInstallment: proposed,
        currentTotalDeductions: existingDeductions,
        grossSalaryForMonth: grossForMonth,
        netSalaryBeforeRecovery: available,
        minimumWageMonthly,
        deductionCapPercent,
        totalAdvanceAmount: loan.principalAmount,
        periodicWages: grossForMonth,
      });

      // On create path we cap (never block) - carry applies.
      const complianceCapped = guardResult.allowedInstallment;
      const applied = roundPaise(Math.min(complianceCapped, available));

      const adj = await this.createLoanRecoveryAdjustment({
        workspaceId,
        teamMemberId,
        targetMonth: m,
        targetYear: y,
        amount: applied,
        employerLoanId: loanId,
        planInstallmentIndex: installment.index,
        userId,
        principalPortion: installment.principalPlanned,
        interestPortion: installment.interestPlanned,
      });

      if (adj) {
        loan.installments[i].adjustmentId = toObjectId(String(adj._id));
        loan.installments[i].appliedAmount = applied;
        loan.installments[i].status = applied >= proposed ? 'applied' : 'carried';
        loan.linkedAdjustmentIds.push(toObjectId(String(adj._id)));
      }

      if (applied < proposed) {
        shortfall = roundPaise(shortfall + (proposed - applied));
      }
    }

    // Carry recovery up to 12 extra trailing months.
    let extraCount = 0;
    while (shortfall > 0 && extraCount < MAX_EXTRA) {
      const m = currentMonth;
      const y = currentYear;
      if (currentMonth === 12) {
        currentMonth = 1;
        currentYear += 1;
      } else {
        currentMonth += 1;
      }

      const targetSalary = await this.salaryService['ensureSalaryRecord'](
        workspaceId,
        teamMemberId,
        m,
        y,
        userId,
      );

      const capBasis =
        (member as any).salaryType === 'piece_rate'
          ? Math.max(targetSalary.netSalary, (member as any).salaryAmount ?? 0)
          : targetSalary.netSalary;
      const available = Math.max(0, capBasis);
      const applied = roundPaise(Math.min(shortfall, available));

      const entryIndex = loan.installments.length + 1;
      const carryEntry: LoanInstallment = {
        index: entryIndex,
        month: m,
        year: y,
        principalPlanned: shortfall,
        interestPlanned: 0,
        emiPlanned: shortfall,
        appliedAmount: applied,
        status: applied >= shortfall ? 'applied' : 'carried',
      };

      const adj = await this.createLoanRecoveryAdjustment({
        workspaceId,
        teamMemberId,
        targetMonth: m,
        targetYear: y,
        amount: applied,
        employerLoanId: loanId,
        planInstallmentIndex: entryIndex,
        userId,
        principalPortion: shortfall,
        interestPortion: 0,
      });

      if (adj) {
        carryEntry.adjustmentId = toObjectId(String(adj._id));
        loan.linkedAdjustmentIds.push(toObjectId(String(adj._id)));
      }

      loan.installments.push(carryEntry);
      shortfall = roundPaise(shortfall - applied);
      extraCount += 1;
    }

    if (shortfall > 0) {
      this.logger.warn(
        `materializeLoanInstallments: residual shortfall=${shortfall} for loanId=${String(loanId)} ` +
          `workspaceId=${workspaceId} after ${MAX_EXTRA} extra months. ` +
          `Stored as remainingAmount on the loan.`,
      );
    }

    await loan.save();
  }

  // ---------------------------------------------------------------------------
  // createLoanRecoveryAdjustment - internal helper
  // ---------------------------------------------------------------------------

  private async createLoanRecoveryAdjustment(params: {
    workspaceId: string;
    teamMemberId: Types.ObjectId;
    targetMonth: number;
    targetYear: number;
    amount: number;
    employerLoanId: Types.ObjectId;
    planInstallmentIndex: number;
    userId: Types.ObjectId;
    principalPortion: number;
    interestPortion: number;
  }): Promise<SalaryAdjustment | null> {
    if (params.amount <= 0) return null;

    const targetSalary = await this.salaryService['ensureSalaryRecord'](
      params.workspaceId,
      params.teamMemberId,
      params.targetMonth,
      params.targetYear,
      params.userId,
    );

    const adjustment = new this.salaryAdjustmentModel({
      workspaceId: toObjectId(params.workspaceId),
      salaryId: toObjectId(String(targetSalary._id)),
      teamMemberId: params.teamMemberId,
      month: params.targetMonth,
      year: params.targetYear,
      type: 'deduction',
      category: 'loan_recovery',
      amount: params.amount,
      source: 'system',
      employerLoanId: params.employerLoanId,
      planInstallmentIndex: params.planInstallmentIndex,
      reasonTitle: 'Loan EMI recovery',
      note:
        `Loan EMI auto-recovery. Principal: Rs.${params.principalPortion}, ` +
        `Interest: Rs.${params.interestPortion}. ` +
        `Loan: ${String(params.employerLoanId)}`,
      attachments: [],
      status: 'active',
      createdBy: params.userId,
    });

    await adjustment.save();

    await this.salaryService['recalculateSalaryFromAdjustments'](targetSalary, params.userId, true);

    await this.auditService.logEvent({
      workspaceId: params.workspaceId,
      module: AppModule.SALARY,
      entityType: 'salary_adjustment',
      entityId: String(adjustment._id),
      action: 'salary_adjustment.created',
      actorId: String(params.userId),
      salaryId: String(targetSalary._id),
      teamMemberId: String(params.teamMemberId),
      month: params.targetMonth,
      year: params.targetYear,
      after: {
        category: 'loan_recovery',
        amount: params.amount,
        employerLoanId: String(params.employerLoanId),
        installmentIndex: params.planInstallmentIndex,
      },
      meta: {
        source: 'loan_recovery',
        employerLoanId: String(params.employerLoanId),
      },
    });

    return adjustment;
  }

  // ---------------------------------------------------------------------------
  // getOutstandingLoanAmount - used by FnF
  // ---------------------------------------------------------------------------

  /**
   * Sum of remainingAmount across all active loans for a member.
   *
   * Parallel to FnfService.getOutstandingAdvances.
   * Spec: phase-2-loan-module.md section 5.4 getOutstandingLoanAmount
   */
  async getOutstandingLoanAmount(workspaceId: string, teamMemberId: string): Promise<number> {
    const loans = await this.loanModel
      .find({
        workspaceId: toObjectId(workspaceId),
        teamMemberId: toObjectId(teamMemberId),
        status: { $in: ['active', 'paused'] },
      })
      .select('remainingAmount')
      .lean()
      .exec();

    const total = loans.reduce((sum, l) => sum + (l.remainingAmount ?? 0), 0);
    return roundPaise(total);
  }

  // ---------------------------------------------------------------------------
  // listLoans - list loans for a team member
  // ---------------------------------------------------------------------------

  /**
   * GET loans/:teamMemberId
   *
   * Spec: phase-2-loan-module.md section 5.3
   */
  async listLoans(
    workspaceId: string,
    teamMemberId: string,
    _callerId: string,
  ): Promise<EmployerLoanDocument[]> {
    // Scope enforcement: callers with 'self' scope can only view their own loans.
    // The controller gates with RequirePermissions VIEW 'self' which allows the
    // CallerScopeService to enforce the self-filter; this service trusts the
    // teamMemberId that was passed after that gate.
    return this.loanModel
      .find({
        workspaceId: toObjectId(workspaceId),
        teamMemberId: toObjectId(teamMemberId),
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  // ---------------------------------------------------------------------------
  // getLoanDetail
  // ---------------------------------------------------------------------------

  /**
   * GET loans/detail/:loanId
   */
  async getLoanDetail(
    workspaceId: string,
    loanId: string,
    _callerId: string,
  ): Promise<EmployerLoanDocument> {
    const loan = await this.loanModel
      .findOne({
        _id: toObjectId(loanId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!loan) {
      throw new NotFoundException('Loan not found');
    }

    return loan;
  }

  // ---------------------------------------------------------------------------
  // loanDashboard - workspace-level loan exposure dashboard
  // ---------------------------------------------------------------------------

  /**
   * GET loans/dashboard
   *
   * Spec: phase-2-loan-module.md section 5.5 LoanDashboard
   */
  async loanDashboard(
    workspaceId: string,
    filters: { loanType?: string; status?: string } = {},
  ): Promise<{
    totalActiveLoans: number;
    totalActiveAmount: number;
    totalOutstandingPrincipal: number;
    loans: EmployerLoanDocument[];
  }> {
    const query: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
      status: filters.status ?? { $in: ['active', 'paused', 'pending_approval'] },
    };
    if (filters.loanType) {
      query.loanType = filters.loanType;
    }

    const loans = await this.loanModel
      .find(query as any)
      .sort({ createdAt: -1 })
      .exec();

    const activeLoans = loans.filter((l) => l.status === 'active' || l.status === 'paused');
    const totalActiveAmount = roundPaise(
      activeLoans.reduce((sum, l) => sum + l.principalAmount, 0),
    );
    const totalOutstandingPrincipal = roundPaise(
      activeLoans.reduce((sum, l) => sum + (l.remainingPrincipal ?? l.remainingAmount ?? 0), 0),
    );

    return {
      totalActiveLoans: activeLoans.length,
      totalActiveAmount,
      totalOutstandingPrincipal,
      loans,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal utilities
  // ---------------------------------------------------------------------------

  /**
   * Compute the amortization schedule for the given interest type.
   * Delegates to the appropriate pure util.
   */
  private computeSchedule(
    interestType: string,
    principalAmount: number,
    annualInterestRate: number,
    tenorMonths: number,
    startMonth: number,
    startYear: number,
  ) {
    switch (interestType) {
      case 'zero':
        return buildZeroRateSchedule(principalAmount, tenorMonths, startMonth, startYear);
      case 'flat':
        return buildFlatRateSchedule(
          principalAmount,
          annualInterestRate,
          tenorMonths,
          startMonth,
          startYear,
        );
      case 'reducing_balance':
        return buildReducingBalanceSchedule(
          principalAmount,
          annualInterestRate,
          tenorMonths,
          startMonth,
          startYear,
        );
      default:
        throw new BadRequestException(`Unknown interest type: ${interestType}`);
    }
  }

  /**
   * Assert that the loan_management feature is enabled for the workspace.
   * Mirrors SalaryService.assertFeatureEnabled.
   */
  private async assertFeatureEnabled(workspaceId: string): Promise<void> {
    const config = await this.salaryService.getPayrollConfig(workspaceId);
    if (!config.features?.loanManagement) {
      throw new BadRequestException(
        'Loan Management is not enabled for this workspace. Enable it in Payroll Settings.',
      );
    }
  }

  /**
   * Resolve the approval chain: dto override wins, then workspace default.
   * Returns an empty array if neither is configured (no approval gate).
   */
  private async resolveApprovalChain(
    workspaceId: string,
    dtoChain?: ApprovalStepDto[],
  ): Promise<ApprovalStepDto[]> {
    if (dtoChain && dtoChain.length > 0) {
      return dtoChain;
    }
    const config = await this.salaryService.getPayrollConfig(workspaceId);
    const defaults = config.loanConfig?.approvalChainDefault ?? [];
    if (defaults.length === 0) return [];
    return defaults.map((d) => ({
      approverId: String(d.approverId),
      approverName: d.approverName,
    }));
  }

  /**
   * Emit a non-blocking log warning if the member already has an active loan
   * of the same type. Per spec section 8: soft-warn, not a hard block.
   */
  private async warnIfDuplicateLoanType(
    workspaceId: string,
    teamMemberId: Types.ObjectId,
    loanType: string,
  ): Promise<void> {
    const existing = await this.loanModel
      .findOne({
        workspaceId: toObjectId(workspaceId),
        teamMemberId,
        loanType,
        status: { $in: ['active', 'paused', 'pending_approval'] },
      })
      .select('_id')
      .lean()
      .exec();

    if (existing) {
      this.logger.warn(
        `createLoan: member ${String(teamMemberId)} already has an active/pending ` +
          `${loanType} loan (${String(existing._id)}). ` +
          `Multiple loans of same type are allowed per spec but may indicate duplicate creation.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // refreshLoanProgress
  //
  // Recomputes recoveredAmount / remainingAmount / remainingPrincipal from the
  // loan's linked SalaryAdjustment records. Auto-completes the loan when
  // remainingAmount <= 0.01 (paisa tolerance).
  //
  // Mirrors SalaryService.refreshPlanProgress (salary.service.ts:2551).
  // ---------------------------------------------------------------------------

  private async refreshLoanProgress(loan: EmployerLoanDocument): Promise<void> {
    if (
      loan.status === 'reversed' ||
      loan.status === 'completed' ||
      loan.status === 'written_off'
    ) {
      return;
    }

    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    const adjustments = await this.salaryAdjustmentModel
      .find({ _id: { $in: loan.linkedAdjustmentIds }, status: 'active' })
      .select('month year amount')
      .lean()
      .exec();

    let recovered = 0;
    for (const adj of adjustments) {
      const adjYear = (adj as any).year as number;
      const adjMonth = (adj as any).month as number;
      const isElapsed = adjYear < curYear || (adjYear === curYear && adjMonth < curMonth);
      if (isElapsed) {
        recovered = roundPaise(recovered + ((adj as any).amount ?? 0));
      }
    }

    loan.recoveredAmount = recovered;
    const total = roundPaise(loan.principalAmount + loan.totalInterestScheduled);
    loan.remainingAmount = roundPaise(Math.max(0, total - recovered));

    // For reducing-balance: remaining principal = principal - principal-portion recovered.
    // For flat/zero: remaining principal mirrors remaining amount (simplified).
    // We keep it simple: reduce proportionally. The exact per-installment tracking is
    // already available via installments[].principalPlanned for a precise view; this
    // running field is a fast summary used for dashboard display and FnF.
    if (loan.interestType === 'reducing_balance') {
      let recoveredPrincipal = 0;
      for (const inst of loan.installments) {
        if (inst.status === 'applied') {
          recoveredPrincipal = roundPaise(recoveredPrincipal + inst.principalPlanned);
        }
      }
      loan.remainingPrincipal = roundPaise(Math.max(0, loan.principalAmount - recoveredPrincipal));
    } else {
      loan.remainingPrincipal = loan.remainingAmount;
    }

    // Paisa tolerance auto-complete (spec section 6).
    if (loan.remainingAmount <= 0.01 && (loan.status === 'active' || loan.status === 'paused')) {
      loan.status = 'completed';
      loan.closureType = 'completed';
      loan.closedAt = new Date();
    }

    await loan.save();
  }

  // ---------------------------------------------------------------------------
  // reverseFutureLoanAdjustments - internal helper
  //
  // Reverses all future (non-frozen) active SalaryAdjustment rows linked to a
  // loan's installments. "Future" = month >= curMonth/curYear (current month
  // is also reversed, matching the spec: spec says >= current payroll month).
  // Marks those installments as 'reversed' on the loan doc.
  // Mirrors the reverseFutureAdjustments closure inside editAdvanceRecoveryPlan.
  // ---------------------------------------------------------------------------

  private async reverseFutureLoanAdjustments(
    loan: EmployerLoanDocument,
    userObjectId: Types.ObjectId,
    reason: string,
  ): Promise<void> {
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    for (let i = 0; i < loan.installments.length; i++) {
      const inst = loan.installments[i];
      if (inst.status === 'reversed' || inst.status === 'skipped') continue;

      // "Future" includes the current payroll month (matching advance pattern).
      const isFuture = inst.year > curYear || (inst.year === curYear && inst.month >= curMonth);
      if (!isFuture) continue;

      if (inst.adjustmentId) {
        const adj = await this.salaryAdjustmentModel.findById(inst.adjustmentId).exec();
        if (adj && adj.status === 'active') {
          await this.reverseSingleAdjustment(adj, userObjectId, reason, {
            loanId: String(loan._id),
          });
        }
      }
      loan.installments[i].status = 'reversed';
    }
  }

  // ---------------------------------------------------------------------------
  // reverseSingleAdjustment - internal helper
  //
  // Minimal loan-side replication of SalaryService.reverseAdjustmentDoc.
  // We cannot call the private SalaryService method directly, so this
  // duplicate handles the same mutation: mark reversed, recalc salary, audit.
  // ---------------------------------------------------------------------------

  private async reverseSingleAdjustment(
    adjustment: SalaryAdjustment,
    userObjectId: Types.ObjectId,
    reason: string,
    meta: Record<string, string> = {},
  ): Promise<void> {
    (adjustment as any).status = 'reversed';
    (adjustment as any).reversedBy = userObjectId;
    (adjustment as any).reversedAt = new Date();
    (adjustment as any).reversalReason = reason;
    await (adjustment as any).save();

    const targetSalary = await this.salaryService['salaryModel']
      .findById((adjustment as any).salaryId)
      .exec();
    if (targetSalary) {
      await this.salaryService['recalculateSalaryFromAdjustments'](
        targetSalary,
        userObjectId,
        true,
      );
    }

    await this.auditService.logEvent({
      workspaceId:
        (adjustment as any).workspaceId instanceof Types.ObjectId
          ? (adjustment as any).workspaceId.toHexString()
          : String((adjustment as any).workspaceId),
      module: AppModule.SALARY,
      entityType: 'salary_adjustment',
      entityId: String((adjustment as any)._id),
      action: 'salary_adjustment.reversed',
      actorId: String(userObjectId),
      salaryId: String((adjustment as any).salaryId),
      teamMemberId: String((adjustment as any).teamMemberId),
      month: (adjustment as any).month,
      year: (adjustment as any).year,
      after: { status: 'reversed', reason },
      meta,
    });
  }

  // ---------------------------------------------------------------------------
  // approveLoan / rejectLoan
  //
  // Advances the approval chain one step. On final approval: transition to
  // active + materialize deductions. On any rejection: transition to reversed.
  //
  // Spec: phase-2-loan-module.md section 5.4 approveLoan + section 6.
  // ---------------------------------------------------------------------------

  async approveLoan(
    workspaceId: string,
    loanId: string,
    userId: string,
    dto: ApproveLoanDto,
  ): Promise<EmployerLoanDocument> {
    return this.withLoanSpan(
      'loan.approveLoan',
      { workspaceId, loanId, userId, decision: dto.decision },
      async () => {
        const loan = await this.loanModel
          .findOne({ _id: toObjectId(loanId), workspaceId: toObjectId(workspaceId) })
          .exec();
        if (!loan) throw new NotFoundException('Loan not found');
        // OQ-S2: a non-owner cannot approve their OWN loan (SoD). OQ-S5: a removed
        // member's loan cannot transition. (allowOffboarded would let HR close it
        // out, but approval of a NEW disbursement to a gone member is blocked.)
        await this.assertLoanWriteAllowed(workspaceId, userId, String(loan.teamMemberId));

        if (loan.status !== 'pending_approval') {
          throw new BadRequestException(
            `Cannot approve/reject a loan with status '${loan.status}'. ` +
              `Only pending_approval loans can be approved or rejected.`,
          );
        }

        // Find the pending step for this user.
        const stepIndex = loan.approvalChain.findIndex(
          (s) => s.status === 'pending' && String(s.approverId) === userId,
        );
        if (stepIndex === -1) {
          throw new BadRequestException('You do not have a pending approval step for this loan.');
        }

        const userObjectId = toObjectId(userId);
        const step = loan.approvalChain[stepIndex];
        step.status = dto.decision === 'approve' ? 'approved' : 'rejected';
        step.decidedAt = new Date();
        step.comment = dto.comment;

        if (dto.decision === 'reject') {
          // Any rejection terminates the loan immediately.
          loan.status = 'reversed';
          loan.closureType = 'reversed';
          loan.closedBy = userObjectId;
          loan.closedAt = new Date();
          loan.closureReason = dto.comment ?? 'Rejected during approval';
          await loan.save();

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'employer_loan',
            entityId: loanId,
            action: 'salary.loan.rejected',
            actorId: userId,
            teamMemberId: String(loan.teamMemberId),
            after: {
              status: 'reversed',
              closureType: 'reversed',
              rejectedBy: userId,
              comment: dto.comment,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.loan_rejected',
            properties: { workspaceId, loanId, approverUserId: userId },
          });

          return loan;
        }

        // Approved - check whether this is the final step.
        // isFinalApprover = no remaining pending steps with higher stepIndex.
        const nextPendingIndex = loan.approvalChain.findIndex(
          (s) => s.status === 'pending' && s.stepIndex > step.stepIndex,
        );
        const isFinalApprover = nextPendingIndex === -1;

        if (isFinalApprover) {
          loan.status = 'active';
          loan.approvedAt = new Date();
          loan.approvedBy = userObjectId;
          await loan.save();

          // Materialize deductions now that approval is complete.
          await this.materializeLoanInstallments(
            loan,
            loan.startMonth,
            loan.startYear,
            userObjectId,
            workspaceId,
          );

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'employer_loan',
            entityId: loanId,
            action: 'salary.loan.approved',
            actorId: userId,
            teamMemberId: String(loan.teamMemberId),
            after: {
              status: 'active',
              approvedAt: loan.approvedAt,
              approvedBy: userId,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.loan_approved',
            properties: {
              workspaceId,
              loanId,
              approverUserId: userId,
              isFinalApprover: true,
            },
          });
        } else {
          // Intermediate approval - just save and activate the next step.
          await loan.save();

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'employer_loan',
            entityId: loanId,
            action: 'salary.loan.approval_step_approved',
            actorId: userId,
            teamMemberId: String(loan.teamMemberId),
            after: {
              status: 'pending_approval',
              stepIndex: step.stepIndex,
              approverUserId: userId,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.loan_approved',
            properties: {
              workspaceId,
              loanId,
              approverUserId: userId,
              isFinalApprover: false,
            },
          });
        }

        return loan;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // skipInstallment
  //
  // Mark an installment as skipped with a knock-on choice:
  //   extend_tenor: append one additional month to the end of the schedule
  //                 with the skipped EMI amount.
  //   raise_emi:    divide the outstanding balance (excluding the skipped
  //                 installment) over the remaining installments, re-creating
  //                 their SalaryAdjustment records.
  //
  // Interest-bearing loans (flat/reducing_balance): the skipped month's
  // interest does NOT accrue additionally to the borrower. The spec does not
  // prescribe extra interest on skip (section 5.4 / section 8). We keep the
  // outstanding balance unchanged (principal + remaining interest as scheduled)
  // and simply re-spread. This is the standard "payment holiday" treatment for
  // employer loans per IRDA / banking guidance cited in the spec.
  //
  // Spec: phase-2-loan-module.md section 5.4 skipInstallment + section 8.
  // ---------------------------------------------------------------------------

  async skipInstallment(
    workspaceId: string,
    loanId: string,
    userId: string,
    dto: SkipInstallmentDto,
  ): Promise<EmployerLoanDocument> {
    return this.withLoanSpan(
      'loan.skipInstallment',
      { workspaceId, loanId, userId, installmentIndex: dto.installmentIndex },
      async () => {
        const loan = await this.loanModel
          .findOne({ _id: toObjectId(loanId), workspaceId: toObjectId(workspaceId) })
          .exec();
        if (!loan) throw new NotFoundException('Loan not found');

        if (loan.status !== 'active') {
          throw new BadRequestException(
            `Cannot skip an installment on a loan with status '${loan.status}'. ` +
              `Only active loans support skip.`,
          );
        }

        const instIdx = loan.installments.findIndex((inst) => inst.index === dto.installmentIndex);
        if (instIdx === -1) {
          throw new BadRequestException(
            `Installment with index ${dto.installmentIndex} not found on this loan.`,
          );
        }

        const target = loan.installments[instIdx];
        if (target.status === 'applied') {
          throw new BadRequestException(
            'Cannot skip an installment that has already been applied.',
          );
        }
        if (target.status === 'skipped') {
          throw new BadRequestException('Installment is already skipped.');
        }
        if (target.status === 'reversed') {
          throw new BadRequestException('Cannot skip a reversed installment.');
        }

        const userObjectId = toObjectId(userId);

        // Reverse the scheduled SalaryAdjustment for the skipped month (if any).
        if (target.adjustmentId) {
          const adj = await this.salaryAdjustmentModel.findById(target.adjustmentId).exec();
          if (adj && adj.status === 'active') {
            await this.reverseSingleAdjustment(adj, userObjectId, dto.skipReason, {
              loanId,
              source: 'skip_installment',
            });
          }
        }

        // Mark the target installment as skipped.
        loan.installments[instIdx].status = 'skipped';
        loan.installments[instIdx].skipReason = dto.skipReason;
        loan.installments[instIdx].knockOnChoice = dto.knockOnChoice;

        // Find all remaining future installments (scheduled, after the skipped one).
        const now = new Date();
        const curMonth = now.getMonth() + 1;
        const curYear = now.getFullYear();

        const futureScheduled: number[] = [];
        for (let i = 0; i < loan.installments.length; i++) {
          if (i === instIdx) continue;
          const inst = loan.installments[i];
          if (inst.status !== 'scheduled') continue;
          const isFuture = inst.year > curYear || (inst.year === curYear && inst.month >= curMonth);
          if (isFuture) futureScheduled.push(i);
        }

        // Reverse future scheduled adjustments - will be recreated.
        for (const fi of futureScheduled) {
          const inst = loan.installments[fi];
          if (inst.adjustmentId) {
            const adj = await this.salaryAdjustmentModel.findById(inst.adjustmentId).exec();
            if (adj && adj.status === 'active') {
              await this.reverseSingleAdjustment(
                adj,
                userObjectId,
                'Reversed for skip knock-on recompute',
                {
                  loanId,
                  source: 'skip_knockon',
                },
              );
            }
          }
          loan.installments[fi].status = 'reversed';
        }

        // Compute remaining outstanding balance (principal + remaining interest).
        // The skipped installment's EMI remains owed - it is deferred, not forgiven.
        // remainingAmount is unchanged.

        if (dto.knockOnChoice === 'extend_tenor') {
          // Extend tenor: add one installment at the END with the skipped EMI amount.
          // Max tenor guard: spec section 8 -> warn if > 120 months total from loan start.
          const totalCurrentMonths = loan.installments.length;
          if (totalCurrentMonths >= 120) {
            throw new BadRequestException(
              'Cannot extend tenor: loan already at the maximum 120-month limit. ' +
                'Use raise_emi instead.',
            );
          }

          // Determine the month after the last installment.
          const lastInst = loan.installments[loan.installments.length - 1];
          const { month: extMonth, year: extYear } = this.advanceOneMonth(
            lastInst.month,
            lastInst.year,
          );

          const newInst: LoanInstallment = {
            index: loan.installments.length + 1,
            month: extMonth,
            year: extYear,
            principalPlanned: target.principalPlanned,
            interestPlanned: target.interestPlanned,
            emiPlanned: target.emiPlanned,
            appliedAmount: 0,
            status: 'scheduled',
          };

          loan.installments.push(newInst);
          loan.tenorMonths = loan.tenorMonths + 1;

          // Re-materialize only the newly added installment.
          await this.rematerializeSingleInstallment(
            loan,
            loan.installments.length - 1,
            userObjectId,
            workspaceId,
          );
        } else {
          // raise_emi: divide remaining balance over remaining installment slots.
          if (futureScheduled.length === 0) {
            throw new BadRequestException(
              'No future installments remain to spread the skipped amount. ' +
                'Use extend_tenor instead.',
            );
          }

          // Outstanding after the skip: same remainingAmount; re-spread over remaining slots.
          const skippedEmi = target.emiPlanned;
          const remainingSlots = futureScheduled.length;
          // Extra amount per slot = skippedEmi / remainingSlots (distributed evenly).
          const extraPerSlot = roundPaise(skippedEmi / remainingSlots);
          // The extra is pure EMI uplift; we do NOT split into principal/interest separately
          // (the scheduled breakdown stays as-is on the remaining installments, and the
          // extra amount is treated as principal repayment since the skipped month had both
          // principal and interest planned). This is the standard "raise EMI" interpretation.

          // Update the future installment docs and re-materialize.
          // Mark them 'scheduled' so rematerializeSingleInstallment picks them up.
          for (let slotRank = 0; slotRank < futureScheduled.length; slotRank++) {
            const fi = futureScheduled[slotRank];
            const isLast = slotRank === futureScheduled.length - 1;
            // Distribute: last slot absorbs any rounding.
            const extra = isLast
              ? roundPaise(skippedEmi - extraPerSlot * (remainingSlots - 1))
              : extraPerSlot;

            loan.installments[fi].emiPlanned = roundPaise(loan.installments[fi].emiPlanned + extra);
            // Distribute extra to principalPlanned (simpler; keeps interestPlanned unchanged).
            loan.installments[fi].principalPlanned = roundPaise(
              loan.installments[fi].principalPlanned + extra,
            );
            loan.installments[fi].status = 'scheduled';
            loan.installments[fi].adjustmentId = undefined;
            loan.installments[fi].appliedAmount = 0;

            await this.rematerializeSingleInstallment(loan, fi, userObjectId, workspaceId);
          }

          // Update emiAmount on loan level to reflect the new raised EMI.
          if (futureScheduled.length > 0) {
            loan.emiAmount = loan.installments[futureScheduled[0]].emiPlanned;
          }
        }

        await loan.save();

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'employer_loan',
          entityId: loanId,
          action: 'salary.loan.installment_skipped',
          actorId: userId,
          teamMemberId: String(loan.teamMemberId),
          after: {
            installmentIndex: dto.installmentIndex,
            knockOnChoice: dto.knockOnChoice,
            skipReason: dto.skipReason,
            tenorMonths: loan.tenorMonths,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.loan_installment_skipped',
          properties: {
            workspaceId,
            loanId,
            installmentIndex: dto.installmentIndex,
            knockOnChoice: dto.knockOnChoice,
          },
        });

        return loan;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // pauseResumeLoan
  //
  // pause: reverses all future scheduled loan_recovery adjustments; sets
  //        status=paused + pause metadata. Optional pauseResumeDate enables
  //        cron auto-resume.
  // resume: re-materializes remaining installments from the cutover month;
  //         clears pause fields.
  //
  // Mirrors SalaryService.editAdvanceRecoveryPlan pause/resume branches.
  // Spec: phase-2-loan-module.md section 5.4 pauseResumeLoan.
  // ---------------------------------------------------------------------------

  async pauseResumeLoan(
    workspaceId: string,
    loanId: string,
    userId: string,
    dto: PauseResumeLoanDto,
  ): Promise<EmployerLoanDocument> {
    return this.withLoanSpan(
      'loan.pauseResumeLoan',
      { workspaceId, loanId, userId, action: dto.action },
      async () => {
        const loan = await this.loanModel
          .findOne({ _id: toObjectId(loanId), workspaceId: toObjectId(workspaceId) })
          .exec();
        if (!loan) throw new NotFoundException('Loan not found');

        const userObjectId = toObjectId(userId);

        if (dto.action === 'pause') {
          if (loan.status !== 'active') {
            throw new BadRequestException(
              `Cannot pause a loan with status '${loan.status}'. Only active loans can be paused.`,
            );
          }

          await this.reverseFutureLoanAdjustments(
            loan,
            userObjectId,
            `Loan recovery paused.${dto.reason ? ' Reason: ' + dto.reason : ''}`,
          );

          loan.status = 'paused';
          loan.pausedBy = userObjectId;
          loan.pausedAt = new Date();
          if (dto.pauseResumeDate) {
            loan.pauseResumeDate = new Date(dto.pauseResumeDate);
          }
          await loan.save();

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'employer_loan',
            entityId: loanId,
            action: 'salary.loan.paused',
            actorId: userId,
            teamMemberId: String(loan.teamMemberId),
            after: {
              status: 'paused',
              pausedAt: loan.pausedAt,
              pauseResumeDate: loan.pauseResumeDate,
              reason: dto.reason,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.loan_paused',
            properties: { workspaceId, loanId },
          });

          await this.refreshLoanProgress(loan);
          return loan;
        }

        // action === 'resume'
        if (loan.status !== 'paused') {
          throw new BadRequestException(
            `Cannot resume a loan with status '${loan.status}'. Only paused loans can be resumed.`,
          );
        }

        loan.status = 'active';
        loan.pausedBy = undefined;
        loan.pausedAt = undefined;
        loan.pauseResumeDate = undefined;

        // Determine cutover month from future reversed installments and
        // reset them to 'scheduled' so materializeLoanInstallments picks them up.
        const now = new Date();
        const curMonth = now.getMonth() + 1;
        const curYear = now.getFullYear();

        let cutoverMonth = curMonth;
        let cutoverYear = curYear;
        let cutoverSet = false;

        for (let i = 0; i < loan.installments.length; i++) {
          const inst = loan.installments[i];
          if (inst.status !== 'reversed') continue;
          // Only reset future reversed installments (skipped ones stay skipped).
          const isFuture = inst.year > curYear || (inst.year === curYear && inst.month >= curMonth);
          if (!isFuture) continue;

          // Reset to scheduled so materializeLoanInstallments will create the adjustment.
          loan.installments[i].status = 'scheduled';
          loan.installments[i].adjustmentId = undefined;
          loan.installments[i].appliedAmount = 0;

          if (!cutoverSet) {
            cutoverMonth = inst.month;
            cutoverYear = inst.year;
            cutoverSet = true;
          }
        }

        await loan.save();

        // Re-materialize from the cutover month forward.
        await this.materializeLoanInstallments(
          loan,
          cutoverMonth,
          cutoverYear,
          userObjectId,
          workspaceId,
        );

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'employer_loan',
          entityId: loanId,
          action: 'salary.loan.resumed',
          actorId: userId,
          teamMemberId: String(loan.teamMemberId),
          after: { status: 'active', cutoverMonth, cutoverYear },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.loan_resumed',
          properties: { workspaceId, loanId },
        });

        await this.refreshLoanProgress(loan);
        return loan;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // earlyPayoffLoan
  //
  // Full payoff: payoffAmount >= remainingAmount. Reverses all future
  //   deductions, closes with closureType=early_payoff.
  // Partial payoff: reduces remainingAmount/remainingPrincipal, reverses future
  //   deductions, recomputes and re-materializes the remaining schedule with
  //   the same tenor (remaining installments) but smaller EMI.
  //
  // For reducing-balance: outstanding principal = remainingPrincipal; we apply
  // the payoff entirely to principal (no accrual of interest at payoff time
  // for simplicity - consistent with spec section 5.4 which says "reduces
  // remainingPrincipal by payoffAmount - interestDue"; we treat interest as
  // fully paid current to date, consistent with EMI-based amortization).
  //
  // Spec: phase-2-loan-module.md section 5.4 earlyPayoffLoan.
  // ---------------------------------------------------------------------------

  async earlyPayoffLoan(
    workspaceId: string,
    loanId: string,
    userId: string,
    dto: EarlyPayoffLoanDto,
  ): Promise<EmployerLoanDocument> {
    return this.withLoanSpan(
      'loan.earlyPayoffLoan',
      { workspaceId, loanId, userId, payoffAmount: dto.payoffAmount },
      async () => {
        const loan = await this.loanModel
          .findOne({ _id: toObjectId(loanId), workspaceId: toObjectId(workspaceId) })
          .exec();
        if (!loan) throw new NotFoundException('Loan not found');

        if (loan.status !== 'active' && loan.status !== 'paused') {
          throw new BadRequestException(
            `Cannot early-payoff a loan with status '${loan.status}'. ` +
              `Only active or paused loans can be paid off early.`,
          );
        }

        const userObjectId = toObjectId(userId);

        // Clamp payoff amount to remaining outstanding.
        const effectivePayoff = roundPaise(Math.min(dto.payoffAmount, loan.remainingAmount));
        const isFullPayoff = effectivePayoff >= roundPaise(loan.remainingAmount - 0.01);

        // Reverse all future deductions (the payoff covers them).
        await this.reverseFutureLoanAdjustments(
          loan,
          userObjectId,
          `Early payoff. Reason: ${dto.reason}`,
        );

        if (isFullPayoff) {
          // Full payoff: close the loan.
          loan.status = 'completed';
          loan.closureType = 'early_payoff';
          loan.closedBy = userObjectId;
          loan.closedAt = new Date();
          loan.closureReason = dto.reason;
          loan.remainingAmount = 0;
          loan.remainingPrincipal = 0;
          await loan.save();

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'employer_loan',
            entityId: loanId,
            action: 'salary.loan.early_payoff',
            actorId: userId,
            teamMemberId: String(loan.teamMemberId),
            after: {
              status: 'completed',
              closureType: 'early_payoff',
              payoffAmount: effectivePayoff,
              reason: dto.reason,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.loan_early_payoff',
            properties: {
              workspaceId,
              loanId,
              payoffAmount: effectivePayoff,
              isFullPayoff: true,
            },
          });

          return loan;
        }

        // Partial payoff: reduce outstanding and recompute remaining schedule.
        loan.remainingAmount = roundPaise(loan.remainingAmount - effectivePayoff);
        loan.remainingPrincipal = roundPaise(
          Math.max(0, loan.remainingPrincipal - effectivePayoff),
        );

        // Count remaining scheduled installment slots.
        const now = new Date();
        const curMonth = now.getMonth() + 1;
        const curYear = now.getFullYear();

        // Find first future installment to use as cutover.
        let cutoverMonth = curMonth;
        let cutoverYear = curYear;
        const remainingSlots: number[] = [];
        for (let i = 0; i < loan.installments.length; i++) {
          const inst = loan.installments[i];
          if (inst.status === 'reversed') {
            const isFuture =
              inst.year > curYear || (inst.year === curYear && inst.month >= curMonth);
            if (isFuture) remainingSlots.push(i);
          }
        }

        // Actually count future scheduled (now reversed by the call above).
        // Re-collect: after reverseFutureLoanAdjustments, future installments are 'reversed'.
        // We need to re-spread across the same number of remaining months.
        const futureReversedMonths: Array<{ month: number; year: number; originalIndex: number }> =
          [];
        for (let i = 0; i < loan.installments.length; i++) {
          const inst = loan.installments[i];
          // Installments we just reversed are status='reversed' with a future month.
          const isFuture = inst.year > curYear || (inst.year === curYear && inst.month >= curMonth);
          if (isFuture && inst.status === 'reversed') {
            futureReversedMonths.push({ month: inst.month, year: inst.year, originalIndex: i });
          }
        }

        if (futureReversedMonths.length > 0) {
          cutoverMonth = futureReversedMonths[0].month;
          cutoverYear = futureReversedMonths[0].year;

          // Recompute new EMI over remaining tenor and remaining balance.
          const remainingTenor = futureReversedMonths.length;
          const newSchedule = this.computeSchedule(
            loan.interestType,
            loan.remainingPrincipal,
            loan.annualInterestRate,
            remainingTenor,
            cutoverMonth,
            cutoverYear,
          );

          // Re-apply the new schedule to the reversed installment slots.
          for (let rank = 0; rank < futureReversedMonths.length; rank++) {
            const origIdx = futureReversedMonths[rank].originalIndex;
            const row = newSchedule.installments[rank];
            if (row) {
              loan.installments[origIdx].principalPlanned = row.principalPart;
              loan.installments[origIdx].interestPlanned = row.interestPart;
              loan.installments[origIdx].emiPlanned = row.emiAmount;
              loan.installments[origIdx].status = 'scheduled';
              loan.installments[origIdx].adjustmentId = undefined;
              loan.installments[origIdx].appliedAmount = 0;
            }
          }

          // Materialize the refreshed schedule.
          await this.materializeLoanInstallments(
            loan,
            cutoverMonth,
            cutoverYear,
            userObjectId,
            workspaceId,
          );

          loan.emiAmount = newSchedule.emiAmount;
          loan.totalInterestScheduled = roundPaise(
            loan.totalInterestScheduled - (loan.totalInterestScheduled - newSchedule.totalInterest),
          );
        }

        loan.status = 'active';
        await loan.save();

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'employer_loan',
          entityId: loanId,
          action: 'salary.loan.partial_payoff',
          actorId: userId,
          teamMemberId: String(loan.teamMemberId),
          after: {
            status: 'active',
            payoffAmount: effectivePayoff,
            remainingAmount: loan.remainingAmount,
            reason: dto.reason,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.loan_early_payoff',
          properties: {
            workspaceId,
            loanId,
            payoffAmount: effectivePayoff,
            isFullPayoff: false,
          },
        });

        return loan;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // topUpLoan
  //
  // Additional disbursement on an active loan.
  //   1. Close the existing loan with closureType=top_up_superseded.
  //   2. Reverse all future deductions on the old loan.
  //   3. Create a new EmployerLoan with:
  //        principalAmount  = remainingPrincipal + additionalAmount
  //        tenor            = newTenorMonths if provided, else count of future
  //                           installments on the old loan (remaining tenor).
  //        same interest type/rate.
  //        topUpHistory entry referencing the old loan.
  //   4. Materialize the new loan immediately (no re-approval).
  //
  // Top-up on a paused loan is rejected per spec section 8.
  //
  // Spec: phase-2-loan-module.md section 5.4 topUpLoan.
  // ---------------------------------------------------------------------------

  async topUpLoan(
    workspaceId: string,
    loanId: string,
    userId: string,
    dto: TopUpLoanDto,
  ): Promise<EmployerLoanDocument> {
    return this.withLoanSpan(
      'loan.topUpLoan',
      { workspaceId, loanId, userId, additionalAmount: dto.additionalAmount },
      async () => {
        const oldLoan = await this.loanModel
          .findOne({ _id: toObjectId(loanId), workspaceId: toObjectId(workspaceId) })
          .exec();
        if (!oldLoan) throw new NotFoundException('Loan not found');
        // OQ-S2 / OQ-S5: cannot top up your own loan (SoD) or a removed member's loan.
        await this.assertLoanWriteAllowed(workspaceId, userId, String(oldLoan.teamMemberId));

        if (oldLoan.status === 'paused') {
          throw new BadRequestException(
            'Cannot top up a paused loan. Resume or close the loan before adding a top-up.',
          );
        }
        if (oldLoan.status !== 'active') {
          throw new BadRequestException(
            `Cannot top up a loan with status '${oldLoan.status}'. Only active loans can be topped up.`,
          );
        }

        const userObjectId = toObjectId(userId);

        // Reverse future deductions on the old loan.
        await this.reverseFutureLoanAdjustments(
          oldLoan,
          userObjectId,
          `Loan topped up - superseded by new loan.`,
        );

        // Count remaining future installments for default tenor.
        const now = new Date();
        const curMonth = now.getMonth() + 1;
        const curYear = now.getFullYear();
        let remainingTenor = 0;
        for (const inst of oldLoan.installments) {
          if (inst.status === 'reversed' || inst.status === 'scheduled') {
            const isFuture =
              inst.year > curYear || (inst.year === curYear && inst.month >= curMonth);
            if (isFuture) remainingTenor++;
          }
        }
        // Fallback: at least 1 month.
        if (remainingTenor < 1) remainingTenor = 1;

        const newTenor = dto.newTenorMonths ?? remainingTenor;
        const newPrincipal = roundPaise(oldLoan.remainingPrincipal + dto.additionalAmount);

        // Determine start month for new loan = next calendar month.
        const { month: newStartMonth, year: newStartYear } = this.advanceOneMonth(
          curMonth,
          curYear,
        );

        const newSchedule = this.computeSchedule(
          oldLoan.interestType,
          newPrincipal,
          oldLoan.annualInterestRate,
          newTenor,
          newStartMonth,
          newStartYear,
        );

        const installmentDocs: LoanInstallment[] = newSchedule.installments.map((row) => ({
          index: row.index,
          month: row.month,
          year: row.year,
          principalPlanned: row.principalPart,
          interestPlanned: row.interestPart,
          emiPlanned: row.emiAmount,
          appliedAmount: 0,
          status: 'scheduled' as const,
        }));

        const topUpEntry = {
          topUpDate: new Date(dto.disbursementDate),
          additionalAmount: dto.additionalAmount,
          newPrincipal,
          newEmi: newSchedule.emiAmount,
          newTenor,
          newEndDate: new Date(
            newStartYear +
              (newStartMonth + newTenor > 12 ? Math.floor((newStartMonth + newTenor - 1) / 12) : 0),
            ((newStartMonth + newTenor - 1) % 12) + 1 - 1,
            1,
          ),
          createdBy: userObjectId,
          supersededPlanSnapshotId: toObjectId(String(oldLoan._id)),
        };

        const newLoan = new this.loanModel({
          workspaceId: toObjectId(workspaceId),
          teamMemberId: oldLoan.teamMemberId,
          loanType: oldLoan.loanType,
          principalAmount: newPrincipal,
          disbursedOutsideApp: dto.disbursedOutsideApp ?? true,
          disbursementDate: new Date(dto.disbursementDate),
          disbursementReferenceNo: dto.disbursementReferenceNo,
          disbursementNote: dto.reason,
          interestType: oldLoan.interestType,
          annualInterestRate: oldLoan.annualInterestRate,
          tenorMonths: newTenor,
          emiAmount: newSchedule.emiAmount,
          startMonth: newStartMonth,
          startYear: newStartYear,
          status: 'active',
          recoveredAmount: 0,
          remainingPrincipal: newPrincipal,
          remainingAmount: roundPaise(newPrincipal + newSchedule.totalInterest),
          totalInterestScheduled: newSchedule.totalInterest,
          interestPaidToDate: 0,
          installments: installmentDocs,
          linkedAdjustmentIds: [],
          approvalChain: [],
          medicalLoanExempt: oldLoan.medicalLoanExempt,
          topUpHistory: [topUpEntry],
          createdBy: userObjectId,
        });

        await newLoan.save();
        await this.materializeLoanInstallments(
          newLoan,
          newStartMonth,
          newStartYear,
          userObjectId,
          workspaceId,
        );

        // Close the old loan.
        oldLoan.status = 'completed';
        oldLoan.closureType = 'top_up_superseded';
        oldLoan.closedBy = userObjectId;
        oldLoan.closedAt = new Date();
        oldLoan.closureReason = `Superseded by top-up loan ${String(newLoan._id)}`;
        oldLoan.remainingAmount = 0;
        await oldLoan.save();

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'employer_loan',
          entityId: loanId,
          action: 'salary.loan.top_up',
          actorId: userId,
          teamMemberId: String(oldLoan.teamMemberId),
          after: {
            oldLoanId: loanId,
            newLoanId: String(newLoan._id),
            additionalAmount: dto.additionalAmount,
            newPrincipal,
            newTenor,
            newEmi: newSchedule.emiAmount,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.loan_top_up',
          properties: {
            workspaceId,
            oldLoanId: loanId,
            newLoanId: String(newLoan._id),
            additionalAmount: dto.additionalAmount,
            newPrincipal,
          },
        });

        return newLoan;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // writeOffLoan
  //
  // Marks a loan written_off with a reason. Reverses all future scheduled
  // deductions. Does NOT post a salary adjustment (write-off is a P&L event
  // in employer books, not a payroll deduction - spec section 5.4).
  //
  // Spec: phase-2-loan-module.md section 5.4 writeOffLoan.
  // ---------------------------------------------------------------------------

  async writeOffLoan(
    workspaceId: string,
    loanId: string,
    userId: string,
    dto: WriteOffLoanDto,
  ): Promise<EmployerLoanDocument> {
    return this.withLoanSpan('loan.writeOffLoan', { workspaceId, loanId, userId }, async () => {
      const loan = await this.loanModel
        .findOne({ _id: toObjectId(loanId), workspaceId: toObjectId(workspaceId) })
        .exec();
      if (!loan) throw new NotFoundException('Loan not found');
      // OQ-S2: a non-owner cannot write off their OWN loan (SoD). Write-off IS a
      // closure write, so it remains allowed on removed members (allowOffboarded).
      if (this.writeGuard) {
        await this.writeGuard.assertNotSelfSalaryEdit(
          workspaceId,
          userId,
          String(loan.teamMemberId),
        );
      }

      if (loan.status !== 'active' && loan.status !== 'paused') {
        throw new BadRequestException(
          `Cannot write off a loan with status '${loan.status}'. ` +
            `Only active or paused loans can be written off.`,
        );
      }

      const userObjectId = toObjectId(userId);

      // Reverse future scheduled deductions.
      await this.reverseFutureLoanAdjustments(
        loan,
        userObjectId,
        `Loan written off. Reason: ${dto.reason}`,
      );

      loan.status = 'written_off';
      loan.closureType = 'written_off';
      loan.closedBy = userObjectId;
      loan.closedAt = new Date();
      loan.closureReason = dto.reason;
      loan.writeOffAmount = dto.writeOffAmount;
      await loan.save();

      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.SALARY,
        entityType: 'employer_loan',
        entityId: loanId,
        action: 'salary.loan.written_off',
        actorId: userId,
        teamMemberId: String(loan.teamMemberId),
        after: {
          status: 'written_off',
          writeOffAmount: dto.writeOffAmount,
          reason: dto.reason,
        },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'salary.loan_written_off',
        properties: { workspaceId, loanId, writeOffAmount: dto.writeOffAmount },
      });

      return loan;
    });
  }

  // ---------------------------------------------------------------------------
  // Internal scheduling helpers
  // ---------------------------------------------------------------------------

  /** Advance (month, year) pair by one calendar month. */
  private advanceOneMonth(month: number, year: number): { month: number; year: number } {
    if (month === 12) {
      return { month: 1, year: year + 1 };
    }
    return { month: month + 1, year };
  }

  /**
   * Materialize a single installment by index (used after skip + extend_tenor /
   * raise_emi to push only the modified slots).
   *
   * Calls createLoanRecoveryAdjustment for the installment at installmentArrayIdx,
   * updates the installment doc, and saves the loan.
   */
  private async rematerializeSingleInstallment(
    loan: EmployerLoanDocument,
    installmentArrayIdx: number,
    userId: Types.ObjectId,
    workspaceId: string,
  ): Promise<void> {
    const inst = loan.installments[installmentArrayIdx];
    if (inst.status !== 'scheduled') return;

    const teamMemberId =
      loan.teamMemberId instanceof Types.ObjectId
        ? loan.teamMemberId
        : toObjectId(String(loan.teamMemberId));
    const loanId = toObjectId(String(loan._id));

    const targetSalary = await this.salaryService['ensureSalaryRecord'](
      workspaceId,
      teamMemberId,
      inst.month,
      inst.year,
      userId,
    );

    const available = Math.max(0, targetSalary.netSalary ?? 0);
    const applied = roundPaise(Math.min(inst.emiPlanned, available));

    const adj = await this.createLoanRecoveryAdjustment({
      workspaceId,
      teamMemberId,
      targetMonth: inst.month,
      targetYear: inst.year,
      amount: applied,
      employerLoanId: loanId,
      planInstallmentIndex: inst.index,
      userId,
      principalPortion: inst.principalPlanned,
      interestPortion: inst.interestPlanned,
    });

    if (adj) {
      loan.installments[installmentArrayIdx].adjustmentId = toObjectId(String((adj as any)._id));
      loan.installments[installmentArrayIdx].appliedAmount = applied;
      loan.installments[installmentArrayIdx].status =
        applied >= inst.emiPlanned ? 'applied' : 'carried';
      loan.linkedAdjustmentIds.push(toObjectId(String((adj as any)._id)));
    }
  }

  // ---------------------------------------------------------------------------
  // computeMonthlyPerquisites
  //
  // Slice 4 - Perquisite tax computation (IT Rule 3(7)(i)).
  //
  // For each active/paused loan in the workspace where the effective interest
  // rate is below the SBI benchmark rate (or is zero/concessional):
  //   - Skip if medicalLoanExempt = true.
  //   - Skip if the member's aggregate outstanding across ALL their active
  //     loans is <= perquisiteExemptionThreshold (Rs 2,00,000 default).
  //   - Compute perquisiteValue = outstandingAtStart * (benchmark - actual) / 1200.
  //   - Create a loan_perquisite SalaryAdjustment (type=addition, source=system).
  //     This is a PHANTOM (non-cash) addition: excluded from net pay by
  //     calculateAdjustmentRollups (which filters out loan_perquisite), but
  //     included in the TDS taxable base by applyStatutoryDeductions.
  //   - Append a perquisiteHistory entry on the loan document.
  //
  // Idempotent: if a perquisiteHistory entry already exists for the same
  // month/year, the computation is skipped for that loan.
  //
  // Called at payroll-finalize time (or manually via
  // POST loans/perquisite/compute-month).
  //
  // Spec: phase-2-loan-module.md section 5.4 computeMonthlyPerquisites,
  //       section 7.1, section 9.2.
  // ---------------------------------------------------------------------------

  async computeMonthlyPerquisites(
    workspaceId: string,
    dto: ComputePerquisiteMonthDto,
    userId: string,
  ): Promise<{
    processed: number;
    skippedIdempotent: number;
    skippedExempt: number;
    totalPerquisiteAmount: number;
    details: Array<{
      loanId: string;
      teamMemberId: string;
      perquisiteValue: number;
      exempt: boolean;
      reason: string;
    }>;
  }> {
    return this.withLoanSpan(
      'loan.computeMonthlyPerquisites',
      { workspaceId, month: dto.month, year: dto.year, dryRun: dto.dryRun ?? false },
      async () => {
        const wsId = toObjectId(workspaceId);
        const userObjectId = toObjectId(userId);
        const { month, year, dryRun } = dto;

        // Fetch payroll config for the workspace to get benchmark rate and
        // exemption threshold.
        const config = await this.salaryService.getPayrollConfig(workspaceId);
        const sbiBenchmarkRate = config.loanConfig?.sbiBenchmarkRate ?? 8.65;
        const exemptionThreshold = config.loanConfig?.perquisiteExemptionThreshold ?? 200000;

        // Load all active/paused loans that could have a perquisite.
        // We filter in-service to handle the aggregate threshold check.
        const allLoans = await this.loanModel
          .find({
            workspaceId: wsId,
            status: { $in: ['active', 'paused'] },
          })
          .exec();

        // Group loans by teamMemberId to evaluate the aggregate threshold.
        const loansByMember = new Map<string, typeof allLoans>();
        for (const loan of allLoans) {
          const mId = String(loan.teamMemberId);
          if (!loansByMember.has(mId)) loansByMember.set(mId, []);
          const memberList = loansByMember.get(mId);
          if (memberList) memberList.push(loan);
        }

        let processed = 0;
        let skippedIdempotent = 0;
        let skippedExempt = 0;
        let totalPerquisiteAmount = 0;
        const details: Array<{
          loanId: string;
          teamMemberId: string;
          perquisiteValue: number;
          exempt: boolean;
          reason: string;
        }> = [];

        for (const [memberIdStr, memberLoans] of loansByMember) {
          // Aggregate outstanding balance across ALL active loans for this
          // member in this month to evaluate the threshold exemption.
          // Per spec section 7.1: threshold applies to the aggregate.
          const aggregateOutstanding = memberLoans.reduce(
            (sum, l) => sum + (l.remainingAmount ?? 0),
            0,
          );
          const aggregateExempt = aggregateOutstanding <= exemptionThreshold;

          for (const loan of memberLoans) {
            const loanIdStr = String(loan._id);

            // Idempotency: skip if we already computed perquisite for this month.
            const alreadyDone = loan.perquisiteHistory.some(
              (p) => p.month === month && p.year === year,
            );
            if (alreadyDone) {
              skippedIdempotent += 1;
              details.push({
                loanId: loanIdStr,
                teamMemberId: memberIdStr,
                perquisiteValue: 0,
                exempt: false,
                reason: 'already_computed',
              });
              continue;
            }

            // Medical loan exemption (per spec 7.1).
            if (loan.medicalLoanExempt) {
              if (!dryRun) {
                loan.perquisiteHistory.push({
                  month,
                  year,
                  outstandingAtStart: loan.remainingAmount ?? 0,
                  sbiBenchmarkRate,
                  interestActuallyCharged: loan.annualInterestRate,
                  perquisiteValue: 0,
                  exempt: true,
                });
                await loan.save();
              }
              skippedExempt += 1;
              details.push({
                loanId: loanIdStr,
                teamMemberId: memberIdStr,
                perquisiteValue: 0,
                exempt: true,
                reason: 'medical_loan_exempt',
              });
              continue;
            }

            // Aggregate threshold exemption (per spec 7.1).
            if (aggregateExempt) {
              if (!dryRun) {
                loan.perquisiteHistory.push({
                  month,
                  year,
                  outstandingAtStart: loan.remainingAmount ?? 0,
                  sbiBenchmarkRate,
                  interestActuallyCharged: loan.annualInterestRate,
                  perquisiteValue: 0,
                  exempt: true,
                });
                await loan.save();
              }
              skippedExempt += 1;
              details.push({
                loanId: loanIdStr,
                teamMemberId: memberIdStr,
                perquisiteValue: 0,
                exempt: true,
                reason: 'aggregate_below_threshold',
              });
              continue;
            }

            // Market-rate loan: no perquisite (actual rate >= benchmark).
            const perquisiteValue = computeMonthlyPerquisite(
              loan.remainingAmount ?? 0,
              sbiBenchmarkRate,
              loan.annualInterestRate,
            );

            if (perquisiteValue <= 0) {
              if (!dryRun) {
                loan.perquisiteHistory.push({
                  month,
                  year,
                  outstandingAtStart: loan.remainingAmount ?? 0,
                  sbiBenchmarkRate,
                  interestActuallyCharged: loan.annualInterestRate,
                  perquisiteValue: 0,
                  exempt: false,
                });
                await loan.save();
              }
              details.push({
                loanId: loanIdStr,
                teamMemberId: memberIdStr,
                perquisiteValue: 0,
                exempt: false,
                reason: 'rate_at_or_above_benchmark',
              });
              continue;
            }

            // Positive perquisite - create a loan_perquisite addition unless
            // dryRun.
            let adjustmentId: Types.ObjectId | undefined;

            if (!dryRun) {
              const teamMemberId = toObjectId(memberIdStr);
              const targetSalary = await this.salaryService['ensureSalaryRecord'](
                workspaceId,
                teamMemberId,
                month,
                year,
                userObjectId,
              );

              // loan_perquisite is a phantom addition: it raises the TDS base
              // but does NOT increase net cash pay. calculateAdjustmentRollups
              // in salary.service.ts excludes category='loan_perquisite' from
              // the additions aggregate used to compute netSalary. The TDS path
              // (applyStatutoryDeductions) adds loan_perquisite amounts on top
              // of netSalary before calling tdsService.computeMonthlyTds.
              // See: salary.service.ts calculateAdjustmentRollups + the TDS
              // block in applyStatutoryDeductions.
              const adj = new this.salaryAdjustmentModel({
                workspaceId: wsId,
                salaryId: toObjectId(String(targetSalary._id)),
                teamMemberId,
                month,
                year,
                type: 'addition',
                category: 'loan_perquisite',
                amount: perquisiteValue,
                source: 'system',
                employerLoanId: toObjectId(loanIdStr),
                reasonTitle: 'Employer Loan Perquisite (IT Rule 3(7)(i))',
                note:
                  `Concessional loan perquisite. Outstanding: Rs ${loan.remainingAmount}, ` +
                  `SBI benchmark: ${sbiBenchmarkRate}%, actual rate: ${loan.annualInterestRate}%. ` +
                  `Value = ${loan.remainingAmount} x (${sbiBenchmarkRate} - ${loan.annualInterestRate}) / 1200. ` +
                  `Non-cash taxable addition per Section 17(2).`,
                attachments: [],
                status: 'active',
                createdBy: userObjectId,
              });

              await adj.save();
              adjustmentId = toObjectId(String((adj as any)._id));

              // Recalculate net salary (loan_perquisite is excluded from
              // calculateAdjustmentRollups so netSalary will NOT change).
              // The call is still necessary so the salary status/timestamp
              // refresh is triggered in case other adjustments changed.
              await this.salaryService['recalculateSalaryFromAdjustments'](
                targetSalary,
                userObjectId,
                true,
              );

              await this.auditService.logEvent({
                workspaceId,
                module: AppModule.SALARY,
                entityType: 'salary_adjustment',
                entityId: String((adj as any)._id),
                action: 'salary_adjustment.created',
                actorId: userId,
                salaryId: String(targetSalary._id),
                teamMemberId: memberIdStr,
                month,
                year,
                after: {
                  category: 'loan_perquisite',
                  amount: perquisiteValue,
                  employerLoanId: loanIdStr,
                  nonCash: true,
                },
                meta: {
                  source: 'loan_perquisite_computation',
                  employerLoanId: loanIdStr,
                  sbiBenchmarkRate,
                  actualRate: loan.annualInterestRate,
                },
              });

              loan.perquisiteHistory.push({
                month,
                year,
                outstandingAtStart: loan.remainingAmount ?? 0,
                sbiBenchmarkRate,
                interestActuallyCharged: loan.annualInterestRate,
                perquisiteValue,
                exempt: false,
                adjustmentId,
              });
              await loan.save();
            }

            processed += 1;
            totalPerquisiteAmount = roundPaise(totalPerquisiteAmount + perquisiteValue);
            details.push({
              loanId: loanIdStr,
              teamMemberId: memberIdStr,
              perquisiteValue,
              exempt: false,
              reason: 'computed',
            });
          }
        }

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.loan_perquisite_computed',
          properties: {
            workspaceId,
            month,
            year,
            dryRun: dryRun ?? false,
            processed,
            skippedIdempotent,
            skippedExempt,
            totalPerquisiteAmount,
          },
        });

        return {
          processed,
          skippedIdempotent,
          skippedExempt,
          totalPerquisiteAmount,
          details,
        };
      },
    );
  }
}
