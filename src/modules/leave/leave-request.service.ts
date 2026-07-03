import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { LeaveRequest, HalfDaySession } from './schemas/leave-request.schema';
import { LeaveType } from './schemas/leave-type.schema';
import { Holiday } from '../holidays/schemas/holiday.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Salary } from '../salary/schemas/salary.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { AttendanceEventService } from '../attendance/attendance-event.service';
import { AttendanceProjectionService } from '../attendance/attendance-projection.service';
import { LeaveLedgerService } from './leave-ledger.service';
import { LeaveSettingsService } from './leave-settings.service';
import { CompOffService } from './comp-off.service';
import { LeaveDelegationService } from './leave-delegation.service';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';
import { PolicyDeniedException } from '../../common/exceptions/policy-denied.exception';
import {
  parseWeeklyOff,
  dayKey,
  expandWorkingDays,
  decomposePaidLwp,
  chargeAllToType,
  classifyLeaveType,
  leaveDayStatusValue,
  affectedMonths,
  LeaveDaySegmentDraft,
  resolveApproverChainForMember,
} from './leave-request.util';

/** A leave request's balance bucket — workspace × member × primary type × year. */
interface RequestBucket {
  workspaceId: Types.ObjectId;
  teamMemberId: Types.ObjectId;
  leaveTypeId: Types.ObjectId;
  year: number;
}

/** One overlapping leave by a teammate, surfaced as a non-blocking apply-time warning. */
export interface TeamConflict {
  teamMemberId: string;
  memberName: string;
  fromDate: Date;
  toDate: Date;
  status: string;
}

export interface ApplyLeaveInput {
  workspaceId: string;
  teamMemberId: string;
  appliedBy: string;
  primaryLeaveTypeId: string;
  fromDate: string; // YYYY-MM-DD
  toDate: string; // YYYY-MM-DD
  firstDayHalf: HalfDaySession;
  lastDayHalf: HalfDaySession;
  reason?: string | null;
  attachments?: string[];
  /** Caller acts on their OWN record at self-scope (controller-resolved).
   *  Gates the workspace self-service leave-apply policy. */
  selfScoped?: boolean;
}

export interface ListLeaveRequestsFilter {
  status?: string;
  teamMemberId?: string;
}

/** The apply-time decomposition, computed without persisting — feeds the
 *  self-service apply drawer's live paid-vs-LWP preview. */
export interface LeavePreviewResult {
  totalDays: number;
  paidDays: number;
  lwpDays: number;
  dayBreakdown: { date: string; leaveTypeId: string; quantity: number }[];
}

/**
 * Leave request lifecycle — L3a apply path + L3b approval lifecycle.
 *
 * `applyForLeave` validates the request, expands the date range into
 * chargeable working days (holiday / weekly-off aware), decomposes them into
 * paid + LWP segments, snapshots the approval chain, creates the request, and
 * reserves the paid portion on the member's `LeaveBalance`. A request with no
 * configured approvers is auto-approved on apply.
 *
 * L3b adds `approveRequest` / `rejectRequest` / `cancelRequest` /
 * `withdrawRequest`. On final approval the reserved `pending` is released, a
 * `usage` ledger entry is posted (FIFO comp-off draw for comp-off types), and
 * each charged day is projected onto attendance as an `on_leave` / `half_day`
 * status event. Withdrawal reverses all three.
 */
@Injectable()
export class LeaveRequestService {
  private readonly logger = new Logger(LeaveRequestService.name);
  private readonly tracer = trace.getTracer('leave');

