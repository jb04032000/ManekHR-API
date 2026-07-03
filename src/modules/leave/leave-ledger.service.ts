import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  LeaveLedger,
  LeaveLedgerEntryType,
  LeaveLedgerSourceKind,
} from './schemas/leave-ledger.schema';
import { LeaveBalance } from './schemas/leave-balance.schema';
import { applyEntryToTotals, computeAvailable, emptyTotals } from './leave-ledger.util';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

/** A member × leave type × calendar year — the unit a balance is tracked in. */
export interface LeaveBucket {
  workspaceId: Types.ObjectId;
  teamMemberId: Types.ObjectId;
  leaveTypeId: Types.ObjectId;
  year: number;
}

export interface AppendLedgerEntryInput extends LeaveBucket {
  entryType: LeaveLedgerEntryType;
  quantity: number;
  effectiveDate: Date;
  sourceRef: { kind: LeaveLedgerSourceKind; id: Types.ObjectId | null };
  actorUserId?: Types.ObjectId | null;
  reason?: string | null;
  lotExpiresOn?: Date | null;
  lotRemaining?: number | null;
  sourceWorkDate?: Date | null;
}

const SEQ_RETRY_LIMIT = 4;

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: number }).code === 11000;
}

/**
 * Owns the leave ledger (immutable, append-only) and its `LeaveBalance`
 * projection. Every balance movement in the leave module goes through
 * `appendEntry`; the projection is always a deterministic fold of the ledger,
 * so `rebuildBucket` can reconstruct it from scratch at any time.
 *
 * `seq` is monotonic per bucket — allocated as `max + 1` with a retry loop
 * because the `(bucket, seq)` unique index rejects a concurrent collision.
 */
@Injectable()
export class LeaveLedgerService {
  private readonly logger = new Logger(LeaveLedgerService.name);
  private readonly tracer = trace.getTracer('leave');

  constructor(
    @InjectModel(LeaveLedger.name)
    private readonly ledgerModel: Model<LeaveLedger>,
    @InjectModel(LeaveBalance.name)
    private readonly balanceModel: Model<LeaveBalance>,
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

  /** Append an immutable ledger entry, then fold it into the balance projection. */
  async appendEntry(input: AppendLedgerEntryInput): Promise<LeaveLedger> {
    const bucket: LeaveBucket = {
      workspaceId: input.workspaceId,
      teamMemberId: input.teamMemberId,
      leaveTypeId: input.leaveTypeId,
      year: input.year,
    };

    let lastErrMessage = '';
    for (let attempt = 0; attempt < SEQ_RETRY_LIMIT; attempt++) {
      const latest = await this.ledgerModel
        .findOne(bucket)
        .sort({ seq: -1 })
        .select('seq')
        .lean()
        .exec();
      const seq = (latest?.seq ?? 0) + 1;
      try {
        const created = await this.ledgerModel.create([
          {
            ...bucket,
            seq,
            entryType: input.entryType,
            quantity: input.quantity,
            effectiveDate: input.effectiveDate,
            sourceRef: input.sourceRef,
            actorUserId: input.actorUserId ?? null,
            reason: input.reason ?? null,
            lotExpiresOn: input.lotExpiresOn ?? null,
            lotRemaining: input.lotRemaining ?? null,
            sourceWorkDate: input.sourceWorkDate ?? null,
          },
        ]);
        await this.rebuildBucket(bucket);
        return created[0];
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          lastErrMessage = err instanceof Error ? err.message : 'duplicate key';
          continue; // a concurrent writer took this seq — retry with a fresh max
        }
        throw err;
      }
    }
    throw new Error(
      `LeaveLedgerService.appendEntry: seq allocation failed after ${SEQ_RETRY_LIMIT} attempts: ${lastErrMessage}`,
    );
  }

