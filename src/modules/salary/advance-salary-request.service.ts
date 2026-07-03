import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AdvanceSalaryRequest } from './schemas/advance-salary-request.schema';
import { PayrollConfig } from './schemas/payroll-config.schema';
import {
  ApproveAdvanceRequestDto,
  CreateAdvanceRequestDto,
  RejectAdvanceRequestDto,
} from './dto/advance-salary-request.dto';
import {
  advanceRequestWindowMessage,
  isAdvanceRequestWindowOpen,
} from './utils/advance-request-window.util';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AdvanceSalaryRequestService {
  private readonly logger = new Logger(AdvanceSalaryRequestService.name);

  constructor(
    @InjectModel(AdvanceSalaryRequest.name)
    private readonly advanceRequestModel: Model<AdvanceSalaryRequest>,
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    // Step 6: worker notifications on decision. The NotificationsService +
    // member-lookup live here (not on SalaryService) so SalaryService's
    // constructor stays untouched; SalaryService.approveAndDisburseAdvanceRequest
    // calls the public notifyAdvanceDisbursed helper below.
    private readonly notificationsService: NotificationsService,
    @InjectModel(TeamMember.name)
    private readonly teamMemberModel: Model<TeamMember>,
    // Owner "request received" notification (2026-07-03): resolve workspace.ownerId.
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
  ) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Returns the current day-of-month in IST (avoids UTC vs IST boundary bugs, RESEARCH Pitfall 1). */
  private getTodayInIST(): { day: number; month: number; year: number } {
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    });
    const parts = formatter.formatToParts(new Date());
    const day = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
    const month = Number(parts.find((p) => p.type === 'month')?.value ?? '0');
    const year = Number(parts.find((p) => p.type === 'year')?.value ?? '0');
    return { day, month, year };
  }

  /**
   * Whole months of tenure elapsed from `from` (join date) to `to` (now).
   * Counts complete months: a member who joined on the 10th has 1 month of
   * tenure on the 10th of the next month, not before. Negative spans (future
   * join date) clamp to 0. Used by the Phase 3b min-tenure eligibility cap.
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

  // ---------------------------------------------------------------------------
  // Create request (employee-initiated, D-02 + D-08 + D-09)
  // ---------------------------------------------------------------------------

  // SECURITY: `teamMemberId` is the caller's OWN member id, resolved from the JWT
  // by the controller via CallerScopeService — it is NOT read from the request body.
  // This closes the IDOR where a self-scoped worker could request on another member's
  // behalf. Links: advance-salary-request.controller.ts createRequest.
  async createRequest(
    workspaceId: string,
    requestedByUserId: string,
    teamMemberId: string,
    dto: CreateAdvanceRequestDto,
  ): Promise<AdvanceSalaryRequest> {
    const config = await this.loadPayrollConfig(workspaceId);

    // OQ-S8 / Playbook Pattern 12 — workspace-policy AND-gate at REQUEST time.
    // Self-service advance requires (caller holds the self grant — enforced by the
    // route) AND (workspace policy enables advancePayments). When the toggle is
    // off, return a STRUCTURED deny payload (code + reason) instead of a generic
    // 400 so the worker app can show a precise "advances are turned off" message.
    if (!config.features?.advancePayments) {
      throw new BadRequestException({
        denied: true,
        code: 'SALARY_ADVANCE_DISABLED',
        reason: 'WORKSPACE_POLICY_ADVANCE_DISABLED',
        message: 'Salary advances are turned off for this workspace.',
      });
    }

    const advanceRequestDay = config.disbursementRules?.advanceRequestDay ?? 15;
    const policy = config.disbursementRules?.advanceRequestPolicy;

    // D-08: timing-policy guard (IST). Honors the workspace advanceRequestPolicy
    // (any_day | window | fixed_day); falls back to the legacy fixed
    // advanceRequestDay when no policy is stored (pre-migration workspaces).
    // Links: advance-request-window.util.ts.
    const { day: todayDay, month: istMonth, year: istYear } = this.getTodayInIST();
    if (!isAdvanceRequestWindowOpen(policy, advanceRequestDay, todayDay)) {
      throw new BadRequestException({
        code: 'ADVANCE_REQUEST_DAY_CLOSED',
        message: advanceRequestWindowMessage(policy, advanceRequestDay),
      });
    }

    // D-02: current-month guard — advance can only be requested against the current IST month/year
    if (dto.month !== istMonth || dto.year !== istYear) {
      throw new BadRequestException({
        code: 'ADVANCE_NOT_CURRENT_MONTH',
        message: 'Advances can only be requested against the current month.',
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 3b: advance ELIGIBILITY CAPS (owner-configurable, OFF by default).
    // Each guardrail runs ONLY when its PayrollConfig cap is non-null. All three
    // are absent on legacy/default workspaces, so this whole block is a no-op
    // unless the owner opted into a cap in Payroll Settings.
    // Links: payroll-config.schema.ts disbursementRules, update-disbursement-rules.dto.ts.
    // ─────────────────────────────────────────────────────────────────────────
    const rules = config.disbursementRules;
    const minTenureMonths = rules?.advanceMinTenureMonths;
    const maxPerYear = rules?.advanceMaxPerYear;
    const maxPercentOfNet = rules?.advanceMaxPercentOfNet;

    // Cap 1 — minimum tenure. Tenure is whole months elapsed from the member's
    // dateOfJoining to today. A member with no join date on file is NOT blocked
    // (we cannot prove they fail the cap; fail-open, mirroring other soft guards).
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
            code: 'ADVANCE_TENURE_NOT_MET',
            message: `You need at least ${minTenureMonths} month(s) of tenure to request an advance.`,
          });
        }
      }
    }

    // Cap 2 — max requests per calendar year. Counts the member's own requests in
    // dto.year that are still in play (pending|approved|paid); rejected/withdrawn
    // do not count against the allowance.
    if (maxPerYear != null) {
      const yearCount = await this.advanceRequestModel.countDocuments({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
        year: dto.year,
        status: { $in: ['pending', 'approved', 'paid'] },
      });
      if (yearCount >= maxPerYear) {
        throw new BadRequestException({
          code: 'ADVANCE_MAX_PER_YEAR',
          message: `You have reached the limit of ${maxPerYear} advance request(s) for this year.`,
        });
      }
    }

    // Cap 3 — % of the member's monthly figure. The member's monthly figure is
    // TeamMember.salaryAmount, stored in RUPEES; requestedAmount is in PAISE (the
    // advance/finance convention — see salary.service.ts applyAdvanceAutoDeductions
    // paise→rupee crossover). Compare in rupees. When salaryAmount is missing/<=0
    // the figure is not usable → SKIP the cap (fail-open) rather than guess.
    //
    // Baseline (owner directive 2026-07-03): a request can NEVER exceed 100% of
    // the monthly salary, always-on. The owner-configurable advanceMaxPercentOfNet
    // only TIGHTENS that baseline (e.g. 50%); when unset, 100% applies.
    {
      const effectivePercent = Math.min(maxPercentOfNet ?? 100, 100);
      const member = await this.teamMemberModel
        .findById(teamMemberId)
        .select('salaryAmount')
        .lean()
        .exec();
      const monthlyRupees = (member as { salaryAmount?: number } | null)?.salaryAmount ?? 0;
      if (monthlyRupees > 0) {
        const requestedRupees = dto.requestedAmount / 100;
        const capRupees = (effectivePercent / 100) * monthlyRupees;
        if (requestedRupees > capRupees) {
          throw new BadRequestException({
            code: 'ADVANCE_EXCEEDS_LIMIT',
            message:
              effectivePercent === 100
                ? 'An advance request cannot exceed your monthly salary.'
                : `An advance request cannot exceed ${effectivePercent}% of your monthly salary.`,
          });
        }
      }
    }

    try {
      const doc = await this.advanceRequestModel.create({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
        month: dto.month,
        year: dto.year,
        requestedAmount: dto.requestedAmount,
        status: 'pending',
        requestedOn: new Date(),
        requestedBy: new Types.ObjectId(requestedByUserId),
      });
      // Tell the owner a request landed (best-effort; in-app + push via dispatch).
      await this.notifyOwnerOfRequest(workspaceId, teamMemberId, String(doc._id), {
        title: 'Advance request received',
        message: `An advance of ${this.formatRupees(dto.requestedAmount)} was requested for ${this.monthLabel(dto.month, dto.year)}.`,
        link: '/dashboard/salary/advance-requests',
      });
      return doc;
    } catch (err: any) {
      // D-09: unique partial index violation → 409 Conflict
      if (err?.code === 11000) {
        throw new ConflictException({
          code: 'ADVANCE_DUPLICATE',
          message: 'An advance request already exists for this member this month.',
        });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Approve (owner action)
  // ---------------------------------------------------------------------------

  async approve(
    workspaceId: string,
    requestId: string,
    reviewerUserId: string,
    dto: ApproveAdvanceRequestDto,
  ): Promise<AdvanceSalaryRequest> {
    const request = await this.advanceRequestModel
      .findOne({
        _id: new Types.ObjectId(requestId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();

    if (!request) {
      throw new NotFoundException('Advance request not found.');
    }

    if (request.status !== 'pending') {
      throw new BadRequestException({
        code: 'ADVANCE_NOT_PENDING',
        message: `Cannot approve an advance request with status '${request.status}'.`,
      });
    }

    request.status = 'approved';
    request.approvedAmount = dto.approvedAmount;
    request.reviewedBy = new Types.ObjectId(reviewerUserId);
    request.reviewedOn = new Date();
    if (dto.reviewNote) {
      request.reviewNote = dto.reviewNote;
    }

    return request.save();
  }

  // ---------------------------------------------------------------------------
  // Reject (owner action)
  // ---------------------------------------------------------------------------

  async reject(
    workspaceId: string,
    requestId: string,
    reviewerUserId: string,
    dto: RejectAdvanceRequestDto,
  ): Promise<AdvanceSalaryRequest> {
    const request = await this.advanceRequestModel
      .findOne({
        _id: new Types.ObjectId(requestId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();

    if (!request) {
      throw new NotFoundException('Advance request not found.');
    }

    if (request.status !== 'pending') {
      throw new BadRequestException({
        code: 'ADVANCE_NOT_PENDING',
        message: `Cannot reject an advance request with status '${request.status}'.`,
      });
    }

    request.status = 'rejected';
    request.reviewedBy = new Types.ObjectId(reviewerUserId);
    request.reviewedOn = new Date();
    if (dto.reviewNote) {
      request.reviewNote = dto.reviewNote;
    }

    const saved = await request.save();

    // Step 6: tell the worker their request was declined (best-effort).
    await this.notifyWorker(workspaceId, saved.teamMemberId, String(saved._id), {
      title: 'Advance request declined',
      message: `Your salary advance request for ${this.monthLabel(saved.month, saved.year)} was not approved.${
        dto.reviewNote ? ` Note: ${dto.reviewNote}` : ''
      }`,
      type: 'warning',
    });

    return saved;
  }

  // ---------------------------------------------------------------------------
  // Mark paid (called by Plan 03/04 after the advance Payment is recorded)
  // ---------------------------------------------------------------------------

  /**
   * Flip an approved request → 'paid', linking the disbursing Payment.
   *
   * PAYROLL-CRITICAL: the disburse caller also passes the explicit-recovery
   * marker it just created — `recoveryPlanId` for a multi-installment plan, or
   * `recoveryAdjustmentId` for a single lump deduction. Stamping the marker
   * here (alongside the status flip, in one save) is what stops the salary-
   * generation safety net (`applyAdvanceAutoDeductions`) from creating a SECOND
   * recovery deduction for the same advance. Markers are optional so legacy
   * callers (and any future caller that has no explicit recovery) still work —
   * the safety net then correctly recovers the advance once.
   */
  async markPaid(
    workspaceId: string,
    requestId: string,
    paymentId: string,
    recovery?: {
      recoveryPlanId?: string;
      recoveryAdjustmentId?: string;
      /** Same-month settlement (owner model 2026-07-03): the advance Payment
       *  itself counts toward the request month's dues; no adjustment/plan
       *  exists. Stamped so applyAdvanceAutoDeductions skips this request. */
      sameMonthRecovery?: boolean;
    },
  ): Promise<AdvanceSalaryRequest> {
    const request = await this.advanceRequestModel
      .findOne({
        _id: new Types.ObjectId(requestId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();

    if (!request) {
      throw new NotFoundException('Advance request not found.');
    }

    if (request.status !== 'approved') {
      throw new BadRequestException({
        code: 'ADVANCE_NOT_APPROVED',
        message: `Cannot mark as paid an advance request with status '${request.status}'.`,
      });
    }

    request.status = 'paid';
    request.paymentId = new Types.ObjectId(paymentId);
    if (recovery?.recoveryPlanId) {
      request.recoveryPlanId = new Types.ObjectId(recovery.recoveryPlanId);
    }
    if (recovery?.recoveryAdjustmentId) {
      request.recoveryAdjustmentId = new Types.ObjectId(recovery.recoveryAdjustmentId);
    }
    if (recovery?.sameMonthRecovery) {
      request.sameMonthRecovery = true;
    }

    return request.save();
  }

  // ---------------------------------------------------------------------------
  // Worker notifications (Step 6) — best-effort, never block the decision.
  // Mirrors leave-notification.service.ts fanOut: resolve the member's linked
  // user account, then dispatch an in-app notification, swallowing failures so
  // a notification outage never rolls back an approve/reject/disburse.
  // ---------------------------------------------------------------------------

  /**
   * "Advance approved" worker notification, fired by
   * SalaryService.approveAndDisburseAdvanceRequest after the request is marked
   * paid. Public (not private) because SalaryService orchestrates the disburse;
   * keeping it here means SalaryService needs no NotificationsService dependency.
   */
  async notifyAdvanceDisbursed(
    workspaceId: string,
    request: AdvanceSalaryRequest,
    _reviewerUserId: string,
  ): Promise<void> {
    const amount = request.approvedAmount ?? request.requestedAmount;
    await this.notifyWorker(workspaceId, request.teamMemberId, String(request._id), {
      title: 'Advance approved',
      message: `Your salary advance of ${this.formatRupees(amount)} for ${this.monthLabel(
        request.month,
        request.year,
      )} was approved. Recovery will begin from next month's pay.`,
      type: 'success',
    });
  }

  private static readonly MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  private monthLabel(month: number, year: number): string {
    const name = AdvanceSalaryRequestService.MONTHS[month - 1] ?? `Month ${month}`;
    return `${name} ${year}`;
  }

  /** Paise -> "₹1,234" (Indian digit grouping). */
  private formatRupees(paise: number): string {
    const rupees = Math.round((paise ?? 0) / 100);
    return `₹${rupees.toLocaleString('en-IN')}`;
  }

  /** Resolve the member's linked platform-user id (null = kiosk-only, no app account). */
  private async resolveMemberUserId(teamMemberId: Types.ObjectId | string): Promise<string | null> {
    try {
      const member = await this.teamMemberModel
        .findById(teamMemberId)
        .select('linkedUserId')
        .lean()
        .exec();
      const linked = (member as { linkedUserId?: Types.ObjectId } | null)?.linkedUserId;
      return linked ? linked.toString() : null;
    } catch (err) {
      this.logger.warn(
        `advance notify: could not resolve user for member ${String(teamMemberId)}: ${this.errMsg(err)}`,
      );
      return null;
    }
  }

  private async notifyWorker(
    workspaceId: string,
    teamMemberId: Types.ObjectId | string,
    requestId: string,
    payload: {
      title: string;
      message: string;
      type: 'info' | 'warning' | 'success' | 'error';
    },
  ): Promise<void> {
    const recipientId = await this.resolveMemberUserId(teamMemberId);
    if (!recipientId) return;
    try {
      // dispatch (not createNotification) so the channel pipeline runs and
      // browser/mobile push fire alongside the in-app row (2026-07-03; same
      // fix as leave-notification.service.ts).
      await this.notificationsService.dispatch({
        recipientId,
        category: 'erp.salary_update',
        title: payload.title,
        message: payload.message,
        type: payload.type,
        workspaceId,
        entityType: 'advance_request',
        entityId: requestId,
        metadata: {
          entityType: 'advance_request',
          entityId: requestId,
          link: '/dashboard/salary',
        },
      });
    } catch (err) {
      this.logger.warn(
        `advance notify failed for member ${String(teamMemberId)}: ${this.errMsg(err)}`,
      );
    }
  }

  /**
   * Owner-facing "request received" notification (2026-07-03) — fired on
   * createRequest so the approver learns about a new advance without polling
   * the queue. Best-effort: any failure is swallowed (a notification outage
   * must never fail the request itself).
   */
  private async notifyOwnerOfRequest(
    workspaceId: string,
    teamMemberId: Types.ObjectId | string,
    requestId: string,
    payload: { title: string; message: string; link: string },
  ): Promise<void> {
    try {
      const ws = await this.workspaceModel.findById(workspaceId).select('ownerId').lean().exec();
      const ownerId = (ws as { ownerId?: Types.ObjectId } | null)?.ownerId;
      if (!ownerId) return;
      const member = await this.teamMemberModel.findById(teamMemberId).select('name').lean().exec();
      const memberName = (member as { name?: string } | null)?.name ?? 'A team member';
      await this.notificationsService.dispatch({
        recipientId: ownerId.toString(),
        category: 'erp.salary_update',
        title: payload.title,
        message: `${memberName}: ${payload.message}`,
        type: 'info',
        workspaceId,
        entityType: 'advance_request',
        entityId: requestId,
        metadata: { entityType: 'advance_request', entityId: requestId, link: payload.link },
      });
    } catch (err) {
      this.logger.warn(`advance owner-notify failed for ws ${workspaceId}: ${this.errMsg(err)}`);
    }
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : 'unknown error';
  }

  // ---------------------------------------------------------------------------
  // Worker-facing window read (self-scoped)
  // ---------------------------------------------------------------------------

  // Worker-facing read: lets the request drawer show whether the advance window
  // is open today without exposing the full PayrollConfig (which is salary view:all).
  // `todayDay` is injectable for unit tests; defaults to the IST day-of-month.
  // Links: advance-salary-request.controller.ts GET window,
  //        advance-request-window.util.ts (isAdvanceRequestWindowOpen + advanceRequestWindowMessage),
  //        AdvanceRequestDrawer.tsx (web consumer).
  async getWindowForMember(
    workspaceId: string,
    todayDay?: number,
  ): Promise<{
    policy: {
      mode: string;
      fixedDay?: number;
      windowStartDay?: number;
      windowEndDay?: number;
    };
    isOpenToday: boolean;
    message: string;
  }> {
    const config = await this.loadPayrollConfig(workspaceId);
    const fallbackDay = config.disbursementRules?.advanceRequestDay ?? 15;
    const policy = config.disbursementRules?.advanceRequestPolicy;
    const day = todayDay ?? this.getTodayInIST().day;
    const isOpenToday = isAdvanceRequestWindowOpen(policy, fallbackDay, day);
    return {
      policy: policy ?? { mode: 'fixed_day', fixedDay: fallbackDay },
      isOpenToday,
      message: advanceRequestWindowMessage(policy, fallbackDay),
    };
  }

  // ---------------------------------------------------------------------------
  // List for workspace (owner queue view)
  // ---------------------------------------------------------------------------

  async listForWorkspace(
    workspaceId: string,
    filter?: { status?: string; teamMemberId?: string },
  ): Promise<AdvanceSalaryRequest[]> {
    const query: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
    };

    if (filter?.status) {
      query.status = filter.status;
    }

    if (filter?.teamMemberId) {
      query.teamMemberId = new Types.ObjectId(filter.teamMemberId);
    }

    return (await this.advanceRequestModel
      .find(query)
      .sort({ createdAt: -1 })
      .lean()
      .exec()) as unknown as AdvanceSalaryRequest[];
  }

  // ---------------------------------------------------------------------------
  // List for a single member (member's own requests)
  // ---------------------------------------------------------------------------

  async listForMember(workspaceId: string, teamMemberId: string): Promise<AdvanceSalaryRequest[]> {
    return (await this.advanceRequestModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec()) as unknown as AdvanceSalaryRequest[];
  }

  // ---------------------------------------------------------------------------
  // Reporting-person review (Phase 3a) — ADVISORY, reportsTo-filtered
  // ---------------------------------------------------------------------------

  /**
   * List the advance requests of every member who REPORTS TO the reviewer
   * (TeamMember.reportsTo == reviewer's own teamMemberId). This is the
   * reporting-person review queue: visibility is a reportsTo-FILTERED read, NOT
   * a new RBAC scope. The route is gated on salary.review_advance@self; the
   * reviewer's own teamMemberId is resolved server-side from the JWT.
   *
   * Returns [] (without touching the request collection) when the reviewer has
   * no direct reports.
   *
   * Links: advance-salary-request.controller.ts GET for-my-reports,
   *        team-member.schema.ts reportsTo.
   */
  async listForMyReports(
    workspaceId: string,
    reviewerTeamMemberId: string,
  ): Promise<AdvanceSalaryRequest[]> {
    const wsOid = new Types.ObjectId(workspaceId);
    const reportIds = await this.teamMemberModel
      .find({ workspaceId: wsOid, reportsTo: new Types.ObjectId(reviewerTeamMemberId) })
      .distinct('_id');

    if (reportIds.length === 0) return [];

    return (await this.advanceRequestModel
      .find({ workspaceId: wsOid, teamMemberId: { $in: reportIds } })
      .sort({ createdAt: -1 })
      .lean()
      .exec()) as unknown as AdvanceSalaryRequest[];
  }

  /**
   * Reporting person VERIFIES one of their direct reports' advance requests.
   *
   * ADVISORY ONLY: this stamps verifiedBy/verifiedAt/verifyNote and NEVER
   * changes request.status nor gates the owner approve/reject/pay path — the
   * owner still sees and decides everything regardless of verification.
   *
   * Two anti-fraud guards, both 403:
   *   - Separation of duties: a reviewer can NEVER verify their OWN request
   *     (request.teamMemberId === reviewer's teamMemberId).
   *   - Direct-report membership: the request's member must actually report to
   *     the reviewer (member.reportsTo === reviewerTeamMemberId), so the
   *     review queue and the verify action enforce the same reportsTo edge.
   *
   * NOTE: this service has no AuditService dependency (its constructor is
   * advanceRequestModel/payrollConfigModel/notificationsService/teamMemberModel),
   * matching the existing approve/reject/markPaid methods which also do not
   * audit here. No new constructor dep is added; if an audit row is desired it
   * is the controller's responsibility (same as elsewhere in this module).
   *
   * Links: advance-salary-request.controller.ts PATCH :requestId/verify,
   *        advance-salary-request.schema.ts (verifiedBy/verifiedAt/verifyNote).
   */
  async verifyRequest(
    workspaceId: string,
    requestId: string,
    reviewerUserId: string,
    reviewerTeamMemberId: string,
    note?: string,
  ): Promise<AdvanceSalaryRequest> {
    const request = await this.advanceRequestModel
      .findOne({
        _id: new Types.ObjectId(requestId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();

    if (!request) {
      throw new NotFoundException('Advance request not found.');
    }

    // SoD: a reviewer can never verify their own request.
    if (String(request.teamMemberId) === String(reviewerTeamMemberId)) {
      throw new ForbiddenException('You cannot verify your own advance request.');
    }

    // Direct-report membership: the request's member must report to the reviewer.
    const member = await this.teamMemberModel.findById(request.teamMemberId).lean().exec();
    const reportsTo = (member as { reportsTo?: Types.ObjectId | null } | null)?.reportsTo;
    if (!reportsTo || String(reportsTo) !== String(reviewerTeamMemberId)) {
      throw new ForbiddenException('This advance request is not from your direct report.');
    }

    request.verifiedBy = new Types.ObjectId(reviewerUserId);
    request.verifiedAt = new Date();
    request.verifyNote = note;

    return request.save();
  }
}
