/**
 * Phase 17 / FIN-16-01..02 — Party Intelligence service.
 *
 * Wave-1 Plan 03 added:
 *   - recheckGstin(wsId, partyId, userId) — delegates to GstinMonitorService.
 *
 * Wave-1 Plan 04 adds:
 *   - getIntelligence(wsId, partyId)               — D-05 read (lean party.intelligence)
 *   - setBlacklist(wsId, partyId, userId, reason)  — D-04 sticky
 *   - clearBlacklist(wsId, partyId, userId)        — D-04 unset + emit
 *   - setManualSegment(wsId, partyId, segment)     — D-07 one-cycle override
 *   - clearManualSegment(wsId, partyId)            — D-07 manual clear before cron
 *   - triggerRerun(wsId, userId)                   — D-07 manual "Re-run now"
 *                                                    (1/10min/wsId rate-limit)
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GstinMonitorService, RecheckResult } from '../gstin-monitor/gstin-monitor.service';
import { RfmSegmenterService } from '../rfm/rfm-segmenter.service';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';
import type { Party } from '../../parties/party.schema';
import type { PartySegment } from './intelligence.types';

const RERUN_RATE_LIMIT_MS = 10 * 60 * 1000; // D-07: 1 run per 10 min per workspace
const ALLOWED_MANUAL_SEGMENTS: PartySegment[] = ['NEW', 'REGULAR', 'VIP', 'DORMANT', 'CHURNED'];

export interface RerunResult {
  status: 'completed' | 'rate_limited';
  retryAfterSeconds?: number;
  updated?: number;
  segmentChanges?: number;
  durationMs?: number;
}

@Injectable()
export class IntelligenceService {
  /**
   * In-memory rate-limit map for manual rerun (T-17-W1C-03).
   * Key: wsId → last run epoch ms.
   */
  private readonly rerunLastRunAt = new Map<string, number>();

  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Spans wrap the intelligence write methods; PostHog fires fire-and-forget on
  // the user-driven writes that carry a userId (blacklist set/clear + manual
  // rerun) - ids only, never any party GSTIN.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    private readonly gstinMonitor: GstinMonitorService,
    private readonly rfmSegmenter: RfmSegmenterService,
    private readonly events: EventEmitter2,
    @InjectModel('Party') private readonly partyModel: Model<Party>,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Plan 03 D-14 — manual GSTIN re-check.
   */
  async recheckGstin(wsId: string, partyId: string, userId: string): Promise<RecheckResult> {
    return this.gstinMonitor.recheckSingleParty(wsId, partyId, userId);
  }

  // ─── Plan 04 — read intelligence sub-doc ───────────────────────────────

  async getIntelligence(wsId: string, partyId: string): Promise<any> {
    const wsOid = new Types.ObjectId(wsId); // Pitfall 1
    const partyOid = new Types.ObjectId(partyId);
    const party = await this.partyModel
      .findOne({ _id: partyOid, workspaceId: wsOid, isDeleted: false })
      .select('intelligence name gstin')
      .lean();
    if (!party) {
      throw new Error('Party not found in workspace');
    }
    return {
      partyId: String(party._id),
      name: (party as any).name,
      gstin: (party as any).gstin ?? null,
      intelligence: (party as any).intelligence ?? null,
    };
  }

  // ─── D-04 BLACKLIST sticky flag ────────────────────────────────────────

  async setBlacklist(
    wsId: string,
    partyId: string,
    userId: string,
    reason: string,
  ): Promise<{ updated: boolean }> {
    return withFinanceSpan(
      this.tracer,
      'finance.setPartyBlacklist',
      { workspaceId: wsId, partyId, userId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const partyOid = new Types.ObjectId(partyId);

        const party = await this.partyModel
          .findOne({ _id: partyOid, workspaceId: wsOid, isDeleted: false })
          .lean();
        if (!party) throw new Error('Party not found in workspace');

        const previousSegment: PartySegment | undefined = (party as any).intelligence?.segment;

        await this.partyModel.updateOne(
          { _id: partyOid },
          {
            $set: {
              'intelligence.blacklisted': true,
              'intelligence.blacklistedReason': reason,
              'intelligence.blacklistedAt': new Date(),
              'intelligence.blacklistedBy': new Types.ObjectId(userId),
              'intelligence.segment': 'BLACKLIST',
              'intelligence.segmentUpdatedAt': new Date(),
            },
          },
        );

        // Emit timeline event — best-effort.
        try {
          this.events.emit('party.timeline', {
            type: 'segment.changed',
            workspaceId: wsOid,
            firmId: (party as any).firmId,
            partyId: partyOid,
            actorUserId: new Types.ObjectId(userId),
            occurredAt: new Date(),
            summary: `Blacklisted: ${reason}`,
            meta: {
              from: previousSegment ?? null,
              to: 'BLACKLIST',
              reason,
            },
          });
        } catch {
          // Swallow — timeline emit must never block.
        }

        // Fire-and-forget product analytics on the blacklist write (ids only -
        // the reason text is intentionally NOT sent).
        this.postHog.capture({
          distinctId: userId,
          event: 'parties.blacklisted_party',
          properties: { workspaceId: wsId, partyId },
        });

        return { updated: true };
      },
    );
  }

  async clearBlacklist(
    wsId: string,
    partyId: string,
    userId: string,
  ): Promise<{ updated: boolean }> {
    return withFinanceSpan(
      this.tracer,
      'finance.clearPartyBlacklist',
      { workspaceId: wsId, partyId, userId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const partyOid = new Types.ObjectId(partyId);

        const party = await this.partyModel
          .findOne({ _id: partyOid, workspaceId: wsOid, isDeleted: false })
          .lean();
        if (!party) throw new Error('Party not found in workspace');

        await this.partyModel.updateOne(
          { _id: partyOid },
          {
            $set: {
              'intelligence.blacklisted': false,
            },
            $unset: {
              'intelligence.blacklistedReason': '',
              'intelligence.blacklistedAt': '',
              'intelligence.blacklistedBy': '',
            },
          },
        );

        try {
          this.events.emit('party.timeline', {
            type: 'segment.changed',
            workspaceId: wsOid,
            firmId: (party as any).firmId,
            partyId: partyOid,
            actorUserId: new Types.ObjectId(userId),
            occurredAt: new Date(),
            summary: 'Blacklist cleared',
            meta: {
              from: 'BLACKLIST',
              to: null,
            },
          });
        } catch {
          // ignore
        }

        // Fire-and-forget product analytics on the blacklist-clear write (ids only).
        this.postHog.capture({
          distinctId: userId,
          event: 'parties.cleared_blacklist',
          properties: { workspaceId: wsId, partyId },
        });

        return { updated: true };
      },
    );
  }

  // ─── D-07 Manual segment override (one-cycle, except BLACKLIST) ────────

  async setManualSegment(
    wsId: string,
    partyId: string,
    segment: PartySegment,
  ): Promise<{ updated: boolean }> {
    return withFinanceSpan(
      this.tracer,
      'finance.setPartyManualSegment',
      { workspaceId: wsId, partyId, segment },
      async () => {
        if (!ALLOWED_MANUAL_SEGMENTS.includes(segment)) {
          throw new Error('Invalid manual segment — use POST /blacklist for BLACKLIST');
        }
        const wsOid = new Types.ObjectId(wsId);
        const partyOid = new Types.ObjectId(partyId);

        const party = await this.partyModel
          .findOne({ _id: partyOid, workspaceId: wsOid, isDeleted: false })
          .lean();
        if (!party) throw new Error('Party not found in workspace');

        await this.partyModel.updateOne(
          { _id: partyOid },
          { $set: { 'intelligence.manualSegment': segment } },
        );
        return { updated: true };
      },
    );
  }

  async clearManualSegment(wsId: string, partyId: string): Promise<{ updated: boolean }> {
    return withFinanceSpan(
      this.tracer,
      'finance.clearPartyManualSegment',
      { workspaceId: wsId, partyId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const partyOid = new Types.ObjectId(partyId);
        await this.partyModel.updateOne(
          { _id: partyOid, workspaceId: wsOid, isDeleted: false },
          { $unset: { 'intelligence.manualSegment': '' } },
        );
        return { updated: true };
      },
    );
  }

  // ─── D-07 Manual rerun (rate-limited) ─────────────────────────────────

  async triggerRerun(wsId: string, userId: string): Promise<RerunResult> {
    return withFinanceSpan(
      this.tracer,
      'finance.triggerRfmRerun',
      { workspaceId: wsId, userId },
      async () => {
        const last = this.rerunLastRunAt.get(wsId) ?? 0;
        const now = Date.now();
        const elapsed = now - last;
        if (elapsed < RERUN_RATE_LIMIT_MS) {
          const retryAfterSeconds = Math.ceil((RERUN_RATE_LIMIT_MS - elapsed) / 1000);
          return { status: 'rate_limited', retryAfterSeconds };
        }
        this.rerunLastRunAt.set(wsId, now);

        const summary = await this.rfmSegmenter.recompute(wsId, {
          runId: `manual-${now}`,
        });

        // Fire-and-forget product analytics on the completed manual rerun
        // (counts only - no party-level data).
        this.postHog.capture({
          distinctId: userId,
          event: 'parties.reran_rfm_segments',
          properties: {
            workspaceId: wsId,
            updated: summary.updated,
            segmentChanges: summary.segmentChanges,
          },
        });

        return {
          status: 'completed',
          updated: summary.updated,
          segmentChanges: summary.segmentChanges,
          durationMs: summary.durationMs,
        };
      },
    );
  }
}