  constructor(
    @InjectModel(LeaveRequest.name)
    private readonly requestModel: Model<LeaveRequest>,
    @InjectModel(LeaveType.name)
    private readonly leaveTypeModel: Model<LeaveType>,
    @InjectModel(Holiday.name)
    private readonly holidayModel: Model<Holiday>,
    @InjectModel(TeamMember.name)
    private readonly memberModel: Model<TeamMember>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly ledgerService: LeaveLedgerService,
    private readonly settingsService: LeaveSettingsService,
    private readonly compOffService: CompOffService,
    private readonly delegationService: LeaveDelegationService,
    @Inject(forwardRef(() => AttendanceEventService))
    private readonly eventService: AttendanceEventService,
    @Inject(forwardRef(() => AttendanceProjectionService))
    private readonly projectionService: AttendanceProjectionService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Phase 5 W4 — wrap a handler body with an OpenTelemetry span. Mirrors
   * `TeamService.withTeamSpan`.
   */
  private async withLeaveSpan<T>(
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
   * Phase 5 W4 — fire-and-forget audit-event helper for a leave request.
   * Mirrors team's `auditTeamEvent`; a failure here never breaks the caller.
   */
  private auditRequestEvent(input: {
    action: string;
    request: LeaveRequest;
    actorId: string;
    meta?: Record<string, unknown>;
  }): void {
    const wsId = String(input.request.workspaceId);
    void this.auditService
      .logEvent({
        workspaceId: wsId,
        module: AppModuleEnum.LEAVE,
        entityType: 'leave_request',
        entityId: String(input.request._id),
        action: input.action,
        actorId: input.actorId,
        teamMemberId: String(input.request.teamMemberId),
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for leave event ${input.action} (workspace ${wsId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'leave', op: `audit.${input.action}` },
          extra: { workspaceId: wsId, actorId: input.actorId },
        });
      });
  }

  /** Create a pending leave request and reserve its paid days. */
  async applyForLeave(input: ApplyLeaveInput): Promise<LeaveRequest> {
    return this.withLeaveSpan(
      'leave.applyForLeave',
      {
        workspaceId: input.workspaceId,
        teamMemberId: input.teamMemberId,
        userId: input.appliedBy,
      },
      () => this.applyForLeaveImpl(input),
    );
  }

  private async applyForLeaveImpl(input: ApplyLeaveInput): Promise<LeaveRequest> {
    const wsId = new Types.ObjectId(input.workspaceId);
    const memberObjId = new Types.ObjectId(input.teamMemberId);
    const from = this.parseUtcDate(input.fromDate);
    const to = this.parseUtcDate(input.toDate);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid leave dates');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('fromDate must not be after toDate');
    }
    if (from.getUTCFullYear() !== to.getUTCFullYear()) {
      throw new BadRequestException(
        'A leave request must stay within one calendar year — apply separately for each year',
      );
    }
    const year = from.getUTCFullYear();

    const leaveType = await this.leaveTypeModel
      .findOne({
        _id: new Types.ObjectId(input.primaryLeaveTypeId),
        workspaceId: wsId,
        isActive: true,
      })
      .exec();
    if (!leaveType) throw new NotFoundException('Leave type not found');

    const member = await this.memberModel
      .findOne({ _id: memberObjId, workspaceId: wsId, isDeleted: false })
      .select('weeklyOff gender linkedUserId reportsTo')
      .lean()
      .exec();
    if (!member) throw new NotFoundException('Team member not found');

    // Self-service policy gate — a self-scoped member may apply for their OWN
    // leave only when the owner has enabled it. Admin-applied requests bypass.
    if (input.selfScoped) {
      const ws = await this.workspaceModel.findById(wsId).select('selfServiceConfig').lean().exec();
      if (!ws?.selfServiceConfig?.selfLeaveApply) {
        throw new PolicyDeniedException(
          'SELF_LEAVE_DISABLED',
          'Applying for your own leave is turned off for this workspace. Ask an admin to enable it or to apply on your behalf.',
        );
      }
    }

    // Gender applicability (maternity / paternity).
    const genderRule = leaveType.applicability.gender;
    if (genderRule !== 'any' && member.gender && member.gender !== genderRule) {
      throw new BadRequestException(`${leaveType.labels.en} does not apply to this member`);
    }

    // A retroactive request into a locked payroll month is rejected — once a
    // month is locked its attendance / salary is frozen.
    await this.assertPayrollNotLocked(wsId, memberObjId, from, to, 'applied');

    // Duplicate/overlap guard (2026-07-03): reject when the member already has
    // a pending or approved request touching any day of this range. Stops
    // double submissions (each apply re-notifies the approver, so a duplicate
    // meant duplicate emails) and overlapping bookings in general. Same
    // overlap predicate as findTeamConflicts; cancelled/withdrawn/rejected
    // requests don't block re-applying.
    const overlappingOwn = await this.requestModel
      .findOne({
        workspaceId: wsId,
        teamMemberId: memberObjId,
        status: { $in: ['pending', 'approved'] },
        fromDate: { $lte: to },
        toDate: { $gte: from },
      })
      .select('fromDate toDate status')
      .lean()
      .exec();
    if (overlappingOwn) {
      throw new BadRequestException(
        overlappingOwn.status === 'pending'
          ? 'A pending leave request already covers part of these dates. Cancel it first or pick different dates.'
          : 'An approved leave already covers part of these dates. Pick different dates or withdraw the approved leave.',
      );
    }

    const settings = await this.settingsService.getSettings(input.workspaceId);

    const attachments = input.attachments ?? [];
    if (attachments.length > settings.maxAttachmentsPerRequest) {
      throw new BadRequestException(
        `At most ${settings.maxAttachmentsPerRequest} attachment(s) allowed`,
      );
    }

    // Chargeable working days — holidays + weekly-offs excluded unless sandwich.
    const holidays = await this.holidayModel
      .find({ workspaceId: wsId, date: { $gte: from, $lte: to } })
      .select('date')
      .lean()
      .exec();
    const holidayKeys = new Set(holidays.map((h) => dayKey(h.date)));
    const weeklyOffDays = parseWeeklyOff(member.weeklyOff);

    const workingDays = expandWorkingDays(
      from,
      to,
      input.firstDayHalf,
      input.lastDayHalf,
      holidayKeys,
      weeklyOffDays,
      settings.sandwichLeave,
    );
    if (workingDays.length === 0) {
      throw new BadRequestException('The selected range has no chargeable working days');
    }
    const totalDays = workingDays.reduce((sum, d) => sum + d.quantity, 0);

    if (leaveType.maxPerRequest != null && totalDays > leaveType.maxPerRequest) {
      throw new BadRequestException(
        `${leaveType.labels.en} allows at most ${leaveType.maxPerRequest} day(s) per request`,
      );
    }

    const lwpType = await this.leaveTypeModel
      .findOne({ workspaceId: wsId, code: 'LWP' })
      .select('_id')
      .lean()
      .exec();
    const lwpTypeId = lwpType ? String(lwpType._id) : null;
    const primaryTypeId = String(leaveType._id);
    const isLwpPrimary = lwpTypeId !== null && primaryTypeId === lwpTypeId;
    const isEntitlement = leaveType.accrualRule.mode === 'none' && !leaveType.compOff.isCompOff;

    let segments: LeaveDaySegmentDraft[];
    let paidDays: number;
    let lwpDays: number;
    let reservePaid = false;

    if (isLwpPrimary || isEntitlement) {
      // LWP itself, or an entitlement type (Maternity / Paternity /
      // Bereavement) — charged wholly to the primary type, no balance draw.
      segments = chargeAllToType(workingDays, primaryTypeId);
      paidDays = isLwpPrimary ? 0 : totalDays;
      lwpDays = isLwpPrimary ? totalDays : 0;
    } else {
      // Balance-tracked (CL / SL / EL) or comp-off — draw from the balance,
      // overflow to LWP.
      if (!lwpTypeId) {
        throw new BadRequestException('Workspace is missing the system Loss-of-Pay leave type');
      }
      const balance = await this.ledgerService.getBalance({
        workspaceId: wsId,
        teamMemberId: memberObjId,
        leaveTypeId: new Types.ObjectId(primaryTypeId),
        year,
      });
      const availablePaid = Math.max(0, balance?.available ?? 0);
      const decomposition = decomposePaidLwp(workingDays, availablePaid, primaryTypeId, lwpTypeId);
      segments = decomposition.segments;
      paidDays = decomposition.paidDays;
      lwpDays = decomposition.lwpDays;
      reservePaid = decomposition.paidDays > 0;
    }

    // Snapshot the approval chain (SoD: a member can never approve their own
    // leave). Routing is manager-first: the member's direct reporting manager
    // (Tier 1), else the workspace-configured approver chain (Tier 2), else the
    // workspace owner as the final oversight backstop (Tier 3). An empty chain
    // means the applicant is the sole authority (the owner applying their own
    // leave) and the request auto-approves. The resolver owns all SoD + manager
    // eligibility (inactive / deleted / no app account / self) decisions.
    const selfUserId = member.linkedUserId ? String(member.linkedUserId) : null;
    const manager = member.reportsTo
      ? await this.memberModel
          .findOne({ _id: member.reportsTo, workspaceId: wsId })
          .select('linkedUserId isActive isDeleted')
          .lean()
          .exec()
      : null;
    const ws = await this.workspaceModel.findById(wsId).select('ownerId').lean().exec();
    const ownerUserId = ws?.ownerId ? String(ws.ownerId) : null;
    const approvalChain = resolveApproverChainForMember({
      selfUserId,
      manager,
      settingsApproverUserIds: settings.approverUserIds,
      ownerUserId,
    });

    const todayUtc = this.startOfUtcDay(new Date());
    const isRetroactive = from.getTime() < todayUtc.getTime();

    // Chain is still empty only when the applicant IS the sole authority (the
    // owner applying their own leave) — born approved + finalised inline.
    // Otherwise it stays pending until the approver(s) decide.
    const autoApprove = approvalChain.length === 0;

    const created = await this.requestModel.create({
      workspaceId: wsId,
      teamMemberId: memberObjId,
      appliedBy: new Types.ObjectId(input.appliedBy),
      primaryLeaveTypeId: new Types.ObjectId(primaryTypeId),
      fromDate: from,
      toDate: to,
      firstDayHalf: input.firstDayHalf,
      lastDayHalf: input.lastDayHalf,
      dayBreakdown: segments.map((s) => ({
        date: s.date,
        leaveTypeId: new Types.ObjectId(s.leaveTypeId),
        quantity: s.quantity,
      })),
      totalDays,
      paidDays,
      lwpDays,
      reason: input.reason ?? null,
      attachments,
      status: autoApprove ? 'approved' : 'pending',
      approvalChain,
      currentLevel: 1,
      finalDecisionAt: autoApprove ? new Date() : null,
      isRetroactive,
    });

    // Reserve the paid portion on the primary leave type's balance.
    if (reservePaid && paidDays > 0) {
      await this.ledgerService.adjustPending(
        {
          workspaceId: wsId,
          teamMemberId: memberObjId,
          leaveTypeId: new Types.ObjectId(primaryTypeId),
          year,
        },
        paidDays,
      );
    }

    this.auditRequestEvent({
      action: 'leave.request_applied',
      request: created,
      actorId: input.appliedBy,
      meta: {
        leaveTypeId: primaryTypeId,
        totalDays,
        paidDays,
        lwpDays,
        autoApproved: autoApprove,
        isRetroactive,
      },
    });

    this.postHog.capture({
      distinctId: input.appliedBy,
      event: 'leave.request_applied',
      properties: {
        workspaceId: input.workspaceId,
        teamMemberId: input.teamMemberId,
        leaveRequestId: String(created._id),
        leaveTypeId: primaryTypeId,
        totalDays,
        paidDays,
        lwpDays,
        autoApproved: autoApprove,
      },
    });

    if (autoApprove) {
      return this.finalizeApprovedRequest(created, new Types.ObjectId(input.appliedBy));
    }
    return created;
  }

