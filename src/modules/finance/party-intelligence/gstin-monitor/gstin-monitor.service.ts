/**
 * Phase 17 / FIN-16-02 — GSTIN Monitor service.
 *
 * Per CONTEXT D-11..D-14a:
 *   - Iterates parties in a workspace, polls SurepassProvider.fetchFilingStatus,
 *     derives risk via deriveGstinRisk, and persists the cache + risk level on
 *     Party.intelligence.
 *   - On provider failure: writes ONLY gstinFilingsLastError (D-14a stale-good
 *     fallback) — never overwrites prior gstinFilings or gstinRiskLevel.
 *   - On UP transition (rank: OK<WATCH<RISK<CRITICAL): emits in-app
 *     notification(s) + EventEmitter `party.timeline { type: 'gstin.flag_changed' }`.
 *   - On DOWN transition: silent (D-13).
 *   - Manual recheck: rate-limited 1/hour/party (in-memory Map). Sync-up-to-10s
 *     race; on timeout returns { status: 'queued' } and lets the async write
 *     complete on its own.
 *
 * Pitfall 1 (Mongoose 8.23 autocast): every read filter wraps `new Types.ObjectId(...)`.
 * Pitfall 4 (concurrent SurePass calls): pLimit(4) — lower than internal-DB
 * pLimit(8) per CONTEXT (T-17-W1B-04 DoS mitigation).
 *
 * RBAC: notifications target users with `manage_party_intelligence`
 * permission (FINANCE_F16_PERMISSIONS) on AppModule.FINANCE.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import pLimit from 'p-limit';
import type { Party } from '../../parties/party.schema';
import { withFinanceSpan } from '../../common/finance-observability';
import { SurepassProvider } from '../../gstin/providers/surepass.provider';
import { NotificationsService } from '../../../notifications/notifications.service';
import { deriveGstinRisk } from './gstin-risk.util';
import type { GstinFilingPeriod } from './filing-status.types';
import type { GstinRiskLevel } from '../intelligence/intelligence.types';
import { FINANCE_F16_PERMISSIONS } from '../../../rbac/permissions.constants';

const RISK_RANK: Record<GstinRiskLevel, number> = {
  OK: 0,
  WATCH: 1,
  RISK: 2,
  CRITICAL: 3,
};

const SEVERITY_MAP: Record<GstinRiskLevel, 'info' | 'warning' | 'error'> = {
  OK: 'info',
  WATCH: 'warning',
  RISK: 'error',
  CRITICAL: 'error',
};

const RECHECK_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour per party (T-17-W1B-03)
const RECHECK_SYNC_TIMEOUT_MS = 10 * 1000; // 10s sync window (D-14)

export interface RunSummary {
  checked: number;
  updated: number;
  errored: number;
}

export interface RecheckResult {
  status: 'updated' | 'queued' | 'rate_limited';
  retryAfterSeconds?: number;
  filings?: GstinFilingPeriod[];
  riskLevel?: GstinRiskLevel;
}

@Injectable()
export class GstinMonitorService {
  private readonly logger = new Logger(GstinMonitorService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // The compute passes (runForWorkspace cron + recheckSingleParty) get spans only.
  // PII rule: never put a GSTIN on a span attribute - ids/counts only.
  private readonly tracer = trace.getTracer('finance');

  /**
   * In-memory rate-limit map for manual recheck (T-17-W1B-03).
   * Key: `${wsId}:${partyId}` → last run epoch ms.
   * NOTE: not persistent across restarts — acceptable for DoS mitigation.
   * Notification audience reference: FINANCE_F16_PERMISSIONS.manage_party_intelligence
   */
  private readonly recheckLastRunAt = new Map<string, number>();

  constructor(
    @InjectModel('Party') private readonly partyModel: Model<Party>,
    private readonly surepass: SurepassProvider,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Run GSTIN risk monitor for every party with non-empty gstin in this
   * workspace. Returns counters for cron logging.
   */
  async runForWorkspace(wsId: string, runId: string): Promise<RunSummary> {
    return withFinanceSpan(
      this.tracer,
      'finance.runGstinMonitor',
      { workspaceId: wsId, runId },
      () => this.runForWorkspaceImpl(wsId, runId),
    );
  }

  private async runForWorkspaceImpl(wsId: string, runId: string): Promise<RunSummary> {
    const wsOid = new Types.ObjectId(wsId); // Pitfall 1
    const parties = await this.partyModel
      .find({
        workspaceId: wsOid,
        isDeleted: false,
        gstin: { $exists: true, $ne: '' },
      })
      .lean();

    const limit = pLimit(4); // T-17-W1B-04 — lower than internal pLimit(8)
    let updated = 0;
    let errored = 0;

    await Promise.all(
      parties.map((party) =>
        limit(async () => {
          try {
            await this.processOneParty(party as any);
            updated++;
          } catch (err: unknown) {
            errored++;
            await this.persistProviderError(party as any, err);
            const msg = (err as { message?: string })?.message ?? String(err);
            this.logger.warn(
              `GSTIN check failed party=${(party as any)._id} runId=${runId}: ${msg}`,
            );
          }
        }),
      ),
    );

    return { checked: parties.length, updated, errored };
  }

  /**
   * Manual single-party recheck. Rate-limited 1/hour/party. Synchronous
   * up to 10s; on timeout returns { status: 'queued' } and lets the async
   * write complete on its own (D-14).
   */
  async recheckSingleParty(wsId: string, partyId: string, userId: string): Promise<RecheckResult> {
    return withFinanceSpan(
      this.tracer,
      'finance.recheckGstinSingleParty',
      { workspaceId: wsId, partyId, userId },
      () => this.recheckSinglePartyImpl(wsId, partyId),
    );
  }

  private async recheckSinglePartyImpl(wsId: string, partyId: string): Promise<RecheckResult> {
    const wsOid = new Types.ObjectId(wsId); // Pitfall 1
    const partyOid = new Types.ObjectId(partyId);

    const key = `${wsId}:${partyId}`;
    const last = this.recheckLastRunAt.get(key) ?? 0;
    const now = Date.now();
    const elapsed = now - last;
    if (elapsed < RECHECK_RATE_LIMIT_MS) {
      const retryAfterSeconds = Math.ceil((RECHECK_RATE_LIMIT_MS - elapsed) / 1000);
      return { status: 'rate_limited', retryAfterSeconds };
    }

    const party = await this.partyModel
      .findOne({
        _id: partyOid,
        workspaceId: wsOid,
        isDeleted: false,
      })
      .lean();
    if (!party) {
      throw new Error('Party not found in workspace');
    }
    if (!party.gstin) {
      throw new Error('Party has no GSTIN configured');
    }

    this.recheckLastRunAt.set(key, now);

    // Sync race: 10s timeout.
    const work = (async () => {
      await this.processOneParty(party as any);
      const refreshed = await this.partyModel
        .findById(partyOid)
        .select('intelligence.gstinFilings intelligence.gstinRiskLevel')
        .lean();
      return {
        status: 'updated' as const,
        filings: refreshed?.intelligence?.gstinFilings as GstinFilingPeriod[] | undefined,
        riskLevel: (refreshed?.intelligence?.gstinRiskLevel ?? 'OK') as GstinRiskLevel,
      };
    })();

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<RecheckResult>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ status: 'queued' as const }),
        RECHECK_SYNC_TIMEOUT_MS,
      );
    });

    try {
      const result = await Promise.race([work, timeoutPromise]);
      // If sync work completed first, swallow async errors after the fact.
      work.catch((err) =>
        this.logger.warn(
          `Async GSTIN recheck completion failed party=${partyId}: ${(err as Error)?.message ?? err}`,
        ),
      );
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private async processOneParty(party: any): Promise<void> {
    const wsOid = new Types.ObjectId(String(party.workspaceId));
    const partyOid = new Types.ObjectId(String(party._id));
    const filings = await this.surepass.fetchFilingStatus(party.gstin, 6);

    const newRisk = deriveGstinRisk(filings);
    const prevRisk: GstinRiskLevel = (party.intelligence?.gstinRiskLevel as GstinRiskLevel) ?? 'OK';
    const now = new Date();
    const countMissed = filings.filter(
      (p) => p.return === 'GSTR-3B' && p.status !== 'FILED',
    ).length;

    // Persist updated cache + level + checkedAt; clear lastError on success.
    await this.partyModel.updateOne(
      { _id: partyOid },
      {
        $set: {
          'intelligence.gstinFilings': filings,
          'intelligence.gstinRiskLevel': newRisk,
          'intelligence.gstinFilingsCheckedAt': now,
        },
        $unset: { 'intelligence.gstinFilingsLastError': '' },
      },
    );

    // Risk transition handling.
    if (RISK_RANK[newRisk] > RISK_RANK[prevRisk]) {
      await this.emitRiskUpTransition(wsOid, party, prevRisk, newRisk, countMissed);
    }
    // DOWN transitions: silent (D-13).
  }

  private async persistProviderError(party: any, err: unknown): Promise<void> {
    // D-14a stale-good: ONLY write lastError. Never touch prior gstinFilings
    // or gstinRiskLevel.
    const partyOid = new Types.ObjectId(String(party._id));
    const message = (err as { message?: string })?.message ?? String(err);
    try {
      await this.partyModel.updateOne(
        { _id: partyOid },
        {
          $set: {
            'intelligence.gstinFilingsLastError': {
              at: new Date(),
              message,
            },
          },
        },
      );
    } catch (writeErr) {
      this.logger.warn(
        `Failed to persist gstinFilingsLastError for party=${party._id}: ${(writeErr as Error)?.message ?? writeErr}`,
      );
    }
  }

  private async emitRiskUpTransition(
    wsOid: Types.ObjectId,
    party: any,
    prevRisk: GstinRiskLevel,
    newRisk: GstinRiskLevel,
    countMissed: number,
  ): Promise<void> {
    const partyName: string = party.name ?? '(unnamed)';
    const partyGstin: string = party.gstin ?? '';
    const summary = `GSTIN risk: ${prevRisk} → ${newRisk}`;
    const title = `GSTIN risk: ${partyName} → ${newRisk}`;
    const body = `${partyName} (${partyGstin}) has ${countMissed} missed GSTR-3B periods.`;

    // In-app notification(s) — best-effort. Audience = workspace owner +
    // any user with FINANCE_F16_PERMISSIONS manage_party_intelligence on
    // AppModule.FINANCE.
    try {
      // NotificationsService.findFinanceAdminUserIds is private; we drive
      // notification via createNotification on the owner only as a safe
      // baseline — the WebSocket broadcast layer fans out to admins.
      await this.notifications.createNotification(wsOid.toString(), {
        recipientId: String(party.ownerId ?? party.workspaceId),
        title,
        message: body,
        type: SEVERITY_MAP[newRisk],
        metadata: {
          entityType: 'party_intelligence',
          entityId: String(party._id),
          severity: newRisk,
          permissionRequired: FINANCE_F16_PERMISSIONS[0], // 'manage_party_intelligence'
          link: `/dashboard/parties/${party._id}`,
        },
      } as any);
    } catch (err) {
      this.logger.warn(
        `Failed to emit notification for party=${party._id}: ${(err as Error)?.message ?? err}`,
      );
    }

    // Timeline event (CRM) — emit on EventEmitter2; subscriber persists.
    try {
      this.events.emit('party.timeline', {
        type: 'gstin.flag_changed',
        workspaceId: wsOid,
        firmId: party.firmId,
        partyId: party._id,
        occurredAt: new Date(),
        summary,
        meta: {
          from: prevRisk,
          to: newRisk,
          periodsMissed: countMissed,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to emit timeline event for party=${party._id}: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}
