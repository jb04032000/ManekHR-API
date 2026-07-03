import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { LeaveRequestSettings } from './schemas/leave-request-settings.schema';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

export interface UpdateLeaveSettingsInput {
  approverUserIds: string[];
  sandwichLeave: boolean;
  retroMaxDaysBack: number;
  maxAttachmentsPerRequest: number;
}

/**
 * Workspace-scoped leave-request configuration — the approver chain, sandwich
 * policy, and retroactive-window settings. The row is lazily created with
 * schema defaults on first read.
 */
@Injectable()
export class LeaveSettingsService {
  private readonly logger = new Logger(LeaveSettingsService.name);
  private readonly tracer = trace.getTracer('leave');

  constructor(
    @InjectModel(LeaveRequestSettings.name)
    private readonly settingsModel: Model<LeaveRequestSettings>,
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

  /** Get the workspace's leave settings, creating defaults if absent. */
  async getSettings(workspaceId: string): Promise<LeaveRequestSettings> {
    const wsId = new Types.ObjectId(workspaceId);
    const existing = await this.settingsModel.findOne({ workspaceId: wsId }).exec();
    if (existing) return existing;
    return this.settingsModel.create({ workspaceId: wsId });
  }

  /** Replace the workspace's leave settings. */
  async updateSettings(
    workspaceId: string,
    input: UpdateLeaveSettingsInput,
    userId: string,
  ): Promise<LeaveRequestSettings> {
    return this.withLeaveSpan('leave.updateSettings', { workspaceId, userId }, async () => {
      const wsId = new Types.ObjectId(workspaceId);
      const updated = await this.settingsModel
        .findOneAndUpdate(
          { workspaceId: wsId },
          {
            $set: {
              approverUserIds: input.approverUserIds.map((id) => new Types.ObjectId(id)),
              sandwichLeave: input.sandwichLeave,
              retroMaxDaysBack: input.retroMaxDaysBack,
              maxAttachmentsPerRequest: input.maxAttachmentsPerRequest,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .exec();

      void this.auditService
        .logEvent({
          workspaceId,
          module: AppModuleEnum.LEAVE,
          entityType: 'leave_settings',
          entityId: String(updated._id),
          action: 'leave.settings_updated',
          actorId: userId,
          meta: {
            approverCount: input.approverUserIds.length,
            sandwichLeave: input.sandwichLeave,
            retroMaxDaysBack: input.retroMaxDaysBack,
          },
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : 'unknown error';
          this.logger.warn(
            `Audit log failed for leave event leave.settings_updated (workspace ${workspaceId}): ${detail}`,
          );
          Sentry.captureException(err, {
            tags: { module: 'leave', op: 'audit.leave.settings_updated' },
            extra: { workspaceId, actorId: userId },
          });
        });

      this.postHog.capture({
        distinctId: userId,
        event: 'leave.settings_updated',
        properties: {
          workspaceId,
          approverCount: input.approverUserIds.length,
          sandwichLeave: input.sandwichLeave,
        },
      });

      return updated;
    });
  }
}
