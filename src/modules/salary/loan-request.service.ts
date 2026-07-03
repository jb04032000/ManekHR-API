import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LoanRequest } from './schemas/loan-request.schema';
import { PayrollConfig } from './schemas/payroll-config.schema';
import { EmployerLoan } from './schemas/employer-loan.schema';
import {
  ApproveLoanRequestDto,
  CreateLoanRequestDto,
  RejectLoanRequestDto,
} from './dto/loan-request.dto';
import { CreateLoanDto } from './dto/loan.dto';
import { LoanService } from './loan.service';
import { CallerScopeService } from '../../common/services/caller-scope.service';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * LoanRequestService — employee-originated, self-service 0% loan request
 * lifecycle (Task 2). Mirrors AdvanceSalaryRequestService conventions:
 *   - createRequest binds to the caller's OWN teamMemberId (resolved from the
 *     JWT by the controller via CallerScopeService), NEVER a body id (closes the
 *     IDOR a self-scoped worker could otherwise exploit);
 *   - the self-apply AND-gate + eligibility caps mirror the advance Phase-3b
 *     caps (each enforced only when configured / non-null);
 *   - the partial-unique {workspaceId,teamMemberId} where status='pending' index
 *     is surfaced as a friendly 409.
 *
 * On owner approval, the EXISTING LoanService.createLoan materializes the real
 * interest-free EmployerLoan (interestType='zero'); the EmployerLoan engine and
 * its Separation-of-Duties guard are NOT touched here. If the owner somehow
 * approves their OWN request, that guard throws naturally — we do not weaken it.
 */
@Injectable()
export class LoanRequestService {
  private readonly logger = new Logger(LoanRequestService.name);

