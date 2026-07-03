/**
 * Phase 17 / FIN-16-03 — PartyTimelineService.
 *
 * Persists `party.timeline` events to the PartyTimelineEvent collection.
 *
 * Design (CONTEXT D-17, D-18):
 *  - Idempotent: duplicate-key (E11000) on the partial unique index
 *    `(refModel, refId, type)` is swallowed and logged at warn — re-running
 *    the backfill against the same voucher does NOT create duplicates.
 *  - Manual entries (`note.added`, `call.logged`, `email.logged`) have no
 *    refModel/refId and bypass the idempotency check entirely (each entry is
 *    a distinct row).
 *  - Throws on non-duplicate errors so the @OnEvent subscriber can log them
 *    centrally; subscribers never let errors propagate to the producer.
 *
 * Pitfall 1 (Mongoose autocast): every ObjectId-typed field is wrapped via
 * `new Types.ObjectId(...)` to defend against string IDs entering at the
 * EventEmitter boundary.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';
import { PartyTimelineEvent, PartyTimelineEventType } from './party-timeline-event.schema';

export interface PartyTimelineEventPayload {
  type: PartyTimelineEventType;
  workspaceId: Types.ObjectId | string;
  firmId: Types.ObjectId | string;
  partyId: Types.ObjectId | string;
  refModel?: string;
  refId?: Types.ObjectId | string;
  occurredAt: Date;
  actorUserId?: Types.ObjectId | string;
  summary: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class PartyTimelineService {
  private readonly logger = new Logger(PartyTimelineService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // append() persists one CRM timeline row (driven by @OnEvent subscribers or
  // manual entries) - span only, no PostHog (the producer events carry analytics).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(PartyTimelineEvent.name)
    private readonly model: Model<PartyTimelineEvent>,
  ) {}

  /**
   * Persist a timeline event. Safe to call repeatedly with the same
   * (refModel, refId, type) tuple — duplicates are swallowed and logged
   * (D-18 idempotency).
   */
  async append(payload: PartyTimelineEventPayload): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.appendPartyTimelineEvent',
      {
        workspaceId: String(payload.workspaceId),
        partyId: String(payload.partyId),
        eventType: payload.type,
      },
      () => this.appendImpl(payload),
    );
  }

  private async appendImpl(payload: PartyTimelineEventPayload): Promise<void> {
    const doc: Record<string, unknown> = {
      type: payload.type,
      workspaceId: new Types.ObjectId(String(payload.workspaceId)),
      firmId: new Types.ObjectId(String(payload.firmId)),
      partyId: new Types.ObjectId(String(payload.partyId)),
      occurredAt: payload.occurredAt,
      summary: payload.summary,
    };
    if (payload.refModel) doc.refModel = payload.refModel;
    if (payload.refId) doc.refId = new Types.ObjectId(String(payload.refId));
    if (payload.actorUserId) {
      doc.actorUserId = new Types.ObjectId(String(payload.actorUserId));
    }
    if (payload.meta) doc.meta = payload.meta;

    try {
      await this.model.create(doc);
    } catch (err: unknown) {
      // E11000 — duplicate key on partial unique index (refModel, refId, type).
      // Idempotent backfill / re-emit: swallow and log warn.
      const errAny = err as { code?: number; name?: string; message?: string };
      if (
        errAny?.code === 11000 ||
        (errAny?.name === 'MongoServerError' && errAny?.code === 11000)
      ) {
        this.logger.warn(
          `Idempotent skip: duplicate party.timeline event ` +
            `type=${payload.type} refModel=${payload.refModel ?? '-'} refId=${payload.refId ? String(payload.refId) : '-'}`,
        );
        return;
      }
      this.logger.warn(`party.timeline persist failed: ${errAny?.message ?? String(err)}`);
      throw err;
    }
  }
}