  /**
   * Dry-run the apply-time decomposition for a candidate leave — feeds the
   * worker self-service drawer's live paid-vs-LWP preview. Computational
   * only: it does NOT enforce payroll-lock, attachment caps, or gender
   * applicability (`applyForLeave` is the gate). A range landing entirely on
   * holidays / weekly-offs returns a zero result rather than throwing.
   *
   * The orchestration mirrors `applyForLeave` lines up to the decomposition;
   * the actual day-math lives in the shared pure utils (`expandWorkingDays`
   * / `decomposePaidLwp`), so the preview can never drift from the apply.
   */
  async previewLeave(input: ApplyLeaveInput): Promise<LeavePreviewResult> {
    return this.withLeaveSpan(
      'leave.previewLeave',
      {
        workspaceId: input.workspaceId,
        teamMemberId: input.teamMemberId,
        userId: input.appliedBy,
      },
      () => this.previewLeaveImpl(input),
    );
  }

  private async previewLeaveImpl(input: ApplyLeaveInput): Promise<LeavePreviewResult> {
    const wsId = new Types.ObjectId(input.workspaceId);
    const memberObjId = new Types.ObjectId(input.teamMemberId);
    const from = this.parseUtcDate(input.fromDate);
    const to = this.parseUtcDate(input.toDate);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid leave dates');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('fromDate must not be after toDate');
    }
    if (from.getUTCFullYear() !== to.getUTCFullYear()) {
      throw new BadRequestException('A leave request must stay within one calendar year');
    }
    const year = from.getUTCFullYear();