  constructor(
    @InjectModel(LoanRequest.name)
    private readonly loanRequestModel: Model<LoanRequest>,
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    @InjectModel(EmployerLoan.name)
    private readonly employerLoanModel: Model<EmployerLoan>,
    @InjectModel(TeamMember.name)
    private readonly teamMemberModel: Model<TeamMember>,
    private readonly loanService: LoanService,
    private readonly callerScope: CallerScopeService,
    private readonly auditService: AuditService,
    // Request-lifecycle notifications (2026-07-03): owner on create, worker on
    // decision. Dispatched (channel pipeline) so browser/mobile push fire.
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Best-effort loan-request notification (2026-07-03). recipient 'owner'
   * resolves workspace.ownerId; 'worker' resolves the member's linkedUserId.
   * Failures are swallowed — a notification outage never fails the action.
   * Mirrors AdvanceSalaryRequestService.notifyOwnerOfRequest/notifyWorker.
   */
  private async notifyLoanEvent(
    workspaceId: string,
    teamMemberId: Types.ObjectId | string,
    requestId: string,
    recipient: 'owner' | 'worker',
    payload: { title: string; message: string; type: 'info' | 'warning' | 'success'; link: string },
  ): Promise<void> {
    try {
      let recipientId: string | null = null;
      if (recipient === 'owner') {
        const ws = await this.workspaceModel.findById(workspaceId).select('ownerId').lean().exec();
        recipientId = (ws as { ownerId?: Types.ObjectId } | null)?.ownerId?.toString() ?? null;
      } else {
        const member = await this.teamMemberModel
          .findById(teamMemberId)
          .select('linkedUserId')
          .lean()
          .exec();
        recipientId =
          (member as { linkedUserId?: Types.ObjectId } | null)?.linkedUserId?.toString() ?? null;
      }
      if (!recipientId) return;
      await this.notificationsService.dispatch({
        recipientId,
        category: 'erp.salary_update',
        title: payload.title,
        message: payload.message,
        type: payload.type,
        workspaceId,
        entityType: 'loan_request',
        entityId: requestId,
        metadata: { entityType: 'loan_request', entityId: requestId, link: payload.link },
      });
    } catch (err) {
      this.logger.warn(
        `loan notify (${recipient}) failed for request ${requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Whole months of tenure elapsed from `from` (join date) to `to` (now).
   * Counts complete months: a member who joined on the 10th has 1 month of
   * tenure on the 10th of the next month, not before. Negative spans clamp to 0.
   * Copied verbatim from AdvanceSalaryRequestService.monthsBetween so the loan
   * min-tenure cap computes tenure identically to the advance min-tenure cap.
   */
  private monthsBetween(from: Date, to: Date): number {
    let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    if (to.getDate() < from.getDate()) months -= 1;
    return Math.max(0, months);
  }

  private async loadPayrollConfig(workspaceId: string): Promise<PayrollConfig> {
    const config = await this.payrollConfigModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .lean()
      .exec();
    if (!config) {
      throw new NotFoundException(`PayrollConfig not found for workspace ${workspaceId}`);
    }
    return config as unknown as PayrollConfig;
  }

  /**
   * Resolve the loanConfig self-apply settings + counts and compute whether the
   * given (member, requestedAmount) is eligible. Returned reasons mirror the
   * thrown error codes so getEligibility and createRequest cannot diverge.
   */
  private async evaluateEligibility(
    workspaceId: string,
    teamMemberId: string,
    requestedAmount: number | null,
  ): Promise<{
    enabled: boolean;
    maxAmount: number | null;
    minTenureMonths: number | null;
    eligible: boolean;
    reasons: string[];
  }> {
    const config = await this.loadPayrollConfig(workspaceId);
    const loanConfig = config.loanConfig;

    const featureOn = !!config.features?.loanManagement;
    const selfApplyEnabled = !!loanConfig?.selfApplyEnabled;
    const maxAmount = loanConfig?.selfApplyMaxAmount ?? null;
    const minTenureMonths = loanConfig?.selfApplyMinTenureMonths ?? null;
    const maxActiveLoanAmount = loanConfig?.maxActiveLoanAmount ?? 0;
    const maxActiveLoanCount = loanConfig?.maxActiveLoanCount ?? 0;

    const reasons: string[] = [];

    if (!featureOn) {
      reasons.push('LOAN_FEATURE_DISABLED');
    }
    if (!selfApplyEnabled) {
      reasons.push('LOAN_SELF_APPLY_DISABLED');
    }

    // Min-tenure cap (only when configured). A member with no join date on file
    // is NOT blocked (cannot prove they fail; fail-open, mirroring advance).
    if (minTenureMonths != null) {
      const member = await this.teamMemberModel
        .findById(teamMemberId)
        .select('dateOfJoining')
        .lean()
        .exec();
      const joinDate = (member as { dateOfJoining?: Date } | null)?.dateOfJoining;
      if (joinDate) {
        const tenureMonths = this.monthsBetween(new Date(joinDate), new Date());
        if (tenureMonths < minTenureMonths) {
          reasons.push('LOAN_TENURE_NOT_MET');
        }
      }
    }

    // Max-amount cap (only when an amount is supplied — getEligibility may pass
    // null because it does not know the prospective amount yet).
    if (maxAmount != null && requestedAmount != null && requestedAmount > maxAmount) {
      reasons.push('LOAN_AMOUNT_EXCEEDS_CAP');
    }

    // Active-loan limits (reuse the existing soft workspace caps; 0 = no limit).
    // Count the member's currently-active/paused EmployerLoans plus their pending
    // self-apply requests so a worker cannot stack requests past the cap.
    if (maxActiveLoanCount > 0 || maxActiveLoanAmount > 0) {
      const wsOid = new Types.ObjectId(workspaceId);
      const tmOid = new Types.ObjectId(teamMemberId);
      const activeLoans = await this.employerLoanModel
        .find({
          workspaceId: wsOid,
          teamMemberId: tmOid,
          status: { $in: ['active', 'paused', 'pending_approval'] },
        })
        .select('remainingAmount principalAmount')
        .lean()
        .exec();
      const pendingRequests = await this.loanRequestModel.countDocuments({
        workspaceId: wsOid,
        teamMemberId: tmOid,
        status: 'pending',
      });

      if (maxActiveLoanCount > 0) {
        const projectedCount = activeLoans.length + pendingRequests + 1;
        if (projectedCount > maxActiveLoanCount) {
          reasons.push('LOAN_LIMIT_EXCEEDED');
        }
      }
      if (maxActiveLoanAmount > 0) {
        const outstanding = activeLoans.reduce(
          (sum, l) => sum + ((l as any).remainingAmount ?? (l as any).principalAmount ?? 0),
          0,
        );
        // UNIT FIX: outstanding/maxActiveLoanAmount are RUPEES; requestedAmount is PAISE.
        const projectedOutstanding = outstanding + (requestedAmount ?? 0) / 100;
        if (projectedOutstanding > maxActiveLoanAmount) {
          if (!reasons.includes('LOAN_LIMIT_EXCEEDED')) reasons.push('LOAN_LIMIT_EXCEEDED');
        }
      }
    }

    return {
      enabled: featureOn && selfApplyEnabled,
      maxAmount,
      minTenureMonths,
      eligible: reasons.length === 0,
      reasons,
    };
  }

  // ---------------------------------------------------------------------------
  // createRequest (employee-initiated, scope=self)
  // ---------------------------------------------------------------------------

  /**
   * SECURITY: `teamMemberId` is the caller's OWN member id, resolved from the JWT
   * by the controller via CallerScopeService — it is NOT read from the request
   * body (the DTO has no member id, and forbidNonWhitelisted rejects any extra
   * field). Closes the IDOR a self-scoped worker could otherwise exploit.
   */
  async createRequest(
    workspaceId: string,
    requestedByUserId: string,
    teamMemberId: string,
    dto: CreateLoanRequestDto,
  ): Promise<LoanRequest> {
    const config = await this.loadPayrollConfig(workspaceId);

    // Gate (a) — workspace must have the loan feature on (mirrors
    // SalaryService.assertFeatureEnabled('loanManagement', 'Employee loans')).
    if (!config.features?.loanManagement) {
      throw new BadRequestException({
        code: 'LOAN_FEATURE_DISABLED',
        message:
          'Employee loans are not enabled for this workspace. Enable it in Payroll Settings.',
      });
    }

    // Gate (b) — self-apply AND-gate.
    if (!config.loanConfig?.selfApplyEnabled) {
      throw new BadRequestException({
        code: 'LOAN_SELF_APPLY_DISABLED',
        message: 'Self-service loan requests are not enabled for this workspace.',
      });
    }

    // Gate (c) — eligibility caps (each enforced only when configured / non-null).
    const minTenureMonths = config.loanConfig?.selfApplyMinTenureMonths ?? null;
    const maxAmount = config.loanConfig?.selfApplyMaxAmount ?? null;
    const maxActiveLoanAmount = config.loanConfig?.maxActiveLoanAmount ?? 0;
    const maxActiveLoanCount = config.loanConfig?.maxActiveLoanCount ?? 0;

    // Cap 1 — minimum tenure (months since dateOfJoining, fail-open if no join date).
    if (minTenureMonths != null) {
      const member = await this.teamMemberModel
        .findById(teamMemberId)
        .select('dateOfJoining')
        .lean()
        .exec();
      const joinDate = (member as { dateOfJoining?: Date } | null)?.dateOfJoining;
      if (joinDate) {
        const tenureMonths = this.monthsBetween(new Date(joinDate), new Date());
        if (tenureMonths < minTenureMonths) {
          throw new BadRequestException({
            code: 'LOAN_TENURE_NOT_MET',
            message: `You need at least ${minTenureMonths} month(s) of tenure to apply for a loan.`,
          });
        }
      }
    }

    // Cap 2 — max amount (paise).
    if (maxAmount != null && dto.requestedAmount > maxAmount) {
      throw new BadRequestException({
        code: 'LOAN_AMOUNT_EXCEEDS_CAP',
        message: 'The requested amount exceeds the maximum self-service loan amount.',
      });
    }

    // Cap 3 — active-loan limits (count + outstanding). 0 = no limit.
    if (maxActiveLoanCount > 0 || maxActiveLoanAmount > 0) {
      const wsOid = new Types.ObjectId(workspaceId);
      const tmOid = new Types.ObjectId(teamMemberId);
      const activeLoans = await this.employerLoanModel
        .find({
          workspaceId: wsOid,
          teamMemberId: tmOid,
          status: { $in: ['active', 'paused', 'pending_approval'] },
        })
        .select('remainingAmount principalAmount')
        .lean()
        .exec();
      const pendingRequests = await this.loanRequestModel.countDocuments({
        workspaceId: wsOid,
        teamMemberId: tmOid,
        status: 'pending',
      });

      if (maxActiveLoanCount > 0 && activeLoans.length + pendingRequests + 1 > maxActiveLoanCount) {
        throw new BadRequestException({
          code: 'LOAN_LIMIT_EXCEEDED',
          message: 'You have reached the maximum number of concurrent loans for this workspace.',
        });
      }
      if (maxActiveLoanAmount > 0) {
        const outstanding = activeLoans.reduce(
          (sum, l) => sum + ((l as any).remainingAmount ?? (l as any).principalAmount ?? 0),
          0,
        );
        // UNIT FIX: outstanding (EmployerLoan.remainingAmount/principalAmount) and
        // maxActiveLoanAmount (loanConfig) are RUPEES; dto.requestedAmount is PAISE.
        if (outstanding + dto.requestedAmount / 100 > maxActiveLoanAmount) {
          throw new BadRequestException({
            code: 'LOAN_LIMIT_EXCEEDED',
            message: 'This request would exceed the maximum total loan amount for this workspace.',
          });
        }
      }
    }

    try {
      const doc = await this.loanRequestModel.create({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
        requestedAmount: dto.requestedAmount,
        desiredTenorMonths: dto.desiredTenorMonths,
        purpose: dto.purpose,
        status: 'pending',
      });

      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.SALARY,
        entityType: 'loan_request',
        entityId: String(doc._id),
        action: 'salary.loan_request.created',
        actorId: requestedByUserId,
        teamMemberId,
        after: {
          requestedAmount: dto.requestedAmount,
          desiredTenorMonths: dto.desiredTenorMonths,
          status: 'pending',
        },
      });

      // Tell the owner a request landed (best-effort; in-app + push).
      const member = await this.teamMemberModel.findById(teamMemberId).select('name').lean().exec();
      const memberName = (member as { name?: string } | null)?.name ?? 'A team member';
      await this.notifyLoanEvent(workspaceId, teamMemberId, String(doc._id), 'owner', {
        title: '0% loan request received',
        message: `${memberName} applied for a loan of ₹${Math.round(dto.requestedAmount / 100).toLocaleString('en-IN')} over ${dto.desiredTenorMonths} month(s).`,
        type: 'info',
        link: '/dashboard/salary/loans',
      });

      return doc;
    } catch (err: any) {
      // Partial-unique index violation → friendly 409 (one pending request only).
      if (err?.code === 11000) {
        throw new ConflictException({
          code: 'LOAN_REQUEST_DUPLICATE',
          message: 'You already have a pending loan request.',
        });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // listMine (self)
  // ---------------------------------------------------------------------------

  /**
   * The caller's own loan requests, newest-first. For approved requests we attach
   * a lightweight view of the materialized loan (id + status + outstanding) so the
   * worker app can show progress without a second round-trip.
   */
  async listMine(workspaceId: string, teamMemberId: string): Promise<any[]> {
    const requests = (await this.loanRequestModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec()) as unknown as Array<LoanRequest & { createdEmployerLoanId?: Types.ObjectId }>;

    const loanIds = requests
      .map((r) => r.createdEmployerLoanId)
      .filter((id): id is Types.ObjectId => !!id);

    if (loanIds.length === 0) return requests;

    const loans = await this.employerLoanModel
      .find({ _id: { $in: loanIds } })
      .select('status remainingAmount')
      .lean()
      .exec();
    const loanById = new Map(loans.map((l) => [String((l as any)._id), l]));

    return requests.map((r) => {
      if (!r.createdEmployerLoanId) return r;
      const loan = loanById.get(String(r.createdEmployerLoanId));
      return {
        ...r,
        loan: loan
          ? {
              id: String((loan as any)._id),
              status: (loan as any).status,
              // UNIT: the EmployerLoan engine stores amounts in RUPEES, but this
              // LoanRequest API speaks PAISE end-to-end (requestedAmount is paise; the
              // web divides by 100 to display). Convert rupees -> paise so the web's
              // uniform "/100 to display" is correct (otherwise it shows 100x too small).
              remainingAmount: Math.round(((loan as any).remainingAmount ?? 0) * 100),
            }
          : { id: String(r.createdEmployerLoanId) },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // getEligibility (self) — read-only pre-validation for the apply button
  // ---------------------------------------------------------------------------

  async getEligibility(
    workspaceId: string,
    teamMemberId: string,
  ): Promise<{
    enabled: boolean;
    maxAmount: number | null;
    minTenureMonths: number | null;
    eligible: boolean;
    reasons: string[];
  }> {
    // requestedAmount is unknown at this point → pass null; the amount cap is
    // enforced at createRequest with the real value.
    return this.evaluateEligibility(workspaceId, teamMemberId, null);
  }

  // ---------------------------------------------------------------------------
  // listPending (owner queue)
  // ---------------------------------------------------------------------------

  /**
   * All pending requests in the workspace, newest-first, decorated with the
   * member's name + employee code for the owner approval queue.
   */
  async listPending(workspaceId: string): Promise<any[]> {
    const wsOid = new Types.ObjectId(workspaceId);
    const requests = (await this.loanRequestModel
      .find({ workspaceId: wsOid, status: 'pending' })
      .sort({ createdAt: -1 })
      .lean()
      .exec()) as unknown as Array<LoanRequest & { teamMemberId: Types.ObjectId }>;

    if (requests.length === 0) return requests;

    const memberIds = requests.map((r) => r.teamMemberId);
    const members = await this.teamMemberModel
      .find({ _id: { $in: memberIds } })
      .select('name employeeCode')
      .lean()
      .exec();
    const memberById = new Map(members.map((m: any) => [String(m._id), m]));

    return requests.map((r) => {
      const m = memberById.get(String(r.teamMemberId));
      return {
        ...r,
        member: m
          ? {
              id: String(m._id),
              name: m.name,
              employeeCode: m.employeeCode,
            }
          : { id: String(r.teamMemberId) },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // approveRequest (owner) — materializes the real 0% EmployerLoan
  // ---------------------------------------------------------------------------

  async approveRequest(
    workspaceId: string,
    requestId: string,
    callerUserId: string,
    dto: ApproveLoanRequestDto,
  ): Promise<LoanRequest> {
    const request = await this.loadPendingRequest(workspaceId, requestId);

    const interestType = dto.interestType ?? 'zero';
    // UNIT FIX (money): requestedAmount AND ApproveLoanRequestDto.principalAmount are in
    // PAISE (same unit as AdvanceSalaryRequest.requestedAmount; the web converts rupees
    // -> paise before sending). The EmployerLoan engine's CreateLoanDto.principalAmount is
    // in RUPEES (@IsNumber, decimal). Convert before handing off — exactly like
    // advance-salary-request.service does when it crosses into rupee-land. Skipping this
    // would materialize a loan (and its salary-deduction recovery) 100x too large.
    const principalAmountPaise = dto.principalAmount ?? request.requestedAmount;
    const principalAmount = principalAmountPaise / 100;

    // Build the CreateLoanDto the same shape salary.controller's loan-create
    // route produces. annualInterestRate is 0 for a zero-interest loan (the
    // self-service loan is always interest-free); for any non-zero interestType
    // the owner passes the rate explicitly via a future field — here it stays 0.
    const createLoanDto: CreateLoanDto = {
      teamMemberId: String(request.teamMemberId),
      loanType: 'personal',
      principalAmount,
      disbursedOutsideApp: false,
      disbursementDate: new Date().toISOString(),
      interestType,
      annualInterestRate: 0,
      tenorMonths: dto.tenorMonths,
      startMonth: dto.startMonth,
      startYear: dto.startYear,
      approvalChain: dto.approvalChain,
      note: 'Materialized from employee self-service loan request',
    };

    // Call the EXISTING engine. Its SoD guard forbids acting on your OWN loan;
    // an owner approving an EMPLOYEE's request is fine. If the owner approves
    // their own request, the guard throws naturally — we do not weaken it.
    const loan = await this.loanService.createLoan(workspaceId, createLoanDto, callerUserId);

    const reviewerTeamMemberId = await this.resolveReviewerTeamMemberId(workspaceId, callerUserId);

    request.status = 'approved';
    request.createdEmployerLoanId = (loan as any)._id;
    request.reviewedByUserId = new Types.ObjectId(callerUserId);
    if (reviewerTeamMemberId) {
      request.reviewedByTeamMemberId = new Types.ObjectId(reviewerTeamMemberId);
    }
    request.reviewedAt = new Date();

    const saved = await request.save();

    await this.auditService.logEvent({
      workspaceId,
      module: AppModule.SALARY,
      entityType: 'loan_request',
      entityId: String(saved._id),
      action: 'salary.loan_request.approved',
      actorId: callerUserId,
      teamMemberId: String(saved.teamMemberId),
      after: {
        status: 'approved',
        createdEmployerLoanId: String((loan as any)._id),
        principalAmount,
        interestType,
        tenorMonths: dto.tenorMonths,
      },
    });

    // Tell the worker their loan was approved (best-effort; in-app + push).
    await this.notifyLoanEvent(workspaceId, saved.teamMemberId, String(saved._id), 'worker', {
      title: 'Loan approved',
      message: `Your 0% loan of ₹${Math.round(principalAmount / 100).toLocaleString('en-IN')} was approved over ${dto.tenorMonths} month(s). Installments deduct from your monthly salary.`,
      type: 'success',
      link: '/dashboard/salary',
    });

    return saved;
  }

  // ---------------------------------------------------------------------------
  // rejectRequest (owner)
  // ---------------------------------------------------------------------------

  async rejectRequest(
    workspaceId: string,
    requestId: string,
    callerUserId: string,
    dto: RejectLoanRequestDto,
  ): Promise<LoanRequest> {
    const request = await this.loadPendingRequest(workspaceId, requestId);

    const reviewerTeamMemberId = await this.resolveReviewerTeamMemberId(workspaceId, callerUserId);

    request.status = 'rejected';
    request.rejectionReason = dto.reason;
    request.reviewedByUserId = new Types.ObjectId(callerUserId);
    if (reviewerTeamMemberId) {
      request.reviewedByTeamMemberId = new Types.ObjectId(reviewerTeamMemberId);
    }
    request.reviewedAt = new Date();

    const saved = await request.save();

    await this.auditService.logEvent({
      workspaceId,
      module: AppModule.SALARY,
      entityType: 'loan_request',
      entityId: String(saved._id),
      action: 'salary.loan_request.rejected',
      actorId: callerUserId,
      teamMemberId: String(saved.teamMemberId),
      after: { status: 'rejected', rejectionReason: dto.reason },
    });

    // Tell the worker their loan was declined (best-effort; in-app + push).
    await this.notifyLoanEvent(workspaceId, saved.teamMemberId, String(saved._id), 'worker', {
      title: 'Loan request declined',
      message: `Your 0% loan request was not approved.${dto.reason ? ` Note: ${dto.reason}` : ''}`,
      type: 'warning',
      link: '/dashboard/salary',
    });

    return saved;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Load a request that MUST be pending, else 409 LOAN_REQUEST_NOT_PENDING. */
  private async loadPendingRequest(workspaceId: string, requestId: string): Promise<any> {
    const request = await this.loanRequestModel
      .findOne({
        _id: new Types.ObjectId(requestId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();

    if (!request) {
      throw new NotFoundException('Loan request not found.');
    }
    if (request.status !== 'pending') {
      throw new ConflictException({
        code: 'LOAN_REQUEST_NOT_PENDING',
        message: `Cannot action a loan request with status '${request.status}'.`,
      });
    }
    return request;
  }

  /**
   * Resolve the reviewing owner's own TeamMember._id for the reviewedBy stamp.
   * Best-effort: an owner without a directory row yields null (we still stamp
   * reviewedByUserId), so the audit trail is never blocked by a missing member.
   */
  private async resolveReviewerTeamMemberId(
    workspaceId: string,
    callerUserId: string,
  ): Promise<string | null> {
    try {
      const ctx = await this.callerScope.resolve(workspaceId, callerUserId);
      return ctx.teamMemberId ?? null;
    } catch (err) {
      this.logger.warn(
        `loan-request: could not resolve reviewer member for user ${callerUserId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }
}
