import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Salary } from './schemas/salary.schema';
import { Payment } from './schemas/payment.schema';
import { SalaryIncrement } from './schemas/salary-increment.schema';
import {
  SalaryAdjustment,
  SALARY_ADDITION_CATEGORIES,
  SALARY_DEDUCTION_CATEGORIES,
} from './schemas/salary-adjustment.schema';
import { PayrollConfig } from './schemas/payroll-config.schema';
import { UpdatePayrollConfigDto } from './dto/update-payroll-config.dto';
import { PAYROLL_PRESETS } from './constants/payroll-presets';
import {
  SalaryComponentTemplate,
  SalaryComponentDef,
} from './schemas/salary-component-template.schema';
import { PtSlabConfig } from './schemas/pt-slab.schema';
import { TaxDeclaration } from './schemas/tax-declaration.schema';
import { GratuityLedger } from './schemas/gratuity-ledger.schema';
import { FnfSettlement } from './schemas/fnf-settlement.schema';
import {
  CreateSalaryComponentTemplateDto,
  UpdateSalaryComponentTemplateDto,
} from './dto/salary-component-template.dto';
import { BUILT_IN_TEMPLATES } from './constants/salary-component-templates';
import { TeamMember } from '../team/schemas/team-member.schema';
import { TeamService } from '../team/team.service';
import { SetPieceRateConfigDto } from '../team/dto/piece-rate-config.dto';
import { User } from '../users/schemas/user.schema';
import { Attendance } from '../attendance/schemas/attendance.schema';
import { Shift } from '../shifts/schemas/shift.schema';
import { LeaveRequest } from '../leave/schemas/leave-request.schema';
import { LeaveType } from '../leave/schemas/leave-type.schema';
import { sumPaidLeaveCredit, LeaveDaySegmentLite } from './utils/leave-credit.util';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import {
  UpdateSalaryRecordDto,
  RecordPaymentDto,
  BulkRecordPaymentDto,
  CreateIncrementDto,
  CreateSalaryAdjustmentDto,
  ReverseSalaryAdjustmentDto,
  UpsertTaxDeclarationDto,
  PreviewAdvanceScheduleDto,
} from './dto/salary.dto';
import { AppModule } from '../../common/enums/modules.enum';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { calculateComponents } from './utils/component-calculator';
import { ComplianceExportService } from './compliance-export.service';
import { TdsService } from './tds.service';
import { GratuityService } from './gratuity.service';
import { FnfService } from './fnf.service';
import { getLwfRate, isLwfDeductionMonth } from './constants/lwf-rates';
import { BulkEmailJob, BulkEmailJobStatus } from './schemas/bulk-email-job.schema';
import { PayslipPdfService } from './payslip-pdf.service';
import { AttendancePoliciesService } from '../attendance-policies/attendance-policies.service';
import { CallerScopeService } from '../../common/services/caller-scope.service';
import { PostHogService } from '../../common/posthog/posthog.service';
import { stripSalarySensitiveFields, SALARY_INTERNAL_UNFILTERED } from './salary-read-filter';
import {
  AdvanceRecoveryPlan,
  AdvanceRecoveryPlanDocument,
} from './schemas/advance-recovery-plan.schema';
import { buildInstallmentSchedule, InstallmentConfig } from './utils/advance-recovery.util';
import {
  ComplianceGuardService,
  ComplianceBreach,
  ComplianceWarning,
} from './compliance-guard.service';
import { EmployerLoan, EmployerLoanDocument } from './schemas/employer-loan.schema';
import { SalaryDisbursementGuardService } from './salary-disbursement-guard.service';
import { SalaryLedgerPostingService } from './salary-ledger-posting.service';
import { AdvanceSalaryRequestService } from './advance-salary-request.service';
// Workstream G hardening: shared write guard (SoD self-edit block + MEMBER_OFFBOARDED).
import { SalaryWriteGuardService } from './salary-write-guard.service';
// Phase 6 (member-cap read filter): read-time grandfathering of an over-limit
// workspace's roster. Injected to scope the ORG-scoped salary reports
// (getSalaryRecords + the paginated/summary aggregates) to the allowed member
// set. Optional (appended LAST in the constructor) so positional unit-test
// construction keeps it undefined and the cap is a no-op there.
import { ErpMemberCapService } from '../subscriptions/member-cap/erp-member-cap.service';
// Salary-standalone safeguard (2026-06-20): authoritative cross-module entitlement
// check so payroll gates on the live ATTENDANCE/FINANCE subscription, not just the
// in-config feature flag. SubscriptionsModule is @Global() so no extra import wiring.
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AdvanceSalaryRequest } from './schemas/advance-salary-request.schema';
import { PayAdvanceRequestDto } from './dto/advance-salary-request.dto';
import {
  UpdateDisbursementRulesDto,
  UpdateSalaryLossConfigDto,
  UpdateAttendanceRulesDto,
} from './dto/update-disbursement-rules.dto';

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

interface CanonicalBankDetails {
  accountHolderName?: string;
  accountNumber?: string;
  ifscCode?: string;
  bankName?: string;
}

interface CanonicalBankMember {
  name?: string;
  email?: string;
  mobile?: string;
  employeeCode?: string;
  isActive?: boolean;
  isDeleted?: boolean;
  preferredMethod?: string;
  bankDetails?: CanonicalBankDetails | null;
  upiDetails?: { upiId?: string } | null;
}

export interface CanonicalBankFileRow {
  rowId: string;
  employeeCode: string;
  employeeName: string;
  beneficiaryName: string;
  accountNumber: string;
  ifsc: string;
  bankName: string;
  netSalary: number;
  paidSoFar: number;
  amount: number;
  paymentMode: 'NEFT' | 'RTGS' | 'IMPS';
  txnDate: string;
  remarks: string;
  email?: string;
  mobile?: string;
  upiId?: string;
  preferredMethod: 'BANK' | 'UPI' | 'CASH' | 'UNKNOWN';
  isActive: boolean;
  isDeleted: boolean;
  isLocked: boolean;
}

type SalaryMember = Pick<
  TeamMember,
  | 'salaryType'
  | 'salaryAmount'
  | 'dailyHours'
  | 'salaryDayBasis'
  | 'fixedMonthDays'
  | 'attendancePayMode'
  | 'workingDays'
  | 'finalMonthlyOverride'
  | 'ctcAmount'
  | 'componentTemplateId'
  | 'componentOverrides'
>;

type SalaryDayBasis = 'fixed_month_days' | 'calendar_month_days';
type AttendancePayMode = 'default' | 'enabled' | 'disabled';
type AppliedAttendancePayMode = 'enabled' | 'disabled';

type PayrollAttendanceBreakdown = {
  creditedDays: number;
  payableDays: number;
  present: number;
  late: number;
  half_day: number;
  absent: number;
  on_leave: number;
  holiday: number;
  week_off: number;
};

type PaymentStatus = 'active' | 'reversed';

type PaymentSplitLine = {
  method?: string;
  amount?: number;
  dateTime?: string;
  accountNumber?: string;
  bankName?: string;
  upiRef?: string;
  transactionId?: string;
  voucherNo?: string;
  paidBy?: string;
  recordedBy?: string;
  paymentFrom?: string;
  referenceNo?: string;
  note?: string;
  proofUrls?: string[];
};

type PaymentWithOptionalStatus = {
  status?: PaymentStatus;
};

type PaginatedTeamMember = SalaryMember & {
  _id: Types.ObjectId;
  name?: string;
  email?: string;
  designation?: string;
  avatar?: string;
  uan?: TeamMember['uan'];
  pan?: TeamMember['pan'];
  esiIpNumber?: TeamMember['esiIpNumber'];
  employmentType?: TeamMember['employmentType'];
  pfApplicable?: TeamMember['pfApplicable'];
  pfOptedOut?: TeamMember['pfOptedOut'];
  esiApplicable?: TeamMember['esiApplicable'];
  shiftId?: TeamMember['shiftId'];
  bankDetails?: TeamMember['bankDetails'];
  upiDetails?: TeamMember['upiDetails'];
  preferredMethod?: TeamMember['preferredMethod'];
  dateOfJoining?: TeamMember['dateOfJoining'];
  dateOfResignation?: TeamMember['dateOfResignation'];
};

type PaginatedSalaryRecord = {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId | string;
  teamMemberId: Types.ObjectId | string;
  month: number;
  year: number;
  baseSalary: number;
  totalDays: number;
  presentDays: number;
  salaryType?: 'monthly' | 'hourly';
  salaryDayBasis?: SalaryDayBasis;
  fixedMonthDays?: number | null;
  attendancePayModeApplied?: AppliedAttendancePayMode;
  deductions?: number;
  additions?: number;
  netSalary: number;
  status: string;
};

type PaidAmountAggregate = {
  _id: Types.ObjectId;
  paidAmount: number;
};

type AdjustmentCountAggregate = {
  _id: Types.ObjectId;
  adjustmentCount: number;
  activeAdjustmentCount: number;
};

type PaginatedSettlementStatus =
  | 'salary_not_set'
  | 'not_generated'
  | 'pending'
  | 'partial'
  | 'paid'
  | 'overpaid';

type AdvanceOutMeta = {
  amount: number;
  targetMonth: number;
  targetYear: number;
};

type AdvanceRecoveryMeta = {
  amount: number;
};

type SalaryShiftSummary = {
  shiftId: string | null;
  shiftName: string;
  shiftStartTime?: string;
  shiftEndTime?: string;
  employeeCount: number;
  totalPayable: number;
  totalPaid: number;
  totalDue: number;
  pendingCount: number;
  partialCount: number;
  paidCount: number;
  overpaidCount: number;
  notGeneratedCount: number;
  salaryNotSetCount: number;
};

type PayrollOverviewTrendPoint = {
  month: number;
  year: number;
  label: string;
  totalPayable: number;
  totalPaid: number;
  totalDue: number;
};

type AdvancesLoansBonusBlock = {
  totalOutstandingAdvances: number;
  totalActiveLoans: number;
  totalOutstandingLoanPrincipal: number;
  totalBonus: number;
  totalCommission: number;
  totalIncentive: number;
};

type PayrollOverviewResponse = {
  summary: {
    totalPayable: number;
    totalPaid: number;
    totalPending: number;
    totalOverpaid: number;
    employeesCount: number;
    paidCount: number;
    pendingCount: number;
    partialCount: number;
    advanceCount: number;
    salaryNotSetCount: number;
    notGeneratedCount: number;
    advancesLoansBonus?: AdvancesLoansBonusBlock;
  };
  shiftSnapshot: SalaryShiftSummary[];
  trend: PayrollOverviewTrendPoint[];
};

type PaymentRegisterStatus = 'all' | 'active' | 'reversed';

type PaymentRegisterRow = {
  _id: string;
  salaryId: string;
  teamMemberId: string;
  teamMemberName: string;
  salaryMonth: number;
  salaryYear: number;
  paymentDate: Date;
  paymentMode: string;
  amount: number;
  commission: number;
  creditedAmount: number;
  isAdvance: boolean;
  advanceForMonth?: number;
  advanceForYear?: number;
  status: PaymentStatus;
  splitCount: number;
  referenceNo?: string;
  paidBy?: string;
  note?: string;
  proofAttached: boolean;
  createdAt?: Date;
};

type PaymentRegisterResponse = {
  records: PaymentRegisterRow[];
  pagination: { page: number; limit: number; total: number; pages: number };
  summary: {
    totalCredited: number;
    totalReversed: number;
    activeCount: number;
    reversedCount: number;
    advanceCount: number;
    splitCount: number;
  };
};

type PaginatedAdvancePayment = {
  _id: Types.ObjectId;
  salaryId: Types.ObjectId | string;
  advanceForMonth?: number;
  advanceForYear?: number;
  advanceRecoveryAdjustmentId?: Types.ObjectId | string | null;
};

type PaginatedAdvanceRecoveryAdjustment = {
  _id: Types.ObjectId;
  salaryId?: Types.ObjectId | string;
  amount?: number;
};

type PaginatedSalaryRow = {
  _id: Types.ObjectId | null;
  workspaceId: string;
  teamMemberId: string;
  teamMember: PaginatedTeamMember;
  month: number;
  year: number;
  baseSalary: number;
  totalDays: number;
  presentDays: number;
  salaryType?: 'monthly' | 'hourly';
  salaryDayBasis?: SalaryDayBasis;
  fixedMonthDays?: number | null;
  attendancePayModeApplied?: AppliedAttendancePayMode;
  additions: number;
  deductions: number;
  netSalary: number;
  effectiveSalary?: number;
  paidAmount: number;
  status: string;
  isPreview: boolean;
  adjustmentCount: number;
  activeAdjustmentCount: number;
  settlementStatus: PaginatedSettlementStatus;
  advanceOut?: AdvanceOutMeta | null;
  advanceRecovery?: AdvanceRecoveryMeta | null;
  _derivedStatus: string;
};

type SetBasePaySalaryConfigBase = {
  salaryAmount: number;
  preferredMethod?: 'BANK' | 'UPI';
  upiDetails?: TeamMember['upiDetails'];
  bankDetails?: TeamMember['bankDetails'];
  salaryDayBasis: SalaryDayBasis;
  fixedMonthDays?: number | null;
  attendancePayMode: AttendancePayMode;
};

type MonthlySetBasePaySalaryConfig = SetBasePaySalaryConfigBase & {
  salaryType: 'monthly';
  ctcAmount?: number | null;
  componentTemplateId?: string | null;
  componentOverrides?: TeamMember['componentOverrides'];
};

type HourlySetBasePaySalaryConfig = SetBasePaySalaryConfigBase & {
  salaryType: 'hourly';
  finalMonthlyOverride?: number | null;
  dailyHours?: number;
};

type SetBasePaySalaryConfig = MonthlySetBasePaySalaryConfig | HourlySetBasePaySalaryConfig;

type SetBasePaySalaryRecordUpdate = {
  salaryId: string;
  baseSalary: number;
};

@Injectable()
export class SalaryService {
  private readonly logger = new Logger(SalaryService.name);
  private readonly tracer = trace.getTracer('salary');

  // Salary-standalone safeguard (2026-06-20) — short-TTL memo for the ATTENDANCE
  // module entitlement, keyed by workspaceId. A payroll run fans out over many
  // members in a tight loop; this lets us resolve `hasModule(ws, ATTENDANCE)`
  // ONCE per workspace per run (a single Subscription lookup) instead of once
  // per member. The 5s TTL keeps the value fresh across runs without leaking a
  // stale answer on this singleton service (a customer flipping ATTENDANCE on is
  // reflected on the next run, not the current in-flight loop).
  private readonly attendanceModuleMemoTtlMs = 5_000;
  private readonly attendanceModuleMemo = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(
    @InjectModel(Salary.name) private salaryModel: Model<Salary>,
    @InjectModel(Payment.name) private paymentModel: Model<Payment>,
    @InjectModel(TeamMember.name) private teamModel: Model<TeamMember>,
    @InjectModel(Attendance.name) private attendanceModel: Model<Attendance>,
    @InjectModel(SalaryIncrement.name)
    private incrementModel: Model<SalaryIncrement>,
    @InjectModel(SalaryAdjustment.name)
    private salaryAdjustmentModel: Model<SalaryAdjustment>,
    @InjectModel(PayrollConfig.name)
    private payrollConfigModel: Model<PayrollConfig>,
    @InjectModel(PtSlabConfig.name)
    private ptSlabConfigModel: Model<PtSlabConfig>,
    @InjectModel(SalaryComponentTemplate.name)
    private componentTemplateModel: Model<SalaryComponentTemplate>,
    @InjectModel(Workspace.name)
    private workspaceModel: Model<Workspace>,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
    @InjectModel(BulkEmailJob.name)
    private bulkEmailJobModel: Model<BulkEmailJob>,
    @InjectModel(User.name)
    private userModel: Model<User>,
    @InjectModel(Shift.name)
    private shiftModel: Model<Shift>,
    @InjectModel(LeaveRequest.name)
    private leaveRequestModel: Model<LeaveRequest>,
    @InjectModel(LeaveType.name)
    private leaveTypeModel: Model<LeaveType>,
    @InjectModel('ProductionLog')
    private readonly productionLogModel: Model<any>,
    @InjectModel('Machine')
    private readonly machineModel: Model<any>,
    @InjectModel('PieceRateConfigAudit')
    private readonly pieceRateConfigAuditModel: Model<any>,
    @InjectModel(AdvanceRecoveryPlan.name)
    private readonly advanceRecoveryPlanModel: Model<AdvanceRecoveryPlanDocument>,
    private auditService: AuditService,
    private mailService: MailService,
    private payslipPdfService: PayslipPdfService,
    private complianceExportService: ComplianceExportService,
    private tdsService: TdsService,
    private gratuityService: GratuityService,
    private fnfService: FnfService,
    private readonly attendancePoliciesService: AttendancePoliciesService,
    @Inject(forwardRef(() => TeamService))
    private readonly teamService: TeamService,
    private readonly callerScope: CallerScopeService,
    private readonly postHog: PostHogService,
    private readonly complianceGuard: ComplianceGuardService,
    // NOTE: keep employerLoanModel LAST so positional test mocks that omit it
    // get undefined (harmless; the loan-balance fetch is catch-guarded) rather
    // than shifting the service/guard args.
    @InjectModel(EmployerLoan.name)
    private readonly employerLoanModel: Model<EmployerLoanDocument>,
    private readonly salaryDisbursementGuardService: SalaryDisbursementGuardService,
    private readonly salaryLedgerPostingService: SalaryLedgerPostingService,
    private readonly advanceSalaryRequestService: AdvanceSalaryRequestService,
    @InjectModel(AdvanceSalaryRequest.name)
    private readonly advanceSalaryRequestModel: Model<AdvanceSalaryRequest>,
    // Workstream G hardening: appended LAST so existing positional test mocks
    // (which stop before this arg) keep `writeGuard` undefined. The new write
    // paths null-guard it, so the unrelated unit specs do not need updating.
    private readonly writeGuard?: SalaryWriteGuardService,
    // Salary-standalone safeguard (2026-06-20): appended after the existing
    // optional writeGuard so legacy positional test mocks keep this undefined.
    // The attendance-module resolver fail-safes to OFF when it is missing, which
    // is exactly the standalone-no-attendance behaviour, so those specs need no
    // update. NestJS DI always injects the real @Global() SubscriptionsService at
    // runtime (resolution is by type, so placement before the later optional
    // `memberCap` arg is harmless for DI and matches the gate spec's positional
    // construction, which passes subscriptionsService right after writeGuard).
    private readonly subscriptionsService?: SubscriptionsService,
    // Phase 6 (member-cap read filter): appended LAST + OPTIONAL (after
    // writeGuard) so existing positional test mocks keep it undefined. The org-
    // scoped report reads null-guard it, so the cap is a behaviour-preserving
    // no-op when absent (and a transparent pass-through in prod until a workspace
    // is over cap past grace — getAllowedMemberIds returns everyone otherwise).
    private readonly memberCap?: ErpMemberCapService,
  ) {}

  /**
   * Phase 6 (member-cap read filter) — the allowed-member ObjectIds for an
   * ORG-scoped salary report, but ONLY when the cap is actually biting (over cap
   * past grace) AND the caller is NOT the internal/compliance sentinel. Statutory
   * exports (ECR / ESI / bank file) pass SALARY_INTERNAL_UNFILTERED and MUST see
   * the complete roster, so they are never capped. Returns `null` when the cap is
   * not active, the caller is internal, the service is not wired, or resolving it
   * fails (best-effort — a cap failure must not break the report). A `null` result
   * leaves the query unconstrained (no-op) and avoids an unbounded `$in` of the
   * full roster on the common uncapped path.
   */
  private async resolveSalaryAllowedMemberIds(
    workspaceId: string,
    userId: string,
  ): Promise<Types.ObjectId[] | null> {
    if (!this.memberCap) return null;
    // Compliance / internal callers see the full roster — never capped.
    if (userId === SALARY_INTERNAL_UNFILTERED) return null;
    try {
      const status = await this.memberCap.getCapStatus(workspaceId);
      if (!status.capped) return null;
      const allowed = await this.memberCap.getAllowedMemberIds(workspaceId);
      return allowed.map((id) => toObjectId(id));
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
   * Phase 7 (member-cap report notice) — the 4-field cap STATUS for the
   * org-scoped salary REPORT (getSalaryRecordsPaginated) so the web can show the
   * "Showing N of TOTAL — upgrade" notice (mirrors team.service's `memberCap`
   * field on the directory list). Returns the trimmed
   * `{ capped, visibleCount, totalCount, limit }` shape Team uses (drops the
   * grace internals).
   *
   * Returns `null` — i.e. NO notice — for the internal/compliance sentinel
   * (SALARY_INTERNAL_UNFILTERED): statutory exports (ECR / ESI / bank file) see
   * the WHOLE roster, so a "you're only seeing N of TOTAL" notice would be both
   * wrong and a leak hint. Also `null` when the cap service is not wired
   * (positional unit tests) or resolving it fails (best-effort: a cap-status
   * failure must never break the report). Like Team, the status is returned
   * regardless of `capped` for real callers so the web always has live counts.
   * Cross-module: feeds ErpMemberCapService.getCapStatus.
   */
  private async resolveSalaryMemberCapStatus(
    workspaceId: string,
    userId: string,
  ): Promise<{ capped: boolean; visibleCount: number; totalCount: number; limit: number } | null> {
    if (!this.memberCap) return null;
    // Compliance / internal callers see the full roster — never show a cap notice.
    if (userId === SALARY_INTERNAL_UNFILTERED) return null;
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
   * OQ-S5 — block writes against a removed (soft-deleted) member's salary record.
   * Delegates to the shared SalaryWriteGuardService so the rule is identical
   * across SalaryService / LoanService / CommissionService / CashLedgerService.
   * The `allowOffboarded` carve-out keeps F&F + final-month lock open to HR/Owner.
   * Null-guarded for positional unit-test construction (see constructor note).
   */
  private async assertMemberWritableForSalary(
    workspaceId: string,
    targetTeamMemberId: string,
    opts?: { allowOffboarded?: boolean },
  ): Promise<void> {
    if (!this.writeGuard) return;
    await this.writeGuard.assertMemberWritable(workspaceId, targetTeamMemberId, opts);
  }

  private roundCurrency(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * LOW-2 — pull the structured deny `code` out of a caught error, if any.
   * Structured denies throw `HttpException({ code, message })`; the code lives on
   * the exception's response object. Returns undefined for plain errors so the
   * bulk-payment row only carries a `code` when one was actually emitted, matching
   * the single-payment {code} contract.
   */
  private extractDenyCode(error: unknown): string | undefined {
    if (error instanceof HttpException) {
      const res = error.getResponse();
      if (res && typeof res === 'object' && 'code' in res) {
        const code = (res as { code?: unknown }).code;
        if (typeof code === 'string') return code;
      }
    }
    return undefined;
  }

  /**
   * Phase 5 W5 — wrap a handler body in an OpenTelemetry span. Mirrors
   * `TeamService.withTeamSpan` (W6 pilot). Empty `OTEL_EXPORTER_OTLP_ENDPOINT`
   * makes the span a safe no-op; the helper still tags errors via
   * `recordException` + sets ERROR status.
   */
  private async withSalarySpan<T>(
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
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * RBAC scope-split (2026-05-18, audit `salary-shifts-holidays.md` #1-#4).
   *
   * The per-employee salary READ endpoints (`history` / `gratuity` /
   * `advances` / `form16` / `tax-declaration` / `fnf` / `increments`) are
   * decorated `@RequirePermissions(SALARY, VIEW, 'self')`, so RolesGuard
   * admits both `self`- and `all`-scoped callers (`all` is a superset).
   * This guard closes the gap the decorator alone cannot: when the
   * caller's *effective* `salary.view` scope is `self`, the requested
   * `teamMemberId` MUST resolve to the caller's own directory row. An
   * `all`-scoped caller or owner short-circuits (`effectiveScope` returns
   * `'all'`) and may read any employee in the workspace, unchanged.
   *
   * Mirrors `AttendanceService.assertSelfWriteAllowed` — scope is read
   * from live RBAC (role + per-member overrides) via `CallerScopeService`;
   * nothing about the role set is hardcoded here.
   */
  private async assertSalarySelfReadAllowed(
    workspaceId: string,
    userId: string,
    targetTeamMemberId: string,
  ): Promise<void> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    const scope = this.callerScope.effectiveScope(ctx, 'salary', 'view');
    if (scope !== 'self') return; // owner / all-scoped — unrestricted
    if (!ctx.teamMemberId) {
      throw new ForbiddenException(
        'Your role only permits viewing your own salary, but your account has no team-directory record.',
      );
    }
    if (String(targetTeamMemberId) !== ctx.teamMemberId) {
      throw new ForbiddenException('Your role only permits viewing your own salary data.');
    }
  }

  /**
   * OQ-S7 — public self-read gate for the cash ledger. A Karigar (salary.view
   * scope=self) may read ONLY their own running balance; an all-scoped caller or
   * owner reads anyone. Reuses the same salary.view scope resolver as every other
   * per-member read, so the cash-ledger read can never diverge from the rest of
   * the module. Called from the controller (CashLedgerService has no CallerScope).
   */
  async assertSalaryLedgerReadAllowed(
    workspaceId: string,
    userId: string,
    targetTeamMemberId: string,
  ): Promise<void> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, targetTeamMemberId);
  }

  /**
   * SoD (Salary A3): a non-owner cannot edit their OWN salary record. Owner
   * bypasses unconditionally. Mirror of team.service.ts assertNotSelfPrivilegeEdit.
   */
  private async assertNotSelfSalaryEdit(
    workspaceId: string,
    userId: string,
    targetTeamMemberId: string,
  ): Promise<void> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    if (ctx.isOwner) return;
    if (ctx.teamMemberId && String(ctx.teamMemberId) === String(targetTeamMemberId)) {
      throw new ForbiddenException('You cannot edit your own salary record.');
    }
  }

  /**
   * Salary A3: resolve the caller's sensitive-field visibility for salary reads.
   * Owner always sees; otherwise the caller must hold salary.sensitive_view.
   * Returns null for ownTeamMemberId when the caller has no team-directory row.
   * Public so the controller can apply the filter after getPayslipData returns.
   */
  async resolveSalarySensitiveCtx(
    workspaceId: string,
    userId: string,
  ): Promise<{ isOwner: boolean; ownTeamMemberId: string | null; canViewSensitive: boolean }> {
    if (userId === SALARY_INTERNAL_UNFILTERED) {
      return { isOwner: true, ownTeamMemberId: null, canViewSensitive: true };
    }
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    const sensitiveScope = this.callerScope.effectiveScope(ctx, 'salary', 'sensitive_view');
    return {
      isOwner: ctx.isOwner,
      ownTeamMemberId: ctx.teamMemberId ? String(ctx.teamMemberId) : null,
      canViewSensitive: ctx.isOwner || sensitiveScope != null,
    };
  }

  /**
   * OQ-S1 / OQ-S3 — HR+Owner-only gate for statutory exports and the sensitive
   * PayrollConfig sub-documents. Statutory exports (ECR / ESI challan / bank file)
   * carry employee PAN, UAN, ESI IP, and bank account numbers; the deductor +
   * statutory config carry the employer TAN/PAN/PF/ESI codes. All are sensitive,
   * so they are restricted to the workspace owner OR a caller holding
   * `salary.sensitive_view` (the HR preset). A Manager (no sensitive_view) is
   * denied with SALARY_EXPORT_FORBIDDEN. Reuses the exact discriminator the
   * salary-read-filter uses, so "who is HR" never diverges across the module.
   */
  async isSalaryComplianceViewer(workspaceId: string, userId: string): Promise<boolean> {
    const sens = await this.resolveSalarySensitiveCtx(workspaceId, userId);
    return sens.isOwner || sens.canViewSensitive;
  }

  async assertSalaryComplianceExportAllowed(workspaceId: string, userId: string): Promise<void> {
    const allowed = await this.isSalaryComplianceViewer(workspaceId, userId);
    if (!allowed) {
      throw new ForbiddenException({
        code: 'SALARY_EXPORT_FORBIDDEN',
        message:
          'Statutory exports (PF ECR, ESI challan, bank file) are restricted to HR and the workspace owner.',
      });
    }
  }

  private getObjectIdString(value: unknown): string {
    if (value instanceof Types.ObjectId) return value.toString();
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && '_id' in value) {
      const nestedId = (value as { _id?: string | Types.ObjectId })._id;
      if (nestedId instanceof Types.ObjectId) return nestedId.toString();
      if (typeof nestedId === 'string') return nestedId;
    }
    return '';
  }

  private getPaymentStatus(payment: PaymentWithOptionalStatus): PaymentStatus {
    return payment.status ?? 'active';
  }

  private getMemberName(member?: { name?: string | null }): string {
    return member?.name ?? '';
  }

  private getComplianceRecordMember(record: {
    teamMember?: unknown;
    teamMemberId?: unknown;
  }): Partial<TeamMember> | null {
    if (record.teamMember && typeof record.teamMember === 'object') {
      return record.teamMember as Partial<TeamMember>;
    }

    if (record.teamMemberId && typeof record.teamMemberId === 'object') {
      return record.teamMemberId as Partial<TeamMember>;
    }

    return null;
  }

  private sanitizeComplianceCode(value?: string | null): string {
    const sanitized = (value || '').replace(/[^A-Za-z0-9_-]/g, '');
    return sanitized || 'UNKNOWN';
  }

  private buildAdjustmentAuditSnapshot(adjustment: SalaryAdjustment) {
    return {
      id: this.getObjectIdString(adjustment._id),
      salaryId: this.getObjectIdString(adjustment.salaryId),
      teamMemberId: this.getObjectIdString(adjustment.teamMemberId),
      month: adjustment.month,
      year: adjustment.year,
      type: adjustment.type,
      category: adjustment.category,
      amount: adjustment.amount,
      correctionOfAdjustmentId: adjustment.correctionOfAdjustmentId
        ? this.getObjectIdString(adjustment.correctionOfAdjustmentId)
        : undefined,
      reasonTitle: adjustment.reasonTitle,
      note: adjustment.note,
      attachments: adjustment.attachments ?? [],
      source: adjustment.source,
      linkedPaymentId: adjustment.linkedPaymentId
        ? this.getObjectIdString(adjustment.linkedPaymentId)
        : undefined,
      status: adjustment.status,
      createdBy: this.getObjectIdString(adjustment.createdBy),
      createdAt: adjustment.createdAt,
      reversedBy: adjustment.reversedBy ? this.getObjectIdString(adjustment.reversedBy) : undefined,
      reversedAt: adjustment.reversedAt,
      reversalReason: adjustment.reversalReason,
    };
  }

  private deriveSalaryStatus(baseSalary: number, netSalary: number, paidAmount: number): string {
    if (baseSalary <= 0 || netSalary <= 0) return 'salary_not_set';
    if (paidAmount >= netSalary) return paidAmount > netSalary ? 'advance' : 'paid';
    if (paidAmount > 0) return 'partial';
    return 'pending';
  }

  private mapSettlementStatus(derivedStatus: string): PaginatedSettlementStatus {
    switch (derivedStatus) {
      case 'advance':
        return 'overpaid';
      case 'paid':
      case 'partial':
      case 'pending':
      case 'not_generated':
      case 'salary_not_set':
        return derivedStatus;
      default:
        return 'pending';
    }
  }

  private computeSalarySummary(rows: PaginatedSalaryRow[]) {
    const summary = {
      totalPayable: 0,
      totalPaid: 0,
      totalPending: 0,
      totalOverpaid: 0,
      employeesCount: rows.length,
      paidCount: 0,
      pendingCount: 0,
      partialCount: 0,
      advanceCount: 0,
      salaryNotSetCount: 0,
      notGeneratedCount: 0,
    };

    rows.forEach((row) => {
      summary.totalPayable += row.netSalary;
      summary.totalPaid += row.paidAmount;

      switch (row._derivedStatus) {
        case 'paid':
          summary.paidCount++;
          break;
        case 'partial':
          summary.partialCount++;
          break;
        case 'advance':
          summary.advanceCount++;
          break;
        case 'salary_not_set':
          summary.salaryNotSetCount++;
          break;
        case 'not_generated':
          summary.notGeneratedCount++;
          break;
        default:
          summary.pendingCount++;
          break;
      }
    });

    summary.totalPayable = this.roundCurrency(summary.totalPayable);
    summary.totalPaid = this.roundCurrency(summary.totalPaid);
    summary.totalPending = this.roundCurrency(
      Math.max(0, summary.totalPayable - summary.totalPaid),
    );
    summary.totalOverpaid = this.roundCurrency(
      Math.max(0, summary.totalPaid - summary.totalPayable),
    );

    return summary;
  }

  private async attachPaginatedSettlementMetadata<
    T extends {
      _id: Types.ObjectId | string | null;
      netSalary: number;
      paidAmount: number;
      settlementStatus: PaginatedSettlementStatus;
    },
  >(
    workspaceId: string,
    rows: T[],
  ): Promise<
    Array<
      T & {
        advanceOut: AdvanceOutMeta | null;
        advanceRecovery: AdvanceRecoveryMeta | null;
      }
    >
  > {
    if (rows.length === 0) {
      return rows.map((row) => ({
        ...row,
        advanceOut: null,
        advanceRecovery: null,
      }));
    }

    const workspaceObjectId = toObjectId(workspaceId);
    const salaryObjectIds = rows
      .map((row) => row._id)
      .filter((rowId): rowId is Types.ObjectId | string => Boolean(rowId))
      .map((rowId) => toObjectId(String(rowId)));

    if (salaryObjectIds.length === 0) {
      return rows.map((row) => ({
        ...row,
        advanceOut: null,
        advanceRecovery: null,
      }));
    }

    const [advancePayments, activeAdvanceRecoveries] = await Promise.all([
      this.paymentModel
        .find({
          workspaceId: workspaceObjectId,
          salaryId: { $in: salaryObjectIds },
          isAdvance: true,
          status: { $ne: 'reversed' },
        })
        .select('_id salaryId advanceForMonth advanceForYear advanceRecoveryAdjustmentId')
        .lean<PaginatedAdvancePayment[]>()
        .exec(),
      this.salaryAdjustmentModel
        .find({
          workspaceId: workspaceObjectId,
          salaryId: { $in: salaryObjectIds },
          category: 'advance_recovery',
          source: 'system',
          status: 'active',
        })
        .select('_id salaryId amount')
        .lean<PaginatedAdvanceRecoveryAdjustment[]>()
        .exec(),
    ]);

    const linkedAdvanceRecoveryIds = [
      ...new Set(
        advancePayments
          .map((payment) =>
            payment.advanceRecoveryAdjustmentId
              ? this.getObjectIdString(payment.advanceRecoveryAdjustmentId)
              : '',
          )
          .filter(Boolean),
      ),
    ];

    let linkedAdvanceRecoveryAmountMap = new Map<string, number>();
    if (linkedAdvanceRecoveryIds.length > 0) {
      const linkedAdvanceRecoveries = await this.salaryAdjustmentModel
        .find({
          workspaceId: workspaceObjectId,
          _id: { $in: linkedAdvanceRecoveryIds.map((id) => toObjectId(id)) },
        })
        .select('_id amount')
        .lean<PaginatedAdvanceRecoveryAdjustment[]>()
        .exec();

      linkedAdvanceRecoveryAmountMap = new Map(
        linkedAdvanceRecoveries.map((adjustment) => [
          this.getObjectIdString(adjustment._id),
          adjustment.amount ?? 0,
        ]),
      );
    }

    const advanceOutBySalaryId = new Map<string, AdvanceOutMeta>();
    advancePayments.forEach((payment) => {
      const salaryId = this.getObjectIdString(payment.salaryId);
      if (!salaryId) return;

      const targetMonth = payment.advanceForMonth ?? 0;
      const targetYear = payment.advanceForYear ?? 0;
      if (!targetMonth || !targetYear) return;

      const linkedAmount = payment.advanceRecoveryAdjustmentId
        ? (linkedAdvanceRecoveryAmountMap.get(
            this.getObjectIdString(payment.advanceRecoveryAdjustmentId),
          ) ?? 0)
        : 0;

      const existing = advanceOutBySalaryId.get(salaryId);
      advanceOutBySalaryId.set(salaryId, {
        amount: (existing?.amount ?? 0) + linkedAmount,
        targetMonth,
        targetYear,
      });
    });

    const advanceRecoveryBySalaryId = new Map<string, number>();
    activeAdvanceRecoveries.forEach((adjustment) => {
      const salaryId = this.getObjectIdString(adjustment.salaryId);
      if (!salaryId) return;

      advanceRecoveryBySalaryId.set(
        salaryId,
        (advanceRecoveryBySalaryId.get(salaryId) ?? 0) + (adjustment.amount ?? 0),
      );
    });

    return rows.map((row) => {
      const salaryId = row._id ? this.getObjectIdString(row._id) : '';
      const rawAdvanceOut = salaryId ? (advanceOutBySalaryId.get(salaryId) ?? null) : null;
      const overpaidAmount = this.roundCurrency(
        Math.max(0, (row.paidAmount ?? 0) - (row.netSalary ?? 0)),
      );
      const advanceOut = rawAdvanceOut
        ? {
            ...rawAdvanceOut,
            amount: this.roundCurrency(
              rawAdvanceOut.amount > 0 ? rawAdvanceOut.amount : overpaidAmount,
            ),
          }
        : null;

      const advanceRecoveryAmount = salaryId ? advanceRecoveryBySalaryId.get(salaryId) : undefined;

      return {
        ...row,
        advanceOut,
        advanceRecovery:
          advanceRecoveryAmount && advanceRecoveryAmount > 0
            ? {
                amount: this.roundCurrency(advanceRecoveryAmount),
              }
            : null,
      };
    });
  }

  private getMonthLength(month: number, year: number): number {
    return new Date(year, month, 0).getDate();
  }

  private countCalendarDaysInclusive(start: Date, end: Date): number {
    const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    return Math.max(0, Math.floor((endUtc - startUtc) / 86_400_000) + 1);
  }

  private resolveEmploymentWindow(
    member: Pick<TeamMember, 'dateOfJoining' | 'dateOfResignation'>,
    month: number,
    year: number,
  ) {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0, 23, 59, 59, 999);
    const monthLength = this.getMonthLength(month, year);

    const activeStart =
      member.dateOfJoining && member.dateOfJoining > firstDay
        ? new Date(member.dateOfJoining)
        : new Date(firstDay);
    const activeEnd =
      member.dateOfResignation && member.dateOfResignation < lastDay
        ? new Date(member.dateOfResignation)
        : new Date(lastDay);

    activeStart.setHours(0, 0, 0, 0);
    activeEnd.setHours(23, 59, 59, 999);

    return {
      firstDay,
      lastDay,
      activeStart,
      activeEnd,
      monthLength,
      activeCalendarDays:
        activeStart > activeEnd ? 0 : this.countCalendarDaysInclusive(activeStart, activeEnd),
    };
  }

  /**
   * Salary-standalone safeguard (2026-06-20) — authoritative "is the ATTENDANCE
   * module live for this workspace?" check, resolved ONCE per workspace per
   * payroll run via a short-TTL memo (see `attendanceModuleMemo`).
   *
   * Threaded into `resolveSalaryCalculationContext` so the attendance pay-mode
   * gate keys off BOTH the in-config feature flag AND the live subscription
   * entitlement. Without this, ATTENDANCE switched OFF (the ManekHR default
   * preset) while `features.attendanceBasedPay` is still true would run the
   * attendance branch against an empty/absent Attendance collection →
   * presentDays=0 → silent ZERO net pay for everyone. This is the #1 standalone
   * risk; resolving the module flag here forces the fixed/calendar-day branch.
   *
   * Fail-safe: if SubscriptionsService is unavailable (e.g. positional test
   * mocks that stop before this dep) or `hasModule` throws, we return FALSE —
   * i.e. treat ATTENDANCE as OFF, which routes salary through the safe
   * fixed-day math rather than the attendance query.
   */
  private async resolveAttendanceModuleEnabled(workspaceId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.attendanceModuleMemo.get(workspaceId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    let value = false;
    try {
      value = (await this.subscriptionsService?.hasModule(workspaceId, AppModule.ATTENDANCE)) ?? false;
    } catch (err: unknown) {
      // Fail-safe OFF: never let an entitlement-lookup failure flip salary onto
      // the attendance branch (which could zero out pay off empty data).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `ATTENDANCE entitlement lookup failed for workspace ${workspaceId}; treating attendance as OFF (fixed-day pay). ${msg}`,
      );
      value = false;
    }

    this.attendanceModuleMemo.set(workspaceId, {
      value,
      expiresAt: now + this.attendanceModuleMemoTtlMs,
    });
    return value;
  }

  private resolveSalaryCalculationContext(
    member: SalaryMember & Pick<TeamMember, 'dateOfJoining' | 'dateOfResignation'>,
    month: number,
    year: number,
    config: Pick<PayrollConfig, 'features' | 'display' | 'rules'>,
    // Salary-standalone safeguard (2026-06-20) — the live ATTENDANCE-module flag,
    // resolved ONCE per workspace by the async caller and threaded in (kept SYNC
    // here, no per-member entitlement lookup). When false, the attendance pay
    // gate is forced OFF below regardless of the in-config feature flag.
    attendanceModuleEnabled: boolean,
  ) {
    const { firstDay, lastDay, activeStart, activeEnd, monthLength, activeCalendarDays } =
      this.resolveEmploymentWindow(member, month, year);
    const salaryDayBasis: SalaryDayBasis =
      member.salaryDayBasis === 'calendar_month_days' ? 'calendar_month_days' : 'fixed_month_days';
    const defaultWorkingDays = Math.max(
      1,
      Math.min(31, Number(config.display?.defaultWorkingDays ?? 26) || 26),
    );
    const fixedMonthDays =
      salaryDayBasis === 'fixed_month_days'
        ? Math.max(
            1,
            Math.min(
              31,
              Number(member.fixedMonthDays ?? member.workingDays ?? defaultWorkingDays) ||
                defaultWorkingDays,
            ),
          )
        : null;
    const basisDays =
      salaryDayBasis === 'calendar_month_days'
        ? monthLength
        : (fixedMonthDays ?? defaultWorkingDays);
    const configuredAttendancePayMode: AttendancePayMode =
      member.attendancePayMode === 'enabled' || member.attendancePayMode === 'disabled'
        ? member.attendancePayMode
        : 'default';
    // Salary-standalone safeguard (2026-06-20): the attendance pay mode is now
    // authoritative on the LIVE ATTENDANCE module entitlement, not just the
    // in-config feature flag. `attendanceModuleEnabled` is resolved once per
    // workspace by the async caller (single `hasModule` lookup). When ATTENDANCE
    // is OFF, the flag drops to false here BEFORE any attendance query runs, so
    // an empty/absent Attendance collection can never zero out pay — the
    // fixed/calendar-day branch (already in buildSalaryRecordData) is used.
    const attendanceFeatureEnabled =
      config.features?.attendanceBasedPay !== false && attendanceModuleEnabled === true;
    const workspaceAttendanceDefault: AppliedAttendancePayMode =
      config.rules?.attendancePayModeDefault === 'disabled' ? 'disabled' : 'enabled';
    const attendancePayModeApplied: AppliedAttendancePayMode = !attendanceFeatureEnabled
      ? 'disabled'
      : configuredAttendancePayMode === 'default'
        ? workspaceAttendanceDefault
        : configuredAttendancePayMode;

    return {
      firstDay,
      lastDay,
      activeStart,
      activeEnd,
      monthLength,
      activeCalendarDays,
      salaryDayBasis,
      fixedMonthDays,
      basisDays,
      configuredAttendancePayMode,
      attendancePayModeApplied,
    };
  }

  private resolveEffectiveMonthlySalary(
    member: SalaryMember,
    options?: { month?: number; year?: number; defaultWorkingDays?: number },
  ): number {
    // CTC-based resolution:
    // If member has ctcAmount > 0 AND componentTemplateId AND salaryType is NOT 'hourly',
    // the actual CTC → component → baseSalary resolution happens at save time
    // (see resolveAndApplyCtcToBaseSalary). This method uses member.salaryAmount
    // which will be pre-populated from the CTC calculation.
    if ((member.salaryType || 'monthly') !== 'hourly') {
      return Math.max(0, member.salaryAmount || 0);
    }

    if (member.finalMonthlyOverride !== undefined && member.finalMonthlyOverride !== null) {
      return Math.max(0, member.finalMonthlyOverride);
    }

    const hourlyRate = Math.max(0, member.salaryAmount || 0);
    const dailyHours = Math.max(0, member.dailyHours || 0);
    const resolvedMonth = options?.month ?? new Date().getMonth() + 1;
    const resolvedYear = options?.year ?? new Date().getFullYear();
    const defaultWorkingDays = Math.max(1, Math.min(31, options?.defaultWorkingDays ?? 26));
    const basisDays =
      member.salaryDayBasis === 'calendar_month_days'
        ? this.getMonthLength(resolvedMonth, resolvedYear)
        : Math.max(
            0,
            Number(member.fixedMonthDays ?? member.workingDays ?? defaultWorkingDays) ||
              defaultWorkingDays,
          );
    return this.roundCurrency(hourlyRate * dailyHours * basisDays);
  }

  private calculateNetSalary(
    baseSalary: number,
    totalDays: number,
    presentDays: number,
    additions = 0,
    deductions = 0,
    pieceEarnings: number = 0,
  ): number {
    const perDay = totalDays > 0 ? baseSalary / totalDays : 0;
    // D-04: pieceEarnings is NEVER LOP'd — added additively to net.
    const calculatedNet = perDay * presentDays + pieceEarnings + additions - deductions;
    return this.roundCurrency(Math.max(0, calculatedNet));
  }

  private async assertNotLocked(salaryId: Types.ObjectId | string): Promise<void> {
    const record = await this.salaryModel.findById(salaryId).select('isLocked').lean().exec();

    if (record?.isLocked) {
      throw new BadRequestException(
        'This salary record is locked and cannot be modified. Unlock it first to make changes.',
      );
    }
  }

  /**
   * Returns true if ANY salary record in (workspaceId, month, year) is locked.
   * Used by Phase 21 ProductionLogs (and future Phase 22 Downtime / Phase 24
   * Maintenance) to gate write operations once payroll is locked for the month.
   *
   * Cache-friendly for bulk callers (Pitfall 6): callers that loop over many
   * rows for the same (year, month) should memoise the result themselves —
   * this method does not cache internally.
   *
   * @param workspaceId workspace ObjectId or stringified ObjectId
   * @param month 1-12 (calendar month in workspace tz)
   * @param year 4-digit year
   */
  async isMonthPayrollLocked(
    workspaceId: string | Types.ObjectId,
    month: number,
    year: number,
  ): Promise<boolean> {
    const wsId = typeof workspaceId === 'string' ? new Types.ObjectId(workspaceId) : workspaceId;
    const record = await this.salaryModel
      .findOne({
        workspaceId: wsId,
        month,
        year,
        isLocked: true,
      })
      .select('_id')
      .lean()
      .exec();
    return record !== null;
  }

  /**
   * Phase 23 D-07 — mark the (un-locked) piece-rate Salary row stale so the UI
   * can show a "Recompute" badge. Eventually-consistent; fire-and-forget at
   * call sites. No-op when:
   *   - date is malformed
   *   - team member is not piece_rate
   *   - matching salary row does not exist (e.g. month not yet generated)
   *   - matching salary row is already locked (snapshot is immutable post-lock)
   *
   * Per-(teamMemberId, month, year) dedupe is the caller's responsibility
   * (e.g. ProductionLogsService.bulkCreate uses a Set to call once per worker/month).
   */
  async markPieceRateStale(
    workspaceId: string | Types.ObjectId,
    teamMemberId: string | Types.ObjectId,
    date: string,
  ): Promise<void> {
    if (!date || typeof date !== 'string') return;
    const parts = date.split('-');
    if (parts.length < 2) return;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    if (Number.isNaN(year) || Number.isNaN(month)) return;

    // Wrap autocast (Mongoose 8.23 bug — see project_attendance_module_session)
    const memberObjectId = new Types.ObjectId(String(teamMemberId));
    const wsObjectId = new Types.ObjectId(String(workspaceId));

    const member = await this.teamModel.findById(memberObjectId).select('salaryType').lean().exec();
    if ((member as any)?.salaryType !== 'piece_rate') return;

    await this.salaryModel
      .updateOne(
        {
          workspaceId: wsObjectId,
          teamMemberId: memberObjectId,
          month,
          year,
          isLocked: false,
        },
        { $set: { pieceRateStale: true } },
      )
      .exec();
  }

  /**
   * Resolve calendar month boundary as YYYY-MM-DD strings.
   * ProductionLog.date is stored as YYYY-MM-DD so lex comparison works.
   * Workspace tz refinement deferred to follow-up.
   */
  private resolveMonthBoundary(
    month: number,
    year: number,
  ): { monthStart: string; monthEnd: string } {
    const daysInMonth = new Date(year, month, 0).getDate();
    const mm = String(month).padStart(2, '0');
    return {
      monthStart: `${year}-${mm}-01`,
      monthEnd: `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`,
    };
  }

  /**
   * Phase 23 keystone: compute piece-rate earnings for a team member in a month.
   *
   * - Resolves pieceRateConfig (snapshot for immutable Salary record).
   * - Aggregates ProductionLog rows in [monthStart, monthEnd], non-deleted.
   * - Per-row rate: perMachineOverrides[machineId] ?? defaultRate.
   * - Per-row qty: derived from cfg.unit (per_piece, per_thousand_stitches,
   *   per_design_completed, blended → machine.primaryMetric).
   * - Per-row amount = round(qty * rate, 2dp); pieceEarnings = sum.
   *
   * D-12 (MACH-P2-XC-06): every ObjectId compare wraps with new Types.ObjectId().
   * D-04: piece earnings are NEVER LOP'd — caller adds to net additively.
   * Pure function — same inputs → same outputs (idempotent, no transactions).
   */
  async computePieceRateEarnings(
    workspaceId: Types.ObjectId | string,
    teamMemberId: string | Types.ObjectId,
    month: number,
    year: number,
    member?: any,
  ): Promise<{
    pieceEarnings: number;
    basePortion: number;
    snapshot: any;
    breakdown: any[];
  }> {
    // CR-01 defence-in-depth: always scope team member read by workspaceId so
    // no future caller can bypass the wrapper-level tenant assertion.
    const wsObjectId = new Types.ObjectId(String(workspaceId));
    const tmObjectId = new Types.ObjectId(String(teamMemberId));
    const m =
      member ??
      (await this.teamModel.findOne({ _id: tmObjectId, workspaceId: wsObjectId }).lean().exec());
    if (!m) {
      throw new NotFoundException({ code: 'TEAM_MEMBER_NOT_FOUND' });
    }
    // When `member` was supplied by caller, still verify it belongs to the
    // same workspace — protects against caller bugs that fetch cross-tenant.
    if (member && String(m.workspaceId) !== String(wsObjectId)) {
      throw new NotFoundException({ code: 'TEAM_MEMBER_NOT_FOUND' });
    }
    const cfg = m.pieceRateConfig;
    if (!cfg) {
      throw new BadRequestException({
        code: 'PIECE_RATE_NOT_CONFIGURED',
        message: 'Team member has no piece-rate configuration',
      });
    }

    const wsId = m.workspaceId;

    // Snapshot config NOW (immutable on Salary doc — D-05)
    // ME-03: capture effectiveFrom + includeStitchUnit so the snapshot is a
    // complete record of the config-of-record at compute time. These fields
    // are needed for audit / payslip explainability.
    const snapshot = {
      unit: cfg.unit,
      defaultRate: cfg.defaultRate,
      basePortion: cfg.basePortion ?? 0,
      perMachineOverrides: (cfg.perMachineOverrides ?? []).map((o: any) => ({
        machineId: o.machineId,
        rate: o.rate,
      })),
      effectiveFrom: cfg.effectiveFrom ?? null,
      includeStitchUnit: cfg.includeStitchUnit ?? true,
    };

    // Build override lookup (string-keyed for stable compare)
    const overrideMap = new Map<string, number>();
    for (const o of snapshot.perMachineOverrides) {
      overrideMap.set(String(o.machineId), o.rate);
    }

    // Month boundary (YYYY-MM-DD lex compare matches ProductionLog.date)
    const { monthStart, monthEnd } = this.resolveMonthBoundary(month, year);

    // Aggregate logs (D-12 autocast wraps)
    const logs = await this.productionLogModel
      .find({
        workspaceId: new Types.ObjectId(String(wsId)),
        teamMemberId: new Types.ObjectId(String(teamMemberId)),
        date: { $gte: monthStart, $lte: monthEnd },
        isDeleted: false,
      })
      .sort({ date: 1 })
      .lean()
      .exec();

    // Batch-fetch machine codes + primaryMetric for breakdown display
    const uniqueMachineIds = [...new Set(logs.map((l: any) => String(l.machineId)))];
    const machines =
      uniqueMachineIds.length > 0
        ? await this.machineModel
            .find({
              _id: {
                $in: uniqueMachineIds.map((id) => new Types.ObjectId(id)),
              },
            })
            .select('machineCode primaryMetric')
            .lean()
            .exec()
        : [];
    const machineMap = new Map<string, { machineCode: string; primaryMetric: string }>(
      machines.map((mc: any) => [
        String(mc._id),
        {
          machineCode: mc.machineCode ?? '',
          primaryMetric: mc.primaryMetric ?? 'pieces',
        },
      ]),
    );

    // Per-row computation
    const breakdown: any[] = [];
    let pieceEarnings = 0;

    for (const log of logs as any[]) {
      const machineMeta = machineMap.get(String(log.machineId));
      const rate = overrideMap.get(String(log.machineId)) ?? snapshot.defaultRate;

      // Derive qty + metricLabel by unit
      let qty = 0;
      let metricLabel = '';
      switch (snapshot.unit) {
        case 'per_piece':
          qty = log.pieceCount ?? 0;
          metricLabel = 'pieces';
          break;
        case 'per_thousand_stitches':
          qty = (log.stitchCount ?? 0) / 1000;
          metricLabel = 'stitches/1000';
          break;
        case 'per_design_completed':
          qty = log.pieceCount ?? 0;
          metricLabel = 'designs';
          break;
        case 'blended': {
          const primary = machineMeta?.primaryMetric ?? 'pieces';
          if (primary === 'stitches') {
            qty = (log.stitchCount ?? 0) / 1000;
            metricLabel = 'stitches/1000';
          } else if (primary === 'hours') {
            qty = log.hoursLogged ?? 0;
            metricLabel = 'hours';
          } else {
            qty = log.pieceCount ?? 0;
            metricLabel = 'pieces';
          }
          break;
        }
      }

      // Round 2dp at row level (CONTEXT specifics: row-level round + then sum)
      // ME-04: use shared roundCurrency helper for consistency with rest of
      // the salary module (single rounding policy across all earnings paths).
      const amount = this.roundCurrency(qty * rate);
      pieceEarnings += amount;

      breakdown.push({
        logId: log._id,
        downtimeCode: log.logCode,
        date: log.date,
        machineId: log.machineId,
        machineCode: machineMeta?.machineCode ?? '',
        metricLabel,
        qty: Math.round(qty * 10000) / 10000, // 4dp display precision
        rate,
        amount,
      });
    }

    pieceEarnings = this.roundCurrency(pieceEarnings);

    return {
      pieceEarnings,
      basePortion: snapshot.basePortion,
      snapshot,
      breakdown,
    };
  }

  /**
   * Resolve a member's shift duration in minutes. Falls back to 480 (8h) when
   * the member has no shiftId or the shift doc is missing.
   * Mirrors the midnight-cross logic from attendance/projection/compute.ts.
   * H3-05 — closes GAP-2.2-C.
   */
  private async resolveShiftDurationMinutes(teamMemberId: Types.ObjectId): Promise<number> {
    const FALLBACK = 480;
    const member = await this.teamModel.findById(teamMemberId).select('shiftId').lean().exec();
    if (!member?.shiftId) return FALLBACK;
    const shift = (await this.shiftModel
      .findById(member.shiftId)
      .select('startTime endTime')
      .lean()
      .exec()) as { startTime?: string; endTime?: string } | null;
    if (!shift?.startTime || !shift?.endTime) return FALLBACK;
    const [sh, sm] = shift.startTime.split(':').map(Number);
    const [eh, em] = shift.endTime.split(':').map(Number);
    if (Number.isNaN(sh) || Number.isNaN(sm) || Number.isNaN(eh) || Number.isNaN(em))
      return FALLBACK;
    const startMin = sh * 60 + sm;
    let endMin = eh * 60 + em;
    if (endMin <= startMin) endMin += 1440;
    const duration = endMin - startMin;
    return duration > 0 ? duration : FALLBACK;
  }

  // Phase C soft integration (DC-6): minute-accurate LOP supplement.
  // Returns additional deduction in currency units; 0 when insufficient data or policy disabled.
  private async calculateMinuteAccurateLop(
    attendance: Attendance[],
    baseSalary: number,
    workspaceId: string,
    month: number,
    year: number,
    teamMemberId: Types.ObjectId,
  ): Promise<number> {
    // GAP-2.2-D: half-day is already counted by buildPayrollAttendanceBreakdown
    // (0.5 day deduction). L4: an `on_leave` day is approved leave — paid leave
    // is credited / LWP is docked via the breakdown, so it never belongs in the
    // minute-accurate worked-shortfall LOP. Exclude both to prevent double-dipping.
    const eligible = attendance.filter((r) => r.status !== 'half_day' && r.status !== 'on_leave');

    const recordsWithMinutes = eligible.filter(
      (r) => r.workedMinutes !== null && r.workedMinutes !== undefined,
    );
    if (recordsWithMinutes.length < eligible.length / 2) return 0;

    const policy = await this.attendancePoliciesService.findDefault(workspaceId);
    if (!policy?.lateArrival?.countAsLop) return 0;

    // GAP-2.2-C: per-member shift duration instead of hardcoded 480.
    // teamMemberId is passed explicitly by the caller — no fragile array-pluck needed.
    const shiftDurationMinutes = await this.resolveShiftDurationMinutes(teamMemberId);

    const workingDaysInMonth = new Date(year, month, 0).getDate();
    const totalShiftMinutesInMonth = shiftDurationMinutes * workingDaysInMonth;
    if (totalShiftMinutesInMonth <= 0) return 0;

    const totalWorkedMinutes = recordsWithMinutes.reduce(
      (sum, r) => sum + (r.workedMinutes ?? 0),
      0,
    );
    const expectedMinutes = shiftDurationMinutes * recordsWithMinutes.length;
    let lopMinutes = Math.max(0, expectedMinutes - totalWorkedMinutes);

    // lopAfterNLateDays — grace quota. The first N `late` days in the cycle
    // are forgiven: their worked-minute shortfall is excluded from the LOP
    // total, so an employer can grant e.g. "3 free late marks per month".
    const graceLateDays = policy.lateArrival.lopAfterNLateDays ?? 0;
    if (graceLateDays > 0 && lopMinutes > 0) {
      const forgivenShortfall = recordsWithMinutes
        .filter((r) => r.status === 'late')
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .slice(0, graceLateDays)
        .reduce((sum, r) => sum + Math.max(0, shiftDurationMinutes - (r.workedMinutes ?? 0)), 0);
      lopMinutes = Math.max(0, lopMinutes - forgivenShortfall);
    }
    if (lopMinutes <= 0) return 0;

    return (baseSalary / totalShiftMinutesInMonth) * lopMinutes;
  }

  /**
   * Paid-leave day credit for a member over a salary period — L4 event-based
   * coupling to the leave module. Reads approved `LeaveRequest`s (no FK) and
   * returns the day-count their paid segments contribute to `creditedDays`.
   * Unpaid (LWP) segments are excluded so they remain docked.
   */
  private async computePaidLeaveCredit(
    workspaceId: string,
    teamMemberId: Types.ObjectId,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    const requests = await this.leaveRequestModel
      .find({
        workspaceId: toObjectId(workspaceId),
        teamMemberId,
        status: 'approved',
        fromDate: { $lte: periodEnd },
        toDate: { $gte: periodStart },
      })
      .select('dayBreakdown')
      .lean()
      .exec();
    if (requests.length === 0) return 0;

    const segments: LeaveDaySegmentLite[] = [];
    const typeIds = new Set<string>();
    for (const req of requests) {
      for (const seg of req.dayBreakdown ?? []) {
        const typeId = String(seg.leaveTypeId);
        segments.push({ date: seg.date, leaveTypeId: typeId, quantity: seg.quantity });
        typeIds.add(typeId);
      }
    }
    if (segments.length === 0) return 0;

    const types = await this.leaveTypeModel
      .find({ _id: { $in: [...typeIds].map((id) => new Types.ObjectId(id)) } })
      .select('isPaid')
      .lean()
      .exec();
    const isPaidByTypeId = new Map<string, boolean>(types.map((t) => [String(t._id), t.isPaid]));

    return sumPaidLeaveCredit(segments, isPaidByTypeId, periodStart, periodEnd);
  }

  private buildPayrollAttendanceBreakdown(
    attendance: Attendance[],
    month: number,
    year: number,
  ): PayrollAttendanceBreakdown {
    const counts: Record<
      keyof Omit<PayrollAttendanceBreakdown, 'creditedDays' | 'payableDays'>,
      number
    > = {
      present: 0,
      late: 0,
      half_day: 0,
      absent: 0,
      on_leave: 0,
      holiday: 0,
      week_off: 0,
    };

    attendance.forEach((record) => {
      if (record.status in counts) {
        counts[record.status as keyof typeof counts] += 1;
      }
    });

    const creditedDays = counts.present + counts.late + counts.half_day * 0.5;
    const excludedDays = counts.holiday + counts.week_off;
    const daysInMonth = new Date(year, month, 0).getDate();
    const payableDays = Math.max(0, daysInMonth - excludedDays);

    return {
      creditedDays,
      payableDays,
      ...counts,
    };
  }

  private validateAdjustmentCategory(type: 'addition' | 'deduction', category: string) {
    const allowedCategories: readonly string[] =
      type === 'addition' ? SALARY_ADDITION_CATEGORIES : SALARY_DEDUCTION_CATEGORIES;

    if (!allowedCategories.includes(category)) {
      throw new BadRequestException(
        `Invalid ${type} category. Allowed values: ${allowedCategories.join(', ')}`,
      );
    }
  }

  private async assertFeatureEnabled(
    workspaceId: string,
    feature: keyof PayrollConfig['features'],
    featureLabel?: string,
  ): Promise<void> {
    const config = await this.getPayrollConfig(workspaceId);
    if (!config.features[feature]) {
      throw new BadRequestException(
        `${featureLabel || feature} is not enabled for this workspace. Enable it in Payroll Settings.`,
      );
    }
  }

  private async buildSalaryRecordData(
    workspaceId: string,
    teamMemberId: Types.ObjectId,
    month: number,
    year: number,
    currentAdditions = 0,
    currentDeductions = 0,
  ) {
    const workspaceObjectId = toObjectId(workspaceId);

    await this.applyPendingIncrement(workspaceId, teamMemberId, month, year);

    const member = await this.teamModel.findById(teamMemberId).exec();
    if (!member) {
      throw new NotFoundException('Team member not found');
    }

    const config = await this.getPayrollConfig(workspaceId);
    // Salary-standalone safeguard (2026-06-20): resolve the ATTENDANCE-module
    // entitlement ONCE per workspace (memoized, short-TTL) and thread it into the
    // sync context resolver — no per-member entitlement lookup. Forces the fixed/
    // calendar-day branch when ATTENDANCE is OFF, before any attendance query.
    const attendanceModuleEnabled = await this.resolveAttendanceModuleEnabled(workspaceId);
    const salaryContext = this.resolveSalaryCalculationContext(
      member,
      month,
      year,
      config,
      attendanceModuleEnabled,
    );

    let creditedDays = 0;
    let adjustedDeductions = currentDeductions;
    if (
      salaryContext.attendancePayModeApplied === 'enabled' &&
      salaryContext.activeCalendarDays > 0
    ) {
      const attendance = await this.attendanceModel
        .find({
          workspaceId: workspaceObjectId,
          teamMemberId: member._id,
          date: {
            $gte: salaryContext.activeStart,
            $lte: salaryContext.activeEnd,
          },
        })
        .exec();
      const breakdown = this.buildPayrollAttendanceBreakdown(attendance, month, year);
      // L4: approved paid leave is a credited (paid) day — unpaid LWP is left
      // out so it stays docked. Event-based read of the leave module; clamped
      // so credit never exceeds the month's payable days.
      const paidLeaveCredit = await this.computePaidLeaveCredit(
        workspaceId,
        member._id,
        salaryContext.activeStart,
        salaryContext.activeEnd,
      );
      creditedDays = Math.min(breakdown.creditedDays + paidLeaveCredit, breakdown.payableDays);
      // Phase C soft integration (DC-6): additive minute-accurate LOP supplement.
      const lopDeductionSupplement = await this.calculateMinuteAccurateLop(
        attendance,
        member.salaryAmount ?? 0,
        workspaceId,
        month,
        year,
        member._id,
      );
      adjustedDeductions = currentDeductions + lopDeductionSupplement;

      // D-03: Apply owner-configured attendance-rule toggles to presentDays/LOP.
      // These toggles adjust how holidays, week-offs, and late marks are credited.
      // Only presentDays/LOP inputs are affected; rate and net formula are unchanged.
      const { holidayCountsAsPresent, weekOffCountsAsPresent, lateMarkAsHalfDay } =
        config.rules ?? {};

      if (holidayCountsAsPresent === true) {
        // Holiday days become credited (paid) days — exclude from absent/LOP.
        creditedDays = Math.min(
          creditedDays + breakdown.holiday,
          breakdown.payableDays + breakdown.holiday,
        );
      }

      if (weekOffCountsAsPresent === true) {
        // Week-off days become credited (paid) days — exclude from absent/LOP.
        creditedDays = Math.min(
          creditedDays + breakdown.week_off,
          breakdown.payableDays + breakdown.week_off,
        );
      }

      if (lateMarkAsHalfDay === true) {
        // Each late-marked day counts as only 0.5 present — dock 0.5 per late day.
        // breakdown.late late-days were credited as 1.0 each; reduce to 0.5 each.
        const lateDock = breakdown.late * 0.5;
        creditedDays = Math.max(0, creditedDays - lateDock);
      }
    }

    const salaryType = member.salaryType || 'monthly';
    const isPieceRate = salaryType === 'piece_rate';
    let pieceRateData: {
      pieceEarnings: number;
      basePortion: number;
      snapshot: any;
      breakdown: any[];
    } | null = null;
    if (isPieceRate) {
      pieceRateData = await this.computePieceRateEarnings(
        workspaceId,
        String(member._id),
        month,
        year,
        member,
      );
    }
    const hourlyRate = Math.max(0, member.salaryAmount || 0);
    const dailyHours = Math.max(0, member.dailyHours || 0);
    const hasHourlyOverride =
      salaryType === 'hourly' &&
      member.finalMonthlyOverride !== undefined &&
      member.finalMonthlyOverride !== null;
    const fullPeriodBase = isPieceRate
      ? Math.max(0, (member as any).pieceRateConfig?.basePortion ?? 0)
      : salaryType === 'hourly'
        ? hasHourlyOverride
          ? Math.max(0, member.finalMonthlyOverride || 0)
          : this.roundCurrency(hourlyRate * dailyHours * salaryContext.basisDays)
        : Math.max(0, member.salaryAmount || 0);

    let totalDays = salaryContext.basisDays;
    let presentDays = salaryContext.basisDays;

    if (salaryType === 'monthly') {
      if (salaryContext.attendancePayModeApplied === 'enabled') {
        totalDays = salaryContext.basisDays;
        presentDays = creditedDays;
      } else {
        totalDays = salaryContext.monthLength;
        presentDays = salaryContext.activeCalendarDays;
      }
    } else if (salaryContext.attendancePayModeApplied === 'enabled') {
      totalDays = salaryContext.basisDays;
      presentDays = creditedDays;
    } else if (hasHourlyOverride) {
      totalDays = salaryContext.basisDays;
      presentDays = salaryContext.basisDays;
    } else if (salaryContext.salaryDayBasis === 'calendar_month_days') {
      totalDays = salaryContext.monthLength;
      presentDays = salaryContext.activeCalendarDays;
    } else {
      totalDays = salaryContext.basisDays;
      presentDays =
        salaryContext.activeCalendarDays >= salaryContext.monthLength
          ? salaryContext.basisDays
          : salaryContext.basisDays *
            (salaryContext.activeCalendarDays / salaryContext.monthLength);
    }

    return {
      workspaceId: workspaceObjectId,
      teamMemberId: member._id,
      month,
      year,
      baseSalary: fullPeriodBase,
      totalDays,
      presentDays,
      salaryType,
      salaryDayBasis: salaryContext.salaryDayBasis,
      fixedMonthDays: salaryContext.fixedMonthDays,
      attendancePayModeApplied: salaryContext.attendancePayModeApplied,
      additions: currentAdditions,
      deductions: adjustedDeductions,
      pieceRateEarnings: pieceRateData?.pieceEarnings ?? 0,
      pieceRateConfigSnapshot: pieceRateData?.snapshot ?? null,
      pieceRateBreakdown: pieceRateData?.breakdown ?? [],
      pieceRateStale: false,
      netSalary: this.calculateNetSalary(
        fullPeriodBase,
        totalDays,
        presentDays,
        currentAdditions,
        adjustedDeductions,
        pieceRateData?.pieceEarnings ?? 0,
      ),
    };
  }

  private async sumPaidAmountForSalary(salaryId: Types.ObjectId): Promise<number> {
    const payments = await this.paymentModel
      .find({ salaryId, status: { $ne: 'reversed' } })
      .select('amount commission')
      .lean()
      .exec();

    return this.roundCurrency(
      payments.reduce((sum, payment) => sum + (payment.amount || 0) + (payment.commission || 0), 0),
    );
  }

  private async createPaymentLinkedAddition(params: {
    workspaceId: string;
    salary: Salary;
    userId: string;
    amount: number;
    category: (typeof SALARY_ADDITION_CATEGORIES)[number];
    reasonTitle: string;
    note?: string;
    linkedPaymentId?: Types.ObjectId;
  }) {
    if (params.amount <= 0) return null;

    const adjustment = new this.salaryAdjustmentModel({
      workspaceId: toObjectId(params.workspaceId),
      salaryId: toObjectId(String(params.salary._id)),
      teamMemberId: toObjectId(this.getObjectIdString(params.salary.teamMemberId)),
      month: params.salary.month,
      year: params.salary.year,
      type: 'addition',
      category: params.category,
      amount: params.amount,
      source: 'payment_recording',
      linkedPaymentId: params.linkedPaymentId,
      reasonTitle: params.reasonTitle,
      note: params.note,
      attachments: [],
      status: 'active',
      createdBy: toObjectId(params.userId),
    });

    await adjustment.save();

    await this.auditService.logEvent({
      workspaceId: params.workspaceId,
      module: AppModule.SALARY,
      entityType: 'salary_adjustment',
      entityId: String(adjustment._id),
      action: 'salary_adjustment.created',
      actorId: params.userId,
      salaryId: this.getObjectIdString(adjustment.salaryId),
      teamMemberId: this.getObjectIdString(adjustment.teamMemberId),
      month: adjustment.month,
      year: adjustment.year,
      after: this.buildAdjustmentAuditSnapshot(adjustment),
      meta: { source: 'payment_recording' },
    });

    return adjustment;
  }

  private async createAdvanceRecoveryDeduction(params: {
    workspaceId: string;
    teamMemberId: Types.ObjectId;
    targetMonth: number;
    targetYear: number;
    amount: number;
    sourcePaymentId: Types.ObjectId;
    userId: Types.ObjectId;
    /** Optional: links this deduction to a multi-installment recovery plan. */
    advanceRecoveryPlanId?: Types.ObjectId;
    /** Optional: 1-based index of the installment within the plan. */
    planInstallmentIndex?: number;
  }): Promise<SalaryAdjustment | null> {
    if (params.amount <= 0) return null;

    const targetSalary = await this.ensureSalaryRecord(
      params.workspaceId,
      params.teamMemberId,
      params.targetMonth,
      params.targetYear,
      params.userId,
    );

    const adjustmentDoc: Record<string, unknown> = {
      workspaceId: toObjectId(params.workspaceId),
      salaryId: toObjectId(String(targetSalary._id)),
      teamMemberId: params.teamMemberId,
      month: params.targetMonth,
      year: params.targetYear,
      type: 'deduction',
      category: 'advance_recovery',
      amount: params.amount,
      source: 'system',
      advanceSourcePaymentId: params.sourcePaymentId,
      reasonTitle: 'Advance recovery',
      note: `Auto-recovery for advance paid in previous month. Source payment: ${String(params.sourcePaymentId)}`,
      attachments: [],
      status: 'active',
      createdBy: params.userId,
    };

    if (params.advanceRecoveryPlanId != null) {
      adjustmentDoc.advanceRecoveryPlanId = params.advanceRecoveryPlanId;
    }
    if (params.planInstallmentIndex != null) {
      adjustmentDoc.planInstallmentIndex = params.planInstallmentIndex;
    }

    const adjustment = new this.salaryAdjustmentModel(adjustmentDoc);

    await adjustment.save();

    await this.recalculateSalaryFromAdjustments(targetSalary, params.userId, true);

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
      after: this.buildAdjustmentAuditSnapshot(adjustment),
      meta: {
        source: 'advance_recovery',
        sourcePaymentId: String(params.sourcePaymentId),
      },
    });

    return adjustment;
  }

  /**
   * Per-installment compliance decision point extracted for testability.
   *
   * Given a fully-resolved set of guard inputs plus the caller's override intent,
   * this method either:
   *   - returns { allowed, warnings } when compliant or override accepted, OR
   *   - pushes to pendingBreaches when a breach is found and overrideCompliance is
   *     false (caller collects all breaches then throws once), OR
   *   - throws BadRequestException immediately if override is true but reason is missing.
   *
   * When overrideCompliance is true and breaches exist, the method:
   *   1. Uses result.allowedInstallment (clamped compliant value) as the applied amount.
   *   2. Emits salary.advance_plan.compliance_override audit event.
   *   3. Returns the clamped amount so the caller writes it to the deduction.
   *
   * This method has NO side-effects on plan documents; it only reads guard results
   * and calls AuditService.
   */
  private async applyComplianceGuard(params: {
    workspaceId: string;
    teamMemberId: Types.ObjectId;
    userId: Types.ObjectId;
    month: number;
    year: number;
    totalAdvanceAmount: number;
    proposedInstallment: number;
    currentTotalDeductions: number;
    grossSalaryForMonth: number;
    netSalaryBeforeRecovery: number;
    minimumWageMonthly: number | null;
    deductionCapPercent: number;
    overrideCompliance: boolean;
    overrideReason: string | undefined;
    pendingBreaches: Array<{
      code: string;
      month: number;
      year: number;
      proposed: number;
      maxCompliant: number;
    }>;
    collectedWarnings: ComplianceWarning[];
    scheduleMonths?: number;
    advisoryMaxMonths?: number;
  }): Promise<{ allowed: number; warnings: ComplianceWarning[] }> {
    const result = this.complianceGuard.evaluate({
      proposedInstallment: params.proposedInstallment,
      currentTotalDeductions: params.currentTotalDeductions,
      grossSalaryForMonth: params.grossSalaryForMonth,
      netSalaryBeforeRecovery: params.netSalaryBeforeRecovery,
      minimumWageMonthly: params.minimumWageMonthly,
      deductionCapPercent: params.deductionCapPercent,
      totalAdvanceAmount: params.totalAdvanceAmount,
      periodicWages: params.grossSalaryForMonth,
      scheduleMonths: params.scheduleMonths,
      advisoryMaxMonths: params.advisoryMaxMonths,
    });

    if (result.breaches.length === 0) {
      // Fully compliant - pass through.
      for (const w of result.warnings) {
        params.collectedWarnings.push(w);
      }
      return { allowed: params.proposedInstallment, warnings: result.warnings };
    }

    // Breaches detected.
    if (!params.overrideCompliance) {
      // Collect for a single structured throw after the loop.
      for (const breach of result.breaches) {
        params.pendingBreaches.push({
          code: breach.code,
          month: params.month,
          year: params.year,
          proposed: params.proposedInstallment,
          maxCompliant: breach.reducedTo,
        });
      }
      for (const w of result.warnings) {
        params.collectedWarnings.push(w);
      }
      // Return the proposed amount here - caller will never use it because it will
      // throw after the loop when pendingBreaches is non-empty.
      return { allowed: params.proposedInstallment, warnings: result.warnings };
    }

    // overrideCompliance === true.
    if (!params.overrideReason || params.overrideReason.trim().length === 0) {
      throw new BadRequestException('overrideReason is required when overrideCompliance is true.');
    }

    // Emit audit event for the override before proceeding.
    await this.auditService.logEvent({
      workspaceId: params.workspaceId,
      module: AppModule.SALARY,
      entityType: 'advance_recovery_plan',
      entityId: String(params.teamMemberId),
      action: 'salary.advance_plan.compliance_override',
      actorId: String(params.userId),
      teamMemberId: String(params.teamMemberId),
      before: { proposed: params.proposedInstallment },
      after: { applied: result.allowedInstallment },
      meta: {
        overrideReason: params.overrideReason,
        breachCodes: result.breaches.map((b: ComplianceBreach) => b.code),
        month: params.month,
        year: params.year,
      },
    });

    for (const w of result.warnings) {
      params.collectedWarnings.push(w);
    }

    // Return the clamped compliant amount.
    return { allowed: result.allowedInstallment, warnings: result.warnings };
  }

  /**
   * Create a multi-installment advance recovery plan.
   *
   * Builds the installment schedule, walks forward from startMonth/startYear
   * scheduling one deduction per month. If a month's available net is less
   * than the planned installment (cap-and-carry), the shortfall is tracked
   * and recovered in trailing months (up to 12 extra). Conservation guarantee:
   * sum of all created deduction amounts + any residual === totalAmount.
   *
   * Piece-rate cap basis: a freshly-ensured future month has ~0 net because
   * no production is logged yet. Capping against that would incorrectly zero
   * every installment. For piece-rate members we use the member's configured
   * salaryAmount as the cap basis (the same figure HR set as their "base")
   * while falling back to netSalary if it is higher (e.g. production already
   * posted for that month).
   */
  private async createAdvanceRecoveryPlan(params: {
    workspaceId: string;
    teamMemberId: Types.ObjectId;
    sourcePaymentId: Types.ObjectId;
    totalAmount: number;
    startMonth: number;
    startYear: number;
    installmentConfig: InstallmentConfig;
    userId: Types.ObjectId;
    overrideCompliance?: boolean;
    overrideReason?: string;
  }): Promise<{ plan: AdvanceRecoveryPlanDocument; complianceWarnings: ComplianceWarning[] }> {
    const {
      workspaceId,
      teamMemberId,
      sourcePaymentId,
      totalAmount,
      startMonth,
      startYear,
      installmentConfig,
      userId,
      overrideCompliance = false,
      overrideReason,
    } = params;

    return this.withSalarySpan(
      'salary.createAdvanceRecoveryPlan',
      {
        workspaceId,
        teamMemberId: String(teamMemberId),
        totalAmount,
        startMonth,
        startYear,
      },
      async () => {
        // Step 1: Build the base installment schedule.
        const planned = buildInstallmentSchedule(totalAmount, installmentConfig);

        // Load the member once for the piece-rate cap-basis check and per-member
        // minimum-wage override.
        const member = await this.teamModel
          .findById(teamMemberId)
          .select('salaryType salaryAmount minimumWageMonthlyOverride')
          .lean()
          .exec();

        if (!member) {
          throw new NotFoundException('Team member not found');
        }

        // Load payroll config once for compliance sub-document.
        const payrollConfig = await this.getPayrollConfig(workspaceId);
        const complianceCfg = payrollConfig.compliance ?? {
          minimumWageMonthly: null,
          deductionCapPercent: 50,
          installmentAdvisoryMaxMonths: 12,
        };

        // Resolve effective minimum wage: per-member override wins, then workspace default.
        // An explicit 0 override is a valid value (floor = 0, no restriction).
        const memberOverride = (member as any).minimumWageMonthlyOverride;
        const minimumWageMonthly: number | null =
          memberOverride !== undefined && memberOverride !== null
            ? (memberOverride as number)
            : (complianceCfg.minimumWageMonthly ?? null);

        const deductionCapPercent = complianceCfg.deductionCapPercent ?? 50;
        const advisoryMaxMonths = complianceCfg.installmentAdvisoryMaxMonths ?? 12;

        // Accumulated compliance state across all installments.
        const pendingBreaches: Array<{
          code: string;
          month: number;
          year: number;
          proposed: number;
          maxCompliant: number;
        }> = [];
        const collectedWarnings: ComplianceWarning[] = [];

        // Step 2: Seed the plan document (installments populated below).
        const plan = new this.advanceRecoveryPlanModel({
          workspaceId: toObjectId(workspaceId),
          teamMemberId,
          sourcePaymentId,
          totalAmount,
          installmentAmount: planned[0],
          installmentCount: planned.length,
          startMonth,
          startYear,
          status: 'active',
          recoveredAmount: 0,
          remainingAmount: totalAmount,
          createdBy: userId,
          installments: [],
          linkedAdjustmentIds: [],
        });

        // -----------------------------------------------------------------------
        // Two-pass design: PASS 1 validates all months (no deduction writes),
        // PASS 2 persists deductions only after validation succeeds.
        // This guarantees that a compliance block never leaves orphaned
        // SalaryAdjustment documents with a dangling advanceRecoveryPlanId.
        // -----------------------------------------------------------------------

        // Shared type for per-month validated context carried between passes.
        type ValidatedMonth = {
          index: number;
          month: number;
          year: number;
          plannedAmount: number;
          effectiveAmount: number; // compliance-clamped (or original) applied vs availableNet
          availableNet: number;
          isCarry: boolean;
        };

        // ----- PASS 1: validate all months, collect breaches, no DB writes -----

        let currentMonth = startMonth;
        let currentYear = startYear;
        // Simulate shortfall accumulation to know which carry months to visit.
        let shortfallSim = 0;

        const validatedMonths: ValidatedMonth[] = [];

        // Pass 1a: primary installment months.
        for (let i = 0; i < planned.length; i++) {
          const plannedAmount = planned[i];
          const m = currentMonth;
          const y = currentYear;

          // Advance the walk for the next iteration (Dec->Jan wrap).
          currentMonth += 1;
          if (currentMonth > 12) {
            currentMonth = 1;
            currentYear += 1;
          }

          // ensureSalaryRecord may create an empty salary row; that is
          // acceptable (it is not a deduction). No deduction created here.
          const targetSalary = await this.ensureSalaryRecord(
            workspaceId,
            teamMemberId,
            m,
            y,
            userId,
          );

          // Cap basis: for piece-rate members future months have ~0 net because
          // no production is logged; use the configured salaryAmount as the floor
          // so the installment is not wrongly zeroed.
          // Spec 6a: use salaryAmount as grossSalaryForMonth estimate for piece-rate.
          const capBasis =
            (member as any).salaryType === 'piece_rate'
              ? Math.max(targetSalary.netSalary, (member as any).salaryAmount ?? 0)
              : targetSalary.netSalary;

          const availableNet = Math.max(0, capBasis);

          // Compliance guard: evaluate planned installment against statutory rules.
          // grossSalaryForMonth = baseSalary + additions (spec rule 1 / spec 5).
          // For piece-rate future months (netSalary~=0, no production yet), the spec
          // (6a) says to use member.salaryAmount as the gross estimate. We use the
          // max of (baseSalary + additions) and member.salaryAmount to handle both
          // cases gracefully. currentTotalDeductions = targetSalary.deductions (sum
          // of all existing active deductions already on this salary record; spec 6b).
          const existingDeductions = targetSalary.deductions ?? 0;
          const recordedGross = (targetSalary.baseSalary ?? 0) + (targetSalary.additions ?? 0);
          const grossForMonth =
            (member as any).salaryType === 'piece_rate'
              ? Math.max(recordedGross, (member as any).salaryAmount ?? 0)
              : recordedGross;
          const { allowed: complianceAllowed } = await this.applyComplianceGuard({
            workspaceId,
            teamMemberId,
            userId,
            month: m,
            year: y,
            totalAdvanceAmount: totalAmount,
            proposedInstallment: plannedAmount,
            currentTotalDeductions: existingDeductions,
            grossSalaryForMonth: grossForMonth,
            netSalaryBeforeRecovery: availableNet,
            minimumWageMonthly,
            deductionCapPercent,
            overrideCompliance,
            overrideReason,
            pendingBreaches,
            collectedWarnings,
            scheduleMonths: planned.length,
            advisoryMaxMonths,
          });

          // Use the compliance-allowed amount if override is active (clamped amount);
          // otherwise use the original planned amount for cap-and-carry logic.
          const effectivePlanned = overrideCompliance ? complianceAllowed : plannedAmount;
          const appliedSim = this.roundCurrency(Math.min(effectivePlanned, availableNet));

          validatedMonths.push({
            index: i + 1,
            month: m,
            year: y,
            plannedAmount,
            effectiveAmount: appliedSim,
            availableNet,
            isCarry: false,
          });

          if (appliedSim < plannedAmount) {
            shortfallSim = this.roundCurrency(shortfallSim + (plannedAmount - appliedSim));
          }
        }

        // Pass 1b: trailing carry months (same cap-and-carry as today; no deductions yet).
        const MAX_EXTRA = 12;
        let extraCountSim = 0;

        while (shortfallSim > 0 && extraCountSim < MAX_EXTRA) {
          const m = currentMonth;
          const y = currentYear;

          currentMonth += 1;
          if (currentMonth > 12) {
            currentMonth = 1;
            currentYear += 1;
          }

          const targetSalary = await this.ensureSalaryRecord(
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

          const availableNet = Math.max(0, capBasis);

          // Also guard trailing carry months against compliance rules.
          const existingDeductions = targetSalary.deductions ?? 0;
          const trailingRecordedGross =
            (targetSalary.baseSalary ?? 0) + (targetSalary.additions ?? 0);
          const trailingGrossForMonth =
            (member as any).salaryType === 'piece_rate'
              ? Math.max(trailingRecordedGross, (member as any).salaryAmount ?? 0)
              : trailingRecordedGross;
          const { allowed: carryAllowed } = await this.applyComplianceGuard({
            workspaceId,
            teamMemberId,
            userId,
            month: m,
            year: y,
            totalAdvanceAmount: totalAmount,
            proposedInstallment: shortfallSim,
            currentTotalDeductions: existingDeductions,
            grossSalaryForMonth: trailingGrossForMonth,
            netSalaryBeforeRecovery: availableNet,
            minimumWageMonthly,
            deductionCapPercent,
            overrideCompliance,
            overrideReason,
            pendingBreaches,
            collectedWarnings,
          });

          const effectiveCarrySim = overrideCompliance ? carryAllowed : shortfallSim;
          const appliedSim = this.roundCurrency(Math.min(effectiveCarrySim, availableNet));

          validatedMonths.push({
            index: validatedMonths.length + 1,
            month: m,
            year: y,
            plannedAmount: shortfallSim,
            effectiveAmount: appliedSim,
            availableNet,
            isCarry: true,
          });

          shortfallSim = this.roundCurrency(shortfallSim - appliedSim);
          extraCountSim += 1;
        }

        // ----- Gate: throw BEFORE any deduction is written -----
        // Throw compliance error after collecting all per-month breaches (better UX
        // than throwing on the first month so the caller sees all affected months).
        if (pendingBreaches.length > 0) {
          throw new BadRequestException({
            message:
              `Advance recovery plan blocked by compliance rules. ` +
              `${pendingBreaches.length} installment month(s) breach statutory limits. ` +
              `Set overrideCompliance=true with an overrideReason to proceed with clamped amounts.`,
            code: 'COMPLIANCE_BLOCKED',
            breaches: pendingBreaches,
          });
        }

        // ----- PASS 2: persist deductions and build plan.installments -----
        // Only reached when no compliance block. All breaches that reach here
        // are overrideCompliance=true (already validated and audited in pass 1).

        // Re-derive shortfall from pass 2 effectiveAmount deltas (mirrors pass 1).
        let shortfall = 0;

        for (const vm of validatedMonths) {
          const { index, month: m, year: y, plannedAmount, effectiveAmount } = vm;

          const installmentEntry: {
            index: number;
            month: number;
            year: number;
            plannedAmount: number;
            appliedAmount: number;
            adjustmentId?: Types.ObjectId;
            status: 'scheduled' | 'applied' | 'reversed' | 'carried';
          } = {
            index,
            month: m,
            year: y,
            plannedAmount,
            appliedAmount: effectiveAmount,
            status: effectiveAmount >= plannedAmount ? 'applied' : 'carried',
          };

          if (effectiveAmount > 0) {
            const adj = await this.createAdvanceRecoveryDeduction({
              workspaceId,
              teamMemberId,
              targetMonth: m,
              targetYear: y,
              amount: effectiveAmount,
              sourcePaymentId,
              userId,
              advanceRecoveryPlanId: plan._id,
              planInstallmentIndex: index,
            });

            if (adj) {
              installmentEntry.adjustmentId = toObjectId(String(adj._id));
              plan.linkedAdjustmentIds.push(toObjectId(String(adj._id)));
            }
          }

          plan.installments.push(installmentEntry);

          if (effectiveAmount < plannedAmount) {
            shortfall = this.roundCurrency(shortfall + (plannedAmount - effectiveAmount));
          }
        }

        if (shortfall > 0) {
          this.logger.warn(
            `createAdvanceRecoveryPlan: could not fully schedule totalAmount=${totalAmount}` +
              ` for teamMemberId=${String(teamMemberId)} workspaceId=${workspaceId}.` +
              ` Residual shortfall=${shortfall} after ${MAX_EXTRA} extra months.` +
              ` Stored as remainingAmount on the plan.`,
          );
        }

        // Step 5: recoveredAmount tracks actual payments applied to salary months
        // as those months are processed later. At creation time it is 0.
        // remainingAmount = totalAmount (nothing recovered yet).
        plan.recoveredAmount = 0;
        plan.remainingAmount = totalAmount;

        await plan.save();

        // Step 6: Audit + PostHog.
        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'advance_recovery_plan',
          entityId: String(plan._id),
          action: 'salary.advance_plan.created',
          actorId: String(userId),
          teamMemberId: String(teamMemberId),
          after: {
            id: String(plan._id),
            totalAmount: plan.totalAmount,
            installmentCount: plan.installments.length,
            startMonth,
            startYear,
            status: plan.status,
          },
          meta: {
            sourcePaymentId: String(sourcePaymentId),
          },
        });

        this.postHog.capture({
          distinctId: String(userId),
          event: 'salary.advance_plan_created',
          properties: {
            workspaceId,
            teamMemberId: String(teamMemberId),
            totalAmount,
            installmentCount: plan.installments.length,
          },
        });

        return { plan, complianceWarnings: collectedWarnings };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Step A: extracted per-adjustment reversal body used by reversePayment and
  // the new plan reversal loop.  Mutates the adjustment doc in-place, recalcs
  // the target salary, and fires an audit event.  Returns the adjustment.
  // ---------------------------------------------------------------------------
  private async reverseAdjustmentDoc(
    adjustment: SalaryAdjustment,
    userObjectId: Types.ObjectId,
    reason: string,
    meta: Record<string, string> = {},
  ): Promise<SalaryAdjustment> {
    const adjBefore = this.buildAdjustmentAuditSnapshot(adjustment);
    adjustment.status = 'reversed';
    adjustment.reversedBy = userObjectId;
    adjustment.reversedAt = new Date();
    adjustment.reversalReason = reason;
    await adjustment.save();

    const targetSalary = await this.salaryModel.findById(adjustment.salaryId).exec();
    if (targetSalary) {
      await this.recalculateSalaryFromAdjustments(targetSalary, userObjectId, true);
    }

    await this.auditService.logEvent({
      workspaceId:
        adjustment.workspaceId instanceof Types.ObjectId
          ? adjustment.workspaceId.toHexString()
          : String(adjustment.workspaceId),
      module: AppModule.SALARY,
      entityType: 'salary_adjustment',
      entityId: String(adjustment._id),
      action: 'salary_adjustment.reversed',
      actorId: String(userObjectId),
      salaryId: this.getObjectIdString(adjustment.salaryId),
      teamMemberId: this.getObjectIdString(adjustment.teamMemberId),
      month: adjustment.month,
      year: adjustment.year,
      before: adjBefore,
      after: this.buildAdjustmentAuditSnapshot(adjustment),
      reason,
      meta,
    });

    return adjustment;
  }

  // ---------------------------------------------------------------------------
  // Step C (support): materializeInstallments - the shared cap+create loop
  // used by createAdvanceRecoveryPlan, editAdvanceRecoveryPlan, and resume.
  // Walks forward month-by-month from (fromMonth, fromYear), applying
  // installmentAmount per month (capped to the salary's available net, with
  // cap-and-carry for shortfalls).  Appends new installment ledger entries and
  // adjustments to the plan; saves the plan.
  //
  // Conservation: sum of applied amounts across all installments created here
  // equals totalAmountToRecover (assuming enough trailing months with net > 0).
  // ---------------------------------------------------------------------------
  private async materializeInstallments(
    plan: AdvanceRecoveryPlanDocument,
    fromMonth: number,
    fromYear: number,
    installmentAmount: number,
    userId: Types.ObjectId,
    workspaceId: string,
  ): Promise<void> {
    const teamMemberId =
      plan.teamMemberId instanceof Types.ObjectId
        ? plan.teamMemberId
        : toObjectId(String(plan.teamMemberId));
    const sourcePaymentId =
      plan.sourcePaymentId instanceof Types.ObjectId
        ? plan.sourcePaymentId
        : toObjectId(String(plan.sourcePaymentId));

    const member = await this.teamModel
      .findById(teamMemberId)
      .select('salaryType salaryAmount')
      .lean()
      .exec();

    if (!member) throw new NotFoundException('Team member not found');

    const remaining = this.roundCurrency(plan.remainingAmount);
    let currentMonth = fromMonth;
    let currentYear = fromYear;
    let shortfall = 0;

    // Build the base installment list from the planned amount.
    const baseSchedule = buildInstallmentSchedule(remaining, { installmentAmount });

    for (let i = 0; i < baseSchedule.length; i++) {
      const planned = baseSchedule[i];
      const m = currentMonth;
      const y = currentYear;
      currentMonth += 1;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear += 1;
      }

      const targetSalary = await this.ensureSalaryRecord(workspaceId, teamMemberId, m, y, userId);
      const capBasis =
        (member as any).salaryType === 'piece_rate'
          ? Math.max(targetSalary.netSalary, (member as any).salaryAmount ?? 0)
          : targetSalary.netSalary;
      const available = Math.max(0, capBasis);
      const applied = this.roundCurrency(Math.min(planned, available));

      const entryIndex = plan.installments.length + 1;
      const entry: {
        index: number;
        month: number;
        year: number;
        plannedAmount: number;
        appliedAmount: number;
        adjustmentId?: Types.ObjectId;
        status: 'scheduled' | 'applied' | 'reversed' | 'carried';
      } = {
        index: entryIndex,
        month: m,
        year: y,
        plannedAmount: planned,
        appliedAmount: applied,
        status: applied >= planned ? 'applied' : 'carried',
      };

      if (applied > 0) {
        const adj = await this.createAdvanceRecoveryDeduction({
          workspaceId,
          teamMemberId,
          targetMonth: m,
          targetYear: y,
          amount: applied,
          sourcePaymentId,
          userId,
          advanceRecoveryPlanId: plan._id,
          planInstallmentIndex: entryIndex,
        });
        if (adj) {
          entry.adjustmentId = toObjectId(String(adj._id));
          plan.linkedAdjustmentIds.push(toObjectId(String(adj._id)));
        }
      }

      plan.installments.push(entry);
      if (applied < planned) {
        shortfall = this.roundCurrency(shortfall + (planned - applied));
      }
    }

    // Recover shortfall in up to 12 trailing months.
    const MAX_EXTRA = 12;
    let extraCount = 0;
    while (shortfall > 0 && extraCount < MAX_EXTRA) {
      const m = currentMonth;
      const y = currentYear;
      currentMonth += 1;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear += 1;
      }

      const targetSalary = await this.ensureSalaryRecord(workspaceId, teamMemberId, m, y, userId);
      const capBasis =
        (member as any).salaryType === 'piece_rate'
          ? Math.max(targetSalary.netSalary, (member as any).salaryAmount ?? 0)
          : targetSalary.netSalary;
      const available = Math.max(0, capBasis);
      const applied = this.roundCurrency(Math.min(shortfall, available));

      const entryIndex = plan.installments.length + 1;
      const entry: {
        index: number;
        month: number;
        year: number;
        plannedAmount: number;
        appliedAmount: number;
        adjustmentId?: Types.ObjectId;
        status: 'scheduled' | 'applied' | 'reversed' | 'carried';
      } = {
        index: entryIndex,
        month: m,
        year: y,
        plannedAmount: shortfall,
        appliedAmount: applied,
        status: applied >= shortfall ? 'applied' : 'carried',
      };

      if (applied > 0) {
        const adj = await this.createAdvanceRecoveryDeduction({
          workspaceId,
          teamMemberId,
          targetMonth: m,
          targetYear: y,
          amount: applied,
          sourcePaymentId,
          userId,
          advanceRecoveryPlanId: plan._id,
          planInstallmentIndex: entryIndex,
        });
        if (adj) {
          entry.adjustmentId = toObjectId(String(adj._id));
          plan.linkedAdjustmentIds.push(toObjectId(String(adj._id)));
        }
      }

      plan.installments.push(entry);
      shortfall = this.roundCurrency(shortfall - applied);
      extraCount += 1;
    }

    await plan.save();
  }

  // ---------------------------------------------------------------------------
  // Step C: refreshPlanProgress
  //
  // Recomputes recoveredAmount and remainingAmount from the plan's linked
  // adjustments without requiring a payroll-run event.
  //
  // Heuristic: an installment is considered "recovered" when its target
  // salary month/year is STRICTLY BEFORE the current calendar month/year
  // (i.e. the month has elapsed and the deduction has been applied).
  // Active adjustments for months that are current or future are still
  // outstanding.
  //
  // If remainingAmount drops to <= 0 and the plan is still active, it is
  // auto-completed.
  // ---------------------------------------------------------------------------
  private async refreshPlanProgress(plan: AdvanceRecoveryPlanDocument): Promise<void> {
    if (plan.status === 'reversed' || plan.status === 'completed') return;

    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    // Load all active adjustments linked to the plan.
    const adjustments = await this.salaryAdjustmentModel
      .find({
        _id: { $in: plan.linkedAdjustmentIds },
        status: 'active',
      })
      .select('month year amount')
      .lean()
      .exec();

    // Sum amounts for months strictly before the current payroll month.
    let recovered = 0;
    for (const adj of adjustments) {
      const adjYear = (adj as any).year as number;
      const adjMonth = (adj as any).month as number;
      const isElapsed = adjYear < curYear || (adjYear === curYear && adjMonth < curMonth);
      if (isElapsed) {
        recovered = this.roundCurrency(recovered + ((adj as any).amount ?? 0));
      }
    }

    plan.recoveredAmount = recovered;
    plan.remainingAmount = this.roundCurrency(Math.max(0, plan.totalAmount - recovered));

    if (plan.remainingAmount <= 0 && plan.status === 'active') {
      plan.status = 'completed';
      plan.closureType = 'completed';
      plan.closedAt = new Date();
    }

    await plan.save();
  }

  // ---------------------------------------------------------------------------
  // Step D: editAdvanceRecoveryPlan
  //
  // Supports three mutually-exclusive actions on an active/paused plan:
  //   action='pause'          - reverse future unlocked installment adjustments,
  //                             mark plan paused.
  //   action='resume'         - re-materialize installments from the cutover
  //                             month using the stored remainingAmount.
  //   installmentAmount       - reverse future installments, recompute
  //                             remainingAmount from frozen actives, re-spread.
  //
  // FROZEN = installments whose target salary month/year is BEFORE the current
  // payroll month/year OR whose target salary is locked.  These are never
  // touched.  The "cutover" is the first non-frozen, not-already-reversed
  // installment.
  // ---------------------------------------------------------------------------
  async editAdvanceRecoveryPlan(
    workspaceId: string,
    planId: string,
    userId: string,
    dto: { installmentAmount?: number; action?: 'pause' | 'resume' },
  ): Promise<AdvanceRecoveryPlanDocument> {
    return this.withSalarySpan(
      'salary.editAdvanceRecoveryPlan',
      { workspaceId, planId, userId },
      async () => {
        const workspaceObjectId = toObjectId(workspaceId);
        const userObjectId = toObjectId(userId);

        const plan = await this.advanceRecoveryPlanModel
          .findOne({ _id: toObjectId(planId), workspaceId: workspaceObjectId })
          .exec();

        if (!plan) throw new NotFoundException('Advance recovery plan not found');

        if (plan.status === 'completed' || plan.status === 'reversed') {
          throw new BadRequestException(`Cannot edit a plan that is already ${plan.status}.`);
        }

        const now = new Date();
        const curMonth = now.getMonth() + 1;
        const curYear = now.getFullYear();

        // Determine which installments are frozen (locked salary or already elapsed).
        const isFrozenEntry = async (entry: { month: number; year: number }): Promise<boolean> => {
          const isElapsed =
            entry.year < curYear || (entry.year === curYear && entry.month < curMonth);
          if (isElapsed) return true;
          // Check if the target salary is locked.
          const salary = await this.salaryModel
            .findOne({
              workspaceId: workspaceObjectId,
              teamMemberId:
                plan.teamMemberId instanceof Types.ObjectId
                  ? plan.teamMemberId
                  : toObjectId(String(plan.teamMemberId)),
              month: entry.month,
              year: entry.year,
            })
            .select('isLocked')
            .lean()
            .exec();
          return !!(salary as any)?.isLocked;
        };

        // Collect future (non-frozen) active installment entries.
        const futureEntries: Array<{
          entry: (typeof plan.installments)[0];
          index: number;
        }> = [];
        for (let i = 0; i < plan.installments.length; i++) {
          const entry = plan.installments[i];
          if (entry.status === 'reversed') continue;
          const frozen = await isFrozenEntry(entry);
          if (!frozen) futureEntries.push({ entry, index: i });
        }

        // Cutover: the first non-frozen installment's month/year.
        const cutoverMonth = futureEntries.length > 0 ? futureEntries[0].entry.month : curMonth;
        const cutoverYear = futureEntries.length > 0 ? futureEntries[0].entry.year : curYear;

        // Helper: reverse future active adjustments and mark their ledger entries.
        const reverseFutureAdjustments = async (reason: string) => {
          for (const { entry, index } of futureEntries) {
            if (entry.adjustmentId) {
              const adj = await this.salaryAdjustmentModel.findById(entry.adjustmentId).exec();
              if (adj && adj.status === 'active') {
                await this.reverseAdjustmentDoc(adj, userObjectId, reason, {
                  planId: String(plan._id),
                  action: dto.action ?? 'edit',
                });
              }
            }
            plan.installments[index].status = 'reversed';
          }
        };

        // ---- action: pause ----
        if (dto.action === 'pause') {
          if (plan.status === 'paused') {
            throw new BadRequestException('Plan is already paused.');
          }
          await reverseFutureAdjustments(`Auto-reversed: advance recovery plan paused by actor.`);
          plan.status = 'paused';
          plan.pausedBy = userObjectId;
          plan.pausedAt = new Date();
          await plan.save();

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'advance_recovery_plan',
            entityId: String(plan._id),
            action: 'salary.advance_plan.paused',
            actorId: userId,
            teamMemberId: this.getObjectIdString(plan.teamMemberId),
            after: { status: 'paused', pausedAt: plan.pausedAt },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.advance_plan_paused',
            properties: { workspaceId, planId: String(plan._id) },
          });

          await this.refreshPlanProgress(plan);
          return plan;
        }

        // ---- action: resume ----
        if (dto.action === 'resume') {
          if (plan.status !== 'paused') {
            throw new BadRequestException('Plan must be paused before it can be resumed.');
          }

          plan.status = 'active';
          await plan.save();

          // Recompute remaining from frozen active installments so the
          // re-materialization uses the correct outstanding balance.
          let frozenActiveTotal = 0;
          for (let i = 0; i < plan.installments.length; i++) {
            const entry = plan.installments[i];
            if (entry.status === 'reversed') continue;
            const frozen = await isFrozenEntry(entry);
            if (frozen && entry.adjustmentId) {
              const adj = await this.salaryAdjustmentModel
                .findById(entry.adjustmentId)
                .select('amount status')
                .lean()
                .exec();
              if (adj && (adj as any).status === 'active') {
                frozenActiveTotal = this.roundCurrency(
                  frozenActiveTotal + ((adj as any).amount ?? 0),
                );
              }
            }
          }
          plan.remainingAmount = this.roundCurrency(
            Math.max(0, plan.totalAmount - frozenActiveTotal),
          );
          await plan.save();

          await this.materializeInstallments(
            plan,
            cutoverMonth,
            cutoverYear,
            plan.installmentAmount,
            userObjectId,
            workspaceId,
          );

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'advance_recovery_plan',
            entityId: String(plan._id),
            action: 'salary.advance_plan.resumed',
            actorId: userId,
            teamMemberId: this.getObjectIdString(plan.teamMemberId),
            after: { status: 'active', cutoverMonth, cutoverYear },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.advance_plan_resumed',
            properties: { workspaceId, planId: String(plan._id) },
          });

          await this.refreshPlanProgress(plan);
          return plan;
        }

        // ---- installmentAmount change ----
        if (dto.installmentAmount != null && dto.installmentAmount > 0) {
          // Reverse future installment adjustments.
          await reverseFutureAdjustments(
            `Auto-reversed: advance recovery installment amount changed.`,
          );

          // Recompute remaining from frozen actives only.
          let frozenActiveTotal = 0;
          for (let i = 0; i < plan.installments.length; i++) {
            const entry = plan.installments[i];
            if (entry.status === 'reversed') continue;
            const frozen = await isFrozenEntry(entry);
            if (frozen && entry.adjustmentId) {
              const adj = await this.salaryAdjustmentModel
                .findById(entry.adjustmentId)
                .select('amount status')
                .lean()
                .exec();
              if (adj && (adj as any).status === 'active') {
                frozenActiveTotal = this.roundCurrency(
                  frozenActiveTotal + ((adj as any).amount ?? 0),
                );
              }
            }
          }
          plan.remainingAmount = this.roundCurrency(
            Math.max(0, plan.totalAmount - frozenActiveTotal),
          );
          plan.installmentAmount = dto.installmentAmount;
          await plan.save();

          await this.materializeInstallments(
            plan,
            cutoverMonth,
            cutoverYear,
            dto.installmentAmount,
            userObjectId,
            workspaceId,
          );

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'advance_recovery_plan',
            entityId: String(plan._id),
            action: 'salary.advance_plan.edited',
            actorId: userId,
            teamMemberId: this.getObjectIdString(plan.teamMemberId),
            after: { installmentAmount: dto.installmentAmount, cutoverMonth, cutoverYear },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.advance_plan_edited',
            properties: {
              workspaceId,
              planId: String(plan._id),
              newInstallmentAmount: dto.installmentAmount,
            },
          });

          await this.refreshPlanProgress(plan);
          return plan;
        }

        throw new BadRequestException('Provide action (pause/resume) or installmentAmount.');
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Step E: earlyPayoffAdvanceRecoveryPlan
  //
  // Reverses all future unrecovered installment adjustments (current payroll
  // month onward), marks the plan completed with closureType 'early_payoff'.
  //
  // v1 does NOT record a cash-receipt Payment.  The assumption is that the
  // outstanding balance was settled out-of-band (e.g. deducted from final
  // settlement, paid in cash).  A future iteration may accept a payment DTO.
  // ---------------------------------------------------------------------------
  async earlyPayoffAdvanceRecoveryPlan(
    workspaceId: string,
    planId: string,
    userId: string,
    dto: { reason: string },
  ): Promise<AdvanceRecoveryPlanDocument> {
    return this.withSalarySpan(
      'salary.earlyPayoffAdvanceRecoveryPlan',
      { workspaceId, planId, userId },
      async () => {
        const workspaceObjectId = toObjectId(workspaceId);
        const userObjectId = toObjectId(userId);

        const plan = await this.advanceRecoveryPlanModel
          .findOne({ _id: toObjectId(planId), workspaceId: workspaceObjectId })
          .exec();

        if (!plan) throw new NotFoundException('Advance recovery plan not found');

        if (plan.status !== 'active' && plan.status !== 'paused') {
          throw new BadRequestException(
            `Cannot early-payoff a plan that is already ${plan.status}.`,
          );
        }

        const now = new Date();
        const curMonth = now.getMonth() + 1;
        const curYear = now.getFullYear();

        // Reverse all active adjustments for months >= current payroll month.
        for (let i = 0; i < plan.installments.length; i++) {
          const entry = plan.installments[i];
          if (entry.status === 'reversed') continue;
          const isFuture =
            entry.year > curYear || (entry.year === curYear && entry.month >= curMonth);
          if (!isFuture) continue;

          if (entry.adjustmentId) {
            const adj = await this.salaryAdjustmentModel.findById(entry.adjustmentId).exec();
            if (adj && adj.status === 'active') {
              await this.reverseAdjustmentDoc(adj, userObjectId, dto.reason, {
                planId: String(plan._id),
                source: 'early_payoff',
              });
            }
          }
          plan.installments[i].status = 'reversed';
        }

        plan.status = 'completed';
        plan.closureType = 'early_payoff';
        plan.closedBy = userObjectId;
        plan.closedAt = new Date();
        plan.closureReason = dto.reason;
        plan.remainingAmount = 0;
        await plan.save();

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'advance_recovery_plan',
          entityId: String(plan._id),
          action: 'salary.advance_plan.early_payoff',
          actorId: userId,
          teamMemberId: this.getObjectIdString(plan.teamMemberId),
          after: {
            status: 'completed',
            closureType: 'early_payoff',
            closedAt: plan.closedAt,
            reason: dto.reason,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.advance_plan_early_payoff',
          properties: {
            workspaceId,
            planId: String(plan._id),
            reason: dto.reason,
          },
        });

        await this.refreshPlanProgress(plan);
        return plan;
      },
    );
  }

  private async syncSalaryStatus(salary: Salary) {
    const totalPaid = await this.sumPaidAmountForSalary(toObjectId(String(salary._id)));

    if (totalPaid > salary.netSalary && salary.netSalary > 0) {
      salary.status = 'advance';
    } else if (totalPaid >= salary.netSalary && salary.netSalary > 0) {
      salary.status = 'paid';
    } else if (totalPaid > 0) {
      salary.status = 'partial';
    } else {
      salary.status = 'pending';
    }

    await salary.save();
    return salary;
  }

  private async ensureSalaryRecord(
    workspaceId: string,
    teamMemberId: string | Types.ObjectId,
    month: number,
    year: number,
    userId?: Types.ObjectId,
  ) {
    const workspaceObjectId = toObjectId(workspaceId);
    const teamMemberObjectId = toObjectId(teamMemberId);
    const loadStatutoryContext = async () => {
      const member = await this.teamModel.findById(teamMemberObjectId).exec();
      if (!member) {
        throw new NotFoundException('Team member not found');
      }

      const config = await this.getPayrollConfig(workspaceId);
      return { member, config };
    };

    const existingRecord = await this.salaryModel
      .findOne({
        workspaceId: workspaceObjectId,
        teamMemberId: teamMemberObjectId,
        month,
        year,
      })
      .exec();

    if (existingRecord) {
      if (existingRecord.isLocked) {
        return existingRecord as Salary;
      }

      // Phase 23 D-08: refresh piece-rate snapshot on every un-locked re-entry
      // so previews + payroll regenerate from the latest ProductionLog state.
      const memberForPieceRate = await this.teamModel
        .findById(teamMemberObjectId)
        .select('salaryType pieceRateConfig workspaceId')
        .lean()
        .exec();
      if ((memberForPieceRate as any)?.salaryType === 'piece_rate') {
        const pieceRateData = await this.computePieceRateEarnings(
          workspaceId,
          String(teamMemberObjectId),
          month,
          year,
          memberForPieceRate,
        );
        (existingRecord as any).pieceRateEarnings = pieceRateData.pieceEarnings;
        (existingRecord as any).pieceRateConfigSnapshot = pieceRateData.snapshot;
        (existingRecord as any).pieceRateBreakdown = pieceRateData.breakdown;
        (existingRecord as any).pieceRateStale = false;
      }

      // D-02: auto-deduct paid advances from prior months before recalculating
      await this.applyAdvanceAutoDeductions(workspaceId, existingRecord);

      const savedRecord = await this.recalculateSalaryFromAdjustments(existingRecord, userId);
      const { member, config } = await loadStatutoryContext();
      await this.applyStatutoryDeductions(workspaceId, savedRecord, member, config);
      if (member.dateOfJoining) {
        await this.gratuityService.updateGratuityLedger(
          workspaceId,
          teamMemberObjectId.toString(),
          new Date(member.dateOfJoining),
          savedRecord.baseSalary,
          savedRecord.month,
          savedRecord.year,
        );
      }
      return savedRecord;
    }

    const recordInfo = await this.buildSalaryRecordData(
      workspaceId,
      teamMemberObjectId,
      month,
      year,
      0,
      0,
    );

    const record = await this.salaryModel.create({
      ...recordInfo,
      status: 'pending',
      ...(userId ? { createdBy: userId } : {}),
    });

    // D-02: auto-deduct paid advances from prior months before recalculating
    await this.applyAdvanceAutoDeductions(workspaceId, record);

    const savedRecord = await this.recalculateSalaryFromAdjustments(record, userId);
    const { member, config } = await loadStatutoryContext();
    await this.applyStatutoryDeductions(workspaceId, savedRecord, member, config);
    if (member.dateOfJoining) {
      await this.gratuityService.updateGratuityLedger(
        workspaceId,
        teamMemberObjectId.toString(),
        new Date(member.dateOfJoining),
        savedRecord.baseSalary,
        savedRecord.month,
        savedRecord.year,
      );
    }
    return savedRecord;
  }

  /**
   * D-02 idempotent advance auto-deduction.
   * For any paid AdvanceSalaryRequest whose (month,year) is strictly earlier than
   * the salary record's (month,year) and whose recoveryAdjustmentId is unset,
   * create a SalaryAdjustment deduction and stamp recoveryAdjustmentId to prevent
   * double-deduction (RESEARCH Integration Seam 3 + Pitfall 4).
   */
  private async applyAdvanceAutoDeductions(workspaceId: string, salary: Salary): Promise<void> {
    const wsOid = new Types.ObjectId(workspaceId);
    const memberOid =
      salary.teamMemberId instanceof Types.ObjectId
        ? salary.teamMemberId
        : new Types.ObjectId(String(salary.teamMemberId));
    const salaryOid =
      salary._id instanceof Types.ObjectId ? salary._id : new Types.ObjectId(String(salary._id));

    // Find paid advances strictly before this salary's (month, year).
    // PAYROLL-CRITICAL: only advances with NO explicit recovery are auto-deducted
    // here. Both markers are checked — recoveryAdjustmentId (single lump deduction)
    // AND recoveryPlanId (multi-installment plan) — because the disburse paths
    // stamp whichever recovery they created. Without the recoveryPlanId guard a
    // plan-recovered advance would be lump-deducted again -> double recovery.
    const paidAdvances = await this.advanceSalaryRequestModel
      .find({
        workspaceId: wsOid,
        teamMemberId: memberOid,
        status: 'paid',
        recoveryAdjustmentId: { $exists: false },
        recoveryPlanId: { $exists: false },
        // Same-month-settled advances (owner model 2026-07-03) are recovered by
        // their own Payment counting toward the request month's dues — never
        // lump-deduct them in a later month.
        sameMonthRecovery: { $ne: true },
        $or: [{ year: { $lt: salary.year } }, { year: salary.year, month: { $lt: salary.month } }],
      })
      .exec();

    for (const advance of paidAdvances) {
      // BUGFIX (paise→rupee crossover): AdvanceSalaryRequest.approvedAmount is stored
      // in PAISE (the request entity mirrors the finance paise convention and the FE
      // sends/displays paise), but SalaryAdjustment.amount is in RUPEES (the salary
      // module convention). Writing approvedAmount straight in deducted 100× the
      // advance (a ₹5,000 advance recovered as ₹5,00,000). Convert at this boundary.
      const amount = this.roundCurrency((advance.approvedAmount ?? 0) / 100);
      if (amount <= 0) continue;

      const adjustment = new this.salaryAdjustmentModel({
        workspaceId: wsOid,
        salaryId: salaryOid,
        teamMemberId: memberOid,
        month: salary.month,
        year: salary.year,
        type: 'deduction',
        category: 'advance_recovery',
        amount,
        source: 'system',
        reasonTitle: `Advance recovery for ${advance.month}/${advance.year}`,
        note: `Auto-deducted from salary. Advance request: ${String(advance._id)}`,
        attachments: [],
        status: 'active',
        createdBy: memberOid,
      });

      await adjustment.save();

      // Idempotency marker — prevents double-deduction on re-run
      advance.recoveryAdjustmentId = new Types.ObjectId(String(adjustment._id));
      await advance.save();
    }
  }

  private async calculateAdjustmentRollups(salaryId: Types.ObjectId) {
    // IMPORTANT: loan_perquisite additions are phantom (taxable-but-non-cash).
    // They must NOT increase net cash pay, so they are excluded from the
    // 'additions' aggregate here. They are added to the TDS taxable base
    // separately in applyStatutoryDeductions and in getForm16Data.
    // See: phase-2-loan-module.md section 7.1 and spec comment on R1.
    const rollups = await this.salaryAdjustmentModel.aggregate<{
      _id: 'addition' | 'deduction';
      total: number;
    }>([
      { $match: { salaryId, status: 'active', category: { $ne: 'loan_perquisite' } } },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$amount' },
        },
      },
    ]);

    return {
      additions: rollups.find((entry) => entry._id === 'addition')?.total ?? 0,
      deductions: rollups.find((entry) => entry._id === 'deduction')?.total ?? 0,
    };
  }

  private async recalculateSalaryFromAdjustments(
    salary: Salary,
    userId?: Types.ObjectId,
    skipLockCheck = false,
  ) {
    if (!skipLockCheck) {
      await this.assertNotLocked(salary._id);
    }

    const { additions, deductions } = await this.calculateAdjustmentRollups(
      toObjectId(String(salary._id)),
    );

    salary.additions = additions;
    salary.deductions = deductions;
    salary.netSalary = this.roundCurrency(
      this.calculateNetSalary(
        salary.baseSalary,
        salary.totalDays,
        salary.presentDays,
        additions,
        deductions,
        (salary as any).pieceRateEarnings ?? 0,
      ),
    );
    if (userId) {
      salary.updatedBy = userId;
    }

    await salary.save();
    return this.syncSalaryStatus(salary);
  }

  private calculatePtAmount(
    grossSalary: number,
    slabs: Array<{
      minSalary: number;
      maxSalary: number | null;
      ptAmount: number;
    }>,
  ): number {
    for (const slab of slabs) {
      const aboveMin = grossSalary >= slab.minSalary;
      const belowMax = slab.maxSalary === null || grossSalary <= slab.maxSalary;
      if (aboveMin && belowMax) {
        return slab.ptAmount;
      }
    }

    return 0;
  }

  private getTeamMemberJoinDateParts(member: Pick<TeamMember, 'dateOfJoining'>) {
    let joinMonth: number | null = null;
    let joinYear: number | null = null;

    if (member.dateOfJoining) {
      const joinDate = new Date(member.dateOfJoining);
      if (!Number.isNaN(joinDate.getTime())) {
        joinMonth = joinDate.getMonth() + 1;
        joinYear = joinDate.getFullYear();
      }
    }

    return { joinMonth, joinYear };
  }

  private async getTdsDeductedSoFarInFy(params: {
    workspaceObjectId: Types.ObjectId;
    teamMemberId: Types.ObjectId;
    fyMonthRange: Array<{ 'salary.month': number; 'salary.year': number }>;
    excludeSalaryId?: Types.ObjectId;
  }): Promise<number> {
    const { workspaceObjectId, teamMemberId, fyMonthRange, excludeSalaryId } = params;
    const match: Record<string, unknown> = {
      workspaceId: workspaceObjectId,
      teamMemberId,
      category: 'tds_employee',
      source: 'system',
      status: 'active',
    };

    if (excludeSalaryId) {
      match.salaryId = { $ne: excludeSalaryId };
    }

    const existingTdsTotal = await this.salaryAdjustmentModel.aggregate<{
      _id: null;
      total: number;
    }>([
      { $match: match },
      {
        $lookup: {
          from: 'salaries',
          localField: 'salaryId',
          foreignField: '_id',
          as: 'salary',
        },
      },
      { $unwind: '$salary' },
      {
        $match: {
          $or: fyMonthRange,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
        },
      },
    ]);

    return existingTdsTotal[0]?.total ?? 0;
  }

  private async applyStatutoryDeductions(
    workspaceId: string,
    salaryRecord: Salary,
    member: TeamMember,
    config: PayrollConfig,
  ): Promise<void> {
    const statutory = config.statutory;
    if (!statutory) {
      return;
    }

    const workspaceObjectId = toObjectId(workspaceId);
    const salaryId = toObjectId(this.getObjectIdString(salaryRecord._id));
    const teamMemberId = toObjectId(this.getObjectIdString(member._id));
    const createdByValue = salaryRecord.updatedBy ?? salaryRecord.createdBy ?? teamMemberId;
    const createdBy = toObjectId(this.getObjectIdString(createdByValue));

    const pfApplicable =
      statutory.pfEnabled &&
      member.pfApplicable !== false &&
      !member.pfOptedOut &&
      !['contract', 'consultant', 'intern'].includes(member.employmentType);

    if (pfApplicable) {
      // Phase 23 (D-09): include piece-rate earnings in PF wage input
      const piecePortion = (salaryRecord as any).pieceRateEarnings ?? 0;
      const pfWageInput = salaryRecord.baseSalary + piecePortion;
      const pfWage = Math.min(pfWageInput, statutory.pfWageCeiling);
      const pfEmployeeAmount = Math.round(pfWage * 0.12);

      if (pfEmployeeAmount > 0) {
        await this.salaryAdjustmentModel.findOneAndUpdate(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            month: salaryRecord.month,
            year: salaryRecord.year,
            category: 'pf_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              workspaceId: workspaceObjectId,
              teamMemberId,
              salaryId,
              month: salaryRecord.month,
              year: salaryRecord.year,
              type: 'deduction',
              category: 'pf_employee',
              amount: pfEmployeeAmount,
              reasonTitle: 'PF Employee Contribution',
              note: `12% of Rs.${pfWage} (wage capped at Rs.${statutory.pfWageCeiling})`,
              attachments: [],
              source: 'system',
              status: 'active',
            },
            $setOnInsert: {
              createdBy,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      } else {
        await this.salaryAdjustmentModel.updateMany(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            category: 'pf_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              status: 'reversed',
              reversedAt: new Date(),
              reversalReason: 'PF amount is zero after recalculation',
            },
          },
        );
      }
    } else {
      await this.salaryAdjustmentModel.updateMany(
        {
          workspaceId: workspaceObjectId,
          salaryId,
          category: 'pf_employee',
          source: 'system',
          status: 'active',
        },
        {
          $set: {
            status: 'reversed',
            reversedAt: new Date(),
            reversalReason: 'PF no longer applicable',
          },
        },
      );
    }

    // Phase 23 (D-09): include piece-rate earnings in ESI gross wage input
    const piecePortionEsi = (salaryRecord as any).pieceRateEarnings ?? 0;
    const grossForEsi = salaryRecord.baseSalary + piecePortionEsi + (salaryRecord.additions || 0);
    const esiApplicable =
      statutory.esiEnabled &&
      (member.esiApplicable || grossForEsi <= statutory.esiGrossThreshold) &&
      !['contract', 'consultant'].includes(member.employmentType);

    if (esiApplicable) {
      const esiEmployeeAmount = Math.round(grossForEsi * 0.0075);

      if (esiEmployeeAmount > 0) {
        await this.salaryAdjustmentModel.findOneAndUpdate(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            month: salaryRecord.month,
            year: salaryRecord.year,
            category: 'esi_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              workspaceId: workspaceObjectId,
              teamMemberId,
              salaryId,
              month: salaryRecord.month,
              year: salaryRecord.year,
              type: 'deduction',
              category: 'esi_employee',
              amount: esiEmployeeAmount,
              reasonTitle: 'ESI Employee Contribution',
              note: `0.75% of Rs.${grossForEsi}`,
              attachments: [],
              source: 'system',
              status: 'active',
            },
            $setOnInsert: {
              createdBy,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      } else {
        await this.salaryAdjustmentModel.updateMany(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            category: 'esi_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              status: 'reversed',
              reversedAt: new Date(),
              reversalReason: 'ESI amount is zero after recalculation',
            },
          },
        );
      }
    } else {
      await this.salaryAdjustmentModel.updateMany(
        {
          workspaceId: workspaceObjectId,
          salaryId,
          category: 'esi_employee',
          source: 'system',
          status: 'active',
        },
        {
          $set: {
            status: 'reversed',
            reversedAt: new Date(),
            reversalReason: 'ESI no longer applicable',
          },
        },
      );
    }

    const ptApplicable = statutory.ptEnabled && !['intern'].includes(member.employmentType);

    if (ptApplicable) {
      const resolvedPtState = statutory.ptState || 'Gujarat';
      let ptSlabs: Array<{
        minSalary: number;
        maxSalary: number | null;
        ptAmount: number;
      }> = [];

      if (statutory.ptUseCustomSlabs && statutory.ptCustomSlabs?.length > 0) {
        ptSlabs = statutory.ptCustomSlabs;
      } else {
        const ptSlabConfig = await this.ptSlabConfigModel
          .findOne({ state: resolvedPtState, isActive: true })
          .lean()
          .exec();
        ptSlabs = ptSlabConfig?.slabs ?? [];
      }

      // Phase 23 (D-09): include piece-rate earnings in PT gross wage input
      const piecePortionPt = (salaryRecord as any).pieceRateEarnings ?? 0;
      const grossForPt = salaryRecord.baseSalary + piecePortionPt + (salaryRecord.additions || 0);
      const ptAmount = this.calculatePtAmount(grossForPt, ptSlabs);

      if (ptAmount > 0) {
        await this.salaryAdjustmentModel.findOneAndUpdate(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            month: salaryRecord.month,
            year: salaryRecord.year,
            category: 'pt_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              workspaceId: workspaceObjectId,
              teamMemberId,
              salaryId,
              month: salaryRecord.month,
              year: salaryRecord.year,
              type: 'deduction',
              category: 'pt_employee',
              amount: ptAmount,
              reasonTitle: 'Professional Tax',
              note: `PT slab for ${resolvedPtState} - gross Rs.${grossForPt}`,
              attachments: [],
              source: 'system',
              status: 'active',
            },
            $setOnInsert: {
              createdBy,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      } else {
        await this.salaryAdjustmentModel.updateMany(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            category: 'pt_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              status: 'reversed',
              reversedAt: new Date(),
              reversalReason: 'PT amount is 0 for current salary slab',
            },
          },
        );
      }
    } else {
      await this.salaryAdjustmentModel.updateMany(
        {
          workspaceId: workspaceObjectId,
          salaryId,
          category: 'pt_employee',
          source: 'system',
          status: 'active',
        },
        {
          $set: {
            status: 'reversed',
            reversedAt: new Date(),
            reversalReason: 'PT not applicable',
          },
        },
      );
    }

    const lwfApplicable =
      statutory.lwfEnabled &&
      !['contract', 'consultant', 'intern'].includes(member.employmentType || 'full_time');

    if (lwfApplicable) {
      const employeeState = (member.stateOfEmployment || '').trim();
      const workspaceState = (statutory.ptState || 'Gujarat').trim();
      const resolvedState = employeeState || workspaceState;
      const isDeductionMonth = isLwfDeductionMonth(resolvedState, salaryRecord.month);

      if (isDeductionMonth) {
        const lwfRate = getLwfRate(resolvedState);

        if (lwfRate && lwfRate.employeeAmount > 0) {
          await this.salaryAdjustmentModel.findOneAndUpdate(
            {
              workspaceId: workspaceObjectId,
              salaryId,
              month: salaryRecord.month,
              year: salaryRecord.year,
              category: 'lwf_employee',
              source: 'system',
              status: 'active',
            },
            {
              $set: {
                workspaceId: workspaceObjectId,
                teamMemberId,
                salaryId,
                month: salaryRecord.month,
                year: salaryRecord.year,
                type: 'deduction',
                category: 'lwf_employee',
                amount: lwfRate.employeeAmount,
                reasonTitle: 'Labour Welfare Fund',
                note: `LWF - ${resolvedState} - ${salaryRecord.month === 6 ? 'June' : 'December'} contribution`,
                attachments: [],
                source: 'system',
                status: 'active',
              },
              $setOnInsert: {
                createdBy,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
        } else {
          await this.salaryAdjustmentModel.updateMany(
            {
              workspaceId: workspaceObjectId,
              salaryId,
              category: 'lwf_employee',
              source: 'system',
              status: 'active',
            },
            {
              $set: {
                status: 'reversed',
                reversedAt: new Date(),
                reversalReason: 'LWF state has no applicable rate',
              },
            },
          );
        }
      } else {
        await this.salaryAdjustmentModel.updateMany(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            category: 'lwf_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              status: 'reversed',
              reversedAt: new Date(),
              reversalReason: 'Not a LWF deduction month',
            },
          },
        );
      }
    } else {
      await this.salaryAdjustmentModel.updateMany(
        {
          workspaceId: workspaceObjectId,
          salaryId,
          category: 'lwf_employee',
          source: 'system',
          status: 'active',
        },
        {
          $set: {
            status: 'reversed',
            reversedAt: new Date(),
            reversalReason: 'LWF not applicable',
          },
        },
      );
    }

    const tdsApplicable =
      statutory.tdsEnabled &&
      ['full_time', 'part_time'].includes(member.employmentType || 'full_time');

    if (tdsApplicable) {
      const workspace = await this.workspaceModel
        .findById(workspaceObjectId)
        .select('fiscalYearStartMonth')
        .exec();
      const fyStartMonth = workspace?.fiscalYearStartMonth || 4;
      const fyYear = this.tdsService.getFinancialYear(
        salaryRecord.month,
        salaryRecord.year,
        fyStartMonth,
      );
      const defaultRegime: 'old' | 'new' = member.taxRegime === 'old' ? 'old' : 'new';
      const existingDeclaration = await this.tdsService.getDeclaration(
        workspaceId,
        teamMemberId.toString(),
        fyYear,
      );
      const declaration =
        existingDeclaration ||
        (await this.tdsService.getOrCreateDeclaration(
          workspaceId,
          teamMemberId.toString(),
          fyYear,
          defaultRegime,
          createdBy.toString(),
        ));
      const regime: 'old' | 'new' = declaration?.taxRegime || defaultRegime;
      const fyMonthRange = this.tdsService.getFyMonthRange(fyYear, fyStartMonth);
      const tdsDedutedSoFar = await this.getTdsDeductedSoFarInFy({
        workspaceObjectId,
        teamMemberId,
        fyMonthRange,
        excludeSalaryId: salaryId,
      });
      const { joinMonth, joinYear } = this.getTeamMemberJoinDateParts(member);
      const hasPan = Boolean(member.pan?.trim());

      if (!hasPan) {
        this.logger.warn(
          `[applyStatutoryDeductions] PAN missing for teamMemberId=${teamMemberId.toString()} workspaceId=${workspaceId}; applying Section 206AA flat 20% TDS`,
        );
      }

      // Add any loan_perquisite additions for this salary record to the TDS
      // taxable base. These phantom additions (IT Rule 3(7)(i)) do not affect
      // net cash pay (excluded from calculateAdjustmentRollups) but must be
      // included in the annual projected salary used for TDS computation.
      // Spec: phase-2-loan-module.md section 7.1.
      const perquisiteAggs = await this.salaryAdjustmentModel.aggregate<{ total: number }>([
        {
          $match: {
            salaryId: toObjectId(String(salaryRecord._id)),
            status: 'active',
            category: 'loan_perquisite',
            type: 'addition',
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      const loanPerquisiteThisMonth = perquisiteAggs[0]?.total ?? 0;

      const monthlyTds = this.tdsService.computeMonthlyTds({
        monthlySalary: salaryRecord.netSalary + loanPerquisiteThisMonth,
        month: salaryRecord.month,
        year: salaryRecord.year,
        joinMonth,
        joinYear,
        fyStartMonth,
        declaration,
        regime,
        tdsDedutedSoFar,
        hasPan,
        isNonItrFiler: member.isNonItrFiler || false,
      });

      if (monthlyTds > 0) {
        const fyLabel = `${fyYear}-${String(fyYear + 1).slice(-2)}`;
        const panNote = hasPan ? '' : ' | PAN not available - TDS at 20% per Section 206AA';

        await this.salaryAdjustmentModel.findOneAndUpdate(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            month: salaryRecord.month,
            year: salaryRecord.year,
            category: 'tds_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              workspaceId: workspaceObjectId,
              teamMemberId,
              salaryId,
              month: salaryRecord.month,
              year: salaryRecord.year,
              type: 'deduction',
              category: 'tds_employee',
              amount: monthlyTds,
              reasonTitle: 'TDS (Income Tax)',
              note: `Section 192 - ${regime === 'new' ? 'New' : 'Old'} Regime - FY ${fyLabel}${panNote}`,
              attachments: [],
              source: 'system',
              status: 'active',
            },
            $setOnInsert: {
              createdBy,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        await this.tdsService.updateTdsDedutedSoFar(
          workspaceId,
          teamMemberId.toString(),
          fyYear,
          tdsDedutedSoFar + monthlyTds,
        );
      } else {
        await this.salaryAdjustmentModel.updateMany(
          {
            workspaceId: workspaceObjectId,
            salaryId,
            category: 'tds_employee',
            source: 'system',
            status: 'active',
          },
          {
            $set: {
              status: 'reversed',
              reversedAt: new Date(),
              reversalReason: 'TDS computed as 0',
            },
          },
        );

        await this.tdsService.updateTdsDedutedSoFar(
          workspaceId,
          teamMemberId.toString(),
          fyYear,
          tdsDedutedSoFar,
        );
      }
    } else {
      await this.salaryAdjustmentModel.updateMany(
        {
          workspaceId: workspaceObjectId,
          salaryId,
          category: 'tds_employee',
          source: 'system',
          status: 'active',
        },
        {
          $set: {
            status: 'reversed',
            reversedAt: new Date(),
            reversalReason: 'TDS not applicable',
          },
        },
      );
    }

    await this.recalculateSalaryFromAdjustments(salaryRecord);
  }

  async generatePayroll(workspaceId: string, month: number, year: number) {
    return this.withSalarySpan(
      'salary.generatePayroll',
      { workspaceId, month, year },
      async (span) => {
        const workspaceObjectId = toObjectId(workspaceId);

        // OQ-S5 cascade (#6): skip removed/soft-deleted members. `isActive:false`
        // already excludes them (remove() flips both flags) but the explicit
        // isDeleted guard is fail-safe against any isActive/isDeleted drift.
        const members = await this.teamModel
          .find({ workspaceId: workspaceObjectId, isActive: true, isDeleted: { $ne: true } })
          .exec();

        const firstDay = new Date(year, month - 1, 1);
        const lastDay = new Date(year, month, 0, 23, 59, 59);

        const eligibleMembers = members.filter((member) => {
          const joined = member.dateOfJoining ? new Date(member.dateOfJoining) : null;
          const resigned = member.dateOfResignation ? new Date(member.dateOfResignation) : null;
          if (joined && joined > lastDay) return false;
          if (resigned && resigned < firstDay) return false;
          return true;
        });

        const records: Salary[] = [];
        try {
          for (const member of eligibleMembers) {
            const record = await this.ensureSalaryRecord(workspaceId, member._id, month, year);
            records.push(record);
          }
        } catch (err) {
          Sentry.captureException(err, { tags: { module: 'salary', op: 'generatePayroll' } });
          throw err;
        }

        span.setAttribute('result', records.length);
        this.postHog.capture({
          distinctId: workspaceId,
          event: 'salary.payroll_generated',
          properties: {
            workspaceId,
            month,
            year,
            membersGenerated: records.length,
            eligibleMembersCount: eligibleMembers.length,
          },
        });

        return records;
      },
    );
  }

  async getSalaryRecords(
    workspaceId: string,
    month: number,
    year: number,
    /**
     * Salary A3 (fail-closed): ALWAYS required. Pass the caller's real userId
     * for user-facing API calls so PII stripping is applied per RBAC scope.
     * Internal/compliance callers (ECR / ESI / bank-disbursement) that need
     * full unfiltered data MUST pass SALARY_INTERNAL_UNFILTERED explicitly
     * rather than omitting this argument. This makes the opt-out visible at
     * every call site and prevents accidental leaks from future callers.
     */
    userId: string,
  ) {
    const workspaceObjectId = toObjectId(workspaceId);

    // Phase 6 (member-cap read filter) — ORG-scoped. This endpoint is gated
    // `salary VIEW 'all'` at the controller (a self-scoped worker uses /me/salary)
    // and passes the caller's real userId; statutory/internal callers pass
    // SALARY_INTERNAL_UNFILTERED and are never capped. When the cap is biting,
    // restrict the records to the allowed member set so an over-limit workspace
    // shows salary only for grandfathered members. Null = no cap (no-op).
    const cappedMemberIds = await this.resolveSalaryAllowedMemberIds(workspaceId, userId);
    const recordsFilter: Record<string, unknown> = { workspaceId: workspaceObjectId, month, year };
    if (cappedMemberIds) {
      recordsFilter.teamMemberId = { $in: cappedMemberIds };
    }

    const records = await this.salaryModel
      .find(recordsFilter)
      .populate({
        path: 'teamMemberId',
        select:
          'name email designation avatar uan pan esiIpNumber employmentType pfApplicable pfOptedOut esiApplicable shiftId bankDetails upiDetails preferredMethod dateOfJoining dateOfResignation salaryType salaryAmount salaryDayBasis fixedMonthDays attendancePayMode dailyHours workingDays finalMonthlyOverride ctcAmount componentTemplateId componentOverrides',
        populate: { path: 'shiftId', select: 'name startTime endTime' },
      })
      .exec();

    if (records.length === 0) return records;

    const salaryObjectIds = records.map((record) => toObjectId(String(record._id)));

    const paidAmounts = await this.paymentModel.aggregate<{
      _id: Types.ObjectId;
      paidAmount: number;
    }>([
      {
        $match: {
          salaryId: { $in: salaryObjectIds },
          status: { $ne: 'reversed' },
        },
      },
      {
        $group: {
          _id: '$salaryId',
          paidAmount: {
            $sum: {
              $add: ['$amount', { $ifNull: ['$commission', 0] }],
            },
          },
        },
      },
    ]);

    const adjustmentCounts = await this.salaryAdjustmentModel.aggregate<{
      _id: Types.ObjectId;
      adjustmentCount: number;
      activeAdjustmentCount: number;
    }>([
      {
        $match: {
          workspaceId: workspaceObjectId,
          salaryId: { $in: salaryObjectIds },
        },
      },
      {
        $group: {
          _id: '$salaryId',
          adjustmentCount: { $sum: 1 },
          activeAdjustmentCount: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] },
          },
        },
      },
    ]);

    const paidMap = new Map<string, number>(
      paidAmounts.map((payment) => [String(payment._id), payment.paidAmount]),
    );
    const adjustmentMap = new Map<
      string,
      { adjustmentCount: number; activeAdjustmentCount: number }
    >(
      adjustmentCounts.map((entry) => [
        String(entry._id),
        {
          adjustmentCount: entry.adjustmentCount,
          activeAdjustmentCount: entry.activeAdjustmentCount,
        },
      ]),
    );

    const enrichedRecords = records.map((record) => {
      const adjustmentMeta = adjustmentMap.get(String(record._id));
      return {
        ...record.toObject(),
        paidAmount: paidMap.get(String(record._id)) || 0,
        adjustmentCount: adjustmentMeta?.adjustmentCount || 0,
        activeAdjustmentCount: adjustmentMeta?.activeAdjustmentCount || 0,
      };
    });

    // Salary A3 (fail-closed): always resolve the sensitive ctx and strip PII.
    // Compliance callers pass SALARY_INTERNAL_UNFILTERED which short-circuits
    // to canViewSensitive=true (no-op strip). Real callers pass their userId.
    const sens = await this.resolveSalarySensitiveCtx(workspaceId, userId);
    for (const record of enrichedRecords) {
      const m = record.teamMemberId as Record<string, unknown> | undefined;
      const memberId =
        m && typeof m === 'object' && '_id' in m
          ? String((m as { _id: unknown })._id)
          : String(record.teamMemberId);
      stripSalarySensitiveFields(m && typeof m === 'object' ? m : null, {
        isOwner: sens.isOwner,
        isOwnRecord: sens.ownTeamMemberId != null && sens.ownTeamMemberId === memberId,
        canViewSensitive: sens.canViewSensitive,
      });
    }

    return enrichedRecords;
  }

  private async getShiftMetadataMap(
    shiftCollection: string,
    shiftIds: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    if (shiftIds.length === 0) {
      return new Map();
    }

    const shifts = await this.teamModel.db
      .collection(shiftCollection)
      .find({ _id: { $in: shiftIds.map((shiftId) => toObjectId(shiftId)) } })
      .project({ name: 1, startTime: 1, endTime: 1 })
      .toArray();

    return new Map(shifts.map((shift) => [String(shift._id), shift as Record<string, unknown>]));
  }

  private async buildSalaryAggregationBasePipeline(
    workspaceId: string,
    month: number,
    year: number,
    options: {
      search?: string;
      shiftId?: string;
      teamMemberId?: string;
      // Phase 6 (member-cap read filter) — when non-null, the ORG-scoped allowed
      // member set. Injected into the opening `$match` (`teamMatch`) so the whole
      // salary aggregate (records + summary + shift summaries) behaves as if only
      // the grandfathered members exist. Combined with an explicit `teamMemberId`
      // filter via `$in` so a capped-out single-member lookup yields nothing
      // rather than widening. Null = no cap (no constraint added).
      allowedMemberIds?: Types.ObjectId[] | null;
    },
  ) {
    const workspaceObjectId = toObjectId(workspaceId);
    const payrollConfig = await this.getPayrollConfig(workspaceId);
    const defaultWorkingDays = Math.max(
      1,
      Math.min(31, Number(payrollConfig.display?.defaultWorkingDays ?? 26) || 26),
    );
    const monthLength = this.getMonthLength(month, year);
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0, 23, 59, 59);

    const salaryCollection = this.salaryModel.collection.name;
    const paymentCollection = this.paymentModel.collection.name;
    const adjustmentCollection = this.salaryAdjustmentModel.collection.name;
    const shiftCollection = 'shifts';

    const teamMatch: Record<string, unknown> = {
      workspaceId: { $in: [workspaceObjectId, workspaceId] },
      isActive: true,
      isDeleted: { $ne: true },
      $and: [
        {
          $or: [
            { dateOfJoining: { $exists: false } },
            { dateOfJoining: null },
            { dateOfJoining: { $lte: lastDay } },
          ],
        },
        {
          $or: [
            { dateOfResignation: { $exists: false } },
            { dateOfResignation: null },
            { dateOfResignation: { $gte: firstDay } },
          ],
        },
      ],
    };

    if (options.search) {
      teamMatch.name = { $regex: options.search, $options: 'i' };
    }

    if (options.shiftId) {
      if (options.shiftId === 'unassigned') {
        (teamMatch.$and as Array<Record<string, unknown>>).push({
          $or: [{ shiftId: { $exists: false } }, { shiftId: null }],
        });
      } else {
        if (!Types.ObjectId.isValid(options.shiftId)) {
          throw new BadRequestException('Invalid shift filter');
        }
        teamMatch.shiftId = {
          $in: [toObjectId(options.shiftId), options.shiftId],
        };
      }
    }

    if (options.teamMemberId) {
      if (!Types.ObjectId.isValid(options.teamMemberId)) {
        throw new BadRequestException('Invalid team member filter');
      }
      teamMatch._id = toObjectId(options.teamMemberId);
    }

    // Phase 6 (member-cap read filter) — restrict the base team-member match to
    // the allowed set when the cap is biting. If a specific `teamMemberId` filter
    // is already present, AND it with the allowed set (a capped-out member yields
    // an empty result) rather than overwriting/widening it. `teamMatch.$and`
    // already exists (the joining/resignation guards above), so we push onto it.
    if (options.allowedMemberIds) {
      if (teamMatch._id !== undefined) {
        (teamMatch.$and as Array<Record<string, unknown>>).push(
          { _id: teamMatch._id },
          { _id: { $in: options.allowedMemberIds } },
        );
        delete teamMatch._id;
      } else {
        teamMatch._id = { $in: options.allowedMemberIds };
      }
    }

    const effectiveSalaryExpr = {
      $cond: {
        if: { $ne: [{ $ifNull: ['$salaryType', 'monthly'] }, 'hourly'] },
        then: { $max: [0, { $ifNull: ['$salaryAmount', 0] }] },
        else: {
          $cond: {
            if: {
              $and: [
                { $ne: [{ $ifNull: ['$finalMonthlyOverride', null] }, null] },
                { $gt: [{ $ifNull: ['$finalMonthlyOverride', 0] }, 0] },
              ],
            },
            then: { $max: [0, { $ifNull: ['$finalMonthlyOverride', 0] }] },
            else: {
              $multiply: [
                { $max: [0, { $ifNull: ['$salaryAmount', 0] }] },
                { $max: [0, { $ifNull: ['$dailyHours', 0] }] },
                {
                  $max: [
                    0,
                    {
                      $cond: {
                        if: { $eq: ['$salaryDayBasis', 'calendar_month_days'] },
                        then: monthLength,
                        else: {
                          $ifNull: [
                            '$fixedMonthDays',
                            { $ifNull: ['$workingDays', defaultWorkingDays] },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };

    const deriveStatusExpr = {
      $switch: {
        branches: [
          {
            case: { $eq: ['$_salaryRecord', null] },
            then: {
              $cond: {
                if: { $gt: ['$_effectiveSalary', 0] },
                then: 'not_generated',
                else: 'salary_not_set',
              },
            },
          },
          {
            case: {
              $or: [{ $lte: ['$_baseSalary', 0] }, { $lte: ['$_netSalary', 0] }],
            },
            then: 'salary_not_set',
          },
          {
            case: { $gt: ['$_paidAmount', '$_netSalary'] },
            then: 'advance',
          },
          {
            case: { $gte: ['$_paidAmount', '$_netSalary'] },
            then: 'paid',
          },
          {
            case: { $gt: ['$_paidAmount', 0] },
            then: 'partial',
          },
        ],
        default: 'pending',
      },
    };

    return {
      shiftCollection,
      pipeline: [
        { $match: teamMatch },
        {
          $project: {
            _id: 1,
            name: 1,
            email: 1,
            designation: 1,
            avatar: 1,
            salaryType: 1,
            salaryAmount: 1,
            salaryDayBasis: 1,
            fixedMonthDays: 1,
            attendancePayMode: 1,
            dailyHours: 1,
            workingDays: 1,
            finalMonthlyOverride: 1,
            ctcAmount: 1,
            componentTemplateId: 1,
            componentOverrides: 1,
            uan: 1,
            pan: 1,
            esiIpNumber: 1,
            employmentType: 1,
            pfApplicable: 1,
            pfOptedOut: 1,
            esiApplicable: 1,
            dateOfJoining: 1,
            dateOfResignation: 1,
            shiftId: 1,
            bankDetails: 1,
            upiDetails: 1,
            preferredMethod: 1,
            _effectiveSalary: effectiveSalaryExpr,
          },
        },
        {
          $lookup: {
            from: salaryCollection,
            let: { memberId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$teamMemberId', '$$memberId'] },
                      { $eq: ['$workspaceId', workspaceObjectId] },
                      { $eq: ['$month', month] },
                      { $eq: ['$year', year] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: '_salaryArr',
          },
        },
        {
          $addFields: {
            _salaryRecord: {
              $ifNull: [{ $arrayElemAt: ['$_salaryArr', 0] }, null],
            },
          },
        },
        {
          $lookup: {
            from: paymentCollection,
            let: { salaryId: '$_salaryRecord._id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [{ $eq: ['$salaryId', '$$salaryId'] }, { $ne: ['$status', 'reversed'] }],
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  total: {
                    $sum: {
                      $add: ['$amount', { $ifNull: ['$commission', 0] }],
                    },
                  },
                },
              },
            ],
            as: '_paidArr',
          },
        },
        {
          $lookup: {
            from: adjustmentCollection,
            let: { salaryId: '$_salaryRecord._id' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$salaryId', '$$salaryId'] },
                },
              },
              {
                $group: {
                  _id: null,
                  adjustmentCount: { $sum: 1 },
                  activeAdjustmentCount: {
                    $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] },
                  },
                },
              },
            ],
            as: '_adjArr',
          },
        },
        {
          $addFields: {
            _paidAmount: {
              $round: [{ $ifNull: [{ $arrayElemAt: ['$_paidArr.total', 0] }, 0] }, 2],
            },
            // Phase 23 (D-09): Form 16 / list synthesis — _baseSalary derives
            // from persisted baseSalary which does NOT include pieceRateEarnings.
            // Add piece earnings on top so compliance/Form 16 totals are correct.
            _baseSalary: {
              $cond: {
                if: { $eq: ['$_salaryRecord', null] },
                then: '$_effectiveSalary',
                else: {
                  $add: [
                    {
                      $cond: {
                        if: {
                          $gt: [{ $ifNull: ['$_salaryRecord.baseSalary', 0] }, 0],
                        },
                        then: '$_salaryRecord.baseSalary',
                        else: '$_effectiveSalary',
                      },
                    },
                    { $ifNull: ['$_salaryRecord.pieceRateEarnings', 0] },
                  ],
                },
              },
            },
            _netSalary: {
              $cond: {
                if: { $eq: ['$_salaryRecord', null] },
                then: 0,
                else: {
                  $cond: {
                    if: {
                      $gt: [{ $ifNull: ['$_salaryRecord.netSalary', 0] }, 0],
                    },
                    then: '$_salaryRecord.netSalary',
                    else: {
                      $cond: {
                        if: {
                          $gt: [{ $ifNull: ['$_salaryRecord.baseSalary', 0] }, 0],
                        },
                        then: '$_salaryRecord.baseSalary',
                        else: '$_effectiveSalary',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        // Running-month settlement view (owner directive 2026-07-03): while the
        // requested month is the CURRENT (or a future) month, settle against the
        // FULL expected month salary, not the attendance-accrued net. Mid-month
        // the accrued net climbs day by day, so an advance (e.g. ₹5,000 of a
        // ₹20,000 salary with 0.5 days marked) falsely read as "Overpaid".
        // Past months keep the FINAL net (a real attendance shortfall then
        // genuinely means overpaid). Clamps the working _netSalary BEFORE
        // deriveStatusExpr + the summary $group consume it; salary docs are
        // untouched. Preview rows (no salary record) keep _netSalary 0.
        ...(year > new Date().getFullYear() ||
        (year === new Date().getFullYear() && month >= new Date().getMonth() + 1)
          ? [
              {
                $addFields: {
                  _netSalary: {
                    $cond: {
                      if: { $eq: ['$_salaryRecord', null] },
                      then: '$_netSalary',
                      else: { $max: ['$_netSalary', '$_baseSalary'] },
                    },
                  },
                },
              },
            ]
          : []),
        {
          $addFields: {
            _derivedStatus: deriveStatusExpr,
          },
        },
        {
          $addFields: {
            _statusOrder: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ['$_derivedStatus', 'salary_not_set'] },
                    then: 0,
                  },
                  {
                    case: { $eq: ['$_derivedStatus', 'not_generated'] },
                    then: 1,
                  },
                  { case: { $eq: ['$_derivedStatus', 'pending'] }, then: 2 },
                  { case: { $eq: ['$_derivedStatus', 'partial'] }, then: 3 },
                  { case: { $eq: ['$_derivedStatus', 'paid'] }, then: 4 },
                  { case: { $eq: ['$_derivedStatus', 'advance'] }, then: 5 },
                ],
                default: 0,
              },
            },
          },
        },
        {
          $project: {
            _id: { $ifNull: ['$_salaryRecord._id', null] },
            workspaceId: { $literal: workspaceId },
            teamMemberId: { $toString: '$_id' },
            teamMember: {
              _id: { $toString: '$_id' },
              name: '$name',
              email: '$email',
              designation: '$designation',
              avatar: '$avatar',
              salaryType: '$salaryType',
              salaryAmount: '$salaryAmount',
              salaryDayBasis: '$salaryDayBasis',
              fixedMonthDays: '$fixedMonthDays',
              attendancePayMode: '$attendancePayMode',
              dailyHours: '$dailyHours',
              workingDays: '$workingDays',
              finalMonthlyOverride: '$finalMonthlyOverride',
              ctcAmount: '$ctcAmount',
              componentTemplateId: '$componentTemplateId',
              componentOverrides: '$componentOverrides',
              uan: '$uan',
              pan: '$pan',
              esiIpNumber: '$esiIpNumber',
              employmentType: '$employmentType',
              pfApplicable: '$pfApplicable',
              pfOptedOut: '$pfOptedOut',
              esiApplicable: '$esiApplicable',
              dateOfJoining: '$dateOfJoining',
              dateOfResignation: '$dateOfResignation',
              shiftId: '$shiftId',
              bankDetails: '$bankDetails',
              upiDetails: '$upiDetails',
              preferredMethod: '$preferredMethod',
            },
            month: { $ifNull: ['$_salaryRecord.month', month] },
            year: { $ifNull: ['$_salaryRecord.year', year] },
            baseSalary: '$_baseSalary',
            totalDays: { $ifNull: ['$_salaryRecord.totalDays', 0] },
            presentDays: { $ifNull: ['$_salaryRecord.presentDays', 0] },
            salaryType: {
              $ifNull: ['$_salaryRecord.salaryType', '$salaryType'],
            },
            salaryDayBasis: {
              $ifNull: ['$_salaryRecord.salaryDayBasis', '$salaryDayBasis'],
            },
            fixedMonthDays: {
              $ifNull: ['$_salaryRecord.fixedMonthDays', '$fixedMonthDays'],
            },
            attendancePayModeApplied: {
              $cond: {
                if: { $eq: ['$_salaryRecord', null] },
                then: '$$REMOVE',
                else: '$_salaryRecord.attendancePayModeApplied',
              },
            },
            additions: { $ifNull: ['$_salaryRecord.additions', 0] },
            deductions: { $ifNull: ['$_salaryRecord.deductions', 0] },
            netSalary: '$_netSalary',
            effectiveSalary: {
              $cond: {
                if: { $eq: ['$_salaryRecord', null] },
                then: '$_effectiveSalary',
                else: '$$REMOVE',
              },
            },
            paidAmount: '$_paidAmount',
            status: { $ifNull: ['$_salaryRecord.status', 'pending'] },
            settlementStatus: {
              $cond: {
                if: { $eq: ['$_derivedStatus', 'advance'] },
                then: 'overpaid',
                else: '$_derivedStatus',
              },
            },
            isPreview: { $eq: ['$_salaryRecord', null] },
            isLocked: { $ifNull: ['$_salaryRecord.isLocked', false] },
            lockedBy: {
              $cond: {
                if: {
                  $ne: [{ $ifNull: ['$_salaryRecord.lockedBy', null] }, null],
                },
                then: { $toString: '$_salaryRecord.lockedBy' },
                else: '$$REMOVE',
              },
            },
            lockedAt: {
              $cond: {
                if: {
                  $ne: [{ $ifNull: ['$_salaryRecord.lockedAt', null] }, null],
                },
                then: '$_salaryRecord.lockedAt',
                else: '$$REMOVE',
              },
            },
            adjustmentCount: {
              $ifNull: [{ $arrayElemAt: ['$_adjArr.adjustmentCount', 0] }, 0],
            },
            activeAdjustmentCount: {
              $ifNull: [{ $arrayElemAt: ['$_adjArr.activeAdjustmentCount', 0] }, 0],
            },
            _derivedStatus: 1,
            _statusOrder: 1,
            _netSalary: 1,
            _paidAmount: 1,
            _teamShiftId: '$shiftId',
            name: 1,
          },
        },
      ] as Record<string, unknown>[],
    };
  }

  private async getSalarySummaryAggregate(workspaceId: string, month: number, year: number) {
    const { pipeline: basePipeline } = await this.buildSalaryAggregationBasePipeline(
      workspaceId,
      month,
      year,
      {},
    );

    const [summary] = await this.teamModel
      .aggregate<{
        _id?: null;
        employeesCount: number;
        totalPayable: number;
        totalPaid: number;
        paidCount: number;
        pendingCount: number;
        partialCount: number;
        advanceCount: number;
        salaryNotSetCount: number;
        notGeneratedCount: number;
      }>([
        ...basePipeline,
        {
          $group: {
            _id: null,
            employeesCount: { $sum: 1 },
            totalPayable: { $sum: '$_netSalary' },
            totalPaid: { $sum: '$_paidAmount' },
            paidCount: {
              $sum: { $cond: [{ $eq: ['$_derivedStatus', 'paid'] }, 1, 0] },
            },
            pendingCount: {
              $sum: { $cond: [{ $eq: ['$_derivedStatus', 'pending'] }, 1, 0] },
            },
            partialCount: {
              $sum: { $cond: [{ $eq: ['$_derivedStatus', 'partial'] }, 1, 0] },
            },
            advanceCount: {
              $sum: { $cond: [{ $eq: ['$_derivedStatus', 'advance'] }, 1, 0] },
            },
            salaryNotSetCount: {
              $sum: {
                $cond: [{ $eq: ['$_derivedStatus', 'salary_not_set'] }, 1, 0],
              },
            },
            notGeneratedCount: {
              $sum: {
                $cond: [{ $eq: ['$_derivedStatus', 'not_generated'] }, 1, 0],
              },
            },
          },
        },
      ])
      .exec();

    const rawSummary = summary || {
      employeesCount: 0,
      totalPayable: 0,
      totalPaid: 0,
      paidCount: 0,
      pendingCount: 0,
      partialCount: 0,
      advanceCount: 0,
      salaryNotSetCount: 0,
      notGeneratedCount: 0,
    };

    const roundedTotalPayable = this.roundCurrency(rawSummary.totalPayable);
    const roundedTotalPaid = this.roundCurrency(rawSummary.totalPaid);

    return {
      employeesCount: rawSummary.employeesCount,
      totalPayable: roundedTotalPayable,
      totalPaid: roundedTotalPaid,
      totalPending: this.roundCurrency(Math.max(0, roundedTotalPayable - roundedTotalPaid)),
      totalOverpaid: this.roundCurrency(Math.max(0, roundedTotalPaid - roundedTotalPayable)),
      paidCount: rawSummary.paidCount,
      pendingCount: rawSummary.pendingCount,
      partialCount: rawSummary.partialCount,
      advanceCount: rawSummary.advanceCount,
      salaryNotSetCount: rawSummary.salaryNotSetCount,
      notGeneratedCount: rawSummary.notGeneratedCount,
    };
  }

  /**
   * Aggregates advances, loans, and bonus/commission/incentive for the workspace.
   *
   * Advance outstanding: computed FRESH at read time, NOT from
   * AdvanceRecoveryPlan.remainingAmount. remainingAmount is initialised to the full
   * totalAmount at plan creation and only recomputed by refreshPlanProgress on plan
   * EDITS (pause/resume/edit-installment/early-payoff) -- never on month roll-over or
   * payroll finalize -- so a plan that simply runs month to month keeps a stale-high
   * remainingAmount and over-states the KPI. We recompute live exactly like the
   * worker-facing getOutstandingAdvances and FnfService.getOutstandingAdvances so the
   * owner figure equals the sum of what each worker sees on their own salary screen:
   *   outstanding = sum over active|paused plans of (totalAmount - elapsed installments)
   *               + sum of non-plan (legacy lump) advance_recovery deductions whose
   *                 target month is current-or-future.
   * "Elapsed" = target month STRICTLY BEFORE the current calendar month (already
   * recovered, mirrors refreshPlanProgress). Anchored to "now" (present-tense balance,
   * like the loan block below), so the figure reconciles with the worker / F&F views.
   *
   * Loan aggregates: queried directly from EmployerLoan via the already-injected
   * employerLoanModel to avoid a circular dependency (LoanService injects SalaryService,
   * so injecting LoanService into SalaryService would form a cycle). The query mirrors
   * LoanService.loanDashboard but omits the loans array to keep it lightweight.
   *
   * Bonus / commission / incentive: aggregated from SalaryAdjustment rows with
   * type='addition', status='active', and category in (bonus, commission, incentive)
   * for the given month+year. This is the single source of truth. Commission entered
   * via the Record Payment modal is written as a SalaryAdjustment with category
   * 'commission' (see recordPayment -> createPaymentLinkedAddition, category: 'commission').
   * Aggregating SalaryAdjustment rows already includes those entries, so payment.commission
   * is intentionally NOT summed separately -- that would double-count.
   */
  private async getAdvancesLoansBonus(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<AdvancesLoansBonusBlock> {
    const wsObjectId = toObjectId(workspaceId);

    // --- Advances (computed fresh; remainingAmount is stale between plan edits) ---
    // See the method docstring for why remainingAmount is NOT trusted. We mirror the
    // worker-facing getOutstandingAdvances / FnfService.getOutstandingAdvances logic,
    // workspace-wide, so the KPI equals the sum of what each worker sees.
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();
    // Strictly-before the current month = already recovered (mirrors refreshPlanProgress).
    const isAdvanceElapsed = (m: number, y: number): boolean =>
      y < curYear || (y === curYear && m < curMonth);

    const [advancePlans, advanceRecoveryAdjustments] = await Promise.all([
      this.advanceRecoveryPlanModel
        .find({ workspaceId: wsObjectId, status: { $in: ['active', 'paused'] } })
        .select('totalAmount linkedAdjustmentIds')
        .lean()
        .exec(),
      // Plan installments AND legacy single-month lumps both carry
      // category 'advance_recovery', type 'deduction'.
      this.salaryAdjustmentModel
        .find({
          workspaceId: wsObjectId,
          category: 'advance_recovery',
          type: 'deduction',
          status: 'active',
        })
        .select('_id month year amount')
        .lean()
        .exec(),
    ]);

    type AdvanceAdjRow = { _id: Types.ObjectId; month: number; year: number; amount: number };
    const advanceAdjRows = advanceRecoveryAdjustments as unknown as AdvanceAdjRow[];
    const advanceAdjById = new Map(advanceAdjRows.map((a) => [String(a._id), a]));
    const planLinkedAdjIds = new Set<string>();

    // Plan-based outstanding: totalAmount - sum(elapsed active installments), live.
    // Includes any un-schedulable residual (totalAmount beyond scheduled installments).
    let planOutstanding = 0;
    const advancePlanRows = advancePlans as unknown as Array<{
      totalAmount?: number;
      linkedAdjustmentIds?: Types.ObjectId[];
    }>;
    for (const plan of advancePlanRows) {
      let elapsedRecovered = 0;
      for (const id of plan.linkedAdjustmentIds ?? []) {
        const key = String(id);
        planLinkedAdjIds.add(key);
        const adj = advanceAdjById.get(key);
        if (adj && isAdvanceElapsed(adj.month, adj.year)) {
          elapsedRecovered += adj.amount ?? 0;
        }
      }
      planOutstanding += Math.max(0, (plan.totalAmount ?? 0) - elapsedRecovered);
    }

    // Legacy lumps: non-plan advance-recovery deductions whose target month is
    // current-or-future. Plan-linked ids are excluded to avoid double-counting.
    let legacyOutstanding = 0;
    for (const adj of advanceAdjRows) {
      if (planLinkedAdjIds.has(String(adj._id))) continue;
      if (!isAdvanceElapsed(adj.month, adj.year)) {
        legacyOutstanding += adj.amount ?? 0;
      }
    }

    const totalOutstandingAdvances = this.roundCurrency(planOutstanding + legacyOutstanding);

    // --- Loans: query employerLoanModel directly to avoid circular dep ---
    // LoanService already injects SalaryService; injecting LoanService here would cycle.
    // Mirror the loanDashboard aggregate: active/paused loans only for outstanding principal.
    const loanResult = await this.employerLoanModel
      .aggregate<{ count: number; totalOutstandingPrincipal: number }>([
        {
          $match: {
            workspaceId: wsObjectId,
            status: { $in: ['active', 'paused'] },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalOutstandingPrincipal: {
              // remainingPrincipal is set for reducing-balance loans;
              // remainingAmount is the fallback (mirrors loanDashboard logic).
              $sum: {
                $ifNull: ['$remainingPrincipal', '$remainingAmount'],
              },
            },
          },
        },
      ])
      .exec();
    const totalActiveLoans = loanResult[0]?.count ?? 0;
    const totalOutstandingLoanPrincipal = this.roundCurrency(
      loanResult[0]?.totalOutstandingPrincipal ?? 0,
    );

    // --- Bonus / Commission / Incentive (single source: SalaryAdjustment) ---
    // Payment-linked commissions are written as SalaryAdjustment with category='commission'.
    // Summing SalaryAdjustment rows already captures those entries; payment.commission is
    // NOT added here to prevent double-counting (spec section 3).
    const adjResult = await this.salaryAdjustmentModel
      .aggregate<{ category: string; total: number }>([
        {
          $match: {
            workspaceId: wsObjectId,
            type: 'addition',
            status: 'active',
            category: { $in: ['bonus', 'commission', 'incentive'] },
            month,
            year,
          },
        },
        {
          $group: {
            _id: '$category',
            total: { $sum: '$amount' },
          },
        },
      ])
      .exec();

    const adjMap = new Map(adjResult.map((r) => [r.category, r.total]));
    const totalBonus = this.roundCurrency(adjMap.get('bonus') ?? 0);
    const totalCommission = this.roundCurrency(adjMap.get('commission') ?? 0);
    const totalIncentive = this.roundCurrency(adjMap.get('incentive') ?? 0);

    return {
      totalOutstandingAdvances,
      totalActiveLoans,
      totalOutstandingLoanPrincipal,
      totalBonus,
      totalCommission,
      totalIncentive,
    };
  }

  async getPayrollOverview(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<PayrollOverviewResponse> {
    const summary = await this.getSalarySummaryAggregate(workspaceId, month, year);
    const shiftSnapshot = (await this.getSalaryShiftSummaries(workspaceId, month, year))
      .slice()
      .sort((left, right) => right.totalPayable - left.totalPayable)
      .slice(0, 6);

    const trendMonths = Array.from({ length: 6 }, (_, index) => {
      const value = new Date(year, month - 1 - (5 - index), 1);
      return {
        month: value.getMonth() + 1,
        year: value.getFullYear(),
        label: new Intl.DateTimeFormat('en-IN', {
          month: 'short',
          year: 'numeric',
        }).format(value),
      };
    });

    const trend = await Promise.all(
      trendMonths.map(async (point) => {
        const monthSummary = await this.getSalarySummaryAggregate(
          workspaceId,
          point.month,
          point.year,
        );

        return {
          month: point.month,
          year: point.year,
          label: point.label,
          totalPayable: monthSummary.totalPayable,
          totalPaid: monthSummary.totalPaid,
          totalDue: monthSummary.totalPending,
        };
      }),
    );

    const advancesLoansBonus = await this.getAdvancesLoansBonus(workspaceId, month, year);

    return {
      summary: { ...summary, advancesLoansBonus },
      shiftSnapshot,
      trend,
    };
  }

  async getSalaryShiftSummaries(
    workspaceId: string,
    month: number,
    year: number,
    options: {
      search?: string;
      teamMemberId?: string;
      status?: string;
    } = {},
  ): Promise<SalaryShiftSummary[]> {
    const { pipeline: basePipeline, shiftCollection } =
      await this.buildSalaryAggregationBasePipeline(workspaceId, month, year, {
        search: options.search,
        teamMemberId: options.teamMemberId,
      });

    const statusFilterMatch =
      options.status && options.status !== 'all' ? { _derivedStatus: options.status } : {};

    const summaries = await this.teamModel
      .aggregate<{
        _id: Types.ObjectId | null;
        employeeCount: number;
        totalPayable: number;
        totalPaid: number;
        pendingCount: number;
        partialCount: number;
        paidCount: number;
        overpaidCount: number;
        notGeneratedCount: number;
        salaryNotSetCount: number;
      }>([
        ...basePipeline,
        ...(Object.keys(statusFilterMatch).length > 0 ? [{ $match: statusFilterMatch }] : []),
        {
          $group: {
            _id: '$_teamShiftId',
            employeeCount: { $sum: 1 },
            totalPayable: { $sum: '$_netSalary' },
            totalPaid: { $sum: '$_paidAmount' },
            pendingCount: {
              $sum: { $cond: [{ $eq: ['$_derivedStatus', 'pending'] }, 1, 0] },
            },
            partialCount: {
              $sum: { $cond: [{ $eq: ['$_derivedStatus', 'partial'] }, 1, 0] },
            },
            paidCount: {
              $sum: { $cond: [{ $eq: ['$_derivedStatus', 'paid'] }, 1, 0] },
            },
            overpaidCount: {
              $sum: { $cond: [{ $eq: ['$_derivedStatus', 'advance'] }, 1, 0] },
            },
            notGeneratedCount: {
              $sum: {
                $cond: [{ $eq: ['$_derivedStatus', 'not_generated'] }, 1, 0],
              },
            },
            salaryNotSetCount: {
              $sum: {
                $cond: [{ $eq: ['$_derivedStatus', 'salary_not_set'] }, 1, 0],
              },
            },
          },
        },
      ])
      .exec();

    const shiftIds = summaries
      .map((summary) =>
        summary._id instanceof Types.ObjectId
          ? summary._id.toHexString()
          : summary._id
            ? String(summary._id)
            : '',
      )
      .filter(Boolean);
    const shiftMap = await this.getShiftMetadataMap(shiftCollection, shiftIds);

    const mapped = summaries.map((summary) => {
      const shiftId =
        summary._id instanceof Types.ObjectId
          ? summary._id.toHexString()
          : summary._id
            ? String(summary._id)
            : null;
      const shift = shiftId ? shiftMap.get(shiftId) : undefined;
      const totalPayable = this.roundCurrency(summary.totalPayable);
      const totalPaid = this.roundCurrency(summary.totalPaid);

      return {
        shiftId,
        shiftName:
          typeof shift?.name === 'string' && shift.name.trim().length > 0
            ? shift.name
            : 'Unassigned',
        shiftStartTime: typeof shift?.startTime === 'string' ? shift.startTime : undefined,
        shiftEndTime: typeof shift?.endTime === 'string' ? shift.endTime : undefined,
        employeeCount: summary.employeeCount,
        totalPayable,
        totalPaid,
        totalDue: this.roundCurrency(Math.max(0, totalPayable - totalPaid)),
        pendingCount: summary.pendingCount,
        partialCount: summary.partialCount,
        paidCount: summary.paidCount,
        overpaidCount: summary.overpaidCount,
        notGeneratedCount: summary.notGeneratedCount,
        salaryNotSetCount: summary.salaryNotSetCount,
      };
    });

    return mapped.sort((left, right) => {
      if (left.shiftName === 'Unassigned' && right.shiftName !== 'Unassigned') {
        return 1;
      }
      if (right.shiftName === 'Unassigned' && left.shiftName !== 'Unassigned') {
        return -1;
      }
      return left.shiftName.localeCompare(right.shiftName);
    });
  }

  /**
   * Counts active members who join AFTER the viewed month (so they are
   * intentionally excluded from that month's payroll list) and returns the
   * earliest such joining month/year for the "view their month" jump.
   * Isolated from the list pipeline so the list filter is never affected.
   */
  private async countUpcomingJoiners(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<{ count: number; nextJoinerMonth: number | null; nextJoinerYear: number | null }> {
    const workspaceObjectId = toObjectId(workspaceId);
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0, 23, 59, 59);

    const [row] = await this.teamModel
      .aggregate<{ count: number; nextJoining: Date | null }>([
        {
          $match: {
            workspaceId: { $in: [workspaceObjectId, workspaceId] },
            isActive: true,
            isDeleted: { $ne: true },
            dateOfJoining: { $gt: lastDay },
            $or: [
              { dateOfResignation: { $exists: false } },
              { dateOfResignation: null },
              { dateOfResignation: { $gte: firstDay } },
            ],
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            nextJoining: { $min: '$dateOfJoining' },
          },
        },
      ])
      .exec();

    const count = row?.count ?? 0;
    const nextJoining = row?.nextJoining ? new Date(row.nextJoining) : null;
    return {
      count,
      nextJoinerMonth: nextJoining ? nextJoining.getMonth() + 1 : null,
      nextJoinerYear: nextJoining ? nextJoining.getFullYear() : null,
    };
  }

  private async runPaginatedAggregation(
    workspaceId: string,
    month: number,
    year: number,
    options: {
      page: number;
      limit: number;
      skip: number;
      search?: string;
      shiftId?: string;
      teamMemberId?: string;
      status?: string;
      sortBy?: string;
      sortOrder: 1 | -1;
      // Phase 6 (member-cap read filter) — the resolved org-scoped allowed set,
      // or null when not capped / internal. Threaded into the base pipeline.
      allowedMemberIds?: Types.ObjectId[] | null;
    },
  ) {
    const { pipeline: basePipeline, shiftCollection } =
      await this.buildSalaryAggregationBasePipeline(workspaceId, month, year, {
        search: options.search,
        shiftId: options.shiftId,
        teamMemberId: options.teamMemberId,
        allowedMemberIds: options.allowedMemberIds,
      });

    let sortStage: Record<string, 1 | -1>;
    switch (options.sortBy) {
      case 'netSalary':
        sortStage = { _netSalary: options.sortOrder };
        break;
      case 'paidAmount':
        sortStage = { _paidAmount: options.sortOrder };
        break;
      case 'status':
        sortStage = { _statusOrder: options.sortOrder };
        break;
      case 'name':
      default:
        sortStage = { name: options.sortOrder };
        break;
    }

    const statusFilterMatch =
      options.status && options.status !== 'all' ? { _derivedStatus: options.status } : {};

    const pipeline = [
      ...basePipeline,
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                employeesCount: { $sum: 1 },
                totalPayable: { $sum: '$_netSalary' },
                totalPaid: { $sum: '$_paidAmount' },
                paidCount: {
                  $sum: { $cond: [{ $eq: ['$_derivedStatus', 'paid'] }, 1, 0] },
                },
                pendingCount: {
                  $sum: {
                    $cond: [{ $eq: ['$_derivedStatus', 'pending'] }, 1, 0],
                  },
                },
                partialCount: {
                  $sum: {
                    $cond: [{ $eq: ['$_derivedStatus', 'partial'] }, 1, 0],
                  },
                },
                advanceCount: {
                  $sum: {
                    $cond: [{ $eq: ['$_derivedStatus', 'advance'] }, 1, 0],
                  },
                },
                salaryNotSetCount: {
                  $sum: {
                    $cond: [{ $eq: ['$_derivedStatus', 'salary_not_set'] }, 1, 0],
                  },
                },
                notGeneratedCount: {
                  $sum: {
                    $cond: [{ $eq: ['$_derivedStatus', 'not_generated'] }, 1, 0],
                  },
                },
              },
            },
          ],
          filtered: [
            ...(Object.keys(statusFilterMatch).length > 0 ? [{ $match: statusFilterMatch }] : []),
            { $sort: sortStage },
            { $skip: options.skip },
            { $limit: options.limit },
            {
              $project: {
                _derivedStatus: 0,
                _statusOrder: 0,
                _netSalary: 0,
                _paidAmount: 0,
                name: 0,
              },
            },
          ],
          filteredTotal: [
            ...(Object.keys(statusFilterMatch).length > 0 ? [{ $match: statusFilterMatch }] : []),
            { $count: 'count' },
          ],
        },
      },
    ];

    const [result] = await this.teamModel
      .aggregate<{
        summary?: Array<{
          _id?: null;
          employeesCount: number;
          totalPayable: number;
          totalPaid: number;
          paidCount: number;
          pendingCount: number;
          partialCount: number;
          advanceCount: number;
          salaryNotSetCount: number;
          notGeneratedCount: number;
        }>;
        filtered?: Array<Record<string, unknown>>;
        filteredTotal?: Array<{ count: number }>;
      }>(pipeline)
      .exec();

    const rawSummary = result?.summary?.[0] || {
      employeesCount: 0,
      totalPayable: 0,
      totalPaid: 0,
      paidCount: 0,
      pendingCount: 0,
      partialCount: 0,
      advanceCount: 0,
      salaryNotSetCount: 0,
      notGeneratedCount: 0,
    };

    const roundedTotalPayable = this.roundCurrency(rawSummary.totalPayable);
    const roundedTotalPaid = this.roundCurrency(rawSummary.totalPaid);

    const upcoming = options.teamMemberId
      ? { count: 0, nextJoinerMonth: null, nextJoinerYear: null }
      : await this.countUpcomingJoiners(workspaceId, month, year);

    const summary = {
      employeesCount: rawSummary.employeesCount,
      totalPayable: roundedTotalPayable,
      totalPaid: roundedTotalPaid,
      totalPending: this.roundCurrency(Math.max(0, roundedTotalPayable - roundedTotalPaid)),
      totalOverpaid: this.roundCurrency(Math.max(0, roundedTotalPaid - roundedTotalPayable)),
      paidCount: rawSummary.paidCount,
      pendingCount: rawSummary.pendingCount,
      partialCount: rawSummary.partialCount,
      advanceCount: rawSummary.advanceCount,
      salaryNotSetCount: rawSummary.salaryNotSetCount,
      notGeneratedCount: rawSummary.notGeneratedCount,
      upcomingJoinersCount: upcoming.count,
      nextJoinerMonth: upcoming.nextJoinerMonth,
      nextJoinerYear: upcoming.nextJoinerYear,
    };

    const total = result?.filteredTotal?.[0]?.count || 0;
    const pages = Math.ceil(total / options.limit);
    const records = result?.filtered || [];

    const shiftIds = [
      ...new Set(
        records
          .map((record) => record._teamShiftId)
          .filter(Boolean)
          .map(String),
      ),
    ];

    const shiftMap = await this.getShiftMetadataMap(shiftCollection, shiftIds);

    const hydratedRecords = records.map((record) => {
      const shiftIdValue = record._teamShiftId;
      const shift = shiftIdValue
        ? shiftMap.get(
            shiftIdValue instanceof Types.ObjectId
              ? shiftIdValue.toHexString()
              : String(shiftIdValue),
          )
        : undefined;
      const teamMember =
        record.teamMember && typeof record.teamMember === 'object'
          ? ({ ...(record.teamMember as Record<string, unknown>) } as Record<string, unknown>)
          : record.teamMember;

      if (teamMember && shift) {
        teamMember.shiftId = shift;
      }

      const { _teamShiftId, ...rest } = record;
      return teamMember ? { ...rest, teamMember } : rest;
    });

    const recordsWithSettlementMetadata = await this.attachPaginatedSettlementMetadata(
      workspaceId,
      hydratedRecords as Array<{
        _id: Types.ObjectId | string | null;
        netSalary: number;
        paidAmount: number;
        settlementStatus: PaginatedSettlementStatus;
      }>,
    );

    return {
      records: recordsWithSettlementMetadata,
      pagination: { page: options.page, limit: options.limit, total, pages },
      summary,
    };
  }

  // Legacy: kept for rollback if aggregation pipeline produces different results. Remove after verification.
  private async getSalaryRecordsPaginatedLegacy(
    workspaceId: string,
    month: number,
    year: number,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      /**
       * Salary A3 (fail-closed): REQUIRED. Pass the caller's real userId for
       * user-facing requests. Internal/compliance callers that need unfiltered
       * data MUST pass SALARY_INTERNAL_UNFILTERED explicitly.
       */
      userId: string;
    },
  ) {
    const workspaceObjectId = toObjectId(workspaceId);
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;
    const sortOrder = options.sortOrder === 'desc' ? -1 : 1;
    const payrollConfig = await this.getPayrollConfig(workspaceId);
    const defaultWorkingDays = Math.max(
      1,
      Math.min(31, Number(payrollConfig.display?.defaultWorkingDays ?? 26) || 26),
    );

    this.logger.log(
      `[salary/paginated] start workspace=${workspaceId} month=${month} year=${year} page=${page} limit=${limit} search=${options.search ?? ''} status=${options.status ?? 'all'} sortBy=${options.sortBy ?? 'name'} sortOrder=${options.sortOrder ?? 'asc'}`,
    );

    // ── Step 1: Get ALL eligible team members ──
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0, 23, 59, 59);
    const teamQueryFilter: FilterQuery<TeamMember> = {
      workspaceId: {
        $in: [workspaceObjectId, workspaceId],
      },
      isActive: true,
      isDeleted: { $ne: true },
      $and: [
        {
          $or: [
            { dateOfJoining: { $exists: false } },
            { dateOfJoining: null },
            { dateOfJoining: { $lte: lastDay } },
          ],
        },
        {
          $or: [
            { dateOfResignation: { $exists: false } },
            { dateOfResignation: null },
            { dateOfResignation: { $gte: firstDay } },
          ],
        },
      ],
      ...(options.search
        ? {
            name: { $regex: options.search, $options: 'i' },
          }
        : {}),
    };

    const allEligibleMembers = await this.teamModel
      .find(teamQueryFilter as never)
      .select(
        '_id name designation avatar salaryType salaryAmount salaryDayBasis fixedMonthDays attendancePayMode dailyHours workingDays finalMonthlyOverride ctcAmount componentTemplateId componentOverrides dateOfJoining dateOfResignation shiftId bankDetails upiDetails preferredMethod',
      )
      .populate('shiftId', 'name startTime endTime')
      .lean<PaginatedTeamMember[]>()
      .exec();

    this.logger.log(`[salary/paginated] eligibleMembers=${allEligibleMembers.length}`);

    // ── Step 2: Get ALL salary records for the month ──
    const allSalaryRecords = await this.salaryModel
      .find({ workspaceId: workspaceObjectId, month, year })
      .lean<PaginatedSalaryRecord[]>()
      .exec();

    this.logger.log(`[salary/paginated] salaryRecordsForMonth=${allSalaryRecords.length}`);

    const salaryMap = new Map<string, PaginatedSalaryRecord>();
    allSalaryRecords.forEach((rec) => {
      salaryMap.set(this.getObjectIdString(rec.teamMemberId), rec);
    });

    // ── Step 3: Get paid amounts + adjustment counts ──
    const salaryObjectIds = allSalaryRecords.map((r) => toObjectId(String(r._id)));

    let paidMap = new Map<string, number>();
    let adjustmentMap = new Map<
      string,
      { adjustmentCount: number; activeAdjustmentCount: number }
    >();

    if (salaryObjectIds.length > 0) {
      const paidAmounts = await this.paymentModel.aggregate<PaidAmountAggregate>([
        {
          $match: {
            salaryId: { $in: salaryObjectIds },
            status: { $ne: 'reversed' },
          },
        },
        {
          $group: {
            _id: '$salaryId',
            paidAmount: {
              $sum: { $add: ['$amount', { $ifNull: ['$commission', 0] }] },
            },
          },
        },
      ]);
      paidMap = new Map(paidAmounts.map((payment) => [String(payment._id), payment.paidAmount]));

      const adjustmentCounts = await this.salaryAdjustmentModel.aggregate<AdjustmentCountAggregate>(
        [
          {
            $match: {
              workspaceId: workspaceObjectId,
              salaryId: { $in: salaryObjectIds },
            },
          },
          {
            $group: {
              _id: '$salaryId',
              adjustmentCount: { $sum: 1 },
              activeAdjustmentCount: {
                $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] },
              },
            },
          },
        ],
      );
      adjustmentMap = new Map(
        adjustmentCounts.map((adjustment) => [
          String(adjustment._id),
          {
            adjustmentCount: adjustment.adjustmentCount,
            activeAdjustmentCount: adjustment.activeAdjustmentCount,
          },
        ]),
      );
    }

    // ── Step 4: Merge into unified rows ──
    // Running-month settlement view (owner directive 2026-07-03): while the
    // selected month is the CURRENT (or a future) month, settle against the
    // FULL expected month salary, not the attendance-accrued net. Mid-month
    // the accrued net climbs day by day, so an advance (e.g. ₹5,000 of a
    // ₹20,000 salary with 0.5 days marked) falsely read as "Overpaid".
    // Past months keep the FINAL net (attendance shortfalls then genuinely
    // mean overpaid). Display/status only - salary docs are not touched.
    const nowForSettle = new Date();
    const isRunningMonth =
      year > nowForSettle.getFullYear() ||
      (year === nowForSettle.getFullYear() && month >= nowForSettle.getMonth() + 1);
    const allMergedRows: PaginatedSalaryRow[] = allEligibleMembers.map((member) => {
      const memberId = String(member._id);
      const salaryRecord = salaryMap.get(memberId);
      const effectiveSalary = this.resolveEffectiveMonthlySalary(member, {
        month,
        year,
        defaultWorkingDays,
      });

      if (salaryRecord) {
        const salaryId = String(salaryRecord._id);
        const paidAmount = paidMap.get(salaryId) || 0;
        const adjMeta = adjustmentMap.get(salaryId);
        const baseSalary = salaryRecord.baseSalary > 0 ? salaryRecord.baseSalary : effectiveSalary;
        const finalNet = salaryRecord.netSalary > 0 ? salaryRecord.netSalary : baseSalary;
        const netSalary = isRunningMonth ? Math.max(finalNet, baseSalary) : finalNet;
        const derivedStatus = this.deriveSalaryStatus(baseSalary, netSalary, paidAmount);

        return {
          _id: salaryRecord._id,
          workspaceId: this.getObjectIdString(salaryRecord.workspaceId),
          teamMemberId: memberId,
          teamMember: member,
          month: salaryRecord.month,
          year: salaryRecord.year,
          baseSalary,
          totalDays: salaryRecord.totalDays,
          presentDays: salaryRecord.presentDays,
          salaryType: salaryRecord.salaryType ?? member.salaryType,
          salaryDayBasis: salaryRecord.salaryDayBasis ?? member.salaryDayBasis,
          fixedMonthDays: salaryRecord.fixedMonthDays ?? member.fixedMonthDays ?? null,
          attendancePayModeApplied: salaryRecord.attendancePayModeApplied,
          additions: salaryRecord.additions || 0,
          deductions: salaryRecord.deductions || 0,
          netSalary,
          paidAmount: this.roundCurrency(paidAmount),
          status: salaryRecord.status,
          isPreview: false,
          adjustmentCount: adjMeta?.adjustmentCount || 0,
          activeAdjustmentCount: adjMeta?.activeAdjustmentCount || 0,
          settlementStatus: this.mapSettlementStatus(derivedStatus),
          _derivedStatus: derivedStatus,
        };
      }

      const derivedStatus = effectiveSalary > 0 ? 'not_generated' : 'salary_not_set';

      return {
        _id: null,
        workspaceId,
        teamMemberId: memberId,
        teamMember: member,
        month,
        year,
        baseSalary: effectiveSalary,
        totalDays: 0,
        presentDays: 0,
        salaryType: member.salaryType,
        salaryDayBasis: member.salaryDayBasis,
        fixedMonthDays: member.fixedMonthDays ?? null,
        additions: 0,
        deductions: 0,
        netSalary: 0,
        effectiveSalary,
        paidAmount: 0,
        status: 'pending',
        isPreview: true,
        adjustmentCount: 0,
        activeAdjustmentCount: 0,
        settlementStatus: this.mapSettlementStatus(derivedStatus),
        _derivedStatus: derivedStatus,
      };
    });

    // ── Step 5: Summary from ALL rows (before filtering/pagination) ──
    const summary = this.computeSalarySummary(allMergedRows);

    // ── Step 6: Filter by status ──
    let filteredRows = allMergedRows;
    if (options.status && options.status !== 'all') {
      filteredRows = filteredRows.filter((row) => row._derivedStatus === options.status);
    }

    this.logger.log(
      `[salary/paginated] mergedRows=${allMergedRows.length} filteredRows=${filteredRows.length} summaryEmployees=${summary.employeesCount} summaryPaid=${summary.paidCount} summaryPending=${summary.pendingCount} summaryPartial=${summary.partialCount} summaryAdvance=${summary.advanceCount} summarySalaryNotSet=${summary.salaryNotSetCount}`,
    );

    // ── Step 7: Sort ──
    const sortBy = options.sortBy || 'name';
    filteredRows.sort((a, b) => {
      switch (sortBy) {
        case 'name': {
          const leftName = this.getMemberName(a.teamMember);
          const rightName = this.getMemberName(b.teamMember);
          return sortOrder * leftName.localeCompare(rightName);
        }
        case 'netSalary':
          return sortOrder * (a.netSalary - b.netSalary);
        case 'paidAmount':
          return sortOrder * (a.paidAmount - b.paidAmount);
        case 'status': {
          const statusOrder: Record<string, number> = {
            salary_not_set: 0,
            pending: 1,
            partial: 2,
            paid: 3,
            advance: 4,
          };
          return (
            sortOrder *
            ((statusOrder[a._derivedStatus] || 0) - (statusOrder[b._derivedStatus] || 0))
          );
        }
        default:
          return 0;
      }
    });

    // ── Step 8: Paginate ──
    const total = filteredRows.length;
    const pages = Math.ceil(total / limit);
    const paginatedRows = filteredRows.slice(skip, skip + limit);

    // Remove internal _derivedStatus from response
    const records = paginatedRows.map(({ _derivedStatus, ...rest }) => rest);
    const recordsWithSettlementMetadata = await this.attachPaginatedSettlementMetadata(
      workspaceId,
      records,
    );

    // Salary A3 (fail-closed): always resolve the sensitive ctx and strip PII.
    // Compliance callers pass SALARY_INTERNAL_UNFILTERED which short-circuits
    // to canViewSensitive=true (no-op strip). Real callers pass their userId.
    const sens = await this.resolveSalarySensitiveCtx(workspaceId, options.userId);
    for (const row of recordsWithSettlementMetadata) {
      const r = row as Record<string, unknown>;
      const memberId = r.teamMemberId != null ? String(r.teamMemberId) : '';
      const teamMember = r.teamMember;
      stripSalarySensitiveFields(
        teamMember && typeof teamMember === 'object'
          ? (teamMember as Record<string, unknown>)
          : null,
        {
          isOwner: sens.isOwner,
          isOwnRecord: sens.ownTeamMemberId != null && sens.ownTeamMemberId === memberId,
          canViewSensitive: sens.canViewSensitive,
        },
      );
    }

    this.logger.log(
      `[salary/paginated] response page=${page}/${pages || 0} total=${total} returned=${records.length}`,
    );

    return {
      records: recordsWithSettlementMetadata,
      pagination: { page, limit, total, pages },
      summary,
    };
  }

  async getSalaryRecordsPaginated(
    workspaceId: string,
    month: number,
    year: number,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      shiftId?: string;
      teamMemberId?: string;
      status?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      /**
       * Salary A3 (fail-closed): REQUIRED. Pass the caller's real userId for
       * user-facing requests. Internal/compliance callers that need unfiltered
       * data MUST pass SALARY_INTERNAL_UNFILTERED explicitly.
       */
      userId: string;
    },
  ) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;
    const sortOrder = options.sortOrder === 'desc' ? -1 : 1;

    this.logger.log(
      `[salary/paginated] start workspace=${workspaceId} month=${month} year=${year} page=${page} limit=${limit} search=${options.search ?? ''} status=${options.status ?? 'all'} sortBy=${options.sortBy ?? 'name'} sortOrder=${options.sortOrder ?? 'asc'}`,
    );

    // Phase 6 (member-cap read filter) — ORG-scoped. Resolve the allowed member
    // set (null when not capped / internal-compliance caller) and thread it into
    // the aggregation so an over-limit workspace's paginated report + summary
    // totals behave as if only the grandfathered members exist.
    const allowedMemberIds = await this.resolveSalaryAllowedMemberIds(workspaceId, options.userId);

    const result = await this.runPaginatedAggregation(workspaceId, month, year, {
      page,
      limit,
      skip,
      search: options.search,
      shiftId: options.shiftId,
      teamMemberId: options.teamMemberId,
      status: options.status,
      sortBy: options.sortBy,
      sortOrder,
      allowedMemberIds,
    });

    // Salary A3 (fail-closed): always resolve the sensitive ctx and strip PII.
    // Compliance callers pass SALARY_INTERNAL_UNFILTERED which short-circuits
    // to canViewSensitive=true (no-op strip). Real callers pass their userId.
    const sens = await this.resolveSalarySensitiveCtx(workspaceId, options.userId);
    for (const row of result.records) {
      const r = row as Record<string, unknown>;
      const memberId = r.teamMemberId != null ? String(r.teamMemberId) : '';
      const teamMember = r.teamMember;
      stripSalarySensitiveFields(
        teamMember && typeof teamMember === 'object'
          ? (teamMember as Record<string, unknown>)
          : null,
        {
          isOwner: sens.isOwner,
          isOwnRecord: sens.ownTeamMemberId != null && sens.ownTeamMemberId === memberId,
          canViewSensitive: sens.canViewSensitive,
        },
      );
    }

    this.logger.log(
      `[salary/paginated] response page=${result.pagination.page}/${result.pagination.pages || 0} total=${result.pagination.total} returned=${result.records.length}`,
    );

    // Phase 7 (member-cap report notice) — surface the optional `memberCap`
    // status on the org-scoped paginated salary REPORT (gated `salary VIEW 'all'`
    // at the controller; the web salary register consumes this) so it can show
    // "Showing N of TOTAL — upgrade", mirroring the Team directory list. Resolved
    // on the SAME non-exempt branch as the cap filter: the internal/compliance
    // sentinel (SALARY_INTERNAL_UNFILTERED) gets `null` (no notice — statutory
    // exports see everyone). Attached only when non-null so the existing
    // { records, pagination, summary } shape is otherwise unchanged.
    const memberCap = await this.resolveSalaryMemberCapStatus(workspaceId, options.userId);

    return memberCap ? { ...result, memberCap } : result;
  }

  async updateSalaryRecord(
    workspaceId: string,
    recordId: string,
    updateDto: UpdateSalaryRecordDto,
    actorId?: string,
  ) {
    return this.withSalarySpan(
      'salary.updateRecord',
      { workspaceId, recordId, ...(actorId ? { userId: actorId } : {}) },
      async () => {
        const workspaceObjectId = toObjectId(workspaceId);

        const record = await this.salaryModel
          .findOne({ _id: toObjectId(recordId), workspaceId: workspaceObjectId })
          .exec();
        if (!record) throw new NotFoundException('Salary record not found');
        await this.assertNotLocked(record._id);

        // LOW-3 invariant: every HTTP write path passes the resolved actor
        // (req.user.sub) into updateSalaryRecord, so the SoD self-edit guard
        // always runs for a real user. Actor-less calls are internal/system only
        // (e.g. cron recalcs, system fallbacks) and have no "self" to protect, so
        // skipping SoD here is correct. The offboard guard below runs regardless.
        if (actorId) {
          await this.assertNotSelfSalaryEdit(
            workspaceId,
            actorId,
            this.getObjectIdString(record.teamMemberId),
          );
        }
        // OQ-S5: block edits to a removed member's salary record.
        await this.assertMemberWritableForSalary(
          workspaceId,
          this.getObjectIdString(record.teamMemberId),
        );

        const beforeSnapshot = {
          baseSalary: record.baseSalary,
          netSalary: record.netSalary,
        };

        if (updateDto.baseSalary !== undefined) {
          record.baseSalary = updateDto.baseSalary;
        }

        const actorObjectId = actorId ? toObjectId(actorId) : undefined;
        const updatedRecord = await this.recalculateSalaryFromAdjustments(record, actorObjectId);

        if (updateDto.baseSalary !== undefined) {
          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'salary_record',
            entityId: String(updatedRecord._id),
            action: 'salary_record.base_updated',
            actorId: actorId || this.getObjectIdString(updatedRecord.teamMemberId),
            actorNameSnapshot: actorId ? undefined : 'System',
            salaryId: String(updatedRecord._id),
            teamMemberId: this.getObjectIdString(updatedRecord.teamMemberId),
            month: updatedRecord.month,
            year: updatedRecord.year,
            before: beforeSnapshot,
            after: {
              baseSalary: updatedRecord.baseSalary,
              netSalary: updatedRecord.netSalary,
            },
            meta: actorId ? undefined : { actorSource: 'system_fallback' },
          });

          if (actorId) {
            this.postHog.capture({
              distinctId: actorId,
              event: 'salary.record_updated',
              properties: {
                workspaceId,
                salaryId: String(updatedRecord._id),
                teamMemberId: this.getObjectIdString(updatedRecord.teamMemberId),
                month: updatedRecord.month,
                year: updatedRecord.year,
                baseSalaryChanged: true,
              },
            });
          }
        }

        return updatedRecord;
      },
    );
  }

  async ensureSingleEmployeeRecord(
    workspaceId: string,
    teamMemberId: string,
    month: number,
    year: number,
    userId?: Types.ObjectId,
  ): Promise<Salary> {
    return this.ensureSalaryRecord(workspaceId, teamMemberId, month, year, userId);
  }

  async setBasePay(
    workspaceId: string,
    teamMemberId: string,
    salaryConfig: SetBasePaySalaryConfig,
    salaryRecordUpdate?: SetBasePaySalaryRecordUpdate,
    userId?: Types.ObjectId,
  ) {
    return this.withSalarySpan(
      'salary.setBasePay',
      {
        workspaceId,
        teamMemberId,
        salaryType: salaryConfig.salaryType,
        ...(userId ? { userId: String(userId) } : {}),
      },
      async () => {
        const workspaceObjectId = toObjectId(workspaceId);
        const teamMemberObjectId = toObjectId(teamMemberId);

        // LOW-3 invariant: every HTTP write path passes the resolved actor
        // (req.user.sub) into setBasePay, so the SoD self-edit guard always runs
        // for a real user. Actor-less calls are internal/system only (onboarding
        // seeders, system fallbacks) and have no "self" to protect, so skipping
        // SoD here is correct. The offboard guard below runs regardless.
        if (userId) {
          await this.assertNotSelfSalaryEdit(workspaceId, String(userId), teamMemberId);
        }
        // OQ-S5: cannot set base pay on a removed member.
        await this.assertMemberWritableForSalary(workspaceId, teamMemberId);

        if (salaryConfig.salaryType === 'hourly') {
          await this.assertFeatureEnabled(workspaceId, 'hourlySalary', 'Hourly salary');
        }
        if (
          salaryConfig.salaryType === 'monthly' &&
          ((salaryConfig.ctcAmount ?? 0) > 0 ||
            !!salaryConfig.componentTemplateId ||
            (salaryConfig.componentOverrides?.length ?? 0) > 0)
        ) {
          await this.assertFeatureEnabled(workspaceId, 'salaryComponents', 'Salary components');
        }

        // Canonical storage: when a salary mode is saved, fields that belong to the
        // inactive mode are cleared instead of being preserved as hidden history.
        const memberSetPayload: {
          salaryAmount: number;
          salaryType: 'monthly' | 'hourly';
          salaryDayBasis: SalaryDayBasis;
          attendancePayMode: AttendancePayMode;
          preferredMethod?: 'BANK' | 'UPI';
          upiDetails?: TeamMember['upiDetails'];
          bankDetails?: TeamMember['bankDetails'];
          fixedMonthDays?: number;
          dailyHours?: number;
          finalMonthlyOverride?: number;
          workingDays?: number;
          ctcAmount?: number;
          componentTemplateId?: Types.ObjectId;
          componentOverrides?: TeamMember['componentOverrides'];
        } = {
          salaryAmount: salaryConfig.salaryAmount,
          salaryType: salaryConfig.salaryType,
          salaryDayBasis: salaryConfig.salaryDayBasis,
          attendancePayMode: salaryConfig.attendancePayMode,
        };
        const memberUnsetPayload: Record<string, 1> = {};

        if (salaryConfig.preferredMethod) {
          memberSetPayload.preferredMethod = salaryConfig.preferredMethod;
        }
        if (salaryConfig.upiDetails) {
          memberSetPayload.upiDetails = salaryConfig.upiDetails;
        }
        if (salaryConfig.bankDetails) {
          memberSetPayload.bankDetails = salaryConfig.bankDetails;
        }

        if (salaryConfig.salaryType === 'hourly') {
          if (salaryConfig.finalMonthlyOverride !== undefined) {
            if (
              salaryConfig.finalMonthlyOverride === null ||
              salaryConfig.finalMonthlyOverride === undefined
            ) {
              memberUnsetPayload.finalMonthlyOverride = 1;
            } else {
              (
                memberSetPayload as typeof memberSetPayload & {
                  finalMonthlyOverride?: number;
                }
              ).finalMonthlyOverride = salaryConfig.finalMonthlyOverride;
            }
          } else {
            memberUnsetPayload.finalMonthlyOverride = 1;
          }

          if (salaryConfig.dailyHours !== undefined) {
            memberSetPayload.dailyHours = salaryConfig.dailyHours;
          } else {
            memberUnsetPayload.dailyHours = 1;
          }

          if (salaryConfig.salaryDayBasis === 'fixed_month_days') {
            if (salaryConfig.fixedMonthDays !== undefined && salaryConfig.fixedMonthDays !== null) {
              memberSetPayload.fixedMonthDays = salaryConfig.fixedMonthDays;
              // Legacy compatibility for still-reading clients while salary module
              // fully transitions to fixedMonthDays.
              memberSetPayload.workingDays = salaryConfig.fixedMonthDays;
            }
          } else {
            memberUnsetPayload.fixedMonthDays = 1;
            memberUnsetPayload.workingDays = 1;
          }

          memberUnsetPayload.ctcAmount = 1;
          memberUnsetPayload.componentTemplateId = 1;
          memberSetPayload.componentOverrides = [];
        } else {
          memberUnsetPayload.dailyHours = 1;
          memberUnsetPayload.workingDays = 1;
          memberUnsetPayload.finalMonthlyOverride = 1;
          if (salaryConfig.salaryDayBasis === 'fixed_month_days') {
            if (salaryConfig.fixedMonthDays !== undefined && salaryConfig.fixedMonthDays !== null) {
              memberSetPayload.fixedMonthDays = salaryConfig.fixedMonthDays;
            }
          } else {
            memberUnsetPayload.fixedMonthDays = 1;
          }

          if (salaryConfig.ctcAmount !== undefined && salaryConfig.ctcAmount !== null) {
            memberSetPayload.ctcAmount = salaryConfig.ctcAmount;
          } else {
            memberUnsetPayload.ctcAmount = 1;
          }

          if (salaryConfig.componentTemplateId) {
            memberSetPayload.componentTemplateId = toObjectId(salaryConfig.componentTemplateId);
          } else {
            memberUnsetPayload.componentTemplateId = 1;
          }

          memberSetPayload.componentOverrides = salaryConfig.componentOverrides ?? [];
        }

        const memberUpdateOperation: {
          $set: typeof memberSetPayload;
          $unset?: Record<string, 1>;
        } = {
          $set: memberSetPayload,
        };
        if (Object.keys(memberUnsetPayload).length > 0) {
          memberUpdateOperation.$unset = memberUnsetPayload;
        }

        const member = await this.teamModel
          .findOneAndUpdate(
            { _id: teamMemberObjectId, workspaceId: workspaceObjectId },
            memberUpdateOperation,
            { new: true },
          )
          .exec();

        if (!member) {
          throw new NotFoundException('Team member not found');
        }

        let salaryRecord: Salary | null = null;
        if (salaryRecordUpdate?.salaryId) {
          await this.assertNotLocked(toObjectId(salaryRecordUpdate.salaryId));

          salaryRecord = await this.salaryModel
            .findOne({
              _id: toObjectId(salaryRecordUpdate.salaryId),
              workspaceId: workspaceObjectId,
            })
            .exec();

          if (salaryRecord) {
            const rebuiltRecordData = await this.buildSalaryRecordData(
              workspaceId,
              teamMemberObjectId,
              salaryRecord.month,
              salaryRecord.year,
              salaryRecord.additions ?? 0,
              salaryRecord.deductions ?? 0,
            );
            salaryRecord.baseSalary = rebuiltRecordData.baseSalary;
            salaryRecord.totalDays = rebuiltRecordData.totalDays;
            salaryRecord.presentDays = rebuiltRecordData.presentDays;
            salaryRecord.salaryType = rebuiltRecordData.salaryType;
            salaryRecord.salaryDayBasis = rebuiltRecordData.salaryDayBasis;
            salaryRecord.fixedMonthDays = rebuiltRecordData.fixedMonthDays;
            salaryRecord.attendancePayModeApplied = rebuiltRecordData.attendancePayModeApplied;
            if (userId) {
              salaryRecord.updatedBy = userId;
            }
            salaryRecord.netSalary = rebuiltRecordData.netSalary;
            await salaryRecord.save();
            salaryRecord = await this.syncSalaryStatus(salaryRecord);
          }
        }

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'team_member',
          entityId: teamMemberId,
          action: 'salary_record.base_pay_set',
          actorId: userId ? String(userId) : teamMemberId,
          actorNameSnapshot: userId ? undefined : 'System',
          teamMemberId,
          after: {
            salaryType: salaryConfig.salaryType,
            salaryAmount: salaryConfig.salaryAmount,
            salaryDayBasis: salaryConfig.salaryDayBasis,
            attendancePayMode: salaryConfig.attendancePayMode,
          },
        });

        if (userId) {
          this.postHog.capture({
            distinctId: String(userId),
            event: 'salary.base_pay_set',
            properties: {
              workspaceId,
              teamMemberId,
              salaryType: salaryConfig.salaryType,
              salaryDayBasis: salaryConfig.salaryDayBasis,
              attendancePayMode: salaryConfig.attendancePayMode,
              salaryRecordUpdated: !!salaryRecordUpdate?.salaryId,
            },
          });
        }

        return { member, salaryRecord };
      },
    );
  }

  async lockSalaryRecord(
    workspaceId: string,
    salaryId: string,
    userId: Types.ObjectId,
  ): Promise<Salary> {
    return this.withSalarySpan(
      'salary.lockRecord',
      { workspaceId, salaryId, userId: String(userId) },
      async () => {
        const record = await this.salaryModel
          .findOne({
            _id: toObjectId(salaryId),
            workspaceId: toObjectId(workspaceId),
          })
          .exec();

        if (!record) throw new NotFoundException('Salary record not found');
        if (record.isLocked) {
          throw new BadRequestException('Record is already locked');
        }
        // OQ-S2: a non-owner cannot lock their own salary record (SoD). OQ-S5
        // carve-out: the final-month lock is part of offboarding, so a removed
        // member's record stays lockable by HR/Owner (allowOffboarded).
        await this.assertNotSelfSalaryEdit(
          workspaceId,
          String(userId),
          this.getObjectIdString(record.teamMemberId),
        );
        await this.assertMemberWritableForSalary(
          workspaceId,
          this.getObjectIdString(record.teamMemberId),
          { allowOffboarded: true },
        );

        // Phase 23 (D-08 / RESEARCH §9): for piece-rate workers, run a final
        // recompute (piece earnings + statutory deductions on fresh wages) BEFORE
        // flipping isLocked, so the snapshot persisted post-lock is correct.
        const member = await this.teamModel.findById(record.teamMemberId).exec();
        if (member && (member as any).salaryType === 'piece_rate') {
          await this.recomputePieceRateForSalary(record, member, userId);
        }

        // CR-02: lock-state re-check before flipping isLocked.
        // recomputePieceRateForSalary above performs async work (compute + save +
        // applyStatutoryDeductions) — during that window a concurrent lock on the
        // same salary row could have flipped isLocked. Without this check we'd
        // silently overwrite the prior lock metadata (lockedBy/lockedAt).
        //
        // Acceptable non-transactional gap because:
        //   (a) lock is a rare admin operation;
        //   (b) re-read narrows the race window to milliseconds;
        //   (c) applyStatutoryDeductions writes are idempotent within the same
        //       record so the recompute itself is safe to have happened.
        const fresh = await this.salaryModel.findById(record._id).select('isLocked').lean();
        if (fresh?.isLocked) {
          throw new ConflictException({ code: 'SALARY_ALREADY_LOCKED' });
        }

        record.isLocked = true;
        record.lockedBy = userId;
        record.lockedAt = new Date();
        record.updatedBy = userId;
        await record.save();

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'salary_record',
          entityId: salaryId,
          action: 'salary_record.locked',
          actorId: String(userId),
          salaryId,
          teamMemberId: this.getObjectIdString(record.teamMemberId),
          month: record.month,
          year: record.year,
          after: { isLocked: true, lockedAt: record.lockedAt },
        });

        this.postHog.capture({
          distinctId: String(userId),
          event: 'salary.record_locked',
          properties: {
            workspaceId,
            salaryId,
            teamMemberId: this.getObjectIdString(record.teamMemberId),
            month: record.month,
            year: record.year,
          },
        });

        return record;
      },
    );
  }

  /**
   * Phase 23 (D-08 / RESEARCH §9) — final piece-rate recompute prior to lock.
   *
   * Refreshes pieceRateEarnings + snapshot + breakdown from current
   * ProductionLog rows, then re-applies statutory deductions so PF / ESI
   * recompute against the updated wages (D-09).
   */
  async recomputePieceRateForSalary(
    record: Salary,
    member: TeamMember,
    userId: Types.ObjectId,
  ): Promise<void> {
    const data = await this.computePieceRateEarnings(
      String((record as any).workspaceId),
      String((record as any).teamMemberId),
      record.month,
      record.year,
      member,
    );
    (record as any).pieceRateEarnings = data.pieceEarnings;
    (record as any).pieceRateConfigSnapshot = data.snapshot;
    (record as any).pieceRateBreakdown = data.breakdown;
    (record as any).pieceRateStale = false;
    (record as any).updatedBy = userId;
    await record.save();

    const config = await this.getPayrollConfig(String(record.workspaceId));
    await this.applyStatutoryDeductions(String(record.workspaceId), record, member, config);
  }

  async unlockSalaryRecord(
    workspaceId: string,
    salaryId: string,
    userId: Types.ObjectId,
  ): Promise<Salary> {
    return this.withSalarySpan(
      'salary.unlockRecord',
      { workspaceId, salaryId, userId: String(userId) },
      async () => {
        const record = await this.salaryModel
          .findOne({
            _id: toObjectId(salaryId),
            workspaceId: toObjectId(workspaceId),
          })
          .exec();

        if (!record) throw new NotFoundException('Salary record not found');
        if (!record.isLocked) {
          throw new BadRequestException('Record is not locked');
        }
        // OQ-S2: SoD self-edit block. OQ-S5 carve-out: unlock stays available to
        // HR/Owner on a removed member (final-month correction is offboarding).
        await this.assertNotSelfSalaryEdit(
          workspaceId,
          String(userId),
          this.getObjectIdString(record.teamMemberId),
        );
        await this.assertMemberWritableForSalary(
          workspaceId,
          this.getObjectIdString(record.teamMemberId),
          { allowOffboarded: true },
        );

        record.isLocked = false;
        record.lockedBy = undefined;
        record.lockedAt = undefined;
        record.updatedBy = userId;
        await record.save();

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'salary_record',
          entityId: salaryId,
          action: 'salary_record.unlocked',
          actorId: String(userId),
          salaryId,
          teamMemberId: this.getObjectIdString(record.teamMemberId),
          month: record.month,
          year: record.year,
          after: { isLocked: false },
        });

        this.postHog.capture({
          distinctId: String(userId),
          event: 'salary.record_unlocked',
          properties: {
            workspaceId,
            salaryId,
            teamMemberId: this.getObjectIdString(record.teamMemberId),
            month: record.month,
            year: record.year,
          },
        });

        return record;
      },
    );
  }

  async createAdjustment(
    workspaceId: string,
    salaryId: string,
    userId: string,
    dto: CreateSalaryAdjustmentDto,
  ) {
    return this.withSalarySpan(
      'salary.createAdjustment',
      { workspaceId, salaryId, userId, adjustmentType: dto.type },
      async () => {
        await this.assertFeatureEnabled(workspaceId, 'adjustments', 'Salary adjustments');

        const workspaceObjectId = toObjectId(workspaceId);
        const salary = await this.salaryModel
          .findOne({
            _id: toObjectId(salaryId),
            workspaceId: workspaceObjectId,
          })
          .exec();

        if (!salary) {
          throw new NotFoundException('Salary record not found');
        }
        await this.assertNotLocked(salaryId);

        await this.assertNotSelfSalaryEdit(
          workspaceId,
          userId,
          this.getObjectIdString(salary.teamMemberId),
        );
        // OQ-S5: no new adjustments on a removed member (F&F only).
        await this.assertMemberWritableForSalary(
          workspaceId,
          this.getObjectIdString(salary.teamMemberId),
        );

        this.validateAdjustmentCategory(dto.type, dto.category);

        let correctionSource: SalaryAdjustment | null = null;
        if (dto.correctionOfAdjustmentId) {
          correctionSource = await this.salaryAdjustmentModel
            .findOne({
              _id: toObjectId(dto.correctionOfAdjustmentId),
              workspaceId: workspaceObjectId,
            })
            .exec();

          if (!correctionSource) {
            throw new NotFoundException('Source salary adjustment not found');
          }

          if (
            this.getObjectIdString(correctionSource.salaryId) !== this.getObjectIdString(salary._id)
          ) {
            throw new BadRequestException(
              'Correction source must belong to the same salary record',
            );
          }

          if (correctionSource.status !== 'reversed') {
            throw new BadRequestException(
              'Only reversed adjustments can be corrected with a new entry',
            );
          }
        }

        const adjustment = new this.salaryAdjustmentModel({
          workspaceId: workspaceObjectId,
          salaryId: toObjectId(String(salary._id)),
          teamMemberId:
            salary.teamMemberId instanceof Types.ObjectId
              ? salary.teamMemberId
              : toObjectId(
                  typeof salary.teamMemberId === 'string'
                    ? salary.teamMemberId
                    : this.getObjectIdString(salary.teamMemberId),
                ),
          month: salary.month,
          year: salary.year,
          type: dto.type,
          category: dto.category,
          amount: dto.amount,
          correctionOfAdjustmentId: correctionSource?._id,
          reasonTitle: dto.reasonTitle.trim(),
          note: dto.note?.trim() || undefined,
          attachments: dto.attachments ?? [],
          status: 'active',
          createdBy: toObjectId(userId),
        });

        await adjustment.save();
        await this.recalculateSalaryFromAdjustments(salary, toObjectId(userId));

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'salary_adjustment',
          entityId: String(adjustment._id),
          action: 'salary_adjustment.created',
          actorId: userId,
          salaryId: this.getObjectIdString(adjustment.salaryId),
          teamMemberId: this.getObjectIdString(adjustment.teamMemberId),
          month: adjustment.month,
          year: adjustment.year,
          after: this.buildAdjustmentAuditSnapshot(adjustment),
          meta: correctionSource
            ? {
                correctionOfAdjustmentId: String(correctionSource._id),
                correctionSourceStatus: correctionSource.status,
              }
            : undefined,
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.adjustment_created',
          properties: {
            workspaceId,
            salaryId: this.getObjectIdString(adjustment.salaryId),
            teamMemberId: this.getObjectIdString(adjustment.teamMemberId),
            month: adjustment.month,
            year: adjustment.year,
            adjustmentType: dto.type,
            adjustmentCategory: dto.category,
            amount: dto.amount,
            isCorrection: !!correctionSource,
          },
        });

        return this.salaryAdjustmentModel
          .findById(adjustment._id)
          .populate('createdBy', 'name email')
          .populate('reversedBy', 'name email')
          .populate('correctionOfAdjustmentId', 'reasonTitle amount type category status')
          .exec();
      },
    );
  }

  async listAdjustmentsForSalary(workspaceId: string, salaryId: string) {
    const salary = await this.salaryModel
      .findOne({
        _id: toObjectId(salaryId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!salary) {
      throw new NotFoundException('Salary record not found');
    }

    return this.salaryAdjustmentModel
      .find({
        workspaceId: toObjectId(workspaceId),
        salaryId: toObjectId(salaryId),
      })
      .populate('createdBy', 'name email')
      .populate('reversedBy', 'name email')
      .populate('correctionOfAdjustmentId', 'reasonTitle amount type category status')
      .sort({ createdAt: -1 })
      .exec();
  }

  async getAdjustmentAuditTrail(workspaceId: string, adjustmentId: string) {
    const adjustment = await this.salaryAdjustmentModel
      .findOne({
        _id: toObjectId(adjustmentId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!adjustment) {
      throw new NotFoundException('Salary adjustment not found');
    }

    return this.auditService.listEntityEvents(workspaceId, 'salary_adjustment', adjustmentId);
  }

  async reverseAdjustment(
    workspaceId: string,
    adjustmentId: string,
    userId: string,
    dto: ReverseSalaryAdjustmentDto,
  ) {
    return this.withSalarySpan(
      'salary.reverseAdjustment',
      { workspaceId, adjustmentId, userId },
      async () => {
        await this.assertFeatureEnabled(workspaceId, 'adjustments', 'Salary adjustments');

        const workspaceObjectId = toObjectId(workspaceId);
        const adjustment = await this.salaryAdjustmentModel
          .findOne({
            _id: toObjectId(adjustmentId),
            workspaceId: workspaceObjectId,
          })
          .exec();

        if (!adjustment) {
          throw new NotFoundException('Salary adjustment not found');
        }
        await this.assertNotLocked(this.getObjectIdString(adjustment.salaryId));
        // OQ-S2 / OQ-S5: a non-owner cannot reverse their own adjustment, and a
        // removed member's adjustments are read-only.
        await this.assertNotSelfSalaryEdit(
          workspaceId,
          userId,
          this.getObjectIdString(adjustment.teamMemberId),
        );
        await this.assertMemberWritableForSalary(
          workspaceId,
          this.getObjectIdString(adjustment.teamMemberId),
        );

        if (adjustment.status === 'reversed') {
          throw new BadRequestException('Salary adjustment is already reversed');
        }

        if (adjustment.source === 'payment_recording' || adjustment.source === 'system') {
          throw new BadRequestException(
            'This adjustment was auto-generated by a payment or system action. To reverse it, reverse the linked payment instead.',
          );
        }

        const beforeSnapshot = this.buildAdjustmentAuditSnapshot(adjustment);
        adjustment.status = 'reversed';
        adjustment.reversedBy = toObjectId(userId);
        adjustment.reversedAt = new Date();
        adjustment.reversalReason = dto.reversalReason.trim();
        await adjustment.save();

        const salary = await this.salaryModel
          .findOne({
            _id:
              adjustment.salaryId instanceof Types.ObjectId
                ? adjustment.salaryId
                : toObjectId(this.getObjectIdString(adjustment.salaryId)),
            workspaceId: workspaceObjectId,
          })
          .exec();

        if (!salary) {
          throw new NotFoundException('Salary record not found');
        }

        await this.recalculateSalaryFromAdjustments(salary, toObjectId(userId));

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'salary_adjustment',
          entityId: String(adjustment._id),
          action: 'salary_adjustment.reversed',
          actorId: userId,
          salaryId: this.getObjectIdString(adjustment.salaryId),
          teamMemberId: this.getObjectIdString(adjustment.teamMemberId),
          month: adjustment.month,
          year: adjustment.year,
          before: beforeSnapshot,
          after: this.buildAdjustmentAuditSnapshot(adjustment),
          reason: adjustment.reversalReason,
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.adjustment_reversed',
          properties: {
            workspaceId,
            adjustmentId,
            salaryId: this.getObjectIdString(adjustment.salaryId),
            teamMemberId: this.getObjectIdString(adjustment.teamMemberId),
            month: adjustment.month,
            year: adjustment.year,
            adjustmentType: adjustment.type,
            adjustmentCategory: adjustment.category,
            amount: adjustment.amount,
          },
        });

        return this.salaryAdjustmentModel
          .findById(adjustment._id)
          .populate('createdBy', 'name email')
          .populate('reversedBy', 'name email')
          .populate('correctionOfAdjustmentId', 'reasonTitle amount type category status')
          .exec();
      },
    );
  }

  /**
   * Approve + disburse a worker self-service advance request in one step, then
   * start interest-free installment recovery. This is the wiring that closes the
   * previously-dead loop (markPaid had zero callers, so an approved request never
   * disbursed). Flow:
   *   1. load the request (idempotency: an already-paid request is a no-op);
   *   2. approve it (pending -> approved) via AdvanceSalaryRequestService;
   *   3. record an isAdvance Payment, linked back via advanceRequestId (reused on retry);
   *   4. post the finance ledger entry (non-blocking, mirrors recordPayment);
   *   5. create the multi-installment AdvanceRecoveryPlan (or a single lump
   *      deduction) starting the month AFTER the request month by default;
   *   6. markPaid (approved -> paid) stamping the payment id.
   * Always interest-free (no rate anywhere) — interest-bearing lending is the
   * separate EmployerLoan tool. The disbursed advance then flows into
   * getOutstandingAdvances + FnF with no further change.
   * Links: advance-salary-request.controller.ts (approve route),
   * advance-salary-request.service.ts (approve/markPaid), createAdvanceRecoveryPlan.
   */
  async approveAndDisburseAdvanceRequest(
    workspaceId: string,
    requestId: string,
    reviewerUserId: string,
    dto: {
      approvedAmount: number;
      reviewNote?: string;
      installmentCount?: number;
      installmentAmount?: number;
      startMonth?: number;
      startYear?: number;
      paymentMode?: string;
      coaAccountId?: string;
      overrideCompliance?: boolean;
      overrideReason?: string;
    },
  ): Promise<{
    request: AdvanceSalaryRequest;
    payment: Payment | null;
    plan: AdvanceRecoveryPlanDocument | null;
    complianceWarnings: ComplianceWarning[];
    alreadyDisbursed: boolean;
  }> {
    return this.withSalarySpan(
      'salary.approveAndDisburseAdvanceRequest',
      { workspaceId, requestId, reviewerUserId },
      async () => {
        const workspaceObjectId = toObjectId(workspaceId);
        const userObjectId = toObjectId(reviewerUserId);
        const requestObjectId = toObjectId(requestId);

        // 1. Load the request. Idempotency: an already-disbursed request is a no-op.
        const existing = await this.advanceSalaryRequestModel
          .findOne({ _id: requestObjectId, workspaceId: workspaceObjectId })
          .exec();
        if (!existing) {
          throw new NotFoundException('Advance request not found.');
        }
        // OQ-S2: a non-owner cannot approve/disburse their OWN advance (SoD).
        // OQ-S5: a removed member cannot be disbursed a new advance.
        await this.assertNotSelfSalaryEdit(
          workspaceId,
          reviewerUserId,
          this.getObjectIdString(existing.teamMemberId),
        );
        await this.assertMemberWritableForSalary(
          workspaceId,
          this.getObjectIdString(existing.teamMemberId),
        );
        if (existing.status === 'paid' && existing.paymentId) {
          const existingPayment = await this.paymentModel.findById(existing.paymentId).exec();
          return {
            request: existing,
            payment: existingPayment,
            plan: null,
            complianceWarnings: [],
            alreadyDisbursed: true,
          };
        }

        // 2. Approve (pending -> approved). An already-approved request (e.g. a
        // retry after a mid-flight failure) skips straight to disburse.
        let request: AdvanceSalaryRequest;
        if (existing.status === 'pending') {
          request = await this.advanceSalaryRequestService.approve(
            workspaceId,
            requestId,
            reviewerUserId,
            { approvedAmount: dto.approvedAmount, reviewNote: dto.reviewNote },
          );
        } else if (existing.status === 'approved') {
          request = existing;
        } else {
          throw new BadRequestException({
            code: 'ADVANCE_NOT_PENDING',
            message: `Cannot disburse an advance request with status '${existing.status}'.`,
          });
        }

        // request.approvedAmount + dto.approvedAmount are PAISE (request entity
        // convention - see AdvanceSalaryRequest schema + ApproveAdvanceRequestDto).
        // The salary Payment + recovery deductions are RUPEES, so convert once here
        // (mirrors payApprovedAdvance); using paise as rupees would 100x the payout.
        const approvedAmountPaise = request.approvedAmount ?? dto.approvedAmount;
        const approvedAmount = this.roundCurrency((approvedAmountPaise ?? 0) / 100);
        if (approvedAmount <= 0) {
          throw new BadRequestException('Approved advance amount must be greater than zero.');
        }
        const memberObjectId =
          request.teamMemberId instanceof Types.ObjectId
            ? request.teamMemberId
            : toObjectId(String(request.teamMemberId));

        // Idempotency belt-and-suspenders: reuse any existing active advance
        // Payment already created for this request rather than creating a second.
        const priorPayment = await this.paymentModel
          .findOne({ advanceRequestId: requestObjectId, status: 'active' })
          .exec();
        if (priorPayment) {
          if (request.status !== 'paid') {
            await this.advanceSalaryRequestService.markPaid(
              workspaceId,
              requestId,
              String(priorPayment._id),
            );
          }
          return {
            request,
            payment: priorPayment,
            plan: null,
            complianceWarnings: [],
            alreadyDisbursed: true,
          };
        }

        // 3. Resolve the disbursement-month salary record and the recovery start
        // month (defaults to the month AFTER the request month — a grace cycle,
        // per industry norm: GreytHR/Keka recovery starts the following month).
        const ensuredSalary = await this.ensureSalaryRecord(
          workspaceId,
          memberObjectId,
          request.month,
          request.year,
          userObjectId,
        );

        let startMonth = dto.startMonth;
        let startYear = dto.startYear;
        if (!startMonth || !startYear) {
          startMonth = request.month + 1;
          startYear = request.year;
          if (startMonth > 12) {
            startMonth = 1;
            startYear += 1;
          }
        }

        // 4. Record the isAdvance Payment, linked back to the request.
        const payment = new this.paymentModel({
          workspaceId: workspaceObjectId,
          teamMemberId: memberObjectId,
          salaryId: ensuredSalary._id,
          amount: approvedAmount,
          paymentMode: dto.paymentMode ?? 'cash',
          paymentDate: new Date(),
          recordedBy: userObjectId,
          status: 'active',
          isAdvance: true,
          advanceForMonth: startMonth,
          advanceForYear: startYear,
          advanceRequestId: requestObjectId,
        });

        // Advances are exempt from the month-complete/payout-window gate; we call
        // the guard for parity (it short-circuits on isAdvance).
        await this.salaryDisbursementGuardService.assertPaymentAllowed(
          workspaceId,
          request.month,
          request.year,
          { isAdvance: true, isOwner: true },
        );

        await payment.save();

        // 5. Finance ledger posting — non-blocking (mirrors recordPayment so a
        // Finance-side error never rolls back a successful disbursement).
        try {
          const ledgerResult = await this.salaryLedgerPostingService.postAdvancePayment(
            payment,
            request,
            dto.coaAccountId,
            reviewerUserId,
          );
          payment.ledgerPosted = ledgerResult.posted;
          if (!ledgerResult.posted) {
            payment.ledgerSkipReason = ledgerResult.reason;
          }
          await payment.save();
        } catch (postingErr: unknown) {
          const msg = postingErr instanceof Error ? postingErr.message : 'unknown error';
          this.logger.error(
            `Advance disburse ledger posting failed for payment ${String(payment._id)}: ${msg}`,
          );
          payment.ledgerPosted = false;
          payment.ledgerSkipReason = 'post_error';
          await payment.save();
        }

        // 6. Recovery — multi-installment plan, or a single lump deduction.
        let plan: AdvanceRecoveryPlanDocument | null = null;
        let complianceWarnings: ComplianceWarning[] = [];
        // PAYROLL-CRITICAL: capture the explicit-recovery marker so step 7 can
        // stamp it onto the REQUEST — this prevents applyAdvanceAutoDeductions
        // from creating a SECOND recovery for the same advance (double recovery).
        let recoveryPlanId: string | undefined;
        let recoveryAdjustmentId: string | undefined;
        const isMultiInstallment =
          dto.installmentAmount != null ||
          (dto.installmentCount != null && dto.installmentCount > 1);

        if (isMultiInstallment) {
          const res = await this.createAdvanceRecoveryPlan({
            workspaceId,
            teamMemberId: memberObjectId,
            sourcePaymentId: toObjectId(String(payment._id)),
            totalAmount: approvedAmount,
            startMonth,
            startYear,
            installmentConfig: {
              installmentCount: dto.installmentCount,
              // installmentAmount is PAISE on the DTO; the recovery plan is RUPEES.
              installmentAmount:
                dto.installmentAmount != null
                  ? this.roundCurrency(dto.installmentAmount / 100)
                  : undefined,
            },
            userId: userObjectId,
            overrideCompliance: dto.overrideCompliance ?? false,
            overrideReason: dto.overrideReason,
          });
          plan = res.plan;
          complianceWarnings = res.complianceWarnings;
          recoveryPlanId = String(plan._id);
          payment.advanceRecoveryPlanId = toObjectId(String(plan._id));
          await payment.save();
        } else {
          const recoveryAdjustment = await this.createAdvanceRecoveryDeduction({
            workspaceId,
            teamMemberId: memberObjectId,
            targetMonth: startMonth,
            targetYear: startYear,
            amount: approvedAmount,
            sourcePaymentId: toObjectId(String(payment._id)),
            userId: userObjectId,
          });
          if (recoveryAdjustment) {
            recoveryAdjustmentId = String(recoveryAdjustment._id);
            payment.advanceRecoveryAdjustmentId = toObjectId(String(recoveryAdjustment._id));
            await payment.save();
          }
        }

        // 7. Close the loop: approved -> paid, stamping the payment id AND the
        // explicit-recovery marker so the next-month safety net
        // (applyAdvanceAutoDeductions) skips this advance instead of double-recovering it.
        const paidRequest = await this.advanceSalaryRequestService.markPaid(
          workspaceId,
          requestId,
          String(payment._id),
          { recoveryPlanId, recoveryAdjustmentId },
        );

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'advance_request',
          entityId: requestId,
          action: 'advance_request.disbursed',
          actorId: reviewerUserId,
          teamMemberId: String(memberObjectId),
          month: request.month,
          year: request.year,
          after: {
            paymentId: String(payment._id),
            amount: approvedAmount,
            planId: plan ? String(plan._id) : undefined,
            installmentCount: dto.installmentCount,
            startMonth,
            startYear,
          },
        });

        this.postHog.capture({
          event: 'salary.advance_disbursed',
          distinctId: reviewerUserId,
          properties: {
            workspaceId,
            requestId,
            paymentId: String(payment._id),
            amount: approvedAmount,
            installmentCount: dto.installmentCount ?? 1,
            hasPlan: plan != null,
          },
        });

        // Step 6: best-effort "advance approved" worker notification. The helper
        // lives on AdvanceSalaryRequestService (which owns the NotificationsService
        // + member lookup) so SalaryService's constructor stays untouched.
        // Non-blocking — a notification failure must never roll back a successful
        // disbursement (mirrors the ledger-posting non-blocking guard above).
        try {
          await this.advanceSalaryRequestService.notifyAdvanceDisbursed(
            workspaceId,
            paidRequest,
            reviewerUserId,
          );
        } catch (notifyErr: unknown) {
          const msg = notifyErr instanceof Error ? notifyErr.message : 'unknown error';
          this.logger.warn(`Advance disburse notification failed for request ${requestId}: ${msg}`);
        }

        return {
          request: paidRequest,
          payment,
          plan,
          complianceWarnings,
          alreadyDisbursed: false,
        };
      },
    );
  }

  /**
   * Pay an owner-APPROVED advance salary request (the request→approve→PAY→ledger
   * path; previously markPaid was never wired so approved requests could never be
   * paid). Records the cash/bank Payment and posts the finance journal
   * (Dr 1014 Salary Advance / Cr cash-bank), then flips the request to 'paid' so
   * the NEXT month's salary auto-recovers it via applyAdvanceAutoDeductions.
   *
   * Money units: request.approvedAmount is PAISE (request entity convention);
   * the salary Payment is RUPEES. Convert once here. The amount is taken from the
   * approved request, never from the client, so the payout cannot exceed approval.
   */
  async payApprovedAdvance(
    workspaceId: string,
    userId: string,
    requestId: string,
    dto: PayAdvanceRequestDto,
  ) {
    const workspaceObjectId = toObjectId(workspaceId);
    const userObjectId = toObjectId(userId);

    const request = await this.advanceSalaryRequestModel
      .findOne({ _id: toObjectId(requestId), workspaceId: workspaceObjectId })
      .exec();
    if (!request) {
      throw new NotFoundException('Advance request not found.');
    }
    // OQ-S2 / OQ-S5: a non-owner cannot pay out their own advance, and a removed
    // member cannot be paid a new advance.
    await this.assertNotSelfSalaryEdit(
      workspaceId,
      userId,
      this.getObjectIdString(request.teamMemberId),
    );
    await this.assertMemberWritableForSalary(
      workspaceId,
      this.getObjectIdString(request.teamMemberId),
    );
    if (request.status !== 'approved') {
      throw new BadRequestException({
        code: 'ADVANCE_NOT_APPROVED',
        message: `Cannot pay an advance request with status '${request.status}'.`,
      });
    }

    // PAISE → RUPEES boundary (see method doc). approvedAmount is set at approval.
    const amountRupees = this.roundCurrency((request.approvedAmount ?? 0) / 100);
    if (amountRupees <= 0) {
      throw new BadRequestException('Approved advance amount must be greater than zero.');
    }

    // Phase 1b: a split disbursement requires the splitPayments feature, exactly
    // like recordPayment (salary.service.ts ~7031). Gate BEFORE writing anything.
    if (dto.paymentMode === 'split' || (dto.splitLines && dto.splitLines.length > 0)) {
      await this.assertFeatureEnabled(workspaceId, 'splitPayments', 'Split payments');
    }

    const teamMemberObjectId =
      request.teamMemberId instanceof Types.ObjectId
        ? request.teamMemberId
        : toObjectId(String(request.teamMemberId));

    // Recovery start month — defaults to the month AFTER the request month (a grace
    // cycle, per industry norm), mirroring approveAndDisburseAdvanceRequest. The
    // caller may override via startMonth/startYear.
    let startMonth = dto.startMonth;
    let startYear = dto.startYear;
    if (!startMonth || !startYear) {
      startMonth = request.month + 1;
      startYear = request.year;
      if (startMonth > 12) {
        startMonth = 1;
        startYear += 1;
      }
    }

    // Payment.salaryId is required; ensure the salary record for the request's
    // month/year exists. Recovery happens from SUBSEQUENT months once status='paid'
    // (applyAdvanceAutoDeductions), so we don't deduct from this salary here.
    const salary = await this.ensureSalaryRecord(
      workspaceId,
      String(teamMemberObjectId),
      request.month,
      request.year,
      userObjectId,
    );

    const paymentData: Record<string, any> = {
      workspaceId: workspaceObjectId,
      teamMemberId: teamMemberObjectId,
      salaryId: toObjectId(String(salary._id)),
      amount: amountRupees,
      paymentMode: dto.paymentMode ?? 'cash',
      paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
      recordedBy: userObjectId,
      status: 'active',
      isAdvance: true,
      // Link the recovery start month/year onto the Payment so the advance and its
      // recovery stay consistent with the combined method (which uses startMonth/Year).
      advanceForMonth: startMonth,
      advanceForYear: startYear,
      advanceRequestId: toObjectId(requestId),
    };
    if (dto.note) paymentData.note = dto.note;
    if (dto.referenceNo) paymentData.referenceNo = dto.referenceNo;
    // disbursedByName is the WHO-handed-over (anti-fraud); persisted via Payment.paidBy.
    // An explicit paidBy still wins if both are sent (legacy callers).
    if (dto.paidBy) paymentData.paidBy = dto.paidBy;
    else if (dto.disbursedByName) paymentData.paidBy = dto.disbursedByName;
    if (dto.proofUrls && dto.proofUrls.length > 0) paymentData.proofUrls = dto.proofUrls;
    if (dto.splitLines && dto.splitLines.length > 0) paymentData.splitLines = dto.splitLines;

    const payment = new this.paymentModel(paymentData);
    await payment.save();

    // Finance ledger posting (non-blocking; mirrors recordPayment's D-06/D-07
    // contract — a Finance-side error never rolls back the payout).
    try {
      const ledgerResult = await this.salaryLedgerPostingService.postAdvancePayment(
        payment,
        request,
        dto.coaAccountId,
        userId,
      );
      payment.ledgerPosted = ledgerResult.posted;
      if (!ledgerResult.posted) {
        payment.ledgerSkipReason = ledgerResult.reason;
      }
      await payment.save();
    } catch (postingErr: unknown) {
      const msg = postingErr instanceof Error ? postingErr.message : 'unknown error';
      this.logger.error(
        `Advance-request ledger posting failed for payment ${String(payment._id)}: ${msg}`,
      );
      payment.ledgerPosted = false;
      payment.ledgerSkipReason = 'post_error';
      await payment.save();
    }

    // ─── Recovery — multi-installment plan, or a single lump deduction ──────────
    // Phase 1b: recovery is created HERE on disburse (was created at approve in the
    // legacy combined approveAndDisburseAdvanceRequest). The biggest regression risk
    // is losing recovery, so this block mirrors the combined method exactly: an
    // installment plan when count > 1 (or a fixed installmentAmount), else a single
    // deduction in the start month. Amounts are RUPEES (installmentAmount on the DTO
    // is PAISE — convert, like the combined method).
    let plan: AdvanceRecoveryPlanDocument | null = null;
    let complianceWarnings: ComplianceWarning[] = [];
    // PAYROLL-CRITICAL: capture the explicit-recovery marker so we can stamp it
    // onto the REQUEST at markPaid — this is what stops applyAdvanceAutoDeductions
    // from creating a SECOND recovery for the same advance (double recovery).
    let recoveryPlanId: string | undefined;
    let recoveryAdjustmentId: string | undefined;
    let sameMonthRecovery = false;
    const isMultiInstallment =
      dto.installmentAmount != null || (dto.installmentCount != null && dto.installmentCount > 1);

    if (isMultiInstallment) {
      const res = await this.createAdvanceRecoveryPlan({
        workspaceId,
        teamMemberId: teamMemberObjectId,
        sourcePaymentId: toObjectId(String(payment._id)),
        totalAmount: amountRupees,
        startMonth,
        startYear,
        installmentConfig: {
          installmentCount: dto.installmentCount,
          installmentAmount:
            dto.installmentAmount != null
              ? this.roundCurrency(dto.installmentAmount / 100)
              : undefined,
        },
        userId: userObjectId,
        overrideCompliance: dto.overrideCompliance ?? false,
        overrideReason: dto.overrideReason,
      });
      plan = res.plan;
      complianceWarnings = res.complianceWarnings;
      recoveryPlanId = String(plan._id);
      payment.advanceRecoveryPlanId = toObjectId(String(plan._id));
      await payment.save();
    } else if (startMonth === request.month && startYear === request.year) {
      // Same-month settlement (owner model 2026-07-03): the advance is part of
      // THIS month's salary paid early. The Payment above is linked to the
      // request month's salary record and already counts toward its paid
      // amount, so payroll's "remaining" is net-of-advance on salary day.
      // Creating a recovery deduction here TOO would recover the advance twice
      // (once via paid, once via net). markPaid stamps sameMonthRecovery so
      // applyAdvanceAutoDeductions never lump-deducts it in a later month.
      sameMonthRecovery = true;
    } else {
      const recoveryAdjustment = await this.createAdvanceRecoveryDeduction({
        workspaceId,
        teamMemberId: teamMemberObjectId,
        targetMonth: startMonth,
        targetYear: startYear,
        amount: amountRupees,
        sourcePaymentId: toObjectId(String(payment._id)),
        userId: userObjectId,
      });
      if (recoveryAdjustment) {
        recoveryAdjustmentId = String(recoveryAdjustment._id);
        payment.advanceRecoveryAdjustmentId = toObjectId(String(recoveryAdjustment._id));
        await payment.save();
      }
    }

    // Flip request → 'paid', link the payment, and STAMP the explicit-recovery
    // marker so the next-month safety net (applyAdvanceAutoDeductions) skips this
    // advance (it already has a plan/deduction/same-month settlement) instead of
    // double-recovering it.
    const updatedRequest = await this.advanceSalaryRequestService.markPaid(
      workspaceId,
      requestId,
      String(payment._id),
      { recoveryPlanId, recoveryAdjustmentId, sameMonthRecovery },
    );

    // Audit the disbursement (anti-fraud trail: who/amount/recovery terms). Mirrors
    // the combined method's advance_request.disbursed event.
    await this.auditService.logEvent({
      workspaceId,
      module: AppModule.SALARY,
      entityType: 'advance_request',
      entityId: requestId,
      action: 'advance_request.disbursed',
      actorId: userId,
      teamMemberId: String(teamMemberObjectId),
      month: request.month,
      year: request.year,
      after: {
        paymentId: String(payment._id),
        amount: amountRupees,
        planId: plan ? String(plan._id) : undefined,
        installmentCount: dto.installmentCount,
        startMonth,
        startYear,
        paymentMode: paymentData.paymentMode,
        disbursedBy: paymentData.paidBy,
      },
    });

    this.postHog.capture({
      event: 'salary.advance_disbursed',
      distinctId: userId,
      properties: {
        workspaceId,
        requestId,
        paymentId: String(payment._id),
        amount: amountRupees,
        installmentCount: dto.installmentCount ?? 1,
        hasPlan: plan != null,
      },
    });

    // Best-effort "advance disbursed" worker notification. Non-blocking — a
    // notification failure must never roll back a successful disbursement (mirrors
    // the ledger-posting guard above and the combined method).
    try {
      await this.advanceSalaryRequestService.notifyAdvanceDisbursed(
        workspaceId,
        updatedRequest,
        userId,
      );
    } catch (notifyErr: unknown) {
      const msg = notifyErr instanceof Error ? notifyErr.message : 'unknown error';
      this.logger.warn(`Advance disburse notification failed for request ${requestId}: ${msg}`);
    }

    return {
      payment,
      request: updatedRequest,
      plan,
      complianceWarnings,
      ledgerPosted: payment.ledgerPosted,
      ledgerSkipReason: payment.ledgerSkipReason ?? null,
    };
  }

  async recordPayment(
    workspaceId: string,
    userId: string,
    paymentDto: RecordPaymentDto,
    isOwnerOverride?: boolean,
  ) {
    return this.withSalarySpan(
      'salary.recordPayment',
      { workspaceId, userId, paymentMode: paymentDto.paymentMode },
      async () => {
        const workspaceObjectId = toObjectId(workspaceId);
        const userObjectId = toObjectId(userId);
        // Resolve owner status for disbursement gate (D-01 owner-bypass).
        // isOwnerOverride is available for internal callers (crons, bulk); the
        // normal HTTP path leaves it undefined and we derive it from callerScope.
        const callerCtx =
          isOwnerOverride !== undefined
            ? { isOwner: isOwnerOverride }
            : await this.callerScope.resolve(workspaceId, userId);
        const isOwner = callerCtx.isOwner;
        let salary: Salary | null;

        if (paymentDto.salaryId) {
          await this.assertNotLocked(paymentDto.salaryId);
          salary = await this.salaryModel
            .findOne({
              _id: toObjectId(paymentDto.salaryId),
              workspaceId: workspaceObjectId,
            })
            .exec();
        } else if (paymentDto.teamMemberId && paymentDto.month && paymentDto.year) {
          // LOW-1: guard the member BEFORE ensureSalaryRecord — otherwise an
          // orphan salary stub gets written for an offboarded member even though
          // the payment is correctly blocked below. The teamMemberId is the
          // resolved target here, so guard it first; the salaryId branch above
          // guards after resolving the record's teamMemberId.
          await this.assertMemberWritableForSalary(workspaceId, paymentDto.teamMemberId);
          const ensuredSalary = await this.ensureSalaryRecord(
            workspaceId,
            paymentDto.teamMemberId,
            paymentDto.month,
            paymentDto.year,
            userObjectId,
          );
          await this.assertNotLocked(ensuredSalary._id);
          salary = ensuredSalary;
        } else {
          throw new NotFoundException('Salary record not found or could not be generated');
        }

        if (!salary) {
          throw new NotFoundException('Salary record not found or could not be generated');
        }

        await this.assertNotSelfSalaryEdit(
          workspaceId,
          userId,
          this.getObjectIdString(salary.teamMemberId),
        );
        // OQ-S5: a removed member's records are read-only (F&F is the only write).
        await this.assertMemberWritableForSalary(
          workspaceId,
          this.getObjectIdString(salary.teamMemberId),
        );

        if (
          paymentDto.paymentMode === 'split' ||
          (paymentDto.splitLines && paymentDto.splitLines.length > 0)
        ) {
          await this.assertFeatureEnabled(workspaceId, 'splitPayments', 'Split payments');
        }
        if (paymentDto.commission && paymentDto.commission > 0) {
          await this.assertFeatureEnabled(workspaceId, 'commissionTracking', 'Commission tracking');
        }

        if (paymentDto.amount === 0 && (!paymentDto.commission || paymentDto.commission <= 0)) {
          throw new BadRequestException(
            'Payment amount must be greater than zero unless a commission is also being recorded.',
          );
        }

        const salaryObjectId = toObjectId(String(salary._id));
        const settledBeforePayment = await this.sumPaidAmountForSalary(salaryObjectId);
        const outstandingBeforePayment = Math.max(0, salary.netSalary - settledBeforePayment);
        const commissionAmount = Math.max(0, paymentDto.commission ?? 0);
        const excessCurrentMonthAmount = Math.max(0, paymentDto.amount - outstandingBeforePayment);
        const linkedAdjustmentIds: Types.ObjectId[] = [];
        let isAdvancePayment = false;
        let advanceForMonth: number | undefined;
        let advanceForYear: number | undefined;
        let advanceAmount = 0;

        if (commissionAmount > 0) {
          const adjustment = await this.createPaymentLinkedAddition({
            workspaceId,
            salary,
            userId,
            amount: commissionAmount,
            category: 'commission',
            reasonTitle: paymentDto.commissionTitle?.trim() || 'Commission recorded with payment',
            note: paymentDto.commissionNote?.trim() || undefined,
          });
          if (adjustment) {
            linkedAdjustmentIds.push(toObjectId(String(adjustment._id)));
          }
        }

        if (excessCurrentMonthAmount > 0) {
          await this.assertFeatureEnabled(workspaceId, 'advancePayments', 'Advance payments');

          if (paymentDto.advanceTarget === 'next_month') {
            let targetMonth = salary.month + 1;
            let targetYear = salary.year;
            if (targetMonth > 12) {
              targetMonth = 1;
              targetYear += 1;
            }

            isAdvancePayment = true;
            advanceForMonth = targetMonth;
            advanceForYear = targetYear;
            advanceAmount = excessCurrentMonthAmount;
          } else {
            const adjustment = await this.createPaymentLinkedAddition({
              workspaceId,
              salary,
              userId,
              amount: excessCurrentMonthAmount,
              category: 'other',
              reasonTitle: 'Extra payout recorded with payment',
              note: 'System-generated to align payroll payable with a payment recorded above the remaining due amount.',
            });
            if (adjustment) {
              linkedAdjustmentIds.push(toObjectId(String(adjustment._id)));
            }
          }
        }

        if (commissionAmount > 0 || excessCurrentMonthAmount > 0) {
          const refreshedSalary = await this.salaryModel.findById(salaryObjectId).exec();
          if (refreshedSalary) {
            salary = await this.recalculateSalaryFromAdjustments(refreshedSalary, userObjectId);
          }
        }

        const recentDuplicate = await this.paymentModel
          .findOne({
            salaryId: salaryObjectId,
            amount: paymentDto.amount,
            commission: paymentDto.commission ?? 0,
            createdAt: { $gte: new Date(Date.now() - 60_000) },
          })
          .exec();

        if (recentDuplicate) {
          throw new ConflictException(
            'A matching payment was recorded in the last 60 seconds. Please verify before retrying.',
          );
        }

        const teamMemberIdValue = salary.teamMemberId;
        const teamMemberObjectId =
          teamMemberIdValue instanceof Types.ObjectId
            ? teamMemberIdValue
            : toObjectId(
                typeof teamMemberIdValue === 'string'
                  ? teamMemberIdValue
                  : (teamMemberIdValue as unknown as Types.ObjectId).toString(),
              );

        const paymentData: Record<string, any> = {
          workspaceId: workspaceObjectId,
          teamMemberId: teamMemberObjectId,
          salaryId: salaryObjectId,
          amount: paymentDto.amount,
          paymentMode: paymentDto.paymentMode,
          paymentDate: new Date(paymentDto.paymentDate),
          recordedBy: userObjectId,
        };
        paymentData.status = 'active';

        if (paymentDto.note) paymentData.note = paymentDto.note;
        if (paymentDto.referenceNo) paymentData.referenceNo = paymentDto.referenceNo;
        if (paymentDto.proofAttached !== undefined) {
          paymentData.proofAttached = paymentDto.proofAttached;
        }
        if (paymentDto.proofUrl) paymentData.proofUrl = paymentDto.proofUrl;
        if (paymentDto.proofUrls) paymentData.proofUrls = paymentDto.proofUrls;
        if (paymentDto.paymentFrom) paymentData.paymentFrom = paymentDto.paymentFrom;
        if (paymentDto.paidBy) paymentData.paidBy = paymentDto.paidBy;
        if (paymentDto.upiDebitedAccount) {
          paymentData.upiDebitedAccount = paymentDto.upiDebitedAccount;
        }
        if (paymentDto.bankFromAccount) {
          paymentData.bankFromAccount = paymentDto.bankFromAccount;
        }
        if (paymentDto.splitLines) paymentData.splitLines = paymentDto.splitLines;
        if (paymentDto.commission !== undefined) {
          paymentData.commission = paymentDto.commission;
        }
        if (paymentDto.commissionNote) {
          paymentData.commissionNote = paymentDto.commissionNote;
        }
        if (isAdvancePayment) {
          paymentData.isAdvance = true;
          paymentData.advanceForMonth = advanceForMonth;
          paymentData.advanceForYear = advanceForYear;
        }

        // D-01 month-complete + payout-window gate. NOTE: currently a NO-OP — disabled
        // inside SalaryDisbursementGuardService per owner 2026-06-22 (GATE_ENABLED=false)
        // so salary can be recorded in the SAME month (factories paying 25th-month-end)
        // and the owner/manager can record a payment any time. Re-enable there to restore.
        await this.salaryDisbursementGuardService.assertPaymentAllowed(
          workspaceId,
          salary.month,
          salary.year,
          { isAdvance: paymentDto.isAdvance, isOwner },
        );

        const payment = new this.paymentModel(paymentData);
        await payment.save();

        // ─── D-06/D-07: Finance ledger posting (non-blocking) ─────────────────
        // Post double-entry journal after payment is persisted. Wrapped in
        // try/catch so a Finance-side error (e.g., missing COA account) never
        // rolls back a successful payroll payment (D-07 safety contract).
        try {
          let ledgerResult: { posted: boolean; reason?: string };
          if (payment.isAdvance) {
            // Resolve the AdvanceSalaryRequest for sourceVoucherNumber
            const advReq = await this.advanceSalaryRequestModel
              .findOne({
                workspaceId: workspaceObjectId,
                teamMemberId: teamMemberObjectId,
                status: 'paid',
              })
              .sort({ updatedAt: -1 })
              .lean()
              .exec();
            const advReqForPosting = advReq ?? { month: salary.month, year: salary.year };
            ledgerResult = await this.salaryLedgerPostingService.postAdvancePayment(
              payment,
              advReqForPosting,
              paymentDto.coaAccountId,
              userId,
            );
          } else {
            ledgerResult = await this.salaryLedgerPostingService.postSalaryPayment(
              payment,
              salary,
              paymentDto.coaAccountId,
              userId,
            );
          }
          payment.ledgerPosted = ledgerResult.posted;
          if (!ledgerResult.posted) {
            payment.ledgerSkipReason = ledgerResult.reason;
          }
          await payment.save();

          // D-10: persist last-used COA account for the workspace picker pre-selection
          if (paymentDto.coaAccountId) {
            await this.payrollConfigModel
              .updateOne(
                { workspaceId: workspaceObjectId },
                { $set: { 'display.lastUsedCoaAccountId': paymentDto.coaAccountId } },
                { upsert: false },
              )
              .exec();
          }
        } catch (postingErr: unknown) {
          const msg =
            postingErr instanceof Error
              ? postingErr.message
              : typeof postingErr === 'string'
                ? postingErr
                : 'unknown error';
          this.logger.error(
            `Salary ledger posting failed for payment ${String(payment._id)}: ${msg}`,
          );
          payment.ledgerPosted = false;
          payment.ledgerSkipReason = 'post_error';
          await payment.save();
        }
        // ─────────────────────────────────────────────────────────────────────

        if (linkedAdjustmentIds.length > 0) {
          await this.salaryAdjustmentModel.updateMany(
            { _id: { $in: linkedAdjustmentIds } },
            { $set: { linkedPaymentId: payment._id } },
          );
        }

        if (isAdvancePayment && advanceAmount > 0 && advanceForMonth && advanceForYear) {
          // Determine whether the caller wants multi-installment (EMI) recovery.
          const installmentCfg = paymentDto.advanceInstallments;
          const isMultiInstallment =
            installmentCfg != null &&
            (installmentCfg.installmentCount == null ||
              installmentCfg.installmentCount > 1 ||
              installmentCfg.installmentAmount != null);

          if (isMultiInstallment) {
            // Multi-installment path: create an AdvanceRecoveryPlan that
            // schedules deductions across multiple future months.
            const { plan, complianceWarnings } = await this.createAdvanceRecoveryPlan({
              workspaceId,
              teamMemberId: teamMemberObjectId,
              sourcePaymentId: toObjectId(String(payment._id)),
              totalAmount: advanceAmount,
              startMonth: advanceForMonth,
              startYear: advanceForYear,
              installmentConfig: installmentCfg,
              userId: userObjectId,
              overrideCompliance: paymentDto.overrideCompliance ?? false,
              overrideReason: paymentDto.overrideReason,
            });

            payment.advanceRecoveryPlanId = toObjectId(String(plan._id));
            await payment.save();

            // Surface compliance warnings in the response meta (additive field).
            if (complianceWarnings.length > 0) {
              (payment as any).__complianceWarnings = complianceWarnings;
            }
          } else {
            // Legacy single-month path: one deduction adjustment in the target month.
            const recoveryAdjustment = await this.createAdvanceRecoveryDeduction({
              workspaceId,
              teamMemberId: teamMemberObjectId,
              targetMonth: advanceForMonth,
              targetYear: advanceForYear,
              amount: advanceAmount,
              sourcePaymentId: toObjectId(String(payment._id)),
              userId: userObjectId,
            });

            if (recoveryAdjustment) {
              payment.advanceRecoveryAdjustmentId = toObjectId(String(recoveryAdjustment._id));
              await payment.save();
            }
          }
        }

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'payment',
          entityId: String(payment._id),
          action: 'payment.created',
          actorId: userId,
          salaryId: String(salaryObjectId),
          teamMemberId: this.getObjectIdString(salary.teamMemberId),
          month: salary.month,
          year: salary.year,
          after: {
            id: String(payment._id),
            amount: payment.amount,
            commission: payment.commission ?? 0,
            paymentMode: payment.paymentMode,
            paymentDate: payment.paymentDate,
            status: 'active',
            linkedAdjustmentIds: linkedAdjustmentIds.map(String),
            ...(isAdvancePayment
              ? {
                  isAdvance: true,
                  advanceForMonth,
                  advanceForYear,
                  advanceRecoveryAdjustmentId: payment.advanceRecoveryAdjustmentId
                    ? String(payment.advanceRecoveryAdjustmentId)
                    : undefined,
                }
              : {}),
          },
        });

        await this.syncSalaryStatus(salary);

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.payment_recorded',
          properties: {
            workspaceId,
            paymentId: String(payment._id),
            salaryId: String(salaryObjectId),
            teamMemberId: String(teamMemberObjectId),
            month: salary.month,
            year: salary.year,
            amount: payment.amount,
            commission: payment.commission ?? 0,
            paymentMode: payment.paymentMode,
            isAdvance: isAdvancePayment,
            hasSplitLines: (paymentDto.splitLines?.length ?? 0) > 0,
            linkedAdjustmentsCount: linkedAdjustmentIds.length,
          },
        });

        // Attach compliance warnings (if any) to the payment object so the
        // controller can include them in meta. Using a transient property avoids
        // schema pollution; the controller reads this and drops it before responding.
        const complianceWarnings: ComplianceWarning[] = (payment as any).__complianceWarnings ?? [];
        return Object.assign(payment, { meta: { complianceWarnings } });
      },
    );
  }

  async recordBulkPayment(
    workspaceId: string,
    userId: string,
    dto: BulkRecordPaymentDto,
  ): Promise<{
    total: number;
    succeeded: number;
    failed: number;
    results: Array<{
      index: number;
      teamMemberId?: string;
      salaryId?: string;
      success: boolean;
      paymentId?: string;
      error?: string;
      // LOW-2: structured deny code (e.g. MEMBER_OFFBOARDED) when the per-item
      // failure carried one, so the FE can localize it exactly like the
      // single-payment contract instead of showing a raw message string.
      code?: string;
    }>;
  }> {
    return this.withSalarySpan(
      'salary.recordBulkPayment',
      { workspaceId, userId, paymentsCount: dto.payments.length },
      async () => {
        await this.assertFeatureEnabled(workspaceId, 'bulkPayments', 'Bulk payments');

        const results: Array<{
          index: number;
          teamMemberId?: string;
          salaryId?: string;
          success: boolean;
          paymentId?: string;
          error?: string;
          code?: string;
        }> = [];

        for (let i = 0; i < dto.payments.length; i++) {
          const item = dto.payments[i];

          try {
            const payment = await this.recordPayment(workspaceId, userId, {
              salaryId: item.salaryId,
              teamMemberId: item.teamMemberId,
              month: item.month,
              year: item.year,
              amount: item.amount,
              paymentMode: item.paymentMode,
              paymentDate: item.paymentDate,
              note: item.note,
              referenceNo: item.referenceNo,
              paymentFrom: item.paymentFrom,
              paidBy: item.paidBy,
              advanceTarget: item.advanceTarget,
              commission: item.commission,
              commissionTitle: item.commissionTitle,
              commissionNote: item.commissionNote,
            });

            results.push({
              index: i,
              teamMemberId: item.teamMemberId,
              salaryId: item.salaryId,
              success: true,
              paymentId: String(payment._id),
            });
          } catch (error: unknown) {
            // LOW-2: when the per-item failure is a structured deny
            // (ForbiddenException({ code, message }), e.g. MEMBER_OFFBOARDED),
            // surface the `code` alongside `error` so the bulk row matches the
            // single-payment {code} contract and the FE can localize it. Plain
            // errors (no structured code) keep just the message, as before.
            const denyCode = this.extractDenyCode(error);
            results.push({
              index: i,
              teamMemberId: item.teamMemberId,
              salaryId: item.salaryId,
              success: false,
              error: error instanceof Error ? error.message : 'Payment failed',
              ...(denyCode ? { code: denyCode } : {}),
            });
          }
        }

        const summary = {
          total: dto.payments.length,
          succeeded: results.filter((result) => result.success).length,
          failed: results.filter((result) => !result.success).length,
          results,
        };

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.bulk_payment_recorded',
          properties: {
            workspaceId,
            total: summary.total,
            succeeded: summary.succeeded,
            failed: summary.failed,
          },
        });

        return summary;
      },
    );
  }

  async reversePayment(
    workspaceId: string,
    paymentId: string,
    userId: string,
    dto: { reversalReason: string },
  ) {
    return this.withSalarySpan(
      'salary.reversePayment',
      { workspaceId, paymentId, userId },
      async () => {
        const workspaceObjectId = toObjectId(workspaceId);
        const paymentObjectId = toObjectId(paymentId);
        const userObjectId = toObjectId(userId);

        const payment = await this.paymentModel
          .findOne({ _id: paymentObjectId, workspaceId: workspaceObjectId })
          .exec();

        if (!payment) {
          throw new NotFoundException('Payment not found');
        }
        await this.assertNotLocked(this.getObjectIdString(payment.salaryId));
        // OQ-S2 / OQ-S5: a non-owner cannot reverse their own payment, and a
        // removed member's payments are read-only.
        await this.assertNotSelfSalaryEdit(
          workspaceId,
          userId,
          this.getObjectIdString(payment.teamMemberId),
        );
        await this.assertMemberWritableForSalary(
          workspaceId,
          this.getObjectIdString(payment.teamMemberId),
        );

        if (payment.status === 'reversed') {
          throw new BadRequestException('Payment is already reversed');
        }

        const beforeSnapshot = {
          id: String(payment._id),
          amount: payment.amount,
          commission: payment.commission ?? 0,
          paymentMode: payment.paymentMode,
          paymentDate: payment.paymentDate,
          status: payment.status || 'active',
        };

        payment.status = 'reversed';
        payment.reversedBy = userObjectId;
        payment.reversedAt = new Date();
        payment.reversalReason = dto.reversalReason.trim();
        await payment.save();

        // Finance ledger: post a compensating reversal journal so the books stop
        // overstating salary expense / cash outflow once a payment is reversed.
        // Only when the original was actually posted (ledgerPosted). Non-blocking
        // per the D-07 contract — a Finance-side error never blocks the reversal.
        if (payment.ledgerPosted) {
          try {
            const revResult = payment.isAdvance
              ? await this.salaryLedgerPostingService.postAdvanceReversal(payment, userId)
              : await this.salaryLedgerPostingService.postSalaryReversal(payment, userId);
            if (!revResult.posted) {
              this.logger.warn(
                `Ledger reversal skipped for payment ${String(payment._id)}: ${revResult.reason}`,
              );
            }
          } catch (revErr: unknown) {
            const msg = revErr instanceof Error ? revErr.message : 'unknown error';
            this.logger.error(
              `Ledger reversal posting failed for payment ${String(payment._id)}: ${msg}`,
            );
          }
        }

        const linkedAdjustments = await this.salaryAdjustmentModel
          .find({
            linkedPaymentId: paymentObjectId,
            status: 'active',
          })
          .exec();

        // Step A refactor: use reverseAdjustmentDoc for each linked-payment adjustment.
        for (const adjustment of linkedAdjustments) {
          adjustment.reversalReason = `Auto-reversed: linked payment reversed. ${dto.reversalReason.trim()}`;
          await this.reverseAdjustmentDoc(adjustment, userObjectId, adjustment.reversalReason, {
            source: 'payment_reversal',
            paymentId: String(payment._id),
          });
        }

        let reversedAdvanceRecoveryAdjustmentId: string | undefined;
        // Step A refactor: legacy single-adjustment path — mutually exclusive with plan path.
        if (payment.isAdvance && payment.advanceRecoveryAdjustmentId) {
          const recoveryAdjustment = await this.salaryAdjustmentModel
            .findById(payment.advanceRecoveryAdjustmentId)
            .exec();

          if (recoveryAdjustment && recoveryAdjustment.status === 'active') {
            reversedAdvanceRecoveryAdjustmentId = String(recoveryAdjustment._id);
            await this.reverseAdjustmentDoc(
              recoveryAdjustment,
              userObjectId,
              `Auto-reversed: source advance payment ${String(payment._id)} was reversed`,
              { source: 'advance_reversal', sourcePaymentId: String(payment._id) },
            );
          }
        }

        // Step B: plan-backed advance reversal.  A payment has EITHER
        // advanceRecoveryAdjustmentId (legacy) OR advanceRecoveryPlanId (multi-installment).
        let reversedAdvanceRecoveryPlanId: string | undefined;
        if (
          payment.isAdvance &&
          payment.advanceRecoveryPlanId &&
          !payment.advanceRecoveryAdjustmentId
        ) {
          const plan = await this.advanceRecoveryPlanModel
            .findById(payment.advanceRecoveryPlanId)
            .exec();

          if (plan && plan.status !== 'reversed') {
            // Reverse every still-active linked adjustment.
            for (let i = 0; i < plan.installments.length; i++) {
              const entry = plan.installments[i];
              if (entry.status === 'reversed') continue;
              if (entry.adjustmentId) {
                const adj = await this.salaryAdjustmentModel.findById(entry.adjustmentId).exec();
                if (adj && adj.status === 'active') {
                  await this.reverseAdjustmentDoc(
                    adj,
                    userObjectId,
                    `Auto-reversed: source advance payment ${String(payment._id)} was reversed`,
                    {
                      source: 'advance_plan_reversal',
                      sourcePaymentId: String(payment._id),
                      planId: String(plan._id),
                    },
                  );
                }
              }
              plan.installments[i].status = 'reversed';
            }

            plan.status = 'reversed';
            plan.closureType = 'reversed';
            plan.closedBy = userObjectId;
            plan.closedAt = new Date();
            plan.remainingAmount = 0;
            await plan.save();

            reversedAdvanceRecoveryPlanId = String(plan._id);
          }
        }

        const salary = await this.salaryModel
          .findOne({
            _id:
              payment.salaryId instanceof Types.ObjectId
                ? payment.salaryId
                : toObjectId(this.getObjectIdString(payment.salaryId)),
            workspaceId: workspaceObjectId,
          })
          .exec();

        if (salary) {
          await this.recalculateSalaryFromAdjustments(salary, userObjectId);
        }

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'payment',
          entityId: String(payment._id),
          action: 'payment.reversed',
          actorId: userId,
          salaryId: this.getObjectIdString(payment.salaryId),
          teamMemberId: this.getObjectIdString(payment.teamMemberId),
          month: salary?.month,
          year: salary?.year,
          before: beforeSnapshot,
          after: {
            ...beforeSnapshot,
            status: 'reversed',
            reversedBy: userId,
            reversedAt: payment.reversedAt,
            reversalReason: payment.reversalReason,
          },
          reason: dto.reversalReason.trim(),
          meta: {
            reversedAdjustmentIds: linkedAdjustments.map((adjustment) => String(adjustment._id)),
            reversedAdvanceRecoveryAdjustmentId,
            reversedAdvanceRecoveryPlanId,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.payment_reversed',
          properties: {
            workspaceId,
            paymentId,
            salaryId: this.getObjectIdString(payment.salaryId),
            teamMemberId: this.getObjectIdString(payment.teamMemberId),
            month: salary?.month,
            year: salary?.year,
            amount: payment.amount,
            paymentMode: payment.paymentMode,
            reversedAdjustmentsCount: linkedAdjustments.length,
            isAdvanceReversal: !!payment.isAdvance,
            reversedAdvanceRecoveryPlanId,
          },
        });

        return this.paymentModel
          .findById(paymentObjectId)
          .populate('recordedBy', 'name email')
          .populate('reversedBy', 'name email')
          .exec();
      },
    );
  }

  async getPaymentAuditTrail(workspaceId: string, paymentId: string) {
    const payment = await this.paymentModel
      .findOne({
        _id: toObjectId(paymentId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    return this.auditService.listEntityEvents(workspaceId, 'payment', paymentId);
  }

  async getPayments(workspaceId: string, salaryId?: string) {
    const workspaceObjectId = toObjectId(workspaceId);

    const query: { workspaceId: Types.ObjectId; salaryId?: Types.ObjectId } = {
      workspaceId: workspaceObjectId,
    };
    if (salaryId) query.salaryId = toObjectId(salaryId);

    return this.paymentModel
      .find(query)
      .populate('teamMemberId', 'name')
      .populate('recordedBy', 'name')
      .exec();
  }

  async getPaymentRegister(
    workspaceId: string,
    options: {
      month?: number;
      year?: number;
      page?: number;
      limit?: number;
      search?: string;
      status?: PaymentRegisterStatus;
      teamMemberId?: string;
    } = {},
  ): Promise<PaymentRegisterResponse> {
    const workspaceObjectId = toObjectId(workspaceId);
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const skip = (page - 1) * limit;
    const teamMemberFilterId = options.teamMemberId?.trim() || null;

    const teamCollection = this.teamModel.collection.name;
    const salaryCollection = this.salaryModel.collection.name;

    const match: Record<string, unknown> = {
      workspaceId: { $in: [workspaceObjectId, workspaceId] },
    };

    if (options.status && options.status !== 'all') {
      match.status = options.status;
    }

    if (teamMemberFilterId) {
      if (!Types.ObjectId.isValid(teamMemberFilterId)) {
        throw new BadRequestException('Invalid team member filter');
      }
    }

    const normalizedSearch = options.search?.trim();
    const searchRegex = normalizedSearch ? new RegExp(normalizedSearch, 'i') : null;

    const [result] = await this.paymentModel
      .aggregate<{
        summary?: Array<{
          totalCredited: number;
          totalReversed: number;
          activeCount: number;
          reversedCount: number;
          advanceCount: number;
          splitCount: number;
        }>;
        records?: Array<Record<string, unknown>>;
        total?: Array<{ count: number }>;
      }>([
        { $match: match },
        {
          $lookup: {
            from: salaryCollection,
            let: {
              rawSalaryId: '$salaryId',
              objectSalaryId: {
                $convert: {
                  input: '$salaryId',
                  to: 'objectId',
                  onError: null,
                  onNull: null,
                },
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $eq: ['$_id', '$$rawSalaryId'] },
                      {
                        $and: [
                          { $ne: ['$$objectSalaryId', null] },
                          { $eq: ['$_id', '$$objectSalaryId'] },
                        ],
                      },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: '_salary',
          },
        },
        {
          $addFields: {
            _salaryRecord: {
              $ifNull: [{ $arrayElemAt: ['$_salary', 0] }, null],
            },
            _effectiveTeamMemberId: {
              $ifNull: [{ $arrayElemAt: ['$_salary.teamMemberId', 0] }, '$teamMemberId'],
            },
            _effectiveReferenceNo: {
              $ifNull: ['$referenceNo', { $arrayElemAt: ['$splitLines.referenceNo', 0] }],
            },
            _effectivePaidBy: {
              $ifNull: ['$paidBy', { $arrayElemAt: ['$splitLines.paidBy', 0] }],
            },
            creditedAmount: {
              $add: [{ $ifNull: ['$amount', 0] }, { $ifNull: ['$commission', 0] }],
            },
            splitCount: {
              $cond: {
                if: { $isArray: '$splitLines' },
                then: { $size: '$splitLines' },
                else: 0,
              },
            },
            normalizedStatus: { $ifNull: ['$status', 'active'] },
          },
        },
        {
          $lookup: {
            from: teamCollection,
            let: {
              rawTeamMemberId: '$_effectiveTeamMemberId',
              objectTeamMemberId: {
                $convert: {
                  input: '$_effectiveTeamMemberId',
                  to: 'objectId',
                  onError: null,
                  onNull: null,
                },
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $eq: ['$_id', '$$rawTeamMemberId'] },
                      {
                        $and: [
                          { $ne: ['$$objectTeamMemberId', null] },
                          { $eq: ['$_id', '$$objectTeamMemberId'] },
                        ],
                      },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: '_teamMember',
          },
        },
        {
          $addFields: {
            _teamMemberRecord: {
              $ifNull: [{ $arrayElemAt: ['$_teamMember', 0] }, null],
            },
            _effectiveTeamMemberIdString: {
              $cond: {
                if: { $ne: ['$_effectiveTeamMemberId', null] },
                then: { $toString: '$_effectiveTeamMemberId' },
                else: '',
              },
            },
          },
        },
        {
          $addFields: {
            teamMemberName: {
              $ifNull: [{ $arrayElemAt: ['$_teamMember.name', 0] }, 'Unknown employee'],
            },
          },
        },
        ...(teamMemberFilterId
          ? [
              {
                $match: {
                  _effectiveTeamMemberIdString: teamMemberFilterId,
                },
              },
            ]
          : []),
        ...(options.month && options.year
          ? [
              {
                $match: {
                  '_salaryRecord.month': options.month,
                  '_salaryRecord.year': options.year,
                },
              },
            ]
          : []),
        ...(searchRegex
          ? [
              {
                $match: {
                  $or: [
                    { teamMemberName: { $regex: searchRegex } },
                    { paymentMode: { $regex: searchRegex } },
                    { _effectiveReferenceNo: { $regex: searchRegex } },
                    { _effectivePaidBy: { $regex: searchRegex } },
                    { note: { $regex: searchRegex } },
                  ],
                },
              },
            ]
          : []),
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  totalCredited: {
                    $sum: {
                      $cond: [{ $eq: ['$normalizedStatus', 'active'] }, '$creditedAmount', 0],
                    },
                  },
                  totalReversed: {
                    $sum: {
                      $cond: [{ $eq: ['$normalizedStatus', 'reversed'] }, '$creditedAmount', 0],
                    },
                  },
                  activeCount: {
                    $sum: {
                      $cond: [{ $eq: ['$normalizedStatus', 'active'] }, 1, 0],
                    },
                  },
                  reversedCount: {
                    $sum: {
                      $cond: [{ $eq: ['$normalizedStatus', 'reversed'] }, 1, 0],
                    },
                  },
                  advanceCount: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$normalizedStatus', 'active'] },
                            { $eq: ['$isAdvance', true] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  splitCount: {
                    $sum: {
                      $cond: [{ $gt: ['$splitCount', 0] }, 1, 0],
                    },
                  },
                },
              },
            ],
            records: [
              { $sort: { paymentDate: -1, createdAt: -1 } },
              { $skip: skip },
              { $limit: limit },
              {
                $project: {
                  _id: { $toString: '$_id' },
                  salaryId: {
                    $cond: {
                      if: { $ne: ['$salaryId', null] },
                      then: { $toString: '$salaryId' },
                      else: '',
                    },
                  },
                  teamMemberId: {
                    $cond: {
                      if: { $ne: ['$_effectiveTeamMemberId', null] },
                      then: { $toString: '$_effectiveTeamMemberId' },
                      else: '',
                    },
                  },
                  teamMemberName: 1,
                  salaryMonth: { $ifNull: ['$_salaryRecord.month', 0] },
                  salaryYear: { $ifNull: ['$_salaryRecord.year', 0] },
                  paymentDate: 1,
                  paymentMode: 1,
                  amount: { $ifNull: ['$amount', 0] },
                  commission: { $ifNull: ['$commission', 0] },
                  creditedAmount: 1,
                  isAdvance: { $ifNull: ['$isAdvance', false] },
                  advanceForMonth: 1,
                  advanceForYear: 1,
                  status: '$normalizedStatus',
                  splitCount: 1,
                  referenceNo: '$_effectiveReferenceNo',
                  paidBy: '$_effectivePaidBy',
                  note: 1,
                  proofAttached: {
                    $cond: {
                      if: {
                        $gt: [{ $size: { $ifNull: ['$proofUrls', []] } }, 0],
                      },
                      then: true,
                      else: { $ifNull: ['$proofAttached', false] },
                    },
                  },
                  createdAt: 1,
                },
              },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec();

    const rawSummary = result?.summary?.[0] || {
      totalCredited: 0,
      totalReversed: 0,
      activeCount: 0,
      reversedCount: 0,
      advanceCount: 0,
      splitCount: 0,
    };

    const total = result?.total?.[0]?.count || 0;
    const pages = Math.ceil(total / limit);

    return {
      records: (result?.records || []) as PaymentRegisterRow[],
      pagination: { page, limit, total, pages },
      summary: {
        totalCredited: this.roundCurrency(rawSummary.totalCredited),
        totalReversed: this.roundCurrency(rawSummary.totalReversed),
        activeCount: rawSummary.activeCount,
        reversedCount: rawSummary.reversedCount,
        advanceCount: rawSummary.advanceCount,
        splitCount: rawSummary.splitCount,
      },
    };
  }

  async getOutstandingAdvances(
    workspaceId: string,
    teamMemberId: string,
    userId: string,
  ): Promise<{
    totalAdvanced: number;
    totalRecovered: number;
    outstanding: number;
    advances: Array<{
      paymentId: string;
      amount: number;
      advanceForMonth: number;
      advanceForYear: number;
      recoveryStatus: 'pending' | 'recovered' | 'reversed' | 'partial';
      paymentDate: Date;
      // Plan-backed advances include a per-month installment breakdown.
      installments?: Array<{
        index: number;
        month: number;
        year: number;
        amount: number;
        status: string;
      }>;
    }>;
  }> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);
    const workspaceObjectId = toObjectId(workspaceId);
    const teamMemberObjectId = toObjectId(teamMemberId);

    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    const advancePayments = await this.paymentModel
      .find({
        workspaceId: workspaceObjectId,
        teamMemberId: teamMemberObjectId,
        isAdvance: true,
        status: { $ne: 'reversed' },
      })
      .sort({ createdAt: -1 })
      .exec();

    let totalAdvanced = 0;
    let totalRecovered = 0;
    const advances: Array<{
      paymentId: string;
      amount: number;
      advanceForMonth: number;
      advanceForYear: number;
      recoveryStatus: 'pending' | 'recovered' | 'reversed' | 'partial';
      paymentDate: Date;
      installments?: Array<{
        index: number;
        month: number;
        year: number;
        amount: number;
        status: string;
      }>;
    }> = [];

    for (const payment of advancePayments) {
      // ---- Step F: plan-backed path ----
      if (payment.advanceRecoveryPlanId && !payment.advanceRecoveryAdjustmentId) {
        const plan = await this.advanceRecoveryPlanModel
          .findById(payment.advanceRecoveryPlanId)
          .exec();

        if (!plan) {
          // Orphaned reference — skip to avoid crashing the response.
          continue;
        }

        const planTotal = plan.totalAmount;
        totalAdvanced = this.roundCurrency(totalAdvanced + planTotal);

        // Active adjustments for future months (>= current payroll month) = still outstanding.
        const activeAdjs = await this.salaryAdjustmentModel
          .find({
            _id: { $in: plan.linkedAdjustmentIds },
            status: 'active',
          })
          .select('month year amount')
          .lean()
          .exec();

        // Remaining = sum of active adjustments for months >= current payroll month.
        let planRemaining = 0;
        for (const adj of activeAdjs) {
          const adjYear = (adj as any).year as number;
          const adjMonth = (adj as any).month as number;
          const isFuture = adjYear > curYear || (adjYear === curYear && adjMonth >= curMonth);
          if (isFuture) {
            planRemaining = this.roundCurrency(planRemaining + ((adj as any).amount ?? 0));
          }
        }

        const planRecovered = this.roundCurrency(Math.max(0, planTotal - planRemaining));
        totalRecovered = this.roundCurrency(totalRecovered + planRecovered);

        // Installment breakdown for the frontend.
        const installmentBreakdown = plan.installments.map((entry) => ({
          index: entry.index,
          month: entry.month,
          year: entry.year,
          amount: entry.appliedAmount,
          status: entry.status,
        }));

        let recoveryStatus: 'pending' | 'recovered' | 'reversed' | 'partial';
        if (plan.status === 'reversed') {
          recoveryStatus = 'reversed';
        } else if (plan.status === 'completed') {
          recoveryStatus = 'recovered';
        } else if (planRecovered > 0) {
          recoveryStatus = 'partial';
        } else {
          recoveryStatus = 'pending';
        }

        advances.push({
          paymentId: String(payment._id),
          amount: planTotal,
          advanceForMonth: payment.advanceForMonth ?? 0,
          advanceForYear: payment.advanceForYear ?? 0,
          recoveryStatus,
          paymentDate: payment.paymentDate,
          installments: installmentBreakdown,
        });
        continue;
      }

      // ---- Legacy single-adjustment (lump) path ----
      // Fix 2026-07-03: an ACTIVE adjustment targeting the current-or-future
      // month is still OUTSTANDING (the deduction has not hit a payroll yet).
      // Previously any active adjustment counted as recovered immediately, so
      // a freshly disbursed lump advance showed outstanding=0 and the worker's
      // Advances card read "nothing to show" right after being paid. Mirrors
      // the plan path's month >= current test.
      let recoveryStatus: 'pending' | 'recovered' | 'reversed' | 'partial' = 'pending';
      let advanceAmount = 0;

      if (payment.advanceRecoveryAdjustmentId) {
        const recovery = await this.salaryAdjustmentModel
          .findById(payment.advanceRecoveryAdjustmentId)
          .select('status amount month year')
          .exec();

        if (recovery) {
          advanceAmount = recovery.amount ?? 0;
          if (recovery.status === 'active') {
            const adjMonth = recovery.month ?? 0;
            const adjYear = recovery.year ?? 0;
            const elapsed = adjYear < curYear || (adjYear === curYear && adjMonth < curMonth);
            if (elapsed) {
              recoveryStatus = 'recovered';
              totalRecovered = this.roundCurrency(totalRecovered + (recovery.amount ?? 0));
            } else {
              recoveryStatus = 'pending';
            }
          } else {
            recoveryStatus = 'reversed';
          }
        }
      } else {
        // Same-month-settled advance (owner model 2026-07-03): no adjustment
        // exists — the Payment itself is the advance AND its recovery (it
        // counts toward the request month's dues). Outstanding while its month
        // is running; settled once the month has elapsed. Payment.amount is
        // RUPEES (salary-module convention).
        advanceAmount = payment.amount ?? 0;
        const forMonth = payment.advanceForMonth ?? 0;
        const forYear = payment.advanceForYear ?? 0;
        const elapsed = forYear < curYear || (forYear === curYear && forMonth < curMonth);
        if (elapsed) {
          recoveryStatus = 'recovered';
          totalRecovered = this.roundCurrency(totalRecovered + advanceAmount);
        } else {
          recoveryStatus = 'pending';
        }
      }

      totalAdvanced = this.roundCurrency(totalAdvanced + advanceAmount);

      advances.push({
        paymentId: String(payment._id),
        amount: advanceAmount,
        advanceForMonth: payment.advanceForMonth ?? 0,
        advanceForYear: payment.advanceForYear ?? 0,
        recoveryStatus,
        paymentDate: payment.paymentDate,
      });
    }

    return {
      totalAdvanced,
      totalRecovered,
      outstanding: this.roundCurrency(Math.max(0, totalAdvanced - totalRecovered)),
      advances,
    };
  }

  /**
   * Lightweight balance summary for UI chips (member detail, payslip line).
   * Returns only the compact shape without the full installment ledger.
   * Self-scope enforcement mirrors `getOutstandingAdvances` exactly via
   * `assertSalarySelfReadAllowed` — a worker (scope=self) may only read their
   * own balance; a manager/HR/owner (scope=all) reads any member.
   */
  async getAdvanceBalanceSummary(
    workspaceId: string,
    teamMemberId: string,
    userId: string,
  ): Promise<{
    outstanding: number;
    totalAdvanced: number;
    totalRecovered: number;
    planCount: number;
    activePlanCount: number;
  }> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);

    const workspaceObjectId = toObjectId(workspaceId);
    const teamMemberObjectId = toObjectId(teamMemberId);

    // Derive outstanding/totalAdvanced/totalRecovered via the existing method
    // (reuse avoids logic divergence between the two endpoints).
    const { outstanding, totalAdvanced, totalRecovered } = await this.getOutstandingAdvances(
      workspaceId,
      teamMemberId,
      userId,
    );

    // Count plans — planCount includes all non-deleted plans; activePlanCount
    // is plans with status 'active' (installments still pending).
    const [planCount, activePlanCount] = await Promise.all([
      this.advanceRecoveryPlanModel
        .countDocuments({
          workspaceId: workspaceObjectId,
          teamMemberId: teamMemberObjectId,
        })
        .exec(),
      this.advanceRecoveryPlanModel
        .countDocuments({
          workspaceId: workspaceObjectId,
          teamMemberId: teamMemberObjectId,
          status: 'active',
        })
        .exec(),
    ]);

    return { outstanding, totalAdvanced, totalRecovered, planCount, activePlanCount };
  }

  /**
   * Internal-only: computes the outstanding advance balance for a team member
   * without any scope guard. Safe to call from payslip-builder paths where
   * the caller has already been authorised at the controller layer.
   */
  private async fetchOutstandingBalanceInternal(
    workspaceId: string,
    teamMemberId: string,
  ): Promise<number> {
    const workspaceObjectId = toObjectId(workspaceId);
    const teamMemberObjectId = toObjectId(teamMemberId);
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    const advancePayments = await this.paymentModel
      .find({
        workspaceId: workspaceObjectId,
        teamMemberId: teamMemberObjectId,
        isAdvance: true,
        status: { $ne: 'reversed' },
      })
      .lean()
      .exec();

    let totalAdvanced = 0;
    let totalRecovered = 0;

    for (const payment of advancePayments as any[]) {
      if (payment.advanceRecoveryPlanId && !payment.advanceRecoveryAdjustmentId) {
        const plan = (await this.advanceRecoveryPlanModel
          .findById(payment.advanceRecoveryPlanId)
          .select('totalAmount linkedAdjustmentIds status')
          .lean()
          .exec()) as any;

        if (!plan) continue;

        totalAdvanced = this.roundCurrency(totalAdvanced + plan.totalAmount);

        const activeAdjs = (await this.salaryAdjustmentModel
          .find({ _id: { $in: plan.linkedAdjustmentIds }, status: 'active' })
          .select('month year amount')
          .lean()
          .exec()) as any[];

        let planRemaining = 0;
        for (const adj of activeAdjs) {
          const isFuture = adj.year > curYear || (adj.year === curYear && adj.month >= curMonth);
          if (isFuture) {
            planRemaining = this.roundCurrency(planRemaining + (adj.amount ?? 0));
          }
        }
        totalRecovered = this.roundCurrency(
          totalRecovered + this.roundCurrency(Math.max(0, plan.totalAmount - planRemaining)),
        );
        continue;
      }

      if (payment.advanceRecoveryAdjustmentId) {
        const recovery = (await this.salaryAdjustmentModel
          .findById(payment.advanceRecoveryAdjustmentId)
          .select('status amount')
          .lean()
          .exec()) as any;

        if (recovery) {
          totalAdvanced = this.roundCurrency(totalAdvanced + (recovery.amount ?? 0));
          if (recovery.status === 'active') {
            totalRecovered = this.roundCurrency(totalRecovered + (recovery.amount ?? 0));
          }
        }
      }
    }

    return this.roundCurrency(Math.max(0, totalAdvanced - totalRecovered));
  }

  async getPayslipData(workspaceId: string, salaryIds: string[]) {
    await this.assertFeatureEnabled(workspaceId, 'payslipGeneration', 'Payslip generation');

    const workspaceObjectId = toObjectId(workspaceId);
    const workspace = await this.workspaceModel
      .findById(workspaceObjectId)
      .select('name branding exportPreferences')
      .lean<{
        name: string;
        branding?: {
          logo?: string;
          pdfHeaderLogo?: string;
          pdfWatermarkLogo?: string;
          pdfFooterDetails?: string;
        };
        exportPreferences?: {
          includeHeaderLogo?: boolean;
          includeFooter?: boolean;
          includeWatermark?: boolean;
          showExportDate?: boolean;
        };
      } | null>()
      .exec();

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const results: Array<{
      record: Record<string, unknown>;
      adjustments: Record<string, unknown>[];
      payments: Record<string, unknown>[];
      componentTemplate: Record<string, unknown> | null;
      workspaceName: string;
      branding: {
        includeHeaderLogo: boolean;
        headerLogoUrl?: string;
        includeWatermark: boolean;
        watermarkLogoUrl?: string;
        includeFooter: boolean;
        footerText?: string;
        showExportDate: boolean;
      };
      /** Informational: outstanding advance balance. Does NOT affect net salary. */
      advanceOutstanding?: number;
      /** Informational: outstanding employer loan balance. Does NOT affect net salary. */
      loanOutstanding?: number;
    }> = [];

    for (const salaryId of salaryIds) {
      const salaryObjectId = toObjectId(salaryId);
      const salaryRecord = await this.salaryModel
        .findOne({ _id: salaryObjectId, workspaceId: workspaceObjectId })
        .populate({
          path: 'teamMemberId',
          select:
            'name email designation avatar salaryType salaryAmount salaryDayBasis fixedMonthDays attendancePayMode dailyHours workingDays finalMonthlyOverride ctcAmount componentTemplateId componentOverrides dateOfJoining bankDetails upiDetails preferredMethod',
        })
        .lean<Record<string, unknown> | null>()
        .exec();

      if (!salaryRecord) {
        continue;
      }

      const adjustments = await this.salaryAdjustmentModel
        .find({ salaryId: salaryObjectId, workspaceId: workspaceObjectId })
        .sort({ createdAt: 1 })
        .lean<Record<string, unknown>[]>()
        .exec();

      const payments = await this.paymentModel
        .find({ salaryId: salaryObjectId, workspaceId: workspaceObjectId })
        .sort({ paymentDate: 1 })
        .lean<Record<string, unknown>[]>()
        .exec();

      const paidAmount = payments
        .filter((payment) => payment.status !== 'reversed')
        .reduce(
          (sum, payment) => sum + Number(payment.amount ?? 0) + Number(payment.commission ?? 0),
          0,
        );

      const teamMember = salaryRecord.teamMemberId as
        | (Record<string, unknown> & {
            _id?: Types.ObjectId | string;
            name?: string;
            designation?: string;
            avatar?: string;
            salaryType?: string;
            salaryAmount?: number;
            salaryDayBasis?: SalaryDayBasis;
            fixedMonthDays?: number | null;
            attendancePayMode?: AttendancePayMode;
            dailyHours?: number;
            workingDays?: number;
            finalMonthlyOverride?: number | null;
            ctcAmount?: number;
            componentTemplateId?: Types.ObjectId | string | null;
            componentOverrides?: unknown[];
            bankDetails?: unknown;
            upiDetails?: unknown;
            preferredMethod?: string;
          })
        | undefined;

      let componentTemplate: Record<string, unknown> | null = null;
      if (teamMember?.componentTemplateId) {
        const rawTemplate = await this.componentTemplateModel
          .findById(teamMember.componentTemplateId)
          .lean<Record<string, unknown> | null>()
          .exec();

        if (rawTemplate) {
          componentTemplate = {
            ...rawTemplate,
            _id: this.getObjectIdString(rawTemplate._id),
            workspaceId: this.getObjectIdString(rawTemplate.workspaceId),
            createdBy: this.getObjectIdString(rawTemplate.createdBy),
          };
        }
      }

      const branding = {
        includeHeaderLogo: workspace.exportPreferences?.includeHeaderLogo ?? true,
        headerLogoUrl: workspace.branding?.pdfHeaderLogo || workspace.branding?.logo || undefined,
        includeWatermark: workspace.exportPreferences?.includeWatermark ?? true,
        watermarkLogoUrl: workspace.branding?.pdfWatermarkLogo || undefined,
        includeFooter: workspace.exportPreferences?.includeFooter ?? true,
        footerText: workspace.branding?.pdfFooterDetails || undefined,
        showExportDate: workspace.exportPreferences?.showExportDate ?? true,
      };

      const normalizedTeamMember =
        teamMember && teamMember._id
          ? {
              id: this.getObjectIdString(teamMember._id),
              name: teamMember.name,
              designation: teamMember.designation,
              avatar: teamMember.avatar,
              salaryType: teamMember.salaryType,
              salaryAmount: teamMember.salaryAmount,
              salaryDayBasis: teamMember.salaryDayBasis,
              fixedMonthDays: teamMember.fixedMonthDays ?? null,
              attendancePayMode: teamMember.attendancePayMode,
              dailyHours: teamMember.dailyHours,
              workingDays: teamMember.workingDays,
              finalMonthlyOverride: teamMember.finalMonthlyOverride,
              ctcAmount: teamMember.ctcAmount,
              componentTemplateId: teamMember.componentTemplateId
                ? this.getObjectIdString(teamMember.componentTemplateId)
                : undefined,
              componentOverrides: teamMember.componentOverrides,
            }
          : undefined;

      const record = {
        ...salaryRecord,
        _id: this.getObjectIdString(salaryRecord._id),
        workspaceId: this.getObjectIdString(salaryRecord.workspaceId),
        teamMemberId:
          teamMember && teamMember._id
            ? {
                _id: this.getObjectIdString(teamMember._id),
                name: teamMember.name,
                designation: teamMember.designation,
                avatar: teamMember.avatar,
                salaryType: teamMember.salaryType,
                salaryAmount: teamMember.salaryAmount,
                salaryDayBasis: teamMember.salaryDayBasis,
                fixedMonthDays: teamMember.fixedMonthDays ?? null,
                attendancePayMode: teamMember.attendancePayMode,
                dailyHours: teamMember.dailyHours,
                workingDays: teamMember.workingDays,
                finalMonthlyOverride: teamMember.finalMonthlyOverride,
                ctcAmount: teamMember.ctcAmount,
                componentTemplateId: teamMember.componentTemplateId
                  ? this.getObjectIdString(teamMember.componentTemplateId)
                  : undefined,
                componentOverrides: teamMember.componentOverrides,
                bankDetails: teamMember.bankDetails,
                upiDetails: teamMember.upiDetails,
                preferredMethod: teamMember.preferredMethod,
              }
            : this.getObjectIdString(salaryRecord.teamMemberId),
        teamMember: normalizedTeamMember,
        paidAmount,
      };

      results.push({
        record,
        adjustments: adjustments.map((adjustment) => ({
          ...adjustment,
          _id: this.getObjectIdString(adjustment._id),
          workspaceId: this.getObjectIdString(adjustment.workspaceId),
          salaryId: this.getObjectIdString(adjustment.salaryId),
          teamMemberId: this.getObjectIdString(adjustment.teamMemberId),
          linkedPaymentId: adjustment.linkedPaymentId
            ? this.getObjectIdString(adjustment.linkedPaymentId)
            : undefined,
          advanceSourcePaymentId: adjustment.advanceSourcePaymentId
            ? this.getObjectIdString(adjustment.advanceSourcePaymentId)
            : undefined,
          correctionOfAdjustmentId: adjustment.correctionOfAdjustmentId
            ? this.getObjectIdString(adjustment.correctionOfAdjustmentId)
            : undefined,
          createdBy: adjustment.createdBy
            ? this.getObjectIdString(adjustment.createdBy)
            : undefined,
          reversedBy: adjustment.reversedBy
            ? this.getObjectIdString(adjustment.reversedBy)
            : undefined,
        })),
        payments: payments.map((payment) => ({
          ...payment,
          _id: this.getObjectIdString(payment._id),
          workspaceId: this.getObjectIdString(payment.workspaceId),
          teamMemberId: this.getObjectIdString(payment.teamMemberId),
          salaryId: this.getObjectIdString(payment.salaryId),
          recordedBy: payment.recordedBy ? this.getObjectIdString(payment.recordedBy) : undefined,
          reversedBy: payment.reversedBy ? this.getObjectIdString(payment.reversedBy) : undefined,
          advanceRecoveryAdjustmentId: payment.advanceRecoveryAdjustmentId
            ? this.getObjectIdString(payment.advanceRecoveryAdjustmentId)
            : undefined,
        })),
        componentTemplate,
        workspaceName: workspace.name,
        branding,
        advanceOutstanding: teamMember?._id
          ? await this.fetchOutstandingBalanceInternal(
              workspaceId,
              this.getObjectIdString(teamMember._id),
            ).catch(() => undefined)
          : undefined,
        loanOutstanding: teamMember?._id
          ? await this.fetchOutstandingLoanBalanceInternal(
              workspaceId,
              this.getObjectIdString(teamMember._id),
            ).catch(() => undefined)
          : undefined,
      });
    }

    return results;
  }

  /** Sum of remainingAmount across all active/paused employer loans for a member. */
  private async fetchOutstandingLoanBalanceInternal(
    workspaceId: string,
    teamMemberId: string,
  ): Promise<number | undefined> {
    const loans = await this.employerLoanModel
      .find({
        workspaceId: toObjectId(workspaceId),
        teamMemberId: toObjectId(teamMemberId),
        status: { $in: ['active', 'paused'] },
      })
      .select('remainingAmount')
      .lean()
      .exec();

    const total = loans.reduce((sum, l) => sum + (Number(l.remainingAmount) || 0), 0);
    return total > 0 ? Math.round(total * 100) / 100 : undefined;
  }

  async sendPayslipEmail(
    workspaceId: string,
    salaryId: string,
    userId?: string,
  ): Promise<{ sent: boolean; reason?: string }> {
    await this.assertFeatureEnabled(workspaceId, 'payslipGeneration', 'Payslip generation');

    const workspaceObjectId = toObjectId(workspaceId);
    const salaryObjectId = toObjectId(salaryId);
    const record = await this.salaryModel
      .findOne({ _id: salaryObjectId, workspaceId: workspaceObjectId })
      .exec();

    if (!record) {
      throw new NotFoundException('Salary record not found');
    }

    const member = await this.teamModel.findById(record.teamMemberId).select('name email').exec();

    if (!member?.email) {
      return {
        sent: false,
        reason: 'Employee has no email address on record',
      };
    }

    // Fetch full payslip data and generate PDF server-side
    const payslipDataArr = await this.getPayslipData(workspaceId, [salaryId]);
    const payslipData = payslipDataArr[0];

    if (!payslipData) {
      throw new NotFoundException('Payslip data not found');
    }

    const config = await this.getPayrollConfig(workspaceId);
    const currencyConfig = {
      symbol: config.display?.currencySymbol || '₹',
      locale: config.display?.currencyLocale || 'en-IN',
      code: config.display?.currencyCode || 'INR',
    };

    const pdfBuffer = await this.payslipPdfService.generatePayslipBuffer({
      record: payslipData.record as any,
      adjustments: payslipData.adjustments as any[],
      payments: payslipData.payments as any[],
      componentTemplate: payslipData.componentTemplate as any,
      workspaceName: payslipData.workspaceName,
      branding: payslipData.branding,
      currencyConfig,
      advanceOutstanding: payslipData.advanceOutstanding,
      loanOutstanding: (payslipData as any).loanOutstanding,
    });
    const pdfBase64 = pdfBuffer.toString('base64');
    const filename = this.payslipPdfService.getPayslipFilename({
      record: payslipData.record as any,
      adjustments: payslipData.adjustments as any[],
      payments: payslipData.payments as any[],
      workspaceName: payslipData.workspaceName,
    });

    const currencySymbol = currencyConfig.symbol;
    const formattedNetSalary = new Intl.NumberFormat(currencyConfig.locale).format(
      record.netSalary || 0,
    );
    const statusLabel =
      record.status === 'paid'
        ? 'Paid'
        : record.status === 'partial'
          ? 'Partially Paid'
          : 'Pending';

    const workspace = await this.workspaceModel
      .findById(workspaceObjectId)
      // Workspaces hardening OQ-W8: the SMTP `pass` field is now `select: false`
      // at the schema level, so it must be re-included explicitly here — this is
      // a functional reader (payslip-over-custom-SMTP send needs the real value).
      .select('name ownerId emailConfig +emailConfig.smtpConfig.pass')
      .populate('ownerId', 'name email')
      .exec();

    // Wave-3 Drift #32 — universal email quota enforcement.
    // Helper returns { allowed, reason } so this fire-and-forget caller can
    // skip silently rather than throw 403 (matches old inline behaviour).
    const quotaResult = await this.mailService.checkEmailQuota(String(workspaceObjectId));
    if (!quotaResult.allowed) {
      return {
        sent: false,
        reason: quotaResult.reason || `Monthly email limit reached (${quotaResult.effectiveLimit})`,
      };
    }

    const owner = workspace?.ownerId as any;

    await this.mailService.sendPayslipEmail({
      to: member.email,
      employeeName: member.name,
      workspaceName: workspace?.name || 'Your Company',
      month: record.month,
      year: record.year,
      netSalary: `${currencySymbol}${formattedNetSalary}`,
      paymentStatus: statusLabel,
      currencySymbol,
      pdfBase64,
      filename,
      replyToEmail: owner?.email,
      replyToName: owner?.name,
      customSmtpConfig: workspace?.emailConfig?.smtpConfig,
    });

    // Persist tracking
    await this.salaryModel.updateOne(
      { _id: salaryObjectId },
      {
        $set: {
          payslipEmailSentAt: new Date(),
          payslipEmailSentBy: userId ? toObjectId(userId) : undefined,
        },
      },
    );

    // Wave-3 Drift #32 — centralised counter increment via MailService.
    await this.mailService.incrementEmailUsage(String(workspaceObjectId));

    return { sent: true };
  }

  async sendBulkPayslipEmails(
    workspaceId: string,
    salaryIds: string[],
    userId?: string,
  ): Promise<{
    sent: number;
    failed: number;
    skipped: number;
    details: Array<{
      salaryId: string;
      result: { sent: boolean; reason?: string };
    }>;
  }> {
    await this.assertFeatureEnabled(workspaceId, 'payslipGeneration', 'Payslip generation');

    const details: Array<{
      salaryId: string;
      result: { sent: boolean; reason?: string };
    }> = [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const salaryId of salaryIds) {
      try {
        const result = await this.sendPayslipEmail(workspaceId, salaryId, userId);

        if (result.sent) {
          sent += 1;
        } else {
          skipped += 1;
        }

        details.push({ salaryId, result });
      } catch (error) {
        failed += 1;
        details.push({
          salaryId,
          result: {
            sent: false,
            reason: error instanceof Error ? error.message : 'Failed to send payslip email',
          },
        });
      }
    }

    return {
      sent,
      failed,
      skipped,
      details,
    };
  }

  async getMonthlyTaskStatus(workspaceId: string, month: number, year: number) {
    const workspaceObjectId = toObjectId(workspaceId);

    const records = await this.salaryModel
      .find({ workspaceId: workspaceObjectId, month, year })
      .select('_id teamMemberId payslipEmailSentAt payslipEmailSentBy isLocked lockedAt lockedBy')
      .lean()
      .exec();

    const memberIds = records.map((r) => r.teamMemberId);
    const actorIds = records
      .flatMap((r) => [r.lockedBy, r.payslipEmailSentBy])
      .filter(Boolean) as Types.ObjectId[];

    const [teamMembers, users] = await Promise.all([
      this.teamModel
        .find({ _id: { $in: memberIds } })
        .select('_id name email')
        .lean()
        .exec(),
      actorIds.length > 0
        ? this.userModel
            .find({ _id: { $in: actorIds } })
            .select('_id name')
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    const memberMap = new Map(teamMembers.map((m) => [m._id.toString(), m]));
    const userMap = new Map(users.map((u) => [(u._id as Types.ObjectId).toString(), u]));

    const members = records.map((r) => {
      const tm = memberMap.get(r.teamMemberId.toString());
      const lockedByUser = r.lockedBy ? userMap.get(r.lockedBy.toString()) : null;
      const sentByUser = r.payslipEmailSentBy ? userMap.get(r.payslipEmailSentBy.toString()) : null;
      return {
        salaryId: r._id.toString(),
        teamMemberId: r.teamMemberId.toString(),
        name: tm?.name ?? '',
        email: (tm as any)?.email ?? '',
        payslipEmailSentAt: r.payslipEmailSentAt ? r.payslipEmailSentAt.toISOString() : null,
        payslipEmailSentByName: sentByUser?.name ?? null,
        isLocked: r.isLocked,
        lockedAt: r.lockedAt ? r.lockedAt.toISOString() : null,
        lockedByName: lockedByUser?.name ?? null,
      };
    });

    const sentCount = members.filter((m) => m.payslipEmailSentAt !== null).length;
    const lockedCount = members.filter((m) => m.isLocked).length;

    const workspace = await this.workspaceModel
      .findById(workspaceObjectId)
      .select('ownerId emailConfig')
      .lean()
      .exec();

    const currentMonthKey = new Date().toISOString().slice(0, 7);
    const emailLimitOverride = workspace?.emailConfig?.emailLimitOverride ?? null;
    let limit = 0;
    if (emailLimitOverride !== null) {
      limit = emailLimitOverride;
    } else {
      const ownerId = (workspace?.ownerId as any)?._id ?? workspace?.ownerId;
      if (ownerId) {
        const sub = await this.subscriptionModel
          .findOne({ userId: ownerId, status: { $in: ['active', 'trial'] } })
          .select('appliedEntitlements.emailsPerMonth')
          .lean()
          .exec();
        limit = (sub?.appliedEntitlements as any)?.emailsPerMonth ?? 0;
      }
    }

    const usage = workspace?.emailConfig?.usage;
    const usedCount = usage?.monthKey === currentMonthKey ? usage.count : 0;

    return {
      payslipEmails: {
        total: members.length,
        sent: sentCount,
        locked: lockedCount,
        members,
      },
      emailQuota: { limit, used: usedCount, monthKey: currentMonthKey },
    };
  }

  async getLedgerHistory(workspaceId: string, teamMemberId: string, userId: string) {
    if (!Types.ObjectId.isValid(teamMemberId)) {
      throw new NotFoundException('Team member not found');
    }

    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);

    const workspaceObjectId = toObjectId(workspaceId);
    const memberObjectId = toObjectId(teamMemberId);

    const member = await this.teamModel.findById(memberObjectId).exec();

    const salaries = await this.salaryModel
      .find({
        workspaceId: workspaceObjectId,
        teamMemberId: memberObjectId,
      })
      .sort({ year: -1, month: -1 })
      .lean()
      .exec();

    const payments = await this.paymentModel
      .find({
        workspaceId: workspaceObjectId,
        teamMemberId: memberObjectId,
      })
      .populate('recordedBy', 'name')
      .sort({ paymentDate: -1 })
      .lean()
      .exec();

    const months = salaries.map((salary) => {
      const salaryIdStr = salary._id.toString();
      const monthPayments = payments.filter((payment) => {
        const paymentSalaryId = payment.salaryId;
        if (!paymentSalaryId) return false;
        const paymentSalaryIdStr =
          paymentSalaryId instanceof Types.ObjectId
            ? paymentSalaryId.toString()
            : typeof paymentSalaryId === 'string'
              ? paymentSalaryId
              : (paymentSalaryId as unknown as Types.ObjectId).toString();
        return paymentSalaryIdStr === salaryIdStr;
      });
      const paid = monthPayments
        .filter((payment) => this.getPaymentStatus(payment) !== 'reversed')
        .reduce((sum, payment) => sum + payment.amount + (payment.commission || 0), 0);

      const date = new Date(salary.year, salary.month - 1);
      const monthLabel = date.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
      });
      const monthKey = `${salary.year}-${String(salary.month).padStart(2, '0')}`;

      return {
        salaryId: salaryIdStr,
        monthKey,
        monthLabel,
        salary: salary.netSalary,
        status: salary.status,
        baseSalary: salary.baseSalary,
        additions: salary.additions,
        deductions: salary.deductions,
        isLocked: salary.isLocked ?? false,
        paid,
        remaining: salary.netSalary - paid,
        transactions: monthPayments.map((payment) => {
          const recordedByPop = payment.recordedBy as { name: string } | undefined;
          return {
            id: String(payment._id),
            transactionType: 'salary',
            amount: payment.amount + (payment.commission || 0),
            method: payment.paymentMode === 'bank_transfer' ? 'bank' : payment.paymentMode,
            dateTime:
              payment.paymentDate instanceof Date
                ? payment.paymentDate.toISOString()
                : new Date(payment.paymentDate).toISOString(),
            recordedBy: recordedByPop?.name || 'Admin',
            paidBy: payment.paidBy,
            referenceNo: payment.referenceNo,
            proofAttached:
              (payment.proofUrls && payment.proofUrls.length > 0) || !!payment.proofUrl,
            proofUrl: payment.proofUrls?.[0] || payment.proofUrl,
            proofUrls: payment.proofUrls,
            upiDebitedAccount: payment.upiDebitedAccount?.accountNumber
              ? String(payment.upiDebitedAccount.accountNumber)
              : undefined,
            bankFromAccount: payment.bankFromAccount?.accountNumber
              ? String(payment.bankFromAccount.accountNumber)
              : undefined,
            paymentFrom: payment.paymentFrom ? String(payment.paymentFrom) : undefined,
            splitLines: payment.splitLines?.map((splitLine: PaymentSplitLine) => ({
              ...splitLine,
              method:
                String(splitLine.method) === 'bank_transfer' ? 'bank' : String(splitLine.method),
              paymentFrom: splitLine.paymentFrom ? String(splitLine.paymentFrom) : undefined,
            })),
            note: payment.note,
            commission: payment.commission,
            commissionNote: payment.commissionNote,
            status: payment.status || 'active',
            reversedAt: payment.reversedAt,
            reversalReason: payment.reversalReason,
          } as const;
        }),
      };
    });

    const totalSalary = salaries.reduce((sum, salary) => sum + salary.netSalary, 0);
    const totalPaid = payments
      .filter((payment) => this.getPaymentStatus(payment) !== 'reversed')
      .reduce((sum, payment) => sum + payment.amount + (payment.commission || 0), 0);

    const memberExt = member as unknown as { employeeCode?: string } | null;

    return {
      employeeId: teamMemberId,
      employeeName: member?.name ?? '',
      employeeCode: memberExt?.employeeCode || member?.designation || '',
      employeePhoto: member?.avatar,
      months,
      totalSalary,
      totalPaid,
      totalRemaining: totalSalary - totalPaid,
      totalTransactions: payments.length,
    };
  }

  /**
   * Access Control Initiative - Salary A2 (2026-05-29). Self-scoped own-record
   * payslip bundle for client-side PDF download. Routed through the existing
   * own-id chokepoint, then re-checks the salaryId belongs to the caller, so a
   * worker cannot download another member's payslip by id-swapping. Returns the
   * same shape as getPayslipData plus currencyConfig so the client needs no
   * extra (and possibly all-scoped) payroll-config read.
   */
  async getOwnPayslipDownload(
    workspaceId: string,
    teamMemberId: string,
    salaryId: string,
    userId: string,
  ) {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);

    if (!Types.ObjectId.isValid(salaryId)) {
      throw new NotFoundException('Payslip data not found');
    }

    const [payslipData] = await this.getPayslipData(workspaceId, [salaryId]);
    if (!payslipData) {
      throw new NotFoundException('Payslip data not found');
    }
    const rawMemberId = payslipData.record.teamMemberId;
    const recordMemberId =
      rawMemberId && typeof rawMemberId === 'object' && '_id' in rawMemberId
        ? String(rawMemberId._id)
        : String(rawMemberId);
    if (recordMemberId !== String(teamMemberId)) {
      throw new ForbiddenException('Your role only permits viewing your own salary data.');
    }

    const config = await this.getPayrollConfig(workspaceId);
    return {
      ...payslipData,
      currencyConfig: {
        symbol: config.display?.currencySymbol || 'Rs',
        locale: config.display?.currencyLocale || 'en-IN',
        code: config.display?.currencyCode || 'INR',
      },
    };
  }

  async getGratuityLedger(
    workspaceId: string,
    teamMemberId: string,
    userId: string,
  ): Promise<GratuityLedger | null> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);
    return this.gratuityService.getGratuityLedger(workspaceId, teamMemberId);
  }

  async getWorkspaceGratuitySummary(workspaceId: string): Promise<{
    totalEligibleEmployees: number;
    totalGratuityLiability: number;
    nearingEligibility: number;
    ledgers: Array<GratuityLedger & { employeeName?: string; designation?: string }>;
  }> {
    return this.gratuityService.getWorkspaceGratuitySummary(workspaceId);
  }

  async initiateFnf(
    workspaceId: string,
    teamMemberId: string,
    dto: {
      lastWorkingDate: string;
      noticePeriodDays: number;
      noticeServedDays: number;
      leaveBalanceDays?: number;
      otherAdditions?: Array<{ description: string; amount: number }>;
      otherDeductions?: Array<{ description: string; amount: number }>;
      notes?: string;
      resignationReason?: string;
    },
    userId: string,
  ): Promise<FnfSettlement> {
    return this.withSalarySpan(
      'salary.initiateFnf',
      { workspaceId, teamMemberId, userId },
      async () => {
        // OQ-S2: a non-owner cannot initiate their OWN F&F (SoD). No offboard
        // writability check here — F&F IS the offboarding write (OQ-S5 carve-out).
        await this.assertNotSelfSalaryEdit(workspaceId, userId, teamMemberId);
        const result = await this.fnfService.initiateFnf(workspaceId, teamMemberId, dto, userId);
        this.postHog.capture({
          distinctId: userId,
          event: 'salary.fnf_initiated',
          properties: {
            workspaceId,
            teamMemberId,
            lastWorkingDate: dto.lastWorkingDate,
            noticePeriodDays: dto.noticePeriodDays,
            noticeServedDays: dto.noticeServedDays,
            hasLeaveBalance: (dto.leaveBalanceDays ?? 0) > 0,
            otherAdditionsCount: dto.otherAdditions?.length ?? 0,
            otherDeductionsCount: dto.otherDeductions?.length ?? 0,
          },
        });
        return result;
      },
    );
  }

  async getFnfSettlement(
    workspaceId: string,
    teamMemberId: string,
    userId: string,
  ): Promise<FnfSettlement | null> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);
    return this.fnfService.getFnfSettlement(workspaceId, teamMemberId);
  }

  async finaliseFnf(
    workspaceId: string,
    teamMemberId: string,
    userId: string,
  ): Promise<FnfSettlement> {
    return this.withSalarySpan(
      'salary.finaliseFnf',
      { workspaceId, teamMemberId, userId },
      async () => {
        // OQ-S2: a non-owner cannot finalise their OWN F&F (SoD). F&F stays
        // available on removed members (OQ-S5 carve-out — it is the closing write).
        await this.assertNotSelfSalaryEdit(workspaceId, userId, teamMemberId);
        try {
          const result = await this.fnfService.finaliseFnf(workspaceId, teamMemberId, userId);
          this.postHog.capture({
            distinctId: userId,
            event: 'salary.fnf_finalised',
            properties: {
              workspaceId,
              teamMemberId,
              settlementId: String((result as any)._id ?? ''),
            },
          });
          return result;
        } catch (err) {
          Sentry.captureException(err, { tags: { module: 'salary', op: 'finaliseFnf' } });
          throw err;
        }
      },
    );
  }

  async getWorkspaceFnfList(workspaceId: string): Promise<FnfSettlement[]> {
    return this.fnfService.getWorkspaceFnfList(workspaceId);
  }

  async getSalaryRecordsForFy(
    workspaceId: string,
    teamMemberId: string,
    financialYear: number,
    fyStartMonth = 4,
  ): Promise<any[]> {
    const monthYearPairs: { month: number; year: number }[] = [];

    for (let i = 0; i < 12; i += 1) {
      const month = ((fyStartMonth - 1 + i) % 12) + 1;
      const year = fyStartMonth + i > 12 ? financialYear + 1 : financialYear;
      monthYearPairs.push({ month, year });
    }

    const workspaceObjectId = toObjectId(workspaceId);
    const memberObjectId = toObjectId(teamMemberId);

    const records = await this.salaryModel
      .find({
        workspaceId: workspaceObjectId,
        teamMemberId: memberObjectId,
        $or: monthYearPairs,
      })
      .sort({ year: 1, month: 1 })
      .lean()
      .exec();

    const enriched = await Promise.all(
      records.map(async (record) => {
        const [adjustments, payments] = await Promise.all([
          this.salaryAdjustmentModel
            .find({
              workspaceId: workspaceObjectId,
              salaryId: record._id,
              status: 'active',
            })
            .lean()
            .exec(),
          this.paymentModel
            .find({
              workspaceId: workspaceObjectId,
              salaryId: record._id,
              status: { $ne: 'reversed' },
            })
            .select('amount commission status')
            .lean()
            .exec(),
        ]);

        const paidAmount = payments.reduce(
          (sum, payment) => sum + Number(payment.amount || 0) + Number(payment.commission || 0),
          0,
        );

        return {
          record: {
            ...record,
            paidAmount,
          },
          adjustments,
        };
      }),
    );

    return enriched;
  }

  async addIncrement(workspaceId: string, userId: string, dto: CreateIncrementDto) {
    return this.withSalarySpan(
      'salary.addIncrement',
      { workspaceId, userId, teamMemberId: dto.teamMemberId, incrementType: dto.type },
      async () => {
        await this.assertFeatureEnabled(workspaceId, 'salaryIncrements', 'Salary increments');

        const workspaceObjectId = toObjectId(workspaceId);
        const teamMemberObjectId = toObjectId(dto.teamMemberId);
        const userObjectId = toObjectId(userId);

        const member = await this.teamModel.findById(teamMemberObjectId).exec();

        if (!member) {
          throw new NotFoundException('Team member not found');
        }

        const latestIncrement = await this.incrementModel
          .findOne({
            workspaceId: workspaceObjectId,
            teamMemberId: teamMemberObjectId,
          })
          .sort({ effectiveYear: -1, effectiveMonth: -1 })
          .exec();

        const previousSalary = latestIncrement
          ? latestIncrement.newSalary
          : member.salaryAmount || 0;

        let newSalary: number;
        if (dto.type === 'fixed_amount') {
          newSalary = previousSalary + dto.value;
        } else {
          newSalary = Math.round(previousSalary * (1 + dto.value / 100));
        }

        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();

        const isPastOrCurrent =
          dto.effectiveYear < currentYear ||
          (dto.effectiveYear === currentYear && dto.effectiveMonth <= currentMonth);

        const increment = new this.incrementModel({
          workspaceId: workspaceObjectId,
          teamMemberId: teamMemberObjectId,
          effectiveMonth: dto.effectiveMonth,
          effectiveYear: dto.effectiveYear,
          type: dto.type,
          value: dto.value,
          previousSalary,
          newSalary,
          note: dto.note,
          isApplied: isPastOrCurrent,
          appliedAt: isPastOrCurrent ? now : undefined,
          createdBy: userObjectId,
        });

        try {
          await increment.save();
        } catch (error: unknown) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 11000
          ) {
            throw new ConflictException('An increment already exists for this month and year');
          }
          throw error;
        }

        if (isPastOrCurrent) {
          member.salaryAmount = newSalary;
          await member.save();
        }

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'salary_increment',
          entityId: String(increment._id),
          action: 'salary_increment.created',
          actorId: userId,
          teamMemberId: dto.teamMemberId,
          after: {
            type: dto.type,
            value: dto.value,
            previousSalary,
            newSalary,
            effectiveMonth: dto.effectiveMonth,
            effectiveYear: dto.effectiveYear,
            isApplied: isPastOrCurrent,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.increment_applied',
          properties: {
            workspaceId,
            teamMemberId: dto.teamMemberId,
            incrementType: dto.type,
            incrementValue: dto.value,
            previousSalary,
            newSalary,
            effectiveMonth: dto.effectiveMonth,
            effectiveYear: dto.effectiveYear,
            isApplied: isPastOrCurrent,
          },
        });

        return increment;
      },
    );
  }

  async getIncrements(workspaceId: string, teamMemberId: string, userId: string) {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);
    const workspaceObjectId = toObjectId(workspaceId);
    const teamMemberObjectId = toObjectId(teamMemberId);

    return this.incrementModel
      .find({
        workspaceId: workspaceObjectId,
        teamMemberId: teamMemberObjectId,
      })
      .sort({ effectiveYear: -1, effectiveMonth: -1 })
      .exec();
  }

  async deleteIncrement(workspaceId: string, incrementId: string) {
    await this.assertFeatureEnabled(workspaceId, 'salaryIncrements', 'Salary increments');

    const workspaceObjectId = toObjectId(workspaceId);
    const incrementObjectId = toObjectId(incrementId);

    const increment = await this.incrementModel
      .findOne({
        _id: incrementObjectId,
        workspaceId: workspaceObjectId,
      })
      .exec();

    if (!increment) {
      throw new NotFoundException('Increment not found');
    }

    if (increment.isApplied) {
      throw new BadRequestException('Cannot delete an applied increment');
    }

    await this.incrementModel.deleteOne({ _id: incrementObjectId }).exec();
    return { success: true };
  }

  async applyPendingIncrement(
    workspaceId: string,
    teamMemberId: Types.ObjectId,
    month: number,
    year: number,
  ) {
    const workspaceObjectId = toObjectId(workspaceId);

    const pendingIncrement = await this.incrementModel
      .findOne({
        workspaceId: workspaceObjectId,
        teamMemberId,
        isApplied: false,
        $or: [
          { effectiveYear: { $lt: year } },
          { effectiveYear: year, effectiveMonth: { $lte: month } },
        ],
      })
      .sort({ effectiveYear: -1, effectiveMonth: -1 })
      .exec();

    if (pendingIncrement) {
      const member = await this.teamModel.findById(teamMemberId).exec();
      if (member) {
        member.salaryAmount = pendingIncrement.newSalary;
        await member.save();

        pendingIncrement.isApplied = true;
        pendingIncrement.appliedAt = new Date();
        await pendingIncrement.save();
      }
    }
  }

  async getPayrollConfig(workspaceId: string): Promise<PayrollConfig> {
    const workspaceObjectId = toObjectId(workspaceId);

    return this.payrollConfigModel
      .findOneAndUpdate(
        { workspaceId: workspaceObjectId },
        {
          $setOnInsert: {
            workspaceId: workspaceObjectId,
            preset: 'basic',
            features: PAYROLL_PRESETS.basic.features,
            rules: PAYROLL_PRESETS.basic.rules,
            display: PAYROLL_PRESETS.basic.display,
          },
        },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  async getTaxDeclaration(
    workspaceId: string,
    teamMemberId: string,
    financialYear: number,
    userId: string,
  ): Promise<TaxDeclaration | null> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);
    return this.tdsService.getDeclaration(workspaceId, teamMemberId, financialYear);
  }

  /**
   * OQ-S6 — tax-declaration upsert with worker self-service.
   *
   * Scope-aware. The route is decorated DECLARE_TAX@self (security-review fix
   * HIGH-1) — a dedicated self-service action, NOT salary.edit, because the
   * seeded Worker role has no salary.edit grant. RolesGuard admits any caller
   * holding `salary.declare_tax` at self OR all scope:
   *   - SELF caller (Worker, declare_tax scope=self): may upsert ONLY their own
   *     FY declaration, and only while it is not locked. They CANNOT set the lock
   *     flag (that is an HR control). A target mismatch → 403; a locked
   *     declaration → 403 DECLARATION_LOCKED.
   *   - ALL caller (HR, declare_tax scope=all) / owner: may upsert any member's
   *     declaration and may set/clear `isLocked` at the cutoff.
   *
   * Scope is resolved on the `declare_tax` action (the action the route gates on),
   * so the self-vs-all branch can never diverge from what RolesGuard admitted.
   * The self anchor + scope come from CallerScopeService (live RBAC), never the
   * payload — so a worker can never declare on another member's behalf (IDOR-safe).
   */
  async upsertTaxDeclaration(
    workspaceId: string,
    teamMemberId: string,
    dto: UpsertTaxDeclarationDto & { isLocked?: boolean },
    userId: string,
  ): Promise<TaxDeclaration> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    const scope = this.callerScope.effectiveScope(ctx, 'salary', 'declare_tax');
    const isAllScoped = ctx.isOwner || scope === 'all';

    if (!isAllScoped) {
      // Self-scoped worker path.
      if (scope !== 'self') {
        // No salary.declare_tax grant at all → deny (the route admitted them via
        // some other path; fail closed).
        throw new ForbiddenException('You do not have permission to edit tax declarations.');
      }
      if (!ctx.teamMemberId || String(ctx.teamMemberId) !== String(teamMemberId)) {
        throw new ForbiddenException('You can only update your own tax declaration.');
      }
      // OQ-S6: a worker cannot self-set the lock flag — strip it defensively.
      if ('isLocked' in dto) delete (dto as { isLocked?: boolean }).isLocked;
      // Block edits once HR has locked the declaration at the cutoff.
      const existing = await this.tdsService.getDeclaration(
        workspaceId,
        teamMemberId,
        dto.financialYear,
      );
      if (existing?.isLocked) {
        throw new ForbiddenException({
          code: 'DECLARATION_LOCKED',
          message:
            'Your tax declaration is locked for this financial year. Contact HR to make changes.',
        });
      }
    }

    const { financialYear, ...updates } = dto;

    return this.tdsService.updateDeclaration(
      workspaceId,
      teamMemberId,
      financialYear,
      updates,
      userId,
    );
  }

  async getTdsPreview(
    workspaceId: string,
    teamMemberId: string,
    month: number,
    year: number,
    userId: string,
  ): Promise<{
    estimatedMonthlyTds: number;
    financialYear: number;
    regime: 'old' | 'new';
    hasPan: boolean;
  }> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);
    const workspaceObjectId = toObjectId(workspaceId);
    const teamMemberObjectId = toObjectId(teamMemberId);
    const member = await this.teamModel
      .findOne({ _id: teamMemberObjectId, workspaceId: workspaceObjectId })
      .exec();

    if (!member) {
      throw new NotFoundException('Team member not found');
    }

    const workspace = await this.workspaceModel
      .findById(workspaceObjectId)
      .select('fiscalYearStartMonth')
      .exec();
    const fyStartMonth = workspace?.fiscalYearStartMonth || 4;
    const financialYear = this.tdsService.getFinancialYear(month, year, fyStartMonth);
    const declaration = await this.tdsService.getDeclaration(
      workspaceId,
      teamMemberId,
      financialYear,
    );
    const regime: 'old' | 'new' =
      declaration?.taxRegime || (member.taxRegime === 'old' ? 'old' : 'new');
    const fyMonthRange = this.tdsService.getFyMonthRange(financialYear, fyStartMonth);
    const salaryRecord = await this.salaryModel
      .findOne({
        workspaceId: workspaceObjectId,
        teamMemberId: teamMemberObjectId,
        month,
        year,
      })
      .exec();

    const currentTdsAdjustment = salaryRecord
      ? await this.salaryAdjustmentModel
          .findOne({
            workspaceId: workspaceObjectId,
            salaryId: salaryRecord._id,
            category: 'tds_employee',
            source: 'system',
            status: 'active',
          })
          .exec()
      : null;
    const monthlySalary = salaryRecord
      ? salaryRecord.netSalary + (currentTdsAdjustment?.amount || 0)
      : member.salaryType === 'hourly'
        ? member.finalMonthlyOverride || member.salaryAmount || 0
        : member.salaryAmount || 0;
    const tdsDedutedSoFar = await this.getTdsDeductedSoFarInFy({
      workspaceObjectId,
      teamMemberId: teamMemberObjectId,
      fyMonthRange,
      excludeSalaryId: salaryRecord?._id,
    });
    const { joinMonth, joinYear } = this.getTeamMemberJoinDateParts(member);
    const hasPan = Boolean(member.pan?.trim());
    const estimatedMonthlyTds = this.tdsService.computeMonthlyTds({
      monthlySalary,
      month,
      year,
      joinMonth,
      joinYear,
      fyStartMonth,
      declaration,
      regime,
      tdsDedutedSoFar,
      hasPan,
      isNonItrFiler: member.isNonItrFiler || false,
    });

    return {
      estimatedMonthlyTds,
      financialYear,
      regime,
      hasPan,
    };
  }

  async getForm16Data(
    workspaceId: string,
    teamMemberId: string,
    financialYear: number,
    userId: string,
  ): Promise<any> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);

    const workspaceObjectId = toObjectId(workspaceId);
    const teamMemberObjectId = toObjectId(teamMemberId);
    const workspace = (await this.workspaceModel
      .findById(workspaceObjectId)
      .select('name fiscalYearStartMonth')
      .lean()
      .exec()) as {
      name?: string;
      fiscalYearStartMonth?: number;
    } | null;
    const fyStartMonth = workspace?.fiscalYearStartMonth || 4;
    const member = (await this.teamModel
      .findOne({
        _id: teamMemberObjectId,
        workspaceId: workspaceObjectId,
      })
      .select('name pan designation employmentType taxRegime dateOfJoining')
      .lean()
      .exec()) as {
      name?: string;
      pan?: string;
      designation?: string;
      employmentType?: string;
      taxRegime?: 'old' | 'new';
      dateOfJoining?: Date | string;
    } | null;

    if (!member) {
      throw new NotFoundException('Team member not found');
    }

    const [config, fyRecords, declaration] = await Promise.all([
      this.getPayrollConfig(workspaceId),
      this.getSalaryRecordsForFy(workspaceId, teamMemberId, financialYear, fyStartMonth),
      this.tdsService.getDeclaration(workspaceId, teamMemberId, financialYear),
    ]);

    let totalBaseSalary = 0;
    let totalAdditions = 0;
    let totalDeductions = 0;
    let totalPfDeducted = 0;
    let totalEsiDeducted = 0;
    let totalPtDeducted = 0;
    let totalTdsDeducted = 0;
    let totalNetSalary = 0;
    let totalPaidAmount = 0;
    // Perquisite total: loan_perquisite phantom additions are excluded from
    // record.additions (net-pay field) but must appear in Form 16 gross
    // taxable income under Section 17(2). Aggregated separately here.
    let totalPerquisite = 0;

    const monthlyBreakdown = fyRecords.map(({ record, adjustments }) => {
      const baseSalary = Number(record.baseSalary || 0);
      const additions = Number(record.additions || 0);
      const deductions = Number(record.deductions || 0);
      const netSalary = Number(record.netSalary || 0);
      const paidAmount = Number(record.paidAmount || 0);
      const pfAdj = adjustments
        .filter(
          (adjustment) => adjustment.category === 'pf_employee' && adjustment.type === 'deduction',
        )
        .reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);
      const esiAdj = adjustments
        .filter(
          (adjustment) => adjustment.category === 'esi_employee' && adjustment.type === 'deduction',
        )
        .reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);
      const ptAdj = adjustments
        .filter(
          (adjustment) => adjustment.category === 'pt_employee' && adjustment.type === 'deduction',
        )
        .reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);
      const tdsAdj = adjustments
        .filter(
          (adjustment) => adjustment.category === 'tds_employee' && adjustment.type === 'deduction',
        )
        .reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);
      // Employer-loan perquisite additions (IT Rule 3(7)(i)): taxable but
      // non-cash; excluded from record.additions (net pay) so summed here.
      const perquisiteAdj = adjustments
        .filter(
          (adjustment) =>
            adjustment.category === 'loan_perquisite' && adjustment.type === 'addition',
        )
        .reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);

      totalBaseSalary += baseSalary;
      totalAdditions += additions;
      totalDeductions += deductions;
      totalPfDeducted += pfAdj;
      totalEsiDeducted += esiAdj;
      totalPtDeducted += ptAdj;
      totalTdsDeducted += tdsAdj;
      totalNetSalary += netSalary;
      totalPaidAmount += paidAmount;
      totalPerquisite += perquisiteAdj;

      return {
        month: Number(record.month || 0),
        year: Number(record.year || 0),
        baseSalary,
        additions,
        deductions,
        netSalary,
        paidAmount,
        pf: pfAdj,
        esi: esiAdj,
        pt: ptAdj,
        tds: tdsAdj,
        // Perquisite u/s 17(2): phantom taxable amount not in net pay.
        perquisite: perquisiteAdj,
      };
    });

    // Gross taxable includes both cash additions and phantom perquisites.
    const totalGrossSalary = totalBaseSalary + totalAdditions + totalPerquisite;
    const taxRegime: 'old' | 'new' =
      declaration?.taxRegime || (member.taxRegime === 'old' ? 'old' : 'new');

    return {
      employeeName: member.name || '',
      employeePan: member.pan || '',
      employeeDesignation: member.designation || '',
      taxRegime,
      employerName: workspace?.name || '',
      financialYear,
      fyLabel: `${financialYear}-${String(financialYear + 1).slice(2)}`,
      totalGrossSalary,
      totalBaseSalary,
      totalAdditions,
      // Perquisites u/s 17(2): loan_perquisite phantom additions excluded from
      // totalAdditions (non-cash) but included in totalGrossSalary for TDS.
      totalPerquisite,
      totalDeductions,
      totalNetSalary,
      totalPaidAmount,
      totalPfDeducted,
      totalEsiDeducted,
      totalPtDeducted,
      totalTdsDeducted,
      declaration: declaration
        ? {
            taxRegime: declaration.taxRegime,
            hraExemption: declaration.hraExemption || 0,
            standardDeduction:
              declaration.standardDeduction || (declaration.taxRegime === 'new' ? 75000 : 50000),
            deduction80C: declaration.deduction80C || 0,
            deduction80D: declaration.deduction80D || 0,
            deduction80G: declaration.deduction80G || 0,
            deduction80CCD1B: declaration.deduction80CCD1B || 0,
            deduction80TTA: declaration.deduction80TTA || 0,
            otherDeductions: declaration.otherDeductions || 0,
            previousEmployerGross: declaration.previousEmployerGross || 0,
            previousEmployerTds: declaration.previousEmployerTds || 0,
          }
        : null,
      monthlyBreakdown,
      currencySymbol: config.display?.currencySymbol || '₹',
      currencyLocale: config.display?.currencyLocale || 'en-IN',
      branding: null,
    };
  }

  async getEcrExport(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<{
    rows: Awaited<ReturnType<ComplianceExportService['buildEcrData']>>;
    text: string;
    filename: string;
    summary: {
      totalEmployees: number;
      totalEpfContribution: number;
      totalEpsContribution: number;
      totalEdliWages: number;
      totalNcpDays: number;
      excludedMissingUanCount: number;
    };
  }> {
    const [workspace, config, salaryRecords] = await Promise.all([
      this.workspaceModel.findById(toObjectId(workspaceId)).select('name').exec(),
      this.getPayrollConfig(workspaceId),
      this.getSalaryRecords(workspaceId, month, year, SALARY_INTERNAL_UNFILTERED),
    ]);

    const statutory = config.statutory || {
      pfEnabled: false,
      pfEstablishmentCode: '',
      pfWageCeiling: 15000,
    };
    const pfWageCeiling = Number(statutory.pfWageCeiling) || 15000;
    const establishmentName = workspace?.name?.trim() || 'ESTABLISHMENT';
    const establishmentCode = statutory.pfEstablishmentCode || '';
    const monthStr = String(month).padStart(2, '0');

    const excludedMissingUanCount = statutory.pfEnabled
      ? salaryRecords.reduce((count, record) => {
          const member = this.getComplianceRecordMember(record);
          if (!member) {
            return count;
          }

          const employmentType = member.employmentType || 'full_time';
          const pfApplicable =
            member.pfApplicable !== false &&
            member.pfOptedOut !== true &&
            !['contract', 'consultant', 'intern'].includes(employmentType);

          if (!pfApplicable || member.uan?.trim()) {
            return count;
          }

          return count + 1;
        }, 0)
      : 0;

    const rows = statutory.pfEnabled
      ? await this.complianceExportService.buildEcrData(
          workspaceId,
          month,
          year,
          salaryRecords as Array<Record<string, unknown>>,
          pfWageCeiling,
        )
      : [];

    const text = this.complianceExportService.formatEcrText(
      rows,
      establishmentName,
      establishmentCode,
      month,
      year,
    );

    return {
      rows,
      text,
      filename: `ECR_${this.sanitizeComplianceCode(establishmentCode)}${monthStr}${year}.txt`,
      summary: {
        totalEmployees: rows.length,
        totalEpfContribution: rows.reduce((sum, row) => sum + row.epfContribution, 0),
        totalEpsContribution: rows.reduce((sum, row) => sum + row.epsContribution, 0),
        totalEdliWages: rows.reduce((sum, row) => sum + row.edliWages, 0),
        totalNcpDays: rows.reduce((sum, row) => sum + row.ncp, 0),
        excludedMissingUanCount,
      },
    };
  }

  async getEsiChallanExport(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<{
    rows: Awaited<ReturnType<ComplianceExportService['buildEsiData']>>;
    csv: string;
    filename: string;
    summary: {
      totalEmployees: number;
      totalEmployeeContrib: number;
      totalEmployerContrib: number;
      totalContrib: number;
      missingIpNumberCount: number;
    };
  }> {
    const [config, salaryRecords] = await Promise.all([
      this.getPayrollConfig(workspaceId),
      this.getSalaryRecords(workspaceId, month, year, SALARY_INTERNAL_UNFILTERED),
    ]);

    const statutory = config.statutory || {
      esiEnabled: false,
      esiCode: '',
      esiGrossThreshold: 21000,
    };
    const esiGrossThreshold = Number(statutory.esiGrossThreshold) || 21000;
    const monthStr = String(month).padStart(2, '0');

    const rows = statutory.esiEnabled
      ? await this.complianceExportService.buildEsiData(
          workspaceId,
          month,
          year,
          salaryRecords as Array<Record<string, unknown>>,
          esiGrossThreshold,
        )
      : [];

    const csv = this.complianceExportService.formatEsiCsv(rows, month, year);

    return {
      rows,
      csv,
      filename: `ESI_${this.sanitizeComplianceCode(statutory.esiCode || '')}${monthStr}${year}.csv`,
      summary: {
        totalEmployees: rows.length,
        totalEmployeeContrib: rows.reduce((sum, row) => sum + row.employeeContribution, 0),
        totalEmployerContrib: rows.reduce((sum, row) => sum + row.employerContribution, 0),
        totalContrib: rows.reduce((sum, row) => sum + row.totalContribution, 0),
        missingIpNumberCount: rows.filter((row) => row.esicIpNumber === 'NOT_ASSIGNED').length,
      },
    };
  }

  async getBankFileExport(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<{
    bankRows: Awaited<ReturnType<ComplianceExportService['buildBankDisbursementData']>>['bankRows'];
    upiRows: Awaited<ReturnType<ComplianceExportService['buildBankDisbursementData']>>['upiRows'];
    skippedRows: Awaited<
      ReturnType<ComplianceExportService['buildBankDisbursementData']>
    >['skippedRows'];
    totalAmount: number;
    totalEmployees: number;
    bankCsv: string;
    upiCsv: string;
    bankFilename: string;
    upiFilename: string;
  }> {
    const workspace = await this.workspaceModel
      .findById(new Types.ObjectId(workspaceId))
      .select('name')
      .exec();

    const records = await this.getSalaryRecords(
      workspaceId,
      month,
      year,
      SALARY_INTERNAL_UNFILTERED,
    );
    const result = await this.complianceExportService.buildBankDisbursementData(
      records as Array<Record<string, unknown>>,
      month,
      year,
    );

    const bankCsv = this.complianceExportService.formatBankNeftCsv(
      result.bankRows,
      month,
      year,
      workspace?.name || '',
    );

    const upiCsv = this.complianceExportService.formatUpiCsv(
      result.upiRows,
      month,
      year,
      workspace?.name || '',
    );

    const mm = String(month).padStart(2, '0');

    return {
      ...result,
      bankCsv,
      upiCsv,
      bankFilename: `Bank_NEFT_${mm}_${year}.csv`,
      upiFilename: `UPI_Payments_${mm}_${year}.csv`,
    };
  }

  async getBankFileRowsCanonical(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<{ rows: CanonicalBankFileRow[] }> {
    const workspaceObjectId = toObjectId(workspaceId);

    const MONTHS = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const monthLabel = MONTHS[month - 1] || String(month);
    const mm = String(month).padStart(2, '0');
    const dd = String(new Date().getDate()).padStart(2, '0');
    const txnDate = `${dd}-${mm}-${year}`;

    const records = await this.salaryModel
      .find({ workspaceId: workspaceObjectId, month, year })
      .populate({
        path: 'teamMemberId',
        select:
          'name email mobile designation employmentType bankDetails upiDetails preferredMethod dateOfResignation isActive isDeleted employeeCode',
      })
      .exec();

    const salaryObjectIds = records.map((r) => toObjectId(String(r._id)));

    const paidAmountsAgg = await this.paymentModel.aggregate<{
      _id: Types.ObjectId;
      paidAmount: number;
    }>([
      {
        $match: {
          salaryId: { $in: salaryObjectIds },
          status: { $ne: 'reversed' },
        },
      },
      {
        $group: {
          _id: '$salaryId',
          paidAmount: {
            $sum: { $add: ['$amount', { $ifNull: ['$commission', 0] }] },
          },
        },
      },
    ]);

    const paidMap = new Map<string, number>(
      paidAmountsAgg.map((a) => [String(a._id), a.paidAmount]),
    );

    const rows: CanonicalBankFileRow[] = [];

    for (const record of records) {
      const member = (
        record.teamMemberId && typeof record.teamMemberId === 'object' ? record.teamMemberId : null
      ) as CanonicalBankMember | null;

      const employeeName = (member?.name || '').trim();
      const netSalary = Number((record as unknown as { netSalary?: number }).netSalary || 0);
      const paidSoFar = paidMap.get(String(record._id)) || 0;
      const remaining = Math.round((netSalary - paidSoFar) * 100) / 100;
      const isActive = member?.isActive !== false;
      const isDeleted = member?.isDeleted === true;
      const isLocked = Boolean((record as unknown as { isLocked?: boolean }).isLocked);
      const preferredMethod: string = member?.preferredMethod || 'BANK';
      const bankDetails = member?.bankDetails;
      const accountNumber = bankDetails?.accountNumber?.trim() || '';
      const ifsc = bankDetails?.ifscCode?.trim() || '';
      const accountHolderName = bankDetails?.accountHolderName?.trim() || employeeName;
      const bankName = bankDetails?.bankName?.trim() || '';
      const amount = Math.max(remaining, 0);
      const paymentMode: 'NEFT' | 'RTGS' | 'IMPS' = amount >= 200000 ? 'RTGS' : 'NEFT';

      rows.push({
        rowId: String(record._id),
        employeeCode: member?.employeeCode?.trim() || '',
        employeeName,
        beneficiaryName: accountHolderName,
        accountNumber,
        ifsc,
        bankName,
        netSalary,
        paidSoFar,
        amount,
        paymentMode,
        txnDate,
        remarks: `Salary ${monthLabel} ${year} - ${employeeName}`,
        email: member?.email?.trim(),
        mobile: member?.mobile?.trim(),
        upiId: member?.upiDetails?.upiId?.trim(),
        preferredMethod: ['BANK', 'UPI', 'CASH'].includes(preferredMethod)
          ? (preferredMethod as 'BANK' | 'UPI' | 'CASH')
          : 'UNKNOWN',
        isActive,
        isDeleted,
        isLocked,
      });
    }

    return { rows };
  }

  // ---------------------------------------------------------------------------
  // D-01 / D-03 owner-only config PATCH methods
  // ---------------------------------------------------------------------------

  async updateDisbursementRules(
    workspaceId: string,
    dto: UpdateDisbursementRulesDto,
  ): Promise<PayrollConfig> {
    const wsOid = new Types.ObjectId(workspaceId);
    const $set: Record<string, unknown> = {};
    if (dto.salaryDate !== undefined) $set['disbursementRules.salaryDate'] = dto.salaryDate;
    if (dto.payoutWindowDays !== undefined)
      $set['disbursementRules.payoutWindowDays'] = dto.payoutWindowDays;
    if (dto.advanceRequestDay !== undefined)
      $set['disbursementRules.advanceRequestDay'] = dto.advanceRequestDay;
    // Phase 1b: fixed advance payout day-of-month (separate from salaryDate).
    if (dto.advancePayoutDay !== undefined)
      $set['disbursementRules.advancePayoutDay'] = dto.advancePayoutDay;

    // Persist the structured request-window policy (any_day | window | fixed_day).
    // Mirrors the advanceRequestDay handling above; the window util reads this on
    // create and getWindowForMember exposes it to self-scoped workers.
    // Links: advance-request-window.util.ts, AdvanceRequestPolicyInputDto,
    //        AdvanceSalaryRequestService.getWindowForMember.
    if (dto.advanceRequestPolicy !== undefined) {
      $set['disbursementRules.advanceRequestPolicy'] = dto.advanceRequestPolicy;
      // Keep the legacy scalar in sync when a fixed day is chosen so pre-migration
      // code paths that still read advanceRequestDay as fallback stay correct.
      if (dto.advanceRequestPolicy.mode === 'fixed_day' && dto.advanceRequestPolicy.fixedDay) {
        $set['disbursementRules.advanceRequestDay'] = dto.advanceRequestPolicy.fixedDay;
      }
    }

    // Phase 3b: advance eligibility caps. `!== undefined` so an explicit null
    // (the web layer's "turn this cap off" signal) is persisted as null and the
    // createRequest guard treats it as off. Same $set['disbursementRules.X'] pattern.
    // Links: advance-salary-request.service.ts createRequest, DisbursementRulesPanel.tsx.
    if (dto.advanceMaxPercentOfNet !== undefined)
      $set['disbursementRules.advanceMaxPercentOfNet'] = dto.advanceMaxPercentOfNet;
    if (dto.advanceMaxPerYear !== undefined)
      $set['disbursementRules.advanceMaxPerYear'] = dto.advanceMaxPerYear;
    if (dto.advanceMinTenureMonths !== undefined)
      $set['disbursementRules.advanceMinTenureMonths'] = dto.advanceMinTenureMonths;

    const updated = await this.payrollConfigModel
      .findOneAndUpdate({ workspaceId: wsOid }, { $set }, { new: true, upsert: false })
      .exec();
    if (!updated) throw new NotFoundException('PayrollConfig not found');
    return updated;
  }

  async updateSalaryLossConfig(
    workspaceId: string,
    dto: UpdateSalaryLossConfigDto,
  ): Promise<PayrollConfig> {
    const wsOid = new Types.ObjectId(workspaceId);
    const $set: Record<string, unknown> = {};
    if (dto.regularizationWindowDays !== undefined)
      $set['salaryLossConfig.regularizationWindowDays'] = dto.regularizationWindowDays;
    if (dto.salaryLossEnabled !== undefined)
      $set['salaryLossConfig.salaryLossEnabled'] = dto.salaryLossEnabled;

    const updated = await this.payrollConfigModel
      .findOneAndUpdate({ workspaceId: wsOid }, { $set }, { new: true, upsert: false })
      .exec();
    if (!updated) throw new NotFoundException('PayrollConfig not found');
    return updated;
  }

  async updateAttendanceRules(
    workspaceId: string,
    dto: UpdateAttendanceRulesDto,
  ): Promise<PayrollConfig> {
    const wsOid = new Types.ObjectId(workspaceId);
    const $set: Record<string, unknown> = {};
    if (dto.holidayCountsAsPresent !== undefined)
      $set['rules.holidayCountsAsPresent'] = dto.holidayCountsAsPresent;
    if (dto.weekOffCountsAsPresent !== undefined)
      $set['rules.weekOffCountsAsPresent'] = dto.weekOffCountsAsPresent;
    if (dto.lateMarkAsHalfDay !== undefined)
      $set['rules.lateMarkAsHalfDay'] = dto.lateMarkAsHalfDay;

    const updated = await this.payrollConfigModel
      .findOneAndUpdate({ workspaceId: wsOid }, { $set }, { new: true, upsert: false })
      .exec();
    if (!updated) throw new NotFoundException('PayrollConfig not found');
    return updated;
  }

  // D-10: COA cash/bank account picker for the Pay drawer
  // ---------------------------------------------------------------------------

  /**
   * Returns the list of cash/bank accounts for the workspace's Finance firm,
   * plus the last-used account and a financeConfigured flag (D-07 UI signal).
   *
   * When no Finance firm exists → returns financeConfigured:false with an
   * empty accounts array so the UI can show a "Set up Finance" banner without
   * blocking salary payment.
   */
  async listCoaCashBankAccounts(workspaceId: string): Promise<{
    accounts: { accountId: string; code: string; name: string }[];
    lastUsedCoaAccountId: string | null;
    financeConfigured: boolean;
  }> {
    // Salary-standalone safeguard (2026-06-20): when FINANCE is OFF (ManekHR
    // default preset — salary runs without the finance/accounting cluster
    // configured), short-circuit to the clean no-finance state so the Pay drawer
    // renders "Finance not configured" instead of an empty/loading COA picker.
    // We never accept/return finance account ids when finance is off. Fail-safe:
    // a missing service or a lookup failure → treat FINANCE as OFF (no picker).
    let financeModuleEnabled = false;
    try {
      financeModuleEnabled =
        (await this.subscriptionsService?.hasModule(workspaceId, AppModule.FINANCE)) ?? false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `FINANCE entitlement lookup failed for workspace ${workspaceId}; showing no-finance COA state. ${msg}`,
      );
      financeModuleEnabled = false;
    }
    if (!financeModuleEnabled) {
      return { accounts: [], lastUsedCoaAccountId: null, financeConfigured: false };
    }

    const firmId = await this.salaryLedgerPostingService.resolveFirmId(workspaceId);
    if (!firmId) {
      return { accounts: [], lastUsedCoaAccountId: null, financeConfigured: false };
    }

    const cashBankAccounts =
      await this.salaryLedgerPostingService.findCashBankAccounts(workspaceId);

    const config = await this.payrollConfigModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .lean()
      .exec();

    const lastUsedCoaAccountId = (config as any)?.display?.lastUsedCoaAccountId ?? null;

    return { accounts: cashBankAccounts, lastUsedCoaAccountId, financeConfigured: true };
  }

  async updatePayrollConfig(
    workspaceId: string,
    updates: UpdatePayrollConfigDto,
  ): Promise<PayrollConfig> {
    return this.withSalarySpan('salary.updatePayrollConfig', { workspaceId }, async () => {
      const workspaceObjectId = toObjectId(workspaceId);
      const currentConfig = await this.getPayrollConfig(workspaceId);
      const plain = currentConfig.toObject() as {
        features: Record<string, boolean>;
        rules: Record<string, string>;
        display: Record<string, unknown>;
        statutory?: Record<string, boolean | number | string>;
        deductor?: Record<string, string>;
        compliance?: Record<string, unknown>;
        loanConfig?: Record<string, unknown>;
        preset?: string;
      };
      const updatedFeatureKeys = updates.features
        ? Object.keys(updates.features).filter(
            (key) => (updates.features as Record<string, boolean | undefined>)[key] !== undefined,
          )
        : [];
      const presetKey =
        updates.preset && updates.preset !== 'custom'
          ? (updates.preset as keyof typeof PAYROLL_PRESETS)
          : null;
      let nextPreset = currentConfig.preset;
      let nextFeatures = { ...plain.features };
      let nextRules = { ...(plain.rules || {}) };
      let nextDisplay = { ...plain.display };
      let nextStatutory = { ...(plain.statutory || {}) };
      let nextDeductor = { ...(plain.deductor || {}) };
      let nextCompliance = { ...(plain.compliance || {}) };
      // Self-apply loan settings (employee LoanRequest layer). Additive: only the
      // keys present in updates.loanConfig are overwritten; everything else
      // (sbiBenchmarkRate, perquisiteExemptionThreshold, maxActiveLoan*,
      // approvalChainDefault) is preserved. Without this write the owner toggling
      // self-apply in Payroll Settings would be silently dropped.
      let nextLoanConfig = { ...(plain.loanConfig || {}) };

      if (presetKey) {
        const presetDefaults = PAYROLL_PRESETS[presetKey];
        nextPreset = updates.preset;
        nextFeatures = {
          ...presetDefaults.features,
          ...(updates.features || {}),
        };
        nextRules = {
          ...presetDefaults.rules,
          ...(updates.rules || {}),
        };
        nextDisplay = {
          ...presetDefaults.display,
          ...(updates.display || {}),
        };
      } else {
        if (updates.preset) {
          nextPreset = updates.preset;
        } else if (updates.features) {
          nextPreset = 'custom';
        }

        if (updates.features) {
          nextFeatures = {
            ...plain.features,
            ...updates.features,
          };
        }

        if (updates.rules) {
          nextRules = {
            ...(plain.rules || {}),
            ...updates.rules,
          };
        }

        if (updates.display) {
          nextDisplay = {
            ...plain.display,
            ...updates.display,
          };
        }
      }

      if (updates.statutory) {
        nextStatutory = {
          ...(plain.statutory || {}),
          ...updates.statutory,
        };
      }

      if (updates.deductor) {
        nextDeductor = {
          ...(plain.deductor || {}),
          ...updates.deductor,
        };
      }

      if (updates.compliance) {
        nextCompliance = {
          ...(plain.compliance || {}),
          ...updates.compliance,
        };
      }

      if (updates.loanConfig) {
        // Merge only the keys actually supplied (mirrors the other config groups).
        // null is a meaningful value for selfApplyMinTenureMonths / selfApplyMaxAmount
        // ("clear the cap"), so we filter on `!== undefined`, not truthiness.
        const incoming = updates.loanConfig as Record<string, unknown>;
        const presentLoanKeys = Object.keys(incoming).reduce<Record<string, unknown>>(
          (acc, key) => {
            if (incoming[key] !== undefined) acc[key] = incoming[key];
            return acc;
          },
          {},
        );
        nextLoanConfig = {
          ...(plain.loanConfig || {}),
          ...presentLoanKeys,
        };
      }

      this.logger.log(
        `[updatePayrollConfig] workspace=${workspaceId} currentPreset=${currentConfig.preset} nextPreset=${nextPreset} ` +
          `updatedFeatures=${updatedFeatureKeys.join(',') || 'none'} updates=${JSON.stringify(updates)}`,
      );

      const config = await this.payrollConfigModel
        .findOneAndUpdate(
          { workspaceId: workspaceObjectId },
          {
            $set: {
              preset: nextPreset,
              features: nextFeatures,
              rules: nextRules,
              display: nextDisplay,
              statutory: nextStatutory,
              deductor: nextDeductor,
              compliance: nextCompliance,
              loanConfig: nextLoanConfig,
            },
          },
          {
            returnDocument: 'after',
          },
        )
        .exec();

      this.logger.log(
        `[updatePayrollConfig] workspace=${workspaceId} savedPreset=${config?.preset} savedFeatures=${JSON.stringify(config?.features || {})}`,
      );

      this.postHog.capture({
        distinctId: workspaceId,
        event: 'salary.payroll_config_updated',
        properties: {
          workspaceId,
          preset: nextPreset,
          updatedFeatureKeys,
          hasStatutoryUpdates: !!updates.statutory,
          hasDeductorUpdates: !!updates.deductor,
          hasRuleUpdates: !!updates.rules,
        },
      });

      return config;
    });
  }

  async resolveAndApplyCtcToBaseSalary(
    workspaceId: string,
    memberId: string,
  ): Promise<{ baseSalaryValue: number; breakdown: any[] } | null> {
    const member = await this.teamModel.findById(toObjectId(memberId)).exec();
    if (!member) throw new NotFoundException('Team member not found');

    // Unsupported by design: hourly salaries do not participate in CTC/template
    // resolution in the current payroll model. If a third salary mode is added,
    // replace this branching with a strategy-based resolver instead of stacking
    // more mode checks here.
    if (!member.ctcAmount || !member.componentTemplateId || member.salaryType === 'hourly') {
      return null;
    }

    const template = await this.componentTemplateModel
      .findOne({
        _id: member.componentTemplateId,
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!template) {
      return null;
    }

    const { breakdown, baseSalaryValue } = calculateComponents(
      member.ctcAmount,
      template.components,
      member.componentOverrides || [],
    );

    member.salaryAmount = baseSalaryValue;
    await member.save();

    return { baseSalaryValue, breakdown };
  }

  private validateComponentDefArray(
    components: {
      id?: string;
      name?: string;
      isBasicComponent?: boolean;
      calcMode?: string;
      referenceComponentId?: string;
    }[],
  ) {
    const basicCount = components.filter((c) => c.isBasicComponent).length;
    if (basicCount !== 1) {
      throw new BadRequestException('Exactly one component must have isBasicComponent: true');
    }

    const balancingCount = components.filter((c) => c.calcMode === 'balancing').length;
    if (balancingCount > 1) {
      throw new BadRequestException('At most one component can have calcMode: balancing');
    }

    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      if (comp.calcMode === 'percent_of_component') {
        if (!comp.referenceComponentId) {
          throw new BadRequestException(
            `Component "${comp.name || `#${i + 1}`}" with calcMode "percent_of_component" must have a referenceComponentId`,
          );
        }
        const refIdx = components.findIndex(
          (c, idx) => idx !== i && c.id === comp.referenceComponentId,
        );
        if (refIdx === -1) {
          throw new BadRequestException(
            `Component reference "${comp.referenceComponentId}" not found in the same template`,
          );
        }
      }
    }

    const visited = new Set<number>();
    const inStack = new Set<number>();
    const detectCycle = (idx: number): boolean => {
      if (inStack.has(idx)) return true;
      if (visited.has(idx)) return false;
      visited.add(idx);
      inStack.add(idx);
      const comp = components[idx];
      if (comp.calcMode === 'percent_of_component' && comp.referenceComponentId) {
        const refIdx = components.findIndex(
          (c, i) => i !== idx && c.id === comp.referenceComponentId,
        );
        if (refIdx !== -1 && detectCycle(refIdx)) return true;
      }
      inStack.delete(idx);
      return false;
    };
    for (let i = 0; i < components.length; i++) {
      if (!visited.has(i)) {
        if (detectCycle(i)) {
          throw new BadRequestException(
            'Circular reference detected in component reference chains',
          );
        }
      }
    }
  }

  private normalizeTemplateComponents(
    components: Array<{
      id?: string;
      name: string;
      calcMode: string;
      value?: number;
      referenceComponentId?: string;
      includedInCtc?: boolean;
      isBasicComponent?: boolean;
      isTaxable?: boolean;
      sortOrder: number;
    }>,
    existingComponents: SalaryComponentDef[] = [],
    preserveExistingIds = true,
  ): SalaryComponentDef[] {
    const existingIds = new Set(existingComponents.map((component) => component.id));
    const preservedIds = new Set<string>();
    const idMap = new Map<string, string>();

    const normalized = components.map((component) => {
      const incomingId = component.id;
      const shouldPreserveExistingId =
        preserveExistingIds &&
        !!incomingId &&
        existingIds.has(incomingId) &&
        !preservedIds.has(incomingId);
      const resolvedId = shouldPreserveExistingId ? incomingId : new Types.ObjectId().toString();

      if (incomingId && !idMap.has(incomingId)) {
        idMap.set(incomingId, resolvedId);
      }
      if (shouldPreserveExistingId) {
        preservedIds.add(resolvedId);
      }

      return {
        id: resolvedId,
        name: component.name,
        calcMode: component.calcMode,
        value: component.value,
        referenceComponentId: component.referenceComponentId,
        includedInCtc: component.includedInCtc ?? true,
        isBasicComponent: component.isBasicComponent ?? false,
        isTaxable: component.isTaxable ?? true,
        sortOrder: component.sortOrder,
      };
    });

    return normalized.map((component, index) => {
      const originalReference = components[index].referenceComponentId;
      return {
        ...component,
        referenceComponentId: originalReference
          ? idMap.get(originalReference) || originalReference
          : undefined,
      };
    });
  }

  async listComponentTemplates(workspaceId: string): Promise<SalaryComponentTemplate[]> {
    return this.componentTemplateModel
      .find({ workspaceId: toObjectId(workspaceId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  async createComponentTemplate(
    workspaceId: string,
    dto: CreateSalaryComponentTemplateDto,
    userId: string,
  ): Promise<SalaryComponentTemplate> {
    const componentsWithIds = this.normalizeTemplateComponents(dto.components, [], false);
    this.validateComponentDefArray(componentsWithIds);

    if (dto.isDefault) {
      await this.componentTemplateModel.updateMany(
        { workspaceId: toObjectId(workspaceId), isDefault: true },
        { $set: { isDefault: false } },
      );
    }

    const template = new this.componentTemplateModel({
      workspaceId: toObjectId(workspaceId),
      name: dto.name,
      isDefault: dto.isDefault ?? false,
      components: componentsWithIds,
      createdBy: toObjectId(userId),
    });

    return template.save();
  }

  async seedComponentTemplate(
    workspaceId: string,
    templateKey: string,
    userId: string,
  ): Promise<SalaryComponentTemplate> {
    const builtIn = BUILT_IN_TEMPLATES[templateKey];
    if (!builtIn) {
      throw new NotFoundException('Built-in template not found');
    }

    const idMap = new Map<string, string>();
    const componentsWithIds: SalaryComponentDef[] = builtIn.components.map((comp) => {
      const newId = new Types.ObjectId().toString();
      idMap.set(comp.id, newId);
      return {
        id: newId,
        name: comp.name,
        calcMode: comp.calcMode,
        value: comp.value,
        referenceComponentId: comp.referenceComponentId
          ? idMap.get(comp.referenceComponentId) || comp.referenceComponentId
          : undefined,
        includedInCtc: comp.includedInCtc ?? true,
        isBasicComponent: comp.isBasicComponent ?? false,
        isTaxable: comp.isTaxable ?? true,
        sortOrder: comp.sortOrder,
      };
    });

    componentsWithIds.forEach((comp, idx) => {
      const originalRef = builtIn.components[idx].referenceComponentId;
      if (originalRef && idMap.has(originalRef)) {
        comp.referenceComponentId = idMap.get(originalRef);
      }
    });

    const existingCount = await this.componentTemplateModel.countDocuments({
      workspaceId: toObjectId(workspaceId),
    });

    const template = new this.componentTemplateModel({
      workspaceId: toObjectId(workspaceId),
      name: builtIn.name,
      isDefault: existingCount === 0,
      components: componentsWithIds,
      createdBy: toObjectId(userId),
    });

    return template.save();
  }

  async updateComponentTemplate(
    workspaceId: string,
    templateId: string,
    dto: UpdateSalaryComponentTemplateDto,
  ): Promise<SalaryComponentTemplate> {
    const template = await this.componentTemplateModel
      .findOne({
        _id: toObjectId(templateId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!template) {
      throw new NotFoundException('Component template not found');
    }

    if (dto.components) {
      template.components = this.normalizeTemplateComponents(dto.components, template.components);
      this.validateComponentDefArray(template.components);
    }

    if (dto.isDefault) {
      await this.componentTemplateModel.updateMany(
        {
          workspaceId: toObjectId(workspaceId),
          _id: { $ne: toObjectId(templateId) },
          isDefault: true,
        },
        { $set: { isDefault: false } },
      );
    }

    if (dto.name !== undefined) {
      template.name = dto.name;
    }
    if (dto.isDefault !== undefined) {
      template.isDefault = dto.isDefault;
    }

    return template.save();
  }

  async deleteComponentTemplate(
    workspaceId: string,
    templateId: string,
  ): Promise<{ success: boolean }> {
    const template = await this.componentTemplateModel
      .findOne({
        _id: toObjectId(templateId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!template) {
      throw new NotFoundException('Component template not found');
    }

    const usageCount = await this.teamModel.countDocuments({
      workspaceId: toObjectId(workspaceId),
      componentTemplateId: toObjectId(templateId),
    });

    if (usageCount > 0) {
      throw new BadRequestException(
        `Cannot delete template — ${usageCount} employee${usageCount > 1 ? 's are' : ' is'} using it`,
      );
    }

    await this.componentTemplateModel.deleteOne({ _id: template._id }).exec();
    return { success: true };
  }

  // ── Bulk Email Payslips (async job) ──────────────

  async triggerBulkPayslipEmails(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<{ jobId: string }> {
    await this.assertFeatureEnabled(workspaceId, 'payslipGeneration', 'Payslip generation');

    // Prevent duplicate running jobs for same workspace+month+year
    const existing = await this.bulkEmailJobModel
      .findOne({
        workspaceId: toObjectId(workspaceId),
        month,
        year,
        status: { $in: ['pending', 'processing'] },
      })
      .exec();

    if (existing) {
      return { jobId: existing._id.toString() };
    }

    const job = await new this.bulkEmailJobModel({
      workspaceId: toObjectId(workspaceId),
      month,
      year,
      status: 'pending',
    }).save();

    const jobId = job._id.toString();

    // Fire-and-forget: start processing asynchronously
    this.processBulkEmailJob(jobId, workspaceId, month, year).catch((error) => {
      this.logger.error(`Bulk email job ${jobId} failed unexpectedly`, error);
    });

    return { jobId };
  }

  async getBulkEmailJobStatus(
    workspaceId: string,
    jobId: string,
  ): Promise<{
    jobId: string;
    status: BulkEmailJobStatus;
    total: number;
    processed: number;
    sent: number;
    failed: number;
    skipped: number;
    error?: string;
    details: Array<{
      salaryId: string;
      employeeName: string;
      email: string;
      status: 'sent' | 'failed' | 'skipped';
      reason?: string;
    }>;
  }> {
    const job = await this.bulkEmailJobModel
      .findOne({
        _id: toObjectId(jobId),
        workspaceId: toObjectId(workspaceId),
      })
      .lean()
      .exec();

    if (!job) {
      throw new NotFoundException('Bulk email job not found');
    }

    return {
      jobId: job._id.toString(),
      status: job.status,
      total: job.total,
      processed: job.processed,
      sent: job.sent,
      failed: job.failed,
      skipped: job.skipped,
      error: job.error,
      details: job.details || [],
    };
  }

  async cancelBulkEmailJob(workspaceId: string, jobId: string): Promise<{ success: boolean }> {
    const result = await this.bulkEmailJobModel
      .updateOne(
        {
          _id: toObjectId(jobId),
          workspaceId: toObjectId(workspaceId),
          status: { $in: ['pending', 'processing'] },
        },
        { $set: { status: 'cancelled' } },
      )
      .exec();

    return { success: result.modifiedCount > 0 };
  }

  private async processBulkEmailJob(
    jobId: string,
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<void> {
    const jobObjectId = toObjectId(jobId);
    const workspaceObjectId = toObjectId(workspaceId);

    try {
      // Mark as processing
      await this.bulkEmailJobModel
        .updateOne({ _id: jobObjectId }, { $set: { status: 'processing' } })
        .exec();

      // Fetch ALL salary records for this month — no filters, no pagination
      const salaryRecords = await this.salaryModel
        .find({ workspaceId: workspaceObjectId, month, year })
        .populate({
          path: 'teamMemberId',
          select:
            'name email designation avatar salaryType salaryAmount salaryDayBasis fixedMonthDays attendancePayMode dailyHours workingDays finalMonthlyOverride ctcAmount componentTemplateId componentOverrides dateOfJoining bankDetails upiDetails preferredMethod mobile employeeCode',
        })
        .lean()
        .exec();

      // Filter to generated records with email
      const emailableRecords = salaryRecords.filter((record) => {
        const member =
          record.teamMemberId && typeof record.teamMemberId === 'object'
            ? (record.teamMemberId as any)
            : null;
        return member?.email?.trim();
      });

      const total = emailableRecords.length;

      await this.bulkEmailJobModel.updateOne({ _id: jobObjectId }, { $set: { total } }).exec();

      if (total === 0) {
        await this.bulkEmailJobModel
          .updateOne({ _id: jobObjectId }, { $set: { status: 'completed' } })
          .exec();
        return;
      }

      // Fetch workspace + payroll config for branding and currency
      const [workspace, config] = await Promise.all([
        this.workspaceModel
          .findById(workspaceObjectId)
          .select('name branding exportPreferences')
          .lean<{
            name: string;
            branding?: {
              logo?: string;
              pdfHeaderLogo?: string;
              pdfWatermarkLogo?: string;
              pdfFooterDetails?: string;
            };
            exportPreferences?: {
              includeHeaderLogo?: boolean;
              includeFooter?: boolean;
              includeWatermark?: boolean;
              showExportDate?: boolean;
            };
          } | null>()
          .exec(),
        this.getPayrollConfig(workspaceId),
      ]);

      const workspaceName = workspace?.name || 'Your Company';
      const exportPreferences = workspace?.exportPreferences;
      const branding = {
        includeHeaderLogo: exportPreferences?.includeHeaderLogo ?? true,
        headerLogoUrl: workspace?.branding?.pdfHeaderLogo || workspace?.branding?.logo,
        includeWatermark: exportPreferences?.includeWatermark ?? true,
        watermarkLogoUrl: workspace?.branding?.pdfWatermarkLogo,
        includeFooter: exportPreferences?.includeFooter ?? true,
        footerText: workspace?.branding?.pdfFooterDetails,
        showExportDate: exportPreferences?.showExportDate ?? true,
      };
      const currencyConfig = {
        symbol: config.display?.currencySymbol || '₹',
        locale: config.display?.currencyLocale || 'en-IN',
        code: config.display?.currencyCode || 'INR',
      };
      const currencySymbol = currencyConfig.symbol;

      // Process each record one at a time
      for (const record of emailableRecords) {
        // Check if job was cancelled
        const currentJob = await this.bulkEmailJobModel
          .findById(jobObjectId)
          .select('status')
          .lean()
          .exec();

        if (currentJob?.status === 'cancelled') {
          return;
        }

        const member =
          record.teamMemberId && typeof record.teamMemberId === 'object'
            ? (record.teamMemberId as any)
            : null;
        const salaryId = record._id.toString();
        const employeeName = member?.name || 'Employee';
        const email = member?.email?.trim() || '';

        if (!email) {
          await this.bulkEmailJobModel
            .updateOne(
              { _id: jobObjectId },
              {
                $inc: { processed: 1, skipped: 1 },
                $push: {
                  details: {
                    salaryId,
                    employeeName,
                    email: '',
                    status: 'skipped',
                    reason: 'No email address',
                  },
                },
              },
            )
            .exec();
          continue;
        }

        try {
          // Fetch adjustments + payments for this record
          const [adjustments, payments] = await Promise.all([
            this.salaryAdjustmentModel
              .find({ salaryId: record._id })
              .sort({ createdAt: -1 })
              .lean()
              .exec(),
            this.paymentModel
              .find({ salaryId: record._id })
              .sort({ paymentDate: -1 })
              .lean()
              .exec(),
          ]);

          // Calculate paidAmount
          const paidAmount = payments
            .filter((p: any) => p.status !== 'reversed')
            .reduce((sum: number, p: any) => sum + (p.amount || 0) + (p.commission || 0), 0);

          // Fetch component template if applicable
          let componentTemplate = null;
          if (member?.componentTemplateId) {
            componentTemplate = await this.componentTemplateModel
              .findById(member.componentTemplateId)
              .lean()
              .exec();
          }

          // Normalize IDs to strings
          const normalizedRecord: any = {
            ...record,
            _id: record._id.toString(),
            teamMember: {
              _id: member?._id?.toString(),
              id: member?._id?.toString(),
              name: member?.name,
              designation: member?.designation,
              email: member?.email,
              mobile: member?.mobile,
              employeeCode: member?.employeeCode,
              salaryType: member?.salaryType,
              ctcAmount: member?.ctcAmount,
              componentTemplateId: member?.componentTemplateId?.toString(),
              componentOverrides: member?.componentOverrides || [],
            },
            paidAmount,
          };

          const normalizedAdjustments = adjustments.map((a: any) => ({
            ...a,
            _id: a._id?.toString(),
          }));

          const normalizedPayments = payments.map((p: any) => ({
            ...p,
            _id: p._id?.toString(),
          }));

          const normalizedTemplate = componentTemplate
            ? {
                ...componentTemplate,
                _id: componentTemplate._id?.toString(),
                components: (componentTemplate.components || []).map((c: any) => ({
                  ...c,
                  _id: undefined,
                })),
              }
            : null;

          // Generate PDF server-side
          const memberIdStr = member?._id?.toString() || '';
          const advanceOutstanding = memberIdStr
            ? await this.fetchOutstandingBalanceInternal(workspaceId, memberIdStr).catch(
                () => undefined,
              )
            : undefined;
          const loanOutstandingBulk = memberIdStr
            ? await this.fetchOutstandingLoanBalanceInternal(workspaceId, memberIdStr).catch(
                () => undefined,
              )
            : undefined;

          const pdfBuffer = await this.payslipPdfService.generatePayslipBuffer({
            record: normalizedRecord,
            adjustments: normalizedAdjustments,
            payments: normalizedPayments,
            componentTemplate: normalizedTemplate,
            workspaceName,
            branding,
            currencyConfig,
            advanceOutstanding,
            loanOutstanding: loanOutstandingBulk,
          });
          const pdfBase64 = pdfBuffer.toString('base64');
          const filename = this.payslipPdfService.getPayslipFilename({
            record: normalizedRecord,
            adjustments: normalizedAdjustments,
            payments: normalizedPayments,
            workspaceName,
          });

          // Format net salary for email template
          const formattedNetSalary = new Intl.NumberFormat(currencyConfig.locale).format(
            record.netSalary || 0,
          );
          const statusLabel =
            record.status === 'paid'
              ? 'Paid'
              : record.status === 'partial'
                ? 'Partially Paid'
                : 'Pending';

          // Send email
          await this.mailService.sendPayslipEmail({
            to: email,
            employeeName,
            workspaceName,
            month: record.month,
            year: record.year,
            netSalary: `${currencySymbol}${formattedNetSalary}`,
            paymentStatus: statusLabel,
            currencySymbol,
            pdfBase64,
            filename,
          });

          await this.bulkEmailJobModel
            .updateOne(
              { _id: jobObjectId },
              {
                $inc: { processed: 1, sent: 1 },
                $push: {
                  details: {
                    salaryId,
                    employeeName,
                    email,
                    status: 'sent',
                  },
                },
              },
            )
            .exec();
        } catch (error) {
          this.logger.warn(
            `Failed to send payslip email for ${employeeName} (${email})`,
            error instanceof Error ? error.message : error,
          );

          await this.bulkEmailJobModel
            .updateOne(
              { _id: jobObjectId },
              {
                $inc: { processed: 1, failed: 1 },
                $push: {
                  details: {
                    salaryId,
                    employeeName,
                    email,
                    status: 'failed',
                    reason: error instanceof Error ? error.message : 'Failed to send payslip email',
                  },
                },
              },
            )
            .exec();
        }
      }

      // Mark completed
      await this.bulkEmailJobModel
        .updateOne({ _id: jobObjectId, status: 'processing' }, { $set: { status: 'completed' } })
        .exec();
    } catch (error) {
      this.logger.error(
        `Bulk email job ${jobId} failed`,
        error instanceof Error ? error.stack : error,
      );

      await this.bulkEmailJobModel
        .updateOne(
          { _id: jobObjectId },
          {
            $set: {
              status: 'failed',
              error:
                error instanceof Error
                  ? error.message
                  : 'Unexpected error during bulk email processing',
            },
          },
        )
        .exec();
    }
  }

  // ── Phase 23 (D-06 / D-08 / D-11) — Piece-Rate Endpoints ───────────────
  // Preview + set + clear service methods consumed by:
  //   - SalaryController (preview)
  //   - TeamController   (set + clear)

  /**
   * D-06 / RESEARCH §7 — live preview of piece-rate earnings for a worker
   * in a given month/year. Returns 400 PAYROLL_MONTH_LOCKED when the salary
   * row is already locked. computePieceRateEarnings already raises 400
   * PIECE_RATE_NOT_CONFIGURED when the worker has no pieceRateConfig.
   */
  async previewPieceRateEarnings(
    workspaceId: string,
    q: { teamMemberId: string; month: number; year: number },
  ): Promise<{
    teamMemberId: string;
    month: number;
    year: number;
    pieceEarnings: number;
    basePortion: number;
    lopOnBase: number;
    netBase: number;
    totalEarnings: number;
    configSnapshot: any;
    breakdown: any[];
  }> {
    const lockedExisting = await this.salaryModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(q.teamMemberId),
        month: q.month,
        year: q.year,
        isLocked: true,
      })
      .select('_id')
      .lean()
      .exec();
    if (lockedExisting) {
      throw new BadRequestException({
        code: 'PAYROLL_MONTH_LOCKED',
        message:
          'Payroll for this month is locked — preview unavailable. Use the stored salary detail.',
      });
    }

    // CR-01: assert team member belongs to this workspace BEFORE compute.
    // Without this, an attacker who guesses a foreign teamMemberId would
    // receive that worker's piece-rate breakdown via the preview endpoint.
    const memberExists = await this.teamModel.exists({
      _id: new Types.ObjectId(q.teamMemberId),
      workspaceId: new Types.ObjectId(workspaceId),
      isDeleted: false,
    });
    if (!memberExists) {
      throw new NotFoundException({ code: 'TEAM_MEMBER_NOT_FOUND' });
    }

    const data = await this.computePieceRateEarnings(workspaceId, q.teamMemberId, q.month, q.year);

    // LOP-on-base for preview (D-04). The existing LOP path lives inside
    // buildSalaryRecordData and is not exposed as a public helper today.
    // Until a thin extractor is wired, the preview reports LOP=0 and the
    // lock-time recompute (recomputePieceRateForSalary) writes the correct
    // post-LOP base to the persisted Salary row. UI should display the
    // preview as "estimated" until the salary record is generated.
    const basePortion = data.basePortion;
    const lopOnBase = 0;
    const netBase = Math.max(0, basePortion - lopOnBase);
    const totalEarnings = Math.round((netBase + data.pieceEarnings) * 100) / 100;

    return {
      teamMemberId: q.teamMemberId,
      month: q.month,
      year: q.year,
      pieceEarnings: data.pieceEarnings,
      basePortion,
      lopOnBase,
      netBase,
      totalEarnings,
      configSnapshot: data.snapshot,
      breakdown: data.breakdown,
    };
  }

  /**
   * D-11 — set/update pieceRateConfig on a TeamMember and auto-upgrade
   * salaryType to 'piece_rate'. Validates cross-field rules via
   * TeamService.validatePieceRateConfig (machine existence, dedupe,
   * future effectiveFrom). Persists a PieceRateConfigAudit row (D-08).
   */
  async setPieceRateConfig(
    workspaceId: string,
    teamMemberId: string,
    dto: SetPieceRateConfigDto,
    userId: string,
  ): Promise<any> {
    const member = await this.teamModel
      .findOne({
        _id: new Types.ObjectId(teamMemberId),
        workspaceId: new Types.ObjectId(workspaceId),
        isDeleted: false,
      })
      .exec();
    if (!member) {
      throw new NotFoundException({ code: 'TEAM_MEMBER_NOT_FOUND' });
    }

    await this.teamService.validatePieceRateConfig(dto, workspaceId);

    if (dto.effectiveFrom && new Date(dto.effectiveFrom) > new Date()) {
      throw new BadRequestException({
        code: 'EFFECTIVE_FROM_FUTURE_NOT_SUPPORTED',
        message: 'Future-dated rate changes are not supported in this version',
      });
    }

    // HI-04: reject (do not silently zero) basePortion for non-blended units.
    // Silently zeroing hides client bugs and surprises the caller — the UI
    // expects to know whether its submitted value was honoured.
    if (
      dto.unit !== 'blended' &&
      dto.basePortion !== undefined &&
      dto.basePortion !== null &&
      dto.basePortion !== 0
    ) {
      throw new BadRequestException({
        code: 'BASE_PORTION_NOT_ALLOWED',
        message: "basePortion is only valid when unit='blended'. Remove the field or send 0.",
      });
    }

    const oldConfig = (member as any).pieceRateConfig ?? null;

    (member as any).pieceRateConfig = {
      unit: dto.unit,
      defaultRate: dto.defaultRate,
      basePortion: dto.unit === 'blended' ? (dto.basePortion ?? 0) : 0,
      perMachineOverrides: dto.perMachineOverrides ?? [],
      effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
      includeStitchUnit: dto.includeStitchUnit ?? true,
    };
    (member as any).salaryType = 'piece_rate';
    await member.save();

    // D-08 audit trail (PieceRateConfigAudit collection)
    await this.writePieceRateConfigAudit({
      workspaceId,
      teamMemberId,
      type: 'piece_rate_config_change',
      before: oldConfig
        ? {
            unit: oldConfig.unit,
            defaultRate: oldConfig.defaultRate,
            basePortion: oldConfig.basePortion,
            perMachineOverrides: oldConfig.perMachineOverrides ?? [],
            effectiveFrom: oldConfig.effectiveFrom,
          }
        : null,
      after: {
        unit: (member as any).pieceRateConfig.unit,
        defaultRate: (member as any).pieceRateConfig.defaultRate,
        basePortion: (member as any).pieceRateConfig.basePortion,
        perMachineOverrides: (member as any).pieceRateConfig.perMachineOverrides,
        effectiveFrom: (member as any).pieceRateConfig.effectiveFrom,
      },
      changedByUserId: userId,
    });

    // Mark the current month's salary row stale (markPieceRateStale lands
    // in Plan 23-07; safe-call here so the audit/save always succeeds).
    if (typeof (this as any).markPieceRateStale === 'function') {
      const now = new Date();
      try {
        await (this as any).markPieceRateStale(
          workspaceId,
          teamMemberId,
          `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
        );
      } catch (err) {
        this.logger.warn(`markPieceRateStale failed (non-fatal): ${(err as Error).message}`);
      }
    }

    return (member as any).pieceRateConfig;
  }

  /**
   * D-11 — clear pieceRateConfig and downgrade salaryType. Blocked when a
   * locked piece-rate salary exists for the worker (PIECE_RATE_HAS_LOCKED_SALARY).
   * Persists a PieceRateConfigAudit row with after=null (D-08).
   */
  async clearPieceRateConfig(
    workspaceId: string,
    teamMemberId: string,
    downgradeTo: 'monthly' | 'hourly',
    userId: string,
  ): Promise<{ cleared: true }> {
    // HI-01: broaden lock filter — historical salary rows may not carry
    // salaryType='piece_rate' (e.g. older records, mid-cycle salaryType
    // changes). Detect ANY locked row that materially recorded piece-rate
    // earnings for this worker, regardless of the row's stored salaryType.
    const lockedExists = await this.salaryModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
        isLocked: true,
        $or: [{ salaryType: 'piece_rate' }, { pieceRateEarnings: { $gt: 0 } }],
      })
      .select('_id')
      .lean()
      .exec();
    if (lockedExists) {
      throw new BadRequestException({
        code: 'PIECE_RATE_HAS_LOCKED_SALARY',
        message:
          'Cannot clear piece-rate config — locked salary records exist. Unlock first or contact support.',
      });
    }

    const member = await this.teamModel
      .findOne({
        _id: new Types.ObjectId(teamMemberId),
        workspaceId: new Types.ObjectId(workspaceId),
        isDeleted: false,
      })
      .exec();
    if (!member) {
      throw new NotFoundException({ code: 'TEAM_MEMBER_NOT_FOUND' });
    }

    const oldConfig = (member as any).pieceRateConfig ?? null;
    (member as any).pieceRateConfig = undefined;
    (member as any).salaryType = downgradeTo;
    await member.save();

    await this.writePieceRateConfigAudit({
      workspaceId,
      teamMemberId,
      type: 'piece_rate_config_change',
      before: oldConfig
        ? {
            unit: oldConfig.unit,
            defaultRate: oldConfig.defaultRate,
            basePortion: oldConfig.basePortion,
            perMachineOverrides: oldConfig.perMachineOverrides ?? [],
            effectiveFrom: oldConfig.effectiveFrom,
          }
        : null,
      after: null,
      changedByUserId: userId,
    });

    return { cleared: true };
  }

  // ---------------------------------------------------------------------------
  // Task 5 — Advance Recovery Plan read / preview service methods
  // ---------------------------------------------------------------------------

  /**
   * Pure preview: build an installment schedule from the supplied parameters
   * without persisting anything. Optionally, when `teamMemberId` is supplied,
   * estimates a projected net salary for each installment month (best-effort;
   * uses the member's configured `salaryAmount` as the monthly base, or the
   * most-recent salary record's `netSalary` as a fallback).
   *
   * OTel span only — no PostHog (read-only computation).
   */
  async previewAdvanceSchedule(
    workspaceId: string,
    dto: PreviewAdvanceScheduleDto,
  ): Promise<{
    installments: Array<{
      index: number;
      month: number;
      year: number;
      amount: number;
      projectedNet?: number;
      capped?: boolean;
      complianceAllowed?: number;
    }>;
    installmentCount: number;
    installmentAmount: number;
    totalAmount: number;
    complianceResult: {
      breaches: Array<{
        code: string;
        month: number;
        year: number;
        proposed: number;
        maxCompliant: number;
      }>;
      warnings: ComplianceWarning[];
    };
  }> {
    return this.withSalarySpan(
      'salary.previewAdvanceSchedule',
      { workspaceId, totalAmount: dto.totalAmount },
      async () => {
        const { totalAmount, startMonth, startYear, installmentCount, installmentAmount } = dto;

        // Exactly one of installmentCount / installmentAmount must be set.
        const config: { installmentCount?: number; installmentAmount?: number } = {};
        if (installmentCount != null) config.installmentCount = installmentCount;
        else if (installmentAmount != null) config.installmentAmount = installmentAmount;
        else config.installmentCount = 1;

        const amounts = buildInstallmentSchedule(totalAmount, config);
        const derivedCount = amounts.length;
        const derivedAmount = amounts[0] ?? totalAmount;

        // Load compliance config and member data when teamMemberId is provided.
        let monthlyBase: number | null = null;
        let minimumWageMonthly: number | null = null;
        let deductionCapPercent = 50;
        let advisoryMaxMonths = 12;

        if (dto.teamMemberId) {
          try {
            const member = await this.teamModel
              .findOne({
                _id: toObjectId(dto.teamMemberId),
                workspaceId: toObjectId(workspaceId),
              })
              .select('salaryAmount minimumWageMonthlyOverride')
              .lean()
              .exec();

            if (member && typeof (member as any).salaryAmount === 'number') {
              monthlyBase = (member as any).salaryAmount as number;
            }

            // Fallback: most recent generated salary record.
            if (monthlyBase == null || monthlyBase === 0) {
              const recent = await this.salaryModel
                .findOne({
                  workspaceId: toObjectId(workspaceId),
                  teamMemberId: toObjectId(dto.teamMemberId),
                })
                .sort({ year: -1, month: -1 })
                .select('netSalary')
                .lean()
                .exec();
              if (recent && typeof (recent as any).netSalary === 'number') {
                monthlyBase = (recent as any).netSalary as number;
              }
            }

            // Resolve effective minimum wage.
            const memberOverride = member ? (member as any).minimumWageMonthlyOverride : undefined;
            const payrollConfig = await this.getPayrollConfig(workspaceId);
            const complianceCfg = payrollConfig.compliance;
            if (memberOverride !== undefined && memberOverride !== null) {
              minimumWageMonthly = memberOverride as number;
            } else {
              minimumWageMonthly = complianceCfg?.minimumWageMonthly ?? null;
            }
            deductionCapPercent = complianceCfg?.deductionCapPercent ?? 50;
            advisoryMaxMonths = complianceCfg?.installmentAdvisoryMaxMonths ?? 12;
          } catch {
            // Best-effort - if the member is not found, skip projection and compliance.
          }
        }

        // Accumulated compliance state across all preview months.
        const previewBreaches: Array<{
          code: string;
          month: number;
          year: number;
          proposed: number;
          maxCompliant: number;
        }> = [];
        const previewWarnings: ComplianceWarning[] = [];

        // Build installment rows, walking months forward from start.
        const installments: Array<{
          index: number;
          month: number;
          year: number;
          amount: number;
          projectedNet?: number;
          capped?: boolean;
          complianceAllowed?: number;
        }> = [];

        let month = startMonth;
        let year = startYear;

        for (let i = 0; i < amounts.length; i++) {
          const amount = amounts[i];
          const row: {
            index: number;
            month: number;
            year: number;
            amount: number;
            projectedNet?: number;
            capped?: boolean;
            complianceAllowed?: number;
          } = { index: i + 1, month, year, amount };

          if (monthlyBase != null) {
            const raw = this.roundCurrency(monthlyBase - amount);
            row.projectedNet = Math.max(0, raw);
            row.capped = raw < 0;

            // Run compliance guard in preview mode - never throws, just reports.
            // currentTotalDeductions is not known for future months without loading
            // actual salary records; use 0 as a conservative estimate that shows
            // worst-case compliance (0 existing deductions means installment alone
            // is checked against cap and floor).
            const guardResult = this.complianceGuard.evaluate({
              proposedInstallment: amount,
              currentTotalDeductions: 0,
              grossSalaryForMonth: monthlyBase,
              netSalaryBeforeRecovery: Math.max(0, monthlyBase),
              minimumWageMonthly,
              deductionCapPercent,
              totalAdvanceAmount: totalAmount,
              periodicWages: monthlyBase,
              scheduleMonths: derivedCount,
              advisoryMaxMonths,
            });

            if (guardResult.breaches.length > 0) {
              for (const breach of guardResult.breaches) {
                previewBreaches.push({
                  code: breach.code,
                  month,
                  year,
                  proposed: amount,
                  maxCompliant: breach.reducedTo,
                });
              }
              row.complianceAllowed = guardResult.allowedInstallment;
            }

            for (const warning of guardResult.warnings) {
              // Deduplicate warnings by code.
              if (!previewWarnings.some((w) => w.code === warning.code)) {
                previewWarnings.push(warning);
              }
            }
          }

          installments.push(row);

          // Advance to next month (Dec -> Jan wrap).
          month += 1;
          if (month > 12) {
            month = 1;
            year += 1;
          }
        }

        return {
          installments,
          installmentCount: derivedCount,
          installmentAmount: derivedAmount,
          totalAmount,
          complianceResult: {
            breaches: previewBreaches,
            warnings: previewWarnings,
          },
        };
      },
    );
  }

  /**
   * Return all AdvanceRecoveryPlans for a team member (active + recent),
   * including their installment ledgers.
   *
   * Self-scope enforced: a worker caller can only read their own member's plans.
   * OTel span only — no PostHog (read).
   */
  async getAdvanceRecoveryPlans(
    workspaceId: string,
    teamMemberId: string,
    userId: string,
  ): Promise<AdvanceRecoveryPlanDocument[]> {
    await this.assertSalarySelfReadAllowed(workspaceId, userId, teamMemberId);

    return this.withSalarySpan(
      'salary.getAdvanceRecoveryPlans',
      { workspaceId, teamMemberId },
      async () => {
        return this.advanceRecoveryPlanModel
          .find({
            workspaceId: toObjectId(workspaceId),
            teamMemberId: toObjectId(teamMemberId),
          })
          .sort({ createdAt: -1 })
          .exec();
      },
    );
  }

  /**
   * Return a single AdvanceRecoveryPlan with its full installment ledger.
   *
   * Self-scope enforced: load the plan first to resolve `teamMemberId`, then
   * call `assertSalarySelfReadAllowed` so a worker can only read their own plan.
   * OTel span only — no PostHog (read).
   */
  async getAdvanceRecoveryPlanDetail(
    workspaceId: string,
    planId: string,
    userId: string,
  ): Promise<AdvanceRecoveryPlanDocument> {
    return this.withSalarySpan(
      'salary.getAdvanceRecoveryPlanDetail',
      { workspaceId, planId },
      async () => {
        const plan = await this.advanceRecoveryPlanModel
          .findOne({ _id: toObjectId(planId), workspaceId: toObjectId(workspaceId) })
          .exec();

        if (!plan) throw new NotFoundException('Advance recovery plan not found');

        await this.assertSalarySelfReadAllowed(workspaceId, userId, String(plan.teamMemberId));

        return plan;
      },
    );
  }

  /**
   * D-08 (BLOCKER 2) — persistent audit trail for piece-rate config changes.
   * Writes a PieceRateConfigAudit document. Errors are swallowed and logged
   * so the underlying config write is never blocked.
   *
   * Wired from: setPieceRateConfig, clearPieceRateConfig.
   */
  private async writePieceRateConfigAudit(input: {
    workspaceId: string;
    teamMemberId: string;
    type: 'piece_rate_config_change';
    before: any;
    after: any;
    changedByUserId: string;
  }): Promise<void> {
    try {
      await this.pieceRateConfigAuditModel.create({
        workspaceId: new Types.ObjectId(input.workspaceId),
        teamMemberId: new Types.ObjectId(input.teamMemberId),
        type: input.type,
        before: input.before,
        after: input.after,
        changedByUserId: new Types.ObjectId(String(input.changedByUserId)),
      });
    } catch (err) {
      this.logger.warn(`PieceRateConfigAudit write failed (non-fatal): ${(err as Error).message}`);
    }
  }
}