    const leaveType = await this.leaveTypeModel
      .findOne({
        _id: new Types.ObjectId(input.primaryLeaveTypeId),
        workspaceId: wsId,
        isActive: true,
      })
      .exec();
    if (!leaveType) throw new NotFoundException('Leave type not found');

    const member = await this.memberModel
      .findOne({ _id: memberObjId, workspaceId: wsId, isDeleted: false })
      .select('weeklyOff')
      .lean()
      .exec();
    if (!member) throw new NotFoundException('Team member not found');

    const settings = await this.settingsService.getSettings(input.workspaceId);

    const holidays = await this.holidayModel
      .find({ workspaceId: wsId, date: { $gte: from, $lte: to } })
      .select('date')
      .lean()
      .exec();
    const holidayKeys = new Set(holidays.map((h) => dayKey(h.date)));
    const weeklyOffDays = parseWeeklyOff(member.weeklyOff);

    const workingDays = expandWorkingDays(
      from,
      to,
      input.firstDayHalf,
      input.lastDayHalf,
      holidayKeys,
      weeklyOffDays,
      settings.sandwichLeave,
    );
    const totalDays = workingDays.reduce((sum, d) => sum + d.quantity, 0);
    if (workingDays.length === 0) {
      return { totalDays: 0, paidDays: 0, lwpDays: 0, dayBreakdown: [] };
    }

    const lwpType = await this.leaveTypeModel
      .findOne({ workspaceId: wsId, code: 'LWP' })
      .select('_id')
      .lean()
      .exec();
    const lwpTypeId = lwpType ? String(lwpType._id) : null;
    const primaryTypeId = String(leaveType._id);
    const isLwpPrimary = lwpTypeId !== null && primaryTypeId === lwpTypeId;
    const isEntitlement = leaveType.accrualRule.mode === 'none' && !leaveType.compOff.isCompOff;

    let segments: LeaveDaySegmentDraft[];
    let paidDays: number;
    let lwpDays: number;

    if (isLwpPrimary || isEntitlement) {
      segments = chargeAllToType(workingDays, primaryTypeId);
      paidDays = isLwpPrimary ? 0 : totalDays;
      lwpDays = isLwpPrimary ? totalDays : 0;
    } else if (!lwpTypeId) {
      throw new BadRequestException('Workspace is missing the system Loss-of-Pay leave type');
    } else {
      const balance = await this.ledgerService.getBalance({
        workspaceId: wsId,
        teamMemberId: memberObjId,
        leaveTypeId: new Types.ObjectId(primaryTypeId),
        year,
      });
      const availablePaid = Math.max(0, balance?.available ?? 0);
      const decomposition = decomposePaidLwp(workingDays, availablePaid, primaryTypeId, lwpTypeId);
      segments = decomposition.segments;
      paidDays = decomposition.paidDays;
      lwpDays = decomposition.lwpDays;
    }

