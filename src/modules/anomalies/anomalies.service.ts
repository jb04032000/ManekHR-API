import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Anomaly, AnomalyRuleType, AnomalySeverity } from './schemas/anomaly.schema';
import { AnomalyRule } from './schemas/anomaly-rule.schema';
import { AnomalyNotifyService } from './anomaly-notify.service';
import { PostHogService } from '../../common/posthog/posthog.service';

export interface RecordAnomalyInput {
  wsId: string | Types.ObjectId;
  ruleType: AnomalyRuleType;
  severity: AnomalySeverity;
  teamMemberId?: string | Types.ObjectId | null;
  deviceSerial?: string | null;
  context: Record<string, unknown>;
  contextKey?: string | null;
}

export interface ListAnomaliesQuery {
  unacknowledgedOnly?: boolean;
  page?: number;
  limit?: number;
}

@Injectable()
export class AnomaliesService {
  private readonly logger = new Logger(AnomaliesService.name);
  private readonly tracer = trace.getTracer('anomalies');

  constructor(
    @InjectModel(Anomaly.name) private readonly anomalyModel: Model<Anomaly>,
    @InjectModel(AnomalyRule.name) private readonly ruleModel: Model<AnomalyRule>,
    private readonly notifyService: AnomalyNotifyService,
    // @Optional so manual construction (tests, non-DI ingest wiring) does not
    // crash — PostHogModule is @Global, so production DI always supplies it.
    @Optional() private readonly postHog?: PostHogService,
  ) {}

  /**
   * Entry point for ALL anomaly detection paths (synchronous hook, cron, Phase B unknown_sn).
   * Fire-and-forget notification dispatch — detection failure must never break the caller.
   */
  async record(input: RecordAnomalyInput): Promise<void> {
    return this.tracer.startActiveSpan('anomalies.record', async (span) => {
      const wsId = String(input.wsId);
      span.setAttributes({ workspaceId: wsId, ruleType: input.ruleType });
      try {
        const wsObjectId = new Types.ObjectId(wsId);

        // 1. Rule gate — if rule exists and is disabled, short-circuit.
        const rule = await this.ruleModel.findOne({ wsId: wsObjectId, ruleType: input.ruleType });
        if (rule && rule.enabled === false) {
          span.setAttributes({ result: 'rule_disabled' });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return;
        }

        // 2. Contextual dedupe: skip if unacknowledged anomaly with same contextKey exists.
        // unknown_sn and missed_streak are idempotent by contextKey — creating duplicates would cause alert fatigue.
        // D-11 (BUG-05): time_travel added — replay of old events must not bloat anomaly table.
        // contextKey supplied by caller = 'YYYY-MM-DD' of the punch event timestamp (UTC date).
        // Other rule types (rapid_dup, off_shift_punch) are ephemeral events and do NOT use this gate.
        const DEDUPE_RULE_TYPES: AnomalyRuleType[] = ['unknown_sn', 'missed_streak', 'time_travel'];
        if (DEDUPE_RULE_TYPES.includes(input.ruleType) && input.contextKey) {
          const dupe = await this.anomalyModel.findOne({
            wsId: wsObjectId,
            ruleType: input.ruleType,
            contextKey: input.contextKey,
            acknowledged: false,
          });
          if (dupe) {
            span.setAttributes({ result: 'deduped' });
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return;
          }
        }

        // 3. Persist.
        const created = await this.anomalyModel.create({
          wsId: wsObjectId,
          ruleType: input.ruleType,
          severity: input.severity,
          teamMemberId: input.teamMemberId ? new Types.ObjectId(String(input.teamMemberId)) : null,
          deviceSerial: input.deviceSerial ?? null,
          context: input.context,
          contextKey: input.contextKey ?? null,
        });

        span.setAttributes({ result: 'created' });
        span.setStatus({ code: SpanStatusCode.OK });

        // 4. PostHog — emit on successful record write.
        const userId = input.teamMemberId ? String(input.teamMemberId) : wsId;
        this.postHog?.capture({
          distinctId: userId,
          event: 'anomalies.anomaly_recorded',
          properties: {
            workspaceId: wsId,
            ruleType: input.ruleType,
            severity: input.severity,
          },
        });

        // 5. Fire-and-forget notification — must NOT propagate errors upstream.
        setImmediate(() => {
          void this.notifyService.dispatch(created).catch((err) => {
            this.logger.warn(
              `[Anomalies] dispatch failed for anomaly=${String(created._id)} ruleType=${input.ruleType}: ${err?.message}`,
            );
          });
        });
      } catch (err: any) {
        // Even the persistence path is defensive — callers never see an exception.
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        this.logger.warn(
          `[Anomalies] record() failed for ruleType=${input.ruleType}: ${err?.message}`,
        );
        Sentry.captureException(err, { tags: { module: 'anomalies', op: 'record' } });
      } finally {
        span.end();
      }
    });
  }

  /**
   * Acknowledge a single anomaly. Scoped by wsId from caller's JWT → cross-workspace
   * ids are silently rejected with NotFoundException (STRIDE-T mitigation).
   */
  async acknowledge(wsId: string, anomalyId: string, userId: string): Promise<Anomaly> {
    return this.tracer.startActiveSpan('anomalies.acknowledge', async (span) => {
      span.setAttributes({ workspaceId: wsId });
      try {
        const updated = await this.anomalyModel.findOneAndUpdate(
          {
            _id: new Types.ObjectId(anomalyId),
            wsId: new Types.ObjectId(wsId),
          },
          {
            $set: {
              acknowledged: true,
              acknowledgedBy: userId,
              acknowledgedAt: new Date(),
            },
          },
          { new: true },
        );
        if (!updated) {
          throw new NotFoundException(`Anomaly ${anomalyId} not found in workspace`);
        }

        span.setAttributes({ result: 'acknowledged' });
        span.setStatus({ code: SpanStatusCode.OK });

        this.postHog?.capture({
          distinctId: userId,
          event: 'anomalies.anomaly_acknowledged',
          properties: {
            workspaceId: wsId,
            ruleType: (updated as any).ruleType,
          },
        });

        return updated;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /** Unacknowledged count in last 24 hours — powers dashboard widget. */
  async count24h(wsId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.anomalyModel.countDocuments({
      wsId: new Types.ObjectId(wsId),
      acknowledged: false,
      createdAt: { $gte: since },
    });
  }

  /** Paginated feed query — default unacknowledged only, sorted newest first. */
  async list(
    wsId: string,
    { unacknowledgedOnly = true, page = 1, limit = 20 }: ListAnomaliesQuery = {},
  ): Promise<{ items: Anomaly[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = { wsId: new Types.ObjectId(wsId) };
    if (unacknowledgedOnly) filter.acknowledged = false;
    const [items, total] = await Promise.all([
      this.anomalyModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('teamMemberId', 'name')
        .populate('acknowledgedBy', 'name email')
        .lean<Anomaly[]>()
        .exec(),
      this.anomalyModel.countDocuments(filter).exec(),
    ]);
    return { items, total, page, limit };
  }
}
