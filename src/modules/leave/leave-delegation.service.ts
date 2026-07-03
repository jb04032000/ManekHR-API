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
import { LeaveApproverDelegation } from './schemas/leave-approver-delegation.schema';
import { rangesOverlap } from './leave-request.util';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

export interface CreateDelegationInput {
  workspaceId: string;
  fromUserId: string;
  toUserId: string;
  startsOn: string; // YYYY-MM-DD
  endsOn: string; // YYYY-MM-DD
  reason?: string | null;
}

export interface ListDelegationsFilter {
  fromUserId?: string;
  includeInactive?: boolean;
}

/**
 * Approver-delegation lifecycle (Leave epic L3c3) — owns the
 * `LeaveApproverDelegation` records and the `canActAsApprover` resolver that
 * both `LeaveRequestService` and `CompOffRequestService` consult on every
 * approve / reject identity check.
 */
@Injectable()
export class LeaveDelegationService {
  private readonly logger = new Logger(LeaveDelegationService.name);
  private readonly tracer = trace.getTracer('leave');

  constructor(
    @InjectModel(LeaveApproverDelegation.name)
    private readonly delegationModel: Model<LeaveApproverDelegation>,
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
   * Phase 5 W4 — fire-and-forget audit-event helper for delegation events.
   * Mirrors team's `auditTeamEvent`; a failure here never breaks the caller.
   */
  private auditDelegationEvent(input: {
    action: string;
    workspaceId: string;
    actorId: string;
    delegationId: string | Types.ObjectId;
    meta?: Record<string, unknown>;
  }): void {
    void this.auditService
      .logEvent({
        workspaceId: input.workspaceId,
        module: AppModuleEnum.LEAVE,
        entityType: 'leave_delegation',
        entityId: String(input.delegationId),
        action: input.action,
        actorId: input.actorId,
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for leave event ${input.action} (workspace ${input.workspaceId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'leave', op: `audit.${input.action}` },
          extra: { workspaceId: input.workspaceId, actorId: input.actorId },
        });
      });
  }

  /** Delegate the caller's approval authority for a coverage window. */
  async createDelegation(input: CreateDelegationInput): Promise<LeaveApproverDelegation> {
    return this.withLeaveSpan(
      'leave.createDelegation',
      { workspaceId: input.workspaceId, userId: input.fromUserId },
      () => this.createDelegationImpl(input),
    );
  }

  private async createDelegationImpl(
    input: CreateDelegationInput,
  ): Promise<LeaveApproverDelegation> {
    const wsId = new Types.ObjectId(input.workspaceId);
    const fromUserId = new Types.ObjectId(input.fromUserId);
    const toUserId = new Types.ObjectId(input.toUserId);
    if (fromUserId.equals(toUserId)) {
      throw new BadRequestException('Cannot delegate approval authority to yourself');
    }

    const startsOn = this.parseUtcDate(input.startsOn);
    const endsOn = this.parseUtcDate(input.endsOn);
    if (Number.isNaN(startsOn.getTime()) || Number.isNaN(endsOn.getTime())) {
      throw new BadRequestException('Invalid delegation dates');
    }
    if (startsOn.getTime() > endsOn.getTime()) {
      throw new BadRequestException('startsOn must not be after endsOn');
    }

    // One active coverage window per delegator — a clashing window must be
    // revoked first so the live-delegation lookup stays unambiguous.
    const active = await this.delegationModel
      .find({ workspaceId: wsId, fromUserId, isActive: true })
      .select('startsOn endsOn')
      .lean()
      .exec();
    const clash = active.some((d) => rangesOverlap(startsOn, endsOn, d.startsOn, d.endsOn));
    if (clash) {
      throw new ConflictException(
        'An active delegation already covers part of this window — revoke it first',
      );
    }

    const created = await this.delegationModel.create({
      workspaceId: wsId,
      fromUserId,
      toUserId,
      startsOn,
      endsOn,
      reason: input.reason ?? null,
      isActive: true,
    });

    this.auditDelegationEvent({
      action: 'leave.delegation_created',
      workspaceId: input.workspaceId,
      actorId: input.fromUserId,
      delegationId: created._id,
      meta: {
        toUserId: input.toUserId,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      },
    });

    this.postHog.capture({
      distinctId: input.fromUserId,
      event: 'leave.delegation_created',
      properties: {
        workspaceId: input.workspaceId,
        delegationId: String(created._id),
        toUserId: input.toUserId,
      },
    });

    return created;
  }

  /** Workspace delegations — active-only unless `includeInactive` is set. */
  async listDelegations(
    workspaceId: string,
    filter: ListDelegationsFilter,
  ): Promise<LeaveApproverDelegation[]> {
    const query: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
    };
    if (filter.fromUserId) query.fromUserId = new Types.ObjectId(filter.fromUserId);
    if (!filter.includeInactive) query.isActive = true;
    return this.delegationModel.find(query).sort({ startsOn: -1 }).limit(200).exec();
  }

  /** Revoke a delegation — only the delegating approver may do so. */
  async revokeDelegation(
    workspaceId: string,
    id: string,
    callerUserId: string,
  ): Promise<LeaveApproverDelegation> {
    return this.withLeaveSpan(
      'leave.revokeDelegation',
      { workspaceId, delegationId: id, userId: callerUserId },
      () => this.revokeDelegationImpl(workspaceId, id, callerUserId),
    );
  }

  private async revokeDelegationImpl(
    workspaceId: string,
    id: string,
    callerUserId: string,
  ): Promise<LeaveApproverDelegation> {
    const doc = await this.delegationModel
      .findOne({ _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    if (!doc) throw new NotFoundException('Delegation not found');
    if (doc.fromUserId.toString() !== callerUserId) {
      throw new ForbiddenException('Only the delegating approver can revoke this delegation');
    }
    if (!doc.isActive) {
      throw new ConflictException('Delegation is already revoked');
    }
    doc.isActive = false;
    doc.revokedBy = new Types.ObjectId(callerUserId);
    doc.revokedAt = new Date();
    const saved = await doc.save();

    this.auditDelegationEvent({
      action: 'leave.delegation_revoked',
      workspaceId,
      actorId: callerUserId,
      delegationId: saved._id,
    });

    this.postHog.capture({
      distinctId: callerUserId,
      event: 'leave.delegation_revoked',
      properties: { workspaceId, delegationId: String(saved._id) },
    });

    return saved;
  }

  /**
   * Whether `callerUserId` may act in `approverUserId`'s place as of `asOf` —
   * true when they are the same user, or a live delegate. Consulted by both
   * approval services on every approve / reject identity check.
   */
  async canActAsApprover(
    workspaceId: string,
    approverUserId: string,
    callerUserId: string,
    asOf: Date = new Date(),
  ): Promise<boolean> {
    if (approverUserId === callerUserId) return true;
    const today = this.startOfUtcDay(asOf);
    const live = await this.delegationModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        fromUserId: new Types.ObjectId(approverUserId),
        toUserId: new Types.ObjectId(callerUserId),
        isActive: true,
        startsOn: { $lte: today },
        endsOn: { $gte: today },
      })
      .select('_id')
      .lean()
      .exec();
    return live !== null;
  }

  private parseUtcDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }

  private startOfUtcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}