    return {
      totalDays,
      paidDays,
      lwpDays,
      dayBreakdown: segments.map((s) => ({
        date: s.date instanceof Date ? s.date.toISOString() : String(s.date),
        leaveTypeId: s.leaveTypeId,
        quantity: s.quantity,
      })),
    };
  }

  /**
   * Approve the caller's current level. A non-final level advances the chain;
   * the final level flips the request to `approved` and finalises it (ledger
   * `usage`, attendance projection, `pending` release).
   */
  async approveRequest(
    workspaceId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<LeaveRequest> {
    return this.withLeaveSpan(
      'leave.approveRequest',
      { workspaceId, leaveRequestId: requestId, userId: approverUserId },
      () => this.approveRequestImpl(workspaceId, requestId, approverUserId, note),
    );
  }

  private async approveRequestImpl(
    workspaceId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<LeaveRequest> {
    const wsId = new Types.ObjectId(workspaceId);
    const reqId = new Types.ObjectId(requestId);

    const existing = await this.requestModel.findOne({ _id: reqId, workspaceId: wsId }).exec();
    if (!existing) throw new NotFoundException('Leave request not found');
    if (existing.status !== 'pending') {
      throw new ConflictException(`Leave request is ${existing.status}, not pending`);
    }

    const expectedLevel = existing.currentLevel;
    const step = existing.approvalChain[expectedLevel - 1];
    if (
      !step ||
      !(await this.delegationService.canActAsApprover(
        workspaceId,
        step.approverUserId.toString(),
        approverUserId,
      ))
    ) {
      throw new ForbiddenException('You are not the current-level approver for this request');
    }

    const isFinal = expectedLevel >= existing.approvalChain.length;
    // Final-step guards run BEFORE the atomic status flip so a failure leaves
    // no half-state: comp-off lots must still cover the draw, and no affected
    // payroll month may have locked since the request was raised.
    if (isFinal) {
      await this.assertConsumable(existing);
      await this.assertPayrollNotLocked(
        existing.workspaceId,
        existing.teamMemberId,
        existing.fromDate,
        existing.toDate,
        'approved',
      );
    }

    const now = new Date();
    const setOps: Record<string, unknown> = {
      [`approvalChain.${expectedLevel - 1}.decision`]: 'approved',
      [`approvalChain.${expectedLevel - 1}.decidedAt`]: now,
      [`approvalChain.${expectedLevel - 1}.note`]: note ?? null,
    };
    if (isFinal) {
      setOps.status = 'approved';
      setOps.finalDecisionAt = now;
    } else {
      setOps.currentLevel = expectedLevel + 1;
    }

    const updated = await this.requestModel
      .findOneAndUpdate(
        { _id: reqId, workspaceId: wsId, status: 'pending', currentLevel: expectedLevel },
        { $set: setOps },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new ConflictException('Leave request was already decided by a concurrent action');
    }

    this.auditRequestEvent({
      action: 'leave.request_approved',
      request: updated,
      actorId: approverUserId,
      meta: { level: expectedLevel, isFinal },
    });

    this.postHog.capture({
      distinctId: approverUserId,
      event: 'leave.request_approved',
      properties: {
        workspaceId,
        teamMemberId: String(updated.teamMemberId),
        leaveRequestId: String(updated._id),
        level: expectedLevel,
        isFinal,
      },
    });

    if (!isFinal) return updated;
    return this.finalizeApprovedRequest(updated, new Types.ObjectId(approverUserId));
  }

  /** Reject the caller's current level — terminal; releases the `pending` reservation. */
  async rejectRequest(
    workspaceId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<LeaveRequest> {
    return this.withLeaveSpan(
      'leave.rejectRequest',
      { workspaceId, leaveRequestId: requestId, userId: approverUserId },
      () => this.rejectRequestImpl(workspaceId, requestId, approverUserId, note),
    );
  }

  private async rejectRequestImpl(
    workspaceId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<LeaveRequest> {
    const wsId = new Types.ObjectId(workspaceId);
    const reqId = new Types.ObjectId(requestId);

    const existing = await this.requestModel.findOne({ _id: reqId, workspaceId: wsId }).exec();
    if (!existing) throw new NotFoundException('Leave request not found');
    if (existing.status !== 'pending') {
      throw new ConflictException(`Leave request is ${existing.status}, not pending`);
    }

    const expectedLevel = existing.currentLevel;
    const step = existing.approvalChain[expectedLevel - 1];
    if (
      !step ||
      !(await this.delegationService.canActAsApprover(
        workspaceId,
        step.approverUserId.toString(),
        approverUserId,
      ))
    ) {
      throw new ForbiddenException('You are not the current-level approver for this request');
    }

    const now = new Date();
    const updated = await this.requestModel
      .findOneAndUpdate(
        { _id: reqId, workspaceId: wsId, status: 'pending', currentLevel: expectedLevel },
        {
          $set: {
            status: 'rejected',
            finalDecisionAt: now,
            [`approvalChain.${expectedLevel - 1}.decision`]: 'rejected',
            [`approvalChain.${expectedLevel - 1}.decidedAt`]: now,
            [`approvalChain.${expectedLevel - 1}.note`]: note ?? null,
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new ConflictException('Leave request was already decided by a concurrent action');
    }

    await this.releasePending(updated);

    this.auditRequestEvent({
      action: 'leave.request_rejected',
      request: updated,
      actorId: approverUserId,
      meta: { level: expectedLevel },
    });

    this.postHog.capture({
      distinctId: approverUserId,
      event: 'leave.request_rejected',
      properties: {
        workspaceId,
        teamMemberId: String(updated.teamMemberId),
        leaveRequestId: String(updated._id),
        level: expectedLevel,
      },
    });

    return updated;
  }

  /** Applicant cancels their own still-pending request before any level decided. */
  async cancelRequest(
    workspaceId: string,
    requestId: string,
    userId: string,
  ): Promise<LeaveRequest> {
    return this.withLeaveSpan(
      'leave.cancelRequest',
      { workspaceId, leaveRequestId: requestId, userId },
      () => this.cancelRequestImpl(workspaceId, requestId, userId),
    );
  }

  private async cancelRequestImpl(
    workspaceId: string,
    requestId: string,
    userId: string,
  ): Promise<LeaveRequest> {
    const existing = await this.requestModel
      .findOne({ _id: new Types.ObjectId(requestId), workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    if (!existing) throw new NotFoundException('Leave request not found');
    if (existing.appliedBy.toString() !== userId) {
      throw new ForbiddenException('Only the applicant can cancel this request');
    }
    if (existing.status !== 'pending') {
      throw new ConflictException(`Leave request is ${existing.status}, not pending`);
    }
    if (existing.currentLevel > 1) {
      throw new ForbiddenException(
        'An approver has already actioned this request — it can no longer be cancelled',
      );
    }

    existing.status = 'cancelled';
    existing.finalDecisionAt = new Date();
    await existing.save();
    await this.releasePending(existing);

    this.auditRequestEvent({
      action: 'leave.request_cancelled',
      request: existing,
      actorId: userId,
    });

    this.postHog.capture({
      distinctId: userId,
      event: 'leave.request_cancelled',
      properties: {
        workspaceId,
        teamMemberId: String(existing.teamMemberId),
        leaveRequestId: String(existing._id),
      },
    });

    return existing;
  }

  /**
   * Applicant withdraws their own already-approved request — reverses the
   * `usage` ledger entry, voids the projected attendance events, and refreshes
   * each affected day's projection.
   */
  async withdrawRequest(
    workspaceId: string,
    requestId: string,
    userId: string,
  ): Promise<LeaveRequest> {
    return this.withLeaveSpan(
      'leave.withdrawRequest',
      { workspaceId, leaveRequestId: requestId, userId },
      () => this.withdrawRequestImpl(workspaceId, requestId, userId),
    );
  }

  private async withdrawRequestImpl(
    workspaceId: string,
    requestId: string,
    userId: string,
  ): Promise<LeaveRequest> {
    const existing = await this.requestModel
      .findOne({ _id: new Types.ObjectId(requestId), workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    if (!existing) throw new NotFoundException('Leave request not found');
    if (existing.appliedBy.toString() !== userId) {
      throw new ForbiddenException('Only the applicant can withdraw this request');
    }
    if (existing.status !== 'approved') {
      throw new ConflictException(
        `Only an approved request can be withdrawn — this one is ${existing.status}`,
      );
    }
    // Reversal voids attendance events — blocked once an affected month locked.
    await this.assertPayrollNotLocked(
      existing.workspaceId,
      existing.teamMemberId,
      existing.fromDate,
      existing.toDate,
      'withdrawn',
    );

    await this.reverseApprovedRequest(existing, new Types.ObjectId(userId));
    existing.status = 'withdrawn';
    existing.finalDecisionAt = new Date();
    await existing.save();

    this.auditRequestEvent({
      action: 'leave.request_withdrawn',
      request: existing,
      actorId: userId,
      meta: { paidDays: existing.paidDays, lwpDays: existing.lwpDays },
    });

    this.postHog.capture({
      distinctId: userId,
      event: 'leave.request_withdrawn',
      properties: {
        workspaceId,
        teamMemberId: String(existing.teamMemberId),
        leaveRequestId: String(existing._id),
      },
    });

    return existing;
  }

  /** A member's own leave requests, most recent first. */
  async listMyRequests(workspaceId: string, teamMemberId: string): Promise<LeaveRequest[]> {
    return this.requestModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  /** Workspace-wide leave requests, optionally filtered by status / member. */
  async listForWorkspace(
    workspaceId: string,
    filter: ListLeaveRequestsFilter,
  ): Promise<LeaveRequest[]> {
    const query: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
    };
    if (filter.status) query.status = filter.status;
    if (filter.teamMemberId) {
      query.teamMemberId = new Types.ObjectId(filter.teamMemberId);
    }
    return this.requestModel.find(query).sort({ createdAt: -1 }).limit(200).exec();
  }

  /**
   * Approved leave requests overlapping a date window — feeds the team
   * "who's on leave" calendar. A request overlaps when it starts on or
   * before the window end and ends on or after the window start.
   */
  async listForCalendar(workspaceId: string, from: string, to: string): Promise<LeaveRequest[]> {
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);
    return this.requestModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        status: 'approved',
        fromDate: { $lte: toDate },
        toDate: { $gte: fromDate },
      })
      .sort({ fromDate: 1 })
      .exec();
  }

  /** A single leave request scoped to its workspace. */
  async getRequest(workspaceId: string, id: string): Promise<LeaveRequest> {
    const doc = await this.requestModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Leave request not found');
    return doc;
  }

  /**
   * Teammates with a pending / approved leave overlapping `[from, to]` — a
   * non-blocking warning shown before a member submits. "Team" is the
   * member's designation cohort, or the whole workspace when they have none.
   */
  async findTeamConflicts(
    workspaceId: string,
    teamMemberId: string,
    fromDate: string,
    toDate: string,
  ): Promise<{ count: number; conflicts: TeamConflict[] }> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberObjId = new Types.ObjectId(teamMemberId);
    const from = this.parseUtcDate(fromDate);
    const to = this.parseUtcDate(toDate);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid conflict date range');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('fromDate must not be after toDate');
    }

    const member = await this.memberModel
      .findOne({ _id: memberObjId, workspaceId: wsId, isDeleted: false })
      .select('designation')
      .lean()
      .exec();
    if (!member) throw new NotFoundException('Team member not found');

    const siblingFilter: Record<string, unknown> = {
      workspaceId: wsId,
      isDeleted: false,
      _id: { $ne: memberObjId },
    };
    if (member.designation) siblingFilter.designation = member.designation;
    const siblings = await this.memberModel.find(siblingFilter).select('name').lean().exec();
    if (siblings.length === 0) return { count: 0, conflicts: [] };

    const nameById = new Map(siblings.map((s) => [String(s._id), s.name]));
    const overlapping = await this.requestModel
      .find({
        workspaceId: wsId,
        teamMemberId: { $in: siblings.map((s) => s._id) },
        status: { $in: ['pending', 'approved'] },
        // Two ranges overlap iff each starts on/before the other ends.
        fromDate: { $lte: to },
        toDate: { $gte: from },
      })
      .select('teamMemberId fromDate toDate status')
      .sort({ fromDate: 1 })
      .lean()
      .exec();

    const conflicts: TeamConflict[] = overlapping.map((r) => ({
      teamMemberId: String(r.teamMemberId),
      memberName: nameById.get(String(r.teamMemberId)) ?? 'Unknown',
      fromDate: r.fromDate,
      toDate: r.toDate,
      status: r.status,
    }));
    return { count: conflicts.length, conflicts };
  }

  // ──────────────────────────── finalisation ────────────────────────────

  /** Load a request's primary leave type and its behaviour class. */
  private async loadPrimaryClass(request: LeaveRequest) {
    const leaveType = await this.leaveTypeModel.findById(request.primaryLeaveTypeId).lean().exec();
    if (!leaveType) throw new NotFoundException('Primary leave type not found');
    const cls = classifyLeaveType({
      code: leaveType.code,
      accrualMode: leaveType.accrualRule.mode,
      isCompOff: leaveType.compOff.isCompOff,
    });
    return { leaveType, cls };
  }

  /** The request's balance bucket — primary type, calendar year of `fromDate`. */
  private requestBucket(request: LeaveRequest): RequestBucket {
    return {
      workspaceId: request.workspaceId,
      teamMemberId: request.teamMemberId,
      leaveTypeId: request.primaryLeaveTypeId,
      year: request.fromDate.getUTCFullYear(),
    };
  }

  /**
   * Reject the action when any calendar month the leave span touches has a
   * locked `Salary` — a locked month's attendance + payroll is frozen.
   */
  private async assertPayrollNotLocked(
    workspaceId: Types.ObjectId,
    teamMemberId: Types.ObjectId,
    from: Date,
    to: Date,
    context: 'applied' | 'approved' | 'withdrawn',
  ): Promise<void> {
    for (const m of affectedMonths(from, to)) {
      const locked = await this.salaryModel
        .findOne({ workspaceId, teamMemberId, month: m.month, year: m.year, isLocked: true })
        .select('_id')
        .lean()
        .exec();
      if (locked) {
        throw new BadRequestException(
          `Payroll for ${m.year}-${String(m.month).padStart(2, '0')} is locked — leave cannot be ${context} for that period`,
        );
      }
    }
  }

  /** True when an already-computed, still-unlocked `Salary` covers an affected month. */
  private async hasUnlockedSalary(
    workspaceId: Types.ObjectId,
    teamMemberId: Types.ObjectId,
    from: Date,
    to: Date,
  ): Promise<boolean> {
    for (const m of affectedMonths(from, to)) {
      const unlocked = await this.salaryModel
        .findOne({ workspaceId, teamMemberId, month: m.month, year: m.year, isLocked: false })
        .select('_id')
        .lean()
        .exec();
      if (unlocked) return true;
    }
    return false;
  }

  /**
   * Guard before flipping a request to `approved`: a comp-off draw must still
   * be covered by live (non-expired) lots. Accrual draws never fail here — the
   * ledger is append-only and tolerates a negative balance.
   */
  private async assertConsumable(request: LeaveRequest): Promise<void> {
    if (request.paidDays <= 0) return;
    const { cls } = await this.loadPrimaryClass(request);
    if (!cls.isCompOff) return;
    const available = await this.compOffService.availableForConsumption({
      workspaceId: String(request.workspaceId),
      teamMemberId: String(request.teamMemberId),
      compOffLeaveTypeId: String(request.primaryLeaveTypeId),
      asOf: new Date(),
    });
    if (available < request.paidDays) {
      throw new BadRequestException(
        `Comp-off balance is no longer sufficient — ${available} day(s) available, ${request.paidDays} needed`,
      );
    }
  }

  /** Release the `pending` reservation a balance-tracked apply made. */
  private async releasePending(request: LeaveRequest): Promise<void> {
    if (request.paidDays <= 0) return;
    const { cls } = await this.loadPrimaryClass(request);
    if (!cls.balanceTracked) return;
    await this.ledgerService.adjustPending(this.requestBucket(request), -request.paidDays);
  }

  /**
   * Finalise an approved request: post the `usage` ledger entry (FIFO comp-off
   * draw for comp-off types), release the `pending` reservation, and project
   * every charged day onto attendance as an `on_leave` / `half_day` status.
   */
  private async finalizeApprovedRequest(
    request: LeaveRequest,
    actorUserId: Types.ObjectId,
  ): Promise<LeaveRequest> {
    const { leaveType, cls } = await this.loadPrimaryClass(request);
    const sourceRef = { kind: 'leave_request' as const, id: request._id };

    if (cls.balanceTracked && request.paidDays > 0) {
      const bucket = this.requestBucket(request);
      if (cls.isCompOff) {
        const result = await this.compOffService.consumeCompOffFifo({
          workspaceId: String(request.workspaceId),
          teamMemberId: String(request.teamMemberId),
          compOffLeaveTypeId: String(request.primaryLeaveTypeId),
          quantity: request.paidDays,
          asOf: new Date(),
          sourceRef,
          actorUserId,
        });
        request.compOffConsumption = result.lots.map((lot) => ({
          lotLedgerEntryId: new Types.ObjectId(lot.ledgerEntryId),
          year: lot.year,
          consumed: lot.consumed,
        }));
      } else {
        const entry = await this.ledgerService.appendEntry({
          ...bucket,
          entryType: 'usage',
          quantity: -request.paidDays,
          effectiveDate: request.fromDate,
          sourceRef,
          actorUserId,
          reason: `Leave used — ${leaveType.labels.en}`,
        });
        request.ledgerEntryIds = [entry._id];
      }
      await this.ledgerService.adjustPending(bucket, -request.paidDays);
    }

    const eventIds: Types.ObjectId[] = [];
    for (const seg of request.dayBreakdown) {
      const event = await this.eventService.createEvent({
        wsId: request.workspaceId,
        teamMemberId: request.teamMemberId,
        timestamp: seg.date,
        attendanceDate: seg.date,
        punchType: 'STATUS_SET',
        statusValue: leaveDayStatusValue(seg.quantity),
        source: 'leave',
        markedBy: actorUserId,
        sourceMeta: {
          leaveRequestId: String(request._id),
          leaveTypeId: String(seg.leaveTypeId),
          quantity: seg.quantity,
        },
      });
      eventIds.push(event._id);
      await this.projectionService.recompute(
        String(request.workspaceId),
        String(request.teamMemberId),
        seg.date,
      );
    }
    request.attendanceEventIds = eventIds;

    // Flag the request when an already-computed (unlocked) salary covers an
    // affected month — the payroll manager must re-run it to pick up the leave.
    request.salaryInvalidated = await this.hasUnlockedSalary(
      request.workspaceId,
      request.teamMemberId,
      request.fromDate,
      request.toDate,
    );

    await request.save();
    return request;
  }

  /**
   * Reverse a finalised request on withdrawal: post a `usage_reversal` (or
   * re-credit the drawn comp-off lots), void every projected attendance event,
   * and refresh each affected day's projection.
   */
  private async reverseApprovedRequest(
    request: LeaveRequest,
    actorUserId: Types.ObjectId,
  ): Promise<void> {
    const { leaveType, cls } = await this.loadPrimaryClass(request);
    const sourceRef = { kind: 'leave_request' as const, id: request._id };

    if (cls.balanceTracked && request.paidDays > 0) {
      if (cls.isCompOff) {
        await this.compOffService.reverseConsumption({
          workspaceId: String(request.workspaceId),
          teamMemberId: String(request.teamMemberId),
          compOffLeaveTypeId: String(request.primaryLeaveTypeId),
          allocations: request.compOffConsumption.map((c) => ({
            lotLedgerEntryId: String(c.lotLedgerEntryId),
            year: c.year,
            consumed: c.consumed,
          })),
          sourceRef,
          actorUserId,
        });
      } else {
        await this.ledgerService.appendEntry({
          ...this.requestBucket(request),
          entryType: 'usage_reversal',
          quantity: request.paidDays,
          effectiveDate: new Date(),
          sourceRef,
          actorUserId,
          reason: `Leave withdrawn — ${leaveType.labels.en}`,
        });
      }
    }

    for (const eventId of request.attendanceEventIds) {
      try {
        const voided = await this.eventService.voidEvent(
          String(request.workspaceId),
          String(eventId),
          String(actorUserId),
          'Leave request withdrawn',
        );
        await this.projectionService.recompute(
          String(request.workspaceId),
          String(request.teamMemberId),
          voided.date,
        );
      } catch (err) {
        this.logger.warn(
          `withdrawRequest: could not void leave event ${String(eventId)} — ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        Sentry.captureException(err, {
          tags: { module: 'leave', op: 'reverseApprovedRequest.voidEvent' },
          extra: {
            workspaceId: String(request.workspaceId),
            leaveRequestId: String(request._id),
            eventId: String(eventId),
          },
        });
      }
    }
  }

  private parseUtcDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }

  private startOfUtcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}
