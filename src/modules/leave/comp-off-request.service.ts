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
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { CompOffRequest } from './schemas/comp-off-request.schema';
import { LeaveType } from './schemas/leave-type.schema';
import { Holiday } from '../holidays/schemas/holiday.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { CompOffService, CompOffLotView } from './comp-off.service';
import { LeaveSettingsService } from './leave-settings.service';
import { LeaveDelegationService } from './leave-delegation.service';
import { parseWeeklyOff, dayKey, resolveApproverChainForMember } from './leave-request.util';
import { isEarnableCompOffDay } from './leave-comp-off.util';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';
import { PolicyDeniedException } from '../../common/exceptions/policy-denied.exception';

export interface ApplyCompOffInput {
  workspaceId: string;
  teamMemberId: string;
  appliedBy: string;
  workDate: string; // YYYY-MM-DD
  quantity: number; // 0.5 | 1
  reason?: string | null;
  attachments?: string[];
  /** Caller acts on their OWN record at self-scope (controller-resolved).
   *  Gates the workspace self-service policy. */
  selfScoped?: boolean;
}

export interface ListCompOffRequestsFilter {
  status?: string;
  teamMemberId?: string;
}

const DAY_MS = 86_400_000;

/**
 * Comp-off earning lifecycle (Leave epic L3c1) — a member claims they worked a
 * holiday / weekly-off; on final approval `CompOffService.creditCompOff` mints
 * a `comp_off_credit` lot they can later spend via a leave request.
 *
 * Approval mirrors `LeaveRequestService` (snapshot-at-apply chain, atomic
 * per-level advance, auto-approve on an empty chain).
 */
@Injectable()
export class CompOffRequestService {
  private readonly logger = new Logger(CompOffRequestService.name);
  private readonly tracer = trace.getTracer('leave');

