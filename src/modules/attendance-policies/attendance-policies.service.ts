import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { AttendancePolicy } from './schemas/attendance-policy.schema';
import {
  CreateAttendancePolicyDto,
  UpdateAttendancePolicyDto,
  DryRunDto,
} from './dto/attendance-policy.dto';
import {
  computeDailySummary,
  type PolicySnapshot,
  type EventInput,
  DEFAULT_SHIFT_SNAPSHOT,
} from '../attendance/projection/compute';
import { AttendanceEventService } from '../attendance/attendance-event.service';
import { Attendance } from '../attendance/schemas/attendance.schema';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

@Injectable()
export class AttendancePoliciesService {
  private readonly logger = new Logger(AttendancePoliciesService.name);
  private readonly tracer = trace.getTracer('attendance-policies');

  constructor(
    @InjectModel(AttendancePolicy.name)
    private readonly policyModel: Model<AttendancePolicy>,
    @InjectModel(Attendance.name)
    private readonly attendanceModel: Model<Attendance>,
    @Inject(forwardRef(() => AttendanceEventService))
    private readonly eventService: AttendanceEventService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Phase 5 W4 — wrap a handler body with an OpenTelemetry span.
   * Mirrors `AttendanceService.withAttendanceSpan`. Empty
   * `OTEL_EXPORTER_OTLP_ENDPOINT` makes the span a safe no-op.
   */
  private async withPolicySpan<T>(
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
   * Fire-and-forget audit helper. Failure must NEVER break the caller.
   * Mirrors `AttendanceService.auditAttendanceEvent`.
   */
  private auditPolicyEvent(input: {
    action: string;
    workspaceId: string;
    actorId: string;
    policyId: string;
    meta?: Record<string, unknown>;
  }): void {
    void this.auditService
      .logEvent({
        workspaceId: input.workspaceId,
        module: AppModuleEnum.ATTENDANCE,
        entityType: 'attendance_policy',
        entityId: input.policyId,
        action: input.action,
        actorId: input.actorId,
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for attendance-policy event ${input.action} (workspace ${input.workspaceId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'attendance-policies', op: `audit.${input.action}` },
          extra: { workspaceId: input.workspaceId, actorId: input.actorId },
        });
      });
  }

  /** List all policies for a workspace. */
  async findAll(wsId: string): Promise<AttendancePolicy[]> {
    return this.withPolicySpan('attendance.findAll_policies', { workspaceId: wsId }, async () => {
      return this.policyModel
        .find({ wsId: new Types.ObjectId(wsId) })
        .sort({ isDefault: -1, createdAt: 1 })
        .lean()
        .exec();
    });
  }

  /** Get one policy, enforcing workspace ownership. */
  async findOne(wsId: string, id: string): Promise<AttendancePolicy> {
    return this.withPolicySpan(
      'attendance.findOne_policy',
      { workspaceId: wsId, policyId: id },
      async () => {
        const policy = await this.policyModel
          .findOne({ _id: new Types.ObjectId(id), wsId: new Types.ObjectId(wsId) })
          .lean()
          .exec();
        if (!policy) throw new NotFoundException('Attendance policy not found');
        return policy;
      },
    );
  }

  /** Get the default policy for a workspace (null if none set). */
  async findDefault(wsId: string): Promise<AttendancePolicy | null> {
    return this.policyModel
      .findOne({ wsId: new Types.ObjectId(wsId), isDefault: true })
      .lean()
      .exec();
  }

  /** Get effective policy for a given policyId or fall back to workspace default. */
  async findEffective(wsId: string, policyId?: string | null): Promise<AttendancePolicy | null> {
    if (policyId) {
      const p = await this.policyModel
        .findOne({
          _id: new Types.ObjectId(policyId),
          wsId: new Types.ObjectId(wsId),
        })
        .lean()
        .exec();
      if (p) return p;
    }
    return this.findDefault(wsId);
  }

  /**
   * Create a new policy.
   * If isDefault=true, unsets isDefault on all other policies in the workspace first.
   *
   * @param userId — authenticated actor ID (from req.user.sub). Used for PostHog +
   *   audit attribution. Optional only so existing unit-test call sites (which
   *   pre-date this instrumentation) compile without breaking changes.
   */
  async create(
    wsId: string,
    dto: CreateAttendancePolicyDto,
    userId?: string,
  ): Promise<AttendancePolicy> {
    return this.withPolicySpan(
      'attendance.create_policy',
      { workspaceId: wsId, ...(userId ? { userId } : {}) },
      async (_span) => {
        try {
          if (dto.isDefault) {
            await this.unsetOtherDefaults(wsId, null);
          }
          const policy = await this.policyModel.create({
            wsId: new Types.ObjectId(wsId),
            ...dto,
          });
          const result = policy.toObject();

          if (userId) {
            this.postHog.capture({
              distinctId: userId,
              event: 'attendance.created_policy',
              properties: {
                workspaceId: wsId,
                policyId: String(result._id),
                isDefault: result.isDefault ?? false,
              },
            });
            this.auditPolicyEvent({
              action: 'attendance.policy_created',
              workspaceId: wsId,
              actorId: userId,
              policyId: String(result._id),
              meta: { name: dto.name, isDefault: dto.isDefault ?? false },
            });
          }

          return result;
        } catch (err) {
          Sentry.captureException(err, {
            tags: { module: 'attendance-policies', op: 'attendance.create_policy' },
            extra: { workspaceId: wsId },
          });
          throw err;
        }
      },
    );
  }

  /**
   * Update an existing policy.
   * If setting isDefault=true, unsets all other defaults in workspace first.
   *
   * @param userId — authenticated actor ID. Optional to preserve existing callers.
   */
  async update(
    wsId: string,
    id: string,
    dto: UpdateAttendancePolicyDto,
    userId?: string,
  ): Promise<AttendancePolicy> {
    return this.withPolicySpan(
      'attendance.update_policy',
      { workspaceId: wsId, policyId: id, ...(userId ? { userId } : {}) },
      async () => {
        try {
          await this.findOne(wsId, id); // throws if not found / wrong workspace
          if (dto.isDefault) {
            await this.unsetOtherDefaults(wsId, id);
          }
          const updated = await this.policyModel
            .findByIdAndUpdate(id, { $set: dto }, { new: true, lean: true })
            .exec();
          if (!updated) throw new NotFoundException('Attendance policy not found after update');

          if (userId) {
            this.postHog.capture({
              distinctId: userId,
              event: 'attendance.updated_policy',
              properties: {
                workspaceId: wsId,
                policyId: id,
              },
            });
            this.auditPolicyEvent({
              action: 'attendance.policy_updated',
              workspaceId: wsId,
              actorId: userId,
              policyId: id,
            });
          }

          return updated;
        } catch (err) {
          Sentry.captureException(err, {
            tags: { module: 'attendance-policies', op: 'attendance.update_policy' },
            extra: { workspaceId: wsId, policyId: id },
          });
          throw err;
        }
      },
    );
  }

  /**
   * Delete a policy. Cannot delete the default policy (must reassign first).
   *
   * @param userId — authenticated actor ID. Optional to preserve existing callers.
   */
  async remove(wsId: string, id: string, userId?: string): Promise<void> {
    return this.withPolicySpan(
      'attendance.remove_policy',
      { workspaceId: wsId, policyId: id, ...(userId ? { userId } : {}) },
      async () => {
        try {
          const policy = await this.findOne(wsId, id);
          if (policy.isDefault) {
            throw new BadRequestException(
              'Cannot delete the default policy. Assign a different default first.',
            );
          }
          await this.policyModel.findByIdAndDelete(id).exec();

          if (userId) {
            this.postHog.capture({
              distinctId: userId,
              event: 'attendance.deleted_policy',
              properties: {
                workspaceId: wsId,
                policyId: id,
              },
            });
            this.auditPolicyEvent({
              action: 'attendance.policy_deleted',
              workspaceId: wsId,
              actorId: userId,
              policyId: id,
            });
          }
        } catch (err) {
          Sentry.captureException(err, {
            tags: { module: 'attendance-policies', op: 'attendance.remove_policy' },
            extra: { workspaceId: wsId, policyId: id },
          });
          throw err;
        }
      },
    );
  }

  /**
   * Unsets isDefault on all policies in the workspace except the given excludeId.
   * excludeId = null means unset ALL (used on create).
   */
  private async unsetOtherDefaults(wsId: string, excludeId: string | null): Promise<void> {
    const filter: Record<string, unknown> = {
      wsId: new Types.ObjectId(wsId),
      isDefault: true,
    };
    if (excludeId) {
      filter['_id'] = { $ne: new Types.ObjectId(excludeId) };
    }
    await this.policyModel.updateMany(filter, { $set: { isDefault: false } }).exec();
  }

  /**
   * Convert an AttendancePolicy document to a PolicySnapshot for compute fn.
   */
  toPolicySnapshot(policy: AttendancePolicy): PolicySnapshot {
    return {
      lateArrival: {
        countAsLop: policy.lateArrival?.countAsLop ?? false,
        lopAfterNLateDays: policy.lateArrival?.lopAfterNLateDays ?? null,
      },
      earlyDeparture: {
        enabled: policy.earlyDeparture?.enabled ?? false,
        thresholdMinutes: policy.earlyDeparture?.thresholdMinutes ?? 30,
        countAsHalfDay: policy.earlyDeparture?.countAsHalfDay ?? false,
      },
      ot: {
        enabled: policy.ot?.enabled ?? false,
        thresholdMinutes: policy.ot?.thresholdMinutes ?? 30,
        capMinutes: policy.ot?.capMinutes ?? null,
      },
      compOff: {
        enabled: policy.compOff?.enabled ?? false,
      },
    };
  }

  /**
   * Dry-run: compute what changes applying this policy would produce over a date range.
   * Does NOT write to the database.
   *
   * Threat mitigation: date range capped at 31 days (T-C-03: dry-run date range abuse).
   * Scope filter is workspace-scoped via attendanceModel.find({ workspaceId: wsId }) —
   * memberIds from other workspaces simply return no records.
   *
   * LIMITATION: Uses DEFAULT_SHIFT_SNAPSHOT for all members. Per-member shift resolution
   * (flexi/split accuracy) requires Phase D shift lookup. 'after' values for non-fixed
   * shift members are fixed-shift approximations only.
   *
   * Performance: batch-load events per member (one query per member, not per day).
   */
  async dryRun(
    wsId: string,
    policyId: string,
    dto: DryRunDto,
  ): Promise<{
    changed: Array<{
      teamMemberId: string;
      date: string;
      before: { status: string; workedMinutes: number | null };
      after: {
        status: string;
        workedMinutes: number | null;
        lateMinutes: number;
      };
    }>;
    summary: { total: number; changed: number; unchanged: number };
  }> {
    return this.withPolicySpan(
      'attendance.dryRun_policy',
      { workspaceId: wsId, policyId },
      async () => {
        // Validate policy ownership
        const policy = await this.findOne(wsId, policyId);
        const policySnapshot = this.toPolicySnapshot(policy);

        // Threat model mitigation: enforce max 31-day range (T-C-03)
        const from = new Date(dto.dateRange.from + 'T00:00:00Z');
        const to = new Date(dto.dateRange.to + 'T00:00:00Z');
        if (isNaN(from.getTime()) || isNaN(to.getTime())) {
          throw new BadRequestException('Invalid date range: dates must be in YYYY-MM-DD format');
        }
        const diffDays = (to.getTime() - from.getTime()) / 86_400_000;
        if (diffDays > 31) {
          throw new BadRequestException('Dry-run date range cannot exceed 31 days.');
        }
        if (diffDays < 0) {
          throw new BadRequestException('Dry-run date range: "from" must be before "to"');
        }

        // Load current Attendance projections for the date range + optional scope
        const filter: Record<string, unknown> = {
          workspaceId: new Types.ObjectId(wsId),
          date: { $gte: from, $lte: to },
        };
        if (dto.scope?.length) {
          filter['teamMemberId'] = {
            $in: dto.scope.map((id) => new Types.ObjectId(id)),
          };
        }

        const currentRecords = await this.attendanceModel
          .find(filter)
          .select('teamMemberId date status workedMinutes')
          .lean()
          .exec();

        // Get distinct memberIds to batch-load events
        const memberIds = [
          ...new Set(currentRecords.map((r) => (r.teamMemberId as Types.ObjectId).toHexString())),
        ];

        if (memberIds.length > 200) {
          this.logger.warn(
            `DryRun: large workspace (${memberIds.length} members). Performance may be slow.`,
          );
        }

        // Build a map: memberId → dayKey(YYYY-MM-DD) → events[]
        // NOTE: Dry-run uses DEFAULT_SHIFT_SNAPSHOT for all members. Per-member shift
        // resolution (flexi/split accuracy) requires per-member shift lookup, deferred to
        // Phase D. 'after' status for flexi/split employees is a fixed-shift approximation.
        const eventsByMemberDay = new Map<string, Map<string, EventInput[]>>();

        for (const mId of memberIds) {
          const events = await this.eventService.findByMemberDateRange(wsId, mId, from, to);
          const dayMap = new Map<string, EventInput[]>();
          for (const e of events) {
            const dayKey = new Date(e.timestamp).toISOString().slice(0, 10);
            const existing = dayMap.get(dayKey) ?? [];
            existing.push({
              timestamp: new Date(e.timestamp),
              punchType: e.punchType as EventInput['punchType'],
              statusValue: e.statusValue ?? null,
              source: e.source as EventInput['source'],
            });
            dayMap.set(dayKey, existing);
          }
          eventsByMemberDay.set(mId, dayMap);
        }

        const changed: Array<{
          teamMemberId: string;
          date: string;
          before: { status: string; workedMinutes: number | null };
          after: { status: string; workedMinutes: number | null; lateMinutes: number };
        }> = [];

        let total = 0;
        let changedCount = 0;

        for (const record of currentRecords) {
          total += 1;
          const mId = (record.teamMemberId as Types.ObjectId).toHexString();
          const dateKey = record.date.toISOString().slice(0, 10);
          const dayEvents = eventsByMemberDay.get(mId)?.get(dateKey) ?? [];

          const summary = computeDailySummary(
            dayEvents,
            DEFAULT_SHIFT_SNAPSHOT, // fixed-shift approximation — see NOTE above
            policySnapshot,
            new Date(record.date),
          );

          const statusChanged = summary.status !== record.status;
          const minutesChanged = summary.workedMinutes !== record.workedMinutes;

          if (statusChanged || minutesChanged) {
            changedCount += 1;
            changed.push({
              teamMemberId: mId,
              date: dateKey,
              before: {
                status: record.status,
                workedMinutes: record.workedMinutes ?? null,
              },
              after: {
                status: summary.status,
                workedMinutes: summary.workedMinutes,
                lateMinutes: summary.lateMinutes,
              },
            });
          }
        }

        return {
          changed,
          summary: { total, changed: changedCount, unchanged: total - changedCount },
        };
      },
    );
  }
}
