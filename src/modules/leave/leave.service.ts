import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { LeaveType } from './schemas/leave-type.schema';
import { CreateLeaveTypeDto, UpdateLeaveTypeDto } from './dto/leave.dto';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

/** Structural fields a system type (LWP) may not have changed — only label /
 * colour / ordering edits are allowed on it. LWP is the L3 decomposition
 * overflow bucket; flipping its paid flag or accrual rule would corrupt
 * payroll, so the catalogue editor locks it down. */
const SYSTEM_LOCKED_FIELDS: (keyof UpdateLeaveTypeDto)[] = [
  'isPaid',
  'unit',
  'statutoryBasis',
  'maxPerRequest',
  'applicability',
  'accrualRule',
  'yearEndRule',
  'compOff',
  'isActive',
];

/**
 * LeaveService — Leave Management module surface.
 *
 * L1 (foundation) shipped the leave-type read path. L5a adds the leave-type
 * catalogue CRUD that backs the web admin configuration page. The accrual
 * engine (L2), request + approval workflow (L3), and salary coupling (L4)
 * attach their logic to sibling services.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);
  private readonly tracer = trace.getTracer('leave');

  constructor(
    @InjectModel(LeaveType.name)
    private readonly leaveTypeModel: Model<LeaveType>,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Phase 5 W4 — wrap a handler body with an OpenTelemetry span. Mirrors
   * `TeamService.withTeamSpan`. Empty `OTEL_EXPORTER_OTLP_ENDPOINT` makes the
   * span a safe no-op; the helper still tags errors via `recordException` +
   * sets ERROR status.
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
   * Phase 5 W4 — fire-and-forget audit-event helper. Mirrors team's
   * `auditTeamEvent`. Failure here must NEVER break the caller's primary
   * operation; we swallow + Sentry-tag for follow-up.
   */
  private auditLeaveEvent(input: {
    action: string;
    workspaceId: string | Types.ObjectId;
    actorId: string | Types.ObjectId;
    entityType: string;
    entityId: string | Types.ObjectId;
    meta?: Record<string, unknown>;
  }): void {
    const wsId = String(input.workspaceId);
    const actor = String(input.actorId);
    void this.auditService
      .logEvent({
        workspaceId: wsId,
        module: AppModuleEnum.LEAVE,
        entityType: input.entityType,
        entityId: String(input.entityId),
        action: input.action,
        actorId: actor,
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for leave event ${input.action} (workspace ${wsId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'leave', op: `audit.${input.action}` },
          extra: { workspaceId: wsId, actorId: actor },
        });
      });
  }

  /**
   * Leave types for a workspace, ordered for display. Active-only by default
   * (the worker self-service surfaces); the admin config page passes
   * `includeInactive` to also show archived types for reactivation.
   */
  async listLeaveTypes(workspaceId: string, includeInactive = false): Promise<LeaveType[]> {
    return this.withLeaveSpan(
      'leave.listLeaveTypes',
      { workspaceId, includeInactive },
      async () => {
        const filter: FilterQuery<LeaveType> = {
          workspaceId: new Types.ObjectId(workspaceId),
        };
        if (!includeInactive) filter.isActive = true;
        return this.leaveTypeModel.find(filter).sort({ sortOrder: 1, code: 1 }).exec();
      },
    );
  }

  /** Create a hand-authored leave type. `code` must be unique per workspace. */
  async createLeaveType(
    workspaceId: string,
    dto: CreateLeaveTypeDto,
    userId: string,
  ): Promise<LeaveType> {
    return this.withLeaveSpan('leave.createLeaveType', { workspaceId, userId }, async () => {
      const wsId = new Types.ObjectId(workspaceId);
      const code = dto.code.trim().toUpperCase();

      const clash = await this.leaveTypeModel.exists({ workspaceId: wsId, code });
      if (clash) {
        throw new BadRequestException(`A leave type with code "${code}" already exists.`);
      }

      const count = await this.leaveTypeModel.countDocuments({ workspaceId: wsId });

      const created = await this.leaveTypeModel.create({
        workspaceId: wsId,
        code,
        labels: dto.labels,
        color: dto.color,
        isPaid: dto.isPaid,
        unit: dto.unit,
        statutoryBasis: dto.statutoryBasis,
        maxPerRequest: dto.maxPerRequest ?? null,
        applicability: dto.applicability,
        accrualRule: dto.accrualRule,
        yearEndRule: dto.yearEndRule,
        compOff: dto.compOff,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? count,
        isSystem: false,
        createdBy: new Types.ObjectId(userId),
      });

      this.auditLeaveEvent({
        action: 'leave.leave_type_created',
        workspaceId,
        actorId: userId,
        entityType: 'leave_type',
        entityId: created._id,
        meta: { code, isPaid: dto.isPaid, unit: dto.unit },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'leave.leave_type_created',
        properties: { workspaceId, leaveTypeId: String(created._id), code, unit: dto.unit },
      });

      return created;
    });
  }

  /** Update a leave type. System types accept only label / colour / order edits. */
  async updateLeaveType(
    workspaceId: string,
    id: string,
    dto: UpdateLeaveTypeDto,
    userId: string,
  ): Promise<LeaveType> {
    return this.withLeaveSpan(
      'leave.updateLeaveType',
      { workspaceId, leaveTypeId: id, userId },
      async () => {
        const wsId = new Types.ObjectId(workspaceId);
        const existing = await this.leaveTypeModel
          .findOne({ _id: new Types.ObjectId(id), workspaceId: wsId })
          .exec();
        if (!existing) {
          throw new NotFoundException('Leave type not found.');
        }

        const touchedLocked = SYSTEM_LOCKED_FIELDS.filter((k) => dto[k] !== undefined);
        if (existing.isSystem && touchedLocked.length > 0) {
          throw new BadRequestException(
            'System leave types allow only label, colour, and ordering changes.',
          );
        }

        const set: Record<string, unknown> = {};
        if (dto.labels !== undefined) set.labels = dto.labels;
        if (dto.color !== undefined) set.color = dto.color;
        if (dto.sortOrder !== undefined) set.sortOrder = dto.sortOrder;
        for (const k of touchedLocked) set[k] = dto[k];

        const updated = await this.leaveTypeModel
          .findOneAndUpdate({ _id: existing._id, workspaceId: wsId }, { $set: set }, { new: true })
          .exec();
        if (!updated) {
          throw new NotFoundException('Leave type not found.');
        }

        this.auditLeaveEvent({
          action: 'leave.leave_type_updated',
          workspaceId,
          actorId: userId,
          entityType: 'leave_type',
          entityId: updated._id,
          meta: { code: updated.code, fields: Object.keys(set) },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'leave.leave_type_updated',
          properties: {
            workspaceId,
            leaveTypeId: String(updated._id),
            code: updated.code,
          },
        });

        return updated;
      },
    );
  }

  /**
   * Archive a leave type — sets `isActive: false` so it disappears from new
   * applications while leaving every historical ledger entry / request /
   * balance row that references it intact. Never a hard delete. Reactivate
   * via `updateLeaveType({ isActive: true })`. System types cannot be removed.
   */
  async deleteLeaveType(workspaceId: string, id: string, userId: string): Promise<LeaveType> {
    return this.withLeaveSpan(
      'leave.deleteLeaveType',
      { workspaceId, leaveTypeId: id, userId },
      async () => {
        const wsId = new Types.ObjectId(workspaceId);
        const existing = await this.leaveTypeModel
          .findOne({ _id: new Types.ObjectId(id), workspaceId: wsId })
          .exec();
        if (!existing) {
          throw new NotFoundException('Leave type not found.');
        }
        if (existing.isSystem) {
          throw new BadRequestException('System leave types cannot be removed.');
        }
        existing.isActive = false;
        await existing.save();

        this.auditLeaveEvent({
          action: 'leave.leave_type_archived',
          workspaceId,
          actorId: userId,
          entityType: 'leave_type',
          entityId: existing._id,
          meta: { code: existing.code },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'leave.leave_type_archived',
          properties: { workspaceId, leaveTypeId: String(existing._id), code: existing.code },
        });

        return existing;
      },
    );
  }
}