  /** Recompute the `LeaveBalance` projection for one bucket from its ledger. */
  async rebuildBucket(bucket: LeaveBucket): Promise<LeaveBalance> {
    const entries = await this.ledgerModel
      .find(bucket)
      .sort({ seq: 1 })
      .select('entryType quantity seq')
      .lean()
      .exec();

    let totals = emptyTotals();
    let lastLedgerSeq = 0;
    for (const e of entries) {
      totals = applyEntryToTotals(totals, e.entryType, e.quantity);
      if (e.seq > lastLedgerSeq) lastLedgerSeq = e.seq;
    }

    // `pending` is owned by the L3 request lifecycle — preserve the stored
    // value so `available` stays correct.
    const existing = await this.balanceModel.findOne(bucket).select('pending').lean().exec();
    totals.pending = existing?.pending ?? 0;

    return this.balanceModel
      .findOneAndUpdate(
        bucket,
        {
          $set: {
            opening: totals.opening,
            credited: totals.credited,
            used: totals.used,
            lapsed: totals.lapsed,
            encashed: totals.encashed,
            available: computeAvailable(totals),
            lastLedgerSeq,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }

  /** All balances for a member in one leave year. */
  async getBalances(
    workspaceId: Types.ObjectId,
    teamMemberId: Types.ObjectId,
    year: number,
  ): Promise<LeaveBalance[]> {
    return this.balanceModel.find({ workspaceId, teamMemberId, year }).exec();
  }

  /** Current balance for one bucket — null if nothing has been posted yet. */
  async getBalance(bucket: LeaveBucket): Promise<LeaveBalance | null> {
    return this.balanceModel.findOne(bucket).exec();
  }

  /** Every member's balances for one leave year — the HR balances admin view. */
  async getWorkspaceBalances(workspaceId: Types.ObjectId, year: number): Promise<LeaveBalance[]> {
    return this.balanceModel.find({ workspaceId, year }).exec();
  }

  /**
   * Adjust a bucket's `pending` reservation by a signed delta, then refresh
   * the projection so `available` reflects it. `pending` is owned by the L3
   * request lifecycle — a leave application reserves it, approval / rejection
   * / cancellation releases it.
   */
  async adjustPending(bucket: LeaveBucket, delta: number): Promise<LeaveBalance> {
    await this.balanceModel
      .updateOne(bucket, { $inc: { pending: delta } }, { upsert: true, setDefaultsOnInsert: true })
      .exec();
    return this.rebuildBucket(bucket);
  }

  /** HR manual correction — posts a signed `adjustment` ledger entry. */
  async postAdjustment(
    bucket: LeaveBucket,
    quantity: number,
    actorUserId: Types.ObjectId,
    reason: string,
  ): Promise<LeaveLedger> {
    return this.withLeaveSpan(
      'leave.postAdjustment',
      {
        workspaceId: String(bucket.workspaceId),
        teamMemberId: String(bucket.teamMemberId),
        userId: String(actorUserId),
      },
      async () => {
        const entry = await this.appendEntry({
          ...bucket,
          entryType: 'adjustment',
          quantity,
          effectiveDate: new Date(),
          sourceRef: { kind: 'manual', id: null },
          actorUserId,
          reason,
        });

        void this.auditService
          .logEvent({
            workspaceId: String(bucket.workspaceId),
            module: AppModuleEnum.LEAVE,
            entityType: 'leave_balance',
            entityId: String(entry._id),
            action: 'leave.balance_adjusted',
            actorId: String(actorUserId),
            teamMemberId: String(bucket.teamMemberId),
            year: bucket.year,
            meta: {
              leaveTypeId: String(bucket.leaveTypeId),
              quantity,
              reason,
            },
          })
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : 'unknown error';
            this.logger.warn(
              `Audit log failed for leave event leave.balance_adjusted (workspace ${String(
                bucket.workspaceId,
              )}): ${detail}`,
            );
            Sentry.captureException(err, {
              tags: { module: 'leave', op: 'audit.leave.balance_adjusted' },
              extra: {
                workspaceId: String(bucket.workspaceId),
                actorId: String(actorUserId),
              },
            });
          });

        this.postHog.capture({
          distinctId: String(actorUserId),
          event: 'leave.balance_adjusted',
          properties: {
            workspaceId: String(bucket.workspaceId),
            teamMemberId: String(bucket.teamMemberId),
            leaveTypeId: String(bucket.leaveTypeId),
            year: bucket.year,
            quantity,
          },
        });

        return entry;
      },
    );
  }
}