  constructor(
    @InjectModel(CompOffRequest.name)
    private readonly requestModel: Model<CompOffRequest>,
    @InjectModel(LeaveType.name)
    private readonly leaveTypeModel: Model<LeaveType>,
    @InjectModel(Holiday.name)
    private readonly holidayModel: Model<Holiday>,
    @InjectModel(TeamMember.name)
    private readonly memberModel: Model<TeamMember>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly compOffService: CompOffService,
    private readonly settingsService: LeaveSettingsService,
    private readonly delegationService: LeaveDelegationService,
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
   * Phase 5 W4 — fire-and-forget audit-event helper for a comp-off request.
   * Mirrors team's `auditTeamEvent`; a failure here never breaks the caller.
   */
  private auditCompOffEvent(input: {
    action: string;
    request: CompOffRequest;
    actorId: string;
    meta?: Record<string, unknown>;
  }): void {
    const wsId = String(input.request.workspaceId);
    void this.auditService
      .logEvent({
        workspaceId: wsId,
        module: AppModuleEnum.LEAVE,
        entityType: 'comp_off_request',
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

  /** Create a comp-off earning request (auto-approved when no approvers are set). */
  async applyForCompOff(input: ApplyCompOffInput): Promise<CompOffRequest> {
    return this.withLeaveSpan(
      'leave.applyForCompOff',
      {
        workspaceId: input.workspaceId,
        teamMemberId: input.teamMemberId,
        userId: input.appliedBy,
      },
      () => this.applyForCompOffImpl(input),
    );
  }

  private async applyForCompOffImpl(input: ApplyCompOffInput): Promise<CompOffRequest> {
    const wsId = new Types.ObjectId(input.workspaceId);
    const memberObjId = new Types.ObjectId(input.teamMemberId);
    const workDate = this.parseUtcDate(input.workDate);
    if (Number.isNaN(workDate.getTime())) {
      throw new BadRequestException('Invalid work date');
    }

    const todayUtc = this.startOfUtcDay(new Date());
    if (workDate.getTime() > todayUtc.getTime()) {
      throw new BadRequestException('Comp-off cannot be claimed for a future date');
    }

    const settings = await this.settingsService.getSettings(input.workspaceId);
    const daysBack = Math.floor((todayUtc.getTime() - workDate.getTime()) / DAY_MS);
    if (daysBack > settings.retroMaxDaysBack) {
      throw new BadRequestException(
        `Comp-off can be claimed at most ${settings.retroMaxDaysBack} day(s) back`,
      );
    }

    const member = await this.memberModel
      .findOne({ _id: memberObjId, workspaceId: wsId, isDeleted: false })
      .select('weeklyOff linkedUserId reportsTo')
      .lean()
      .exec();
    if (!member) throw new NotFoundException('Team member not found');

    // Self-service policy gate — a self-scoped member may claim their OWN
    // comp-off only when the owner has enabled self-service. Admin bypass.
    if (input.selfScoped) {
      const ws = await this.workspaceModel.findById(wsId).select('selfServiceConfig').lean().exec();
      if (!ws?.selfServiceConfig?.selfLeaveApply) {
        throw new PolicyDeniedException(
          'SELF_LEAVE_DISABLED',
          'Claiming your own comp-off is turned off for this workspace. Ask an admin to enable it.',
        );
      }
    }

    // Comp-off is earned only for working a holiday or one of the member's
    // weekly-off days — a normal working day earns nothing.
    const holidays = await this.holidayModel
      .find({ workspaceId: wsId, date: workDate })
      .select('date')
      .lean()
      .exec();
    const holidayKeys = new Set(holidays.map((h) => dayKey(h.date)));
    const weeklyOffDays = parseWeeklyOff(member.weeklyOff);
    if (!isEarnableCompOffDay(workDate, holidayKeys, weeklyOffDays)) {
      throw new BadRequestException(
        'Comp-off is earned only for working a holiday or a weekly-off day',
      );
    }

    const compOffType = await this.resolveCompOffType(wsId);

    // One live claim per work date — block a duplicate while one is open.
    const duplicate = await this.requestModel
      .findOne({
        workspaceId: wsId,
        teamMemberId: memberObjId,
        workDate,
        status: { $in: ['pending', 'approved'] },
      })
      .select('_id')
      .lean()
      .exec();
    if (duplicate) {
      throw new ConflictException('A comp-off claim for this date already exists');
    }

    const attachments = input.attachments ?? [];
    if (attachments.length > settings.maxAttachmentsPerRequest) {
      throw new BadRequestException(
        `At most ${settings.maxAttachmentsPerRequest} attachment(s) allowed`,
      );
    }

    // Snapshot the approval chain (SoD: a member can never approve their own
    // comp-off). Manager-first routing mirrors leave-request.service: the
    // direct reporting manager (Tier 1), else the workspace-configured approver
    // chain (Tier 2), else the workspace owner as the final backstop (Tier 3).
    // An empty chain means the applicant is the sole authority (the owner) and
    // the claim auto-approves.
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
    const autoApprove = approvalChain.length === 0;

    const created = await this.requestModel.create({
      workspaceId: wsId,
      teamMemberId: memberObjId,
      appliedBy: new Types.ObjectId(input.appliedBy),
      compOffLeaveTypeId: compOffType._id,
      workDate,
      quantity: input.quantity,
      reason: input.reason ?? null,
      attachments,
      status: autoApprove ? 'approved' : 'pending',
      approvalChain,
      currentLevel: 1,
      finalDecisionAt: autoApprove ? new Date() : null,
    });

    this.auditCompOffEvent({
      action: 'leave.comp_off_applied',
      request: created,
      actorId: input.appliedBy,
      meta: {
        workDate: input.workDate,
        quantity: input.quantity,
        autoApproved: autoApprove,
      },
    });

    this.postHog.capture({
      distinctId: input.appliedBy,
      event: 'leave.comp_off_applied',
      properties: {
        workspaceId: input.workspaceId,
        teamMemberId: input.teamMemberId,
        compOffRequestId: String(created._id),
        quantity: input.quantity,
        autoApproved: autoApprove,
      },
    });

    if (autoApprove) {
      return this.finalizeApprovedRequest(created, new Types.ObjectId(input.appliedBy));
    }
    return created;
  }

  /** Approve the caller's current level; the final level mints the comp-off lot. */
  async approveRequest(
    workspaceId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<CompOffRequest> {
    return this.withLeaveSpan(
      'leave.approveCompOff',
      { workspaceId, compOffRequestId: requestId, userId: approverUserId },
      () => this.approveRequestImpl(workspaceId, requestId, approverUserId, note),
    );
  }

  private async approveRequestImpl(
    workspaceId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<CompOffRequest> {
    const wsId = new Types.ObjectId(workspaceId);
    const reqId = new Types.ObjectId(requestId);

    const existing = await this.requestModel.findOne({ _id: reqId, workspaceId: wsId }).exec();
    if (!existing) throw new NotFoundException('Comp-off request not found');
    if (existing.status !== 'pending') {
      throw new ConflictException(`Comp-off request is ${existing.status}, not pending`);
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
      throw new ConflictException('Comp-off request was already decided by a concurrent action');
    }

    this.auditCompOffEvent({
      action: 'leave.comp_off_approved',
      request: updated,
      actorId: approverUserId,
      meta: { level: expectedLevel, isFinal },
    });

    this.postHog.capture({
      distinctId: approverUserId,
      event: 'leave.comp_off_approved',
      properties: {
        workspaceId,
        teamMemberId: String(updated.teamMemberId),
        compOffRequestId: String(updated._id),
        level: expectedLevel,
        isFinal,
      },
    });

    if (!isFinal) return updated;
    return this.finalizeApprovedRequest(updated, new Types.ObjectId(approverUserId));
  }

  /** Reject the caller's current level — terminal, no lot is minted. */
  async rejectRequest(
    workspaceId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<CompOffRequest> {
    return this.withLeaveSpan(
      'leave.rejectCompOff',
      { workspaceId, compOffRequestId: requestId, userId: approverUserId },
      () => this.rejectRequestImpl(workspaceId, requestId, approverUserId, note),
    );
  }

  private async rejectRequestImpl(
    workspaceId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<CompOffRequest> {
    const wsId = new Types.ObjectId(workspaceId);
    const reqId = new Types.ObjectId(requestId);

    const existing = await this.requestModel.findOne({ _id: reqId, workspaceId: wsId }).exec();
    if (!existing) throw new NotFoundException('Comp-off request not found');
    if (existing.status !== 'pending') {
      throw new ConflictException(`Comp-off request is ${existing.status}, not pending`);
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
      throw new ConflictException('Comp-off request was already decided by a concurrent action');
    }

    this.auditCompOffEvent({
      action: 'leave.comp_off_rejected',
      request: updated,
      actorId: approverUserId,
      meta: { level: expectedLevel },
    });

    this.postHog.capture({
      distinctId: approverUserId,
      event: 'leave.comp_off_rejected',
      properties: {
        workspaceId,
        teamMemberId: String(updated.teamMemberId),
        compOffRequestId: String(updated._id),
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
  ): Promise<CompOffRequest> {
    return this.withLeaveSpan(
      'leave.cancelCompOff',
      { workspaceId, compOffRequestId: requestId, userId },
      () => this.cancelRequestImpl(workspaceId, requestId, userId),
    );
  }

  private async cancelRequestImpl(
    workspaceId: string,
    requestId: string,
    userId: string,
  ): Promise<CompOffRequest> {
    const existing = await this.requestModel
      .findOne({ _id: new Types.ObjectId(requestId), workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    if (!existing) throw new NotFoundException('Comp-off request not found');
    if (existing.appliedBy.toString() !== userId) {
      throw new ForbiddenException('Only the applicant can cancel this request');
    }
    if (existing.status !== 'pending') {
      throw new ConflictException(`Comp-off request is ${existing.status}, not pending`);
    }
    if (existing.currentLevel > 1) {
      throw new ForbiddenException(
        'An approver has already actioned this request — it can no longer be cancelled',
      );
    }

    existing.status = 'cancelled';
    existing.finalDecisionAt = new Date();
    await existing.save();

    this.auditCompOffEvent({
      action: 'leave.comp_off_cancelled',
      request: existing,
      actorId: userId,
    });

    this.postHog.capture({
      distinctId: userId,
      event: 'leave.comp_off_cancelled',
      properties: {
        workspaceId,
        teamMemberId: String(existing.teamMemberId),
        compOffRequestId: String(existing._id),
      },
    });

    return existing;
  }

  /** A member's own comp-off requests, most recent first. */
  async listMyRequests(workspaceId: string, teamMemberId: string): Promise<CompOffRequest[]> {
    return this.requestModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  /** Workspace-wide comp-off requests, optionally filtered by status / member. */
  async listForWorkspace(
    workspaceId: string,
    filter: ListCompOffRequestsFilter,
  ): Promise<CompOffRequest[]> {
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
   * A member's active (non-expired, unspent) comp-off lots — the worker
   * comp-off self-service balance view (L6b). Returns an empty list when the
   * workspace has no comp-off leave type, so the surface degrades gracefully.
   */
  async listMyLots(workspaceId: string, teamMemberId: string): Promise<CompOffLotView[]> {
    const compOffType = await this.leaveTypeModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        isActive: true,
        'compOff.isCompOff': true,
      })
      .sort({ sortOrder: 1 })
      .select('_id')
      .lean()
      .exec();
    if (!compOffType) return [];
    return this.compOffService.listActiveLots({
      workspaceId,
      teamMemberId,
      compOffLeaveTypeId: String(compOffType._id),
      asOf: new Date(),
    });
  }

  /** A single comp-off request scoped to its workspace. */
  async getRequest(workspaceId: string, id: string): Promise<CompOffRequest> {
    const doc = await this.requestModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Comp-off request not found');
    return doc;
  }

  // ──────────────────────────── internals ────────────────────────────

  /** Mint the comp-off lot for an approved request and back-link it. */
  private async finalizeApprovedRequest(
    request: CompOffRequest,
    actorUserId: Types.ObjectId,
  ): Promise<CompOffRequest> {
    const compOffType = await this.leaveTypeModel
      .findById(request.compOffLeaveTypeId)
      .lean()
      .exec();
    if (!compOffType) throw new NotFoundException('Comp-off leave type not found');

    const lot = await this.compOffService.creditCompOff({
      workspaceId: String(request.workspaceId),
      teamMemberId: String(request.teamMemberId),
      compOffLeaveTypeId: String(request.compOffLeaveTypeId),
      sourceWorkDate: request.workDate,
      quantity: request.quantity,
      validityDays: compOffType.compOff.validityDays,
      sourceRef: { kind: 'comp_off_request', id: request._id },
      actorUserId,
    });

    request.ledgerEntryId = lot._id;
    request.lotExpiresOn = lot.lotExpiresOn;
    await request.save();
    return request;
  }

  /** The workspace's active comp-off leave type — there should be exactly one. */
  private async resolveCompOffType(wsId: Types.ObjectId): Promise<LeaveType> {
    const compOffType = await this.leaveTypeModel
      .findOne({ workspaceId: wsId, isActive: true, 'compOff.isCompOff': true })
      .sort({ sortOrder: 1 })
      .exec();
    if (!compOffType) {
      throw new BadRequestException('This workspace has no comp-off leave type configured');
    }
    return compOffType;
  }

  private parseUtcDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }

  private startOfUtcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}
