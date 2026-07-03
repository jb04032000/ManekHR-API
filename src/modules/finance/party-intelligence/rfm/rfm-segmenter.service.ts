/**
 * Phase 17 / FIN-16-01 — RFM Segmenter service.
 *
 * Per CONTEXT D-01..D-09:
 *
 *   recompute(wsId, opts) computes RFM dimensions for every active party in
 *   the workspace, scores them via dynamic quintiles ($bucketAuto), applies
 *   D-03 segment derivation rules (BLACKLIST > NEW > VIP > REGULAR > DORMANT
 *   > CHURNED), persists the new sub-doc, and emits party.timeline events on
 *   any segment change.
 *
 * Sticky overrides:
 *   - intelligence.blacklisted=true  → segment forced to 'BLACKLIST' (D-04).
 *   - intelligence.manualSegment set → applied for one cycle then $unset
 *     (cleared); BLACKLIST does not clear (D-07).
 *
 * Small-population fallback (D-06): if active-party count < 5, skip quintile
 * computation entirely and apply fixed thresholds (VIP if M ≥ 50_000_00 paise,
 * REGULAR if F ≥ 2, NEW if createdAt < newWindowDays, else DORMANT). RFM
 * scores are NOT set in this branch.
 *
 * Threshold tuning (D-09): when WorkspaceSettings.partyIntelligence.rfmTuning
 * is set, those numbers override the D-03 defaults at segmentation time.
 *
 * Pitfall 1 (Mongoose 8.23 autocast): every read filter wraps `new
 * Types.ObjectId(...)`. String-injection model tokens (`@InjectModel('Party')`)
 * avoid vitest decorator-metadata trip in unit-test mode (matches Plan 17-03
 * pattern).
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import pLimit from 'p-limit';

import type { Party } from '../../parties/party.schema';
import { withFinanceSpan } from '../../common/finance-observability';
import { computeQuintiles, scoreValue } from './quintile.util';
import type { PartySegment, RfmScore } from '../intelligence/intelligence.types';

// ── D-03 default thresholds ──────────────────────────────────────────────
const DEFAULT_NEW_WINDOW_DAYS = 60;
const DEFAULT_VIP_RFM_FLOOR = 4; // R≥4 AND F≥4 AND M≥4
const DEFAULT_DORMANT_MIN_DAYS = 91;
const DEFAULT_DORMANT_MAX_DAYS = 365;
const DEFAULT_CHURNED_CUTOFF_DAYS = 365;

// ── D-06 fixed-threshold fallback (population < 5) ───────────────────────
const FIXED_VIP_MONETARY_PAISE = 5_000_000; // ₹50,000 in paise
const FIXED_REGULAR_FREQUENCY_MIN = 2;

const TRAILING_DAYS = 365;
const MS_PER_DAY = 86_400_000;

export interface RecomputeSummary {
  updated: number;
  segmentChanges: number;
  durationMs: number;
}

interface RfmTuning {
  newWindowDays: number;
  vipRfmFloor: number;
  dormantMin: number;
  dormantMax: number;
  churnedCutoff: number;
}

interface DimensionsRow {
  partyId: Types.ObjectId;
  firmId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  createdAt: Date;
  intelligence: any;
  recencyDays: number;
  frequency: number;
  monetaryPaise: number;
  lastInvoiceDate: Date | null;
  invoiceTotalPaise: number;
  creditTotalPaise: number;
}

@Injectable()
export class RfmSegmenterService {
  private readonly logger = new Logger(RfmSegmenterService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // recompute() is the main analytics pass (cron + manual rerun) - span only,
  // no PostHog (the manual rerun's user-facing event lives in IntelligenceService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel('Party') private readonly partyModel: Model<Party>,
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Recompute RFM scores + segment for every active party in this workspace.
   *
   * Returns summary: how many docs we touched + how many segments changed.
   */
  async recompute(wsId: string, opts: { runId: string }): Promise<RecomputeSummary> {
    return withFinanceSpan(
      this.tracer,
      'finance.recomputeRfmSegments',
      { workspaceId: wsId, runId: opts.runId },
      () => this.recomputeImpl(wsId, opts),
    );
  }

  private async recomputeImpl(wsId: string, opts: { runId: string }): Promise<RecomputeSummary> {
    const start = Date.now();
    const wsOid = new Types.ObjectId(wsId); // Pitfall 1
    const tuning = await this.loadTuning(wsOid);

    // 1. Compute raw dimensions across all active parties (one aggregation).
    const rows = await this.computeDimensions(wsOid);

    if (rows.length === 0) {
      return {
        updated: 0,
        segmentChanges: 0,
        durationMs: Date.now() - start,
      };
    }

    // 2. Persist raw dimensions FIRST so $bucketAuto in step 3 can read them.
    await this.persistRawDimensions(rows);

    // 3. Decide scoring path. < 5 parties → fixed thresholds (D-06).
    let scoringMode: 'quintile' | 'fixed';
    let recencyCuts: number[] = [];
    let freqCuts: number[] = [];
    let monCuts: number[] = [];

    if (rows.length >= 5) {
      scoringMode = 'quintile';
      // Compute quintile cutoffs per dimension. Recency uses the same util;
      // we INVERT at scoring time, not at cutoff time.
      [recencyCuts, freqCuts, monCuts] = await Promise.all([
        computeQuintiles(this.partyModel, wsOid, null, 'recencyDays'),
        computeQuintiles(this.partyModel, wsOid, null, 'frequency'),
        computeQuintiles(this.partyModel, wsOid, null, 'monetaryPaise'),
      ]);
    } else {
      scoringMode = 'fixed';
    }

    // 4. Per-party scoring + segment derivation.
    const limit = pLimit(8); // D-06 parallelism
    const now = new Date();
    let segmentChanges = 0;
    let updated = 0;

    await Promise.all(
      rows.map((row) =>
        limit(async () => {
          const previousSegment: PartySegment | undefined = row.intelligence?.segment;

          // Score the dimensions (only when in quintile mode).
          let R: RfmScore | undefined;
          let F: RfmScore | undefined;
          let M: RfmScore | undefined;
          if (scoringMode === 'quintile') {
            R = scoreValue(row.recencyDays, recencyCuts, true);
            F = scoreValue(row.frequency, freqCuts, false);
            M = scoreValue(row.monetaryPaise, monCuts, false);
          }

          // Derive segment.
          let newSegment: PartySegment;
          let appliedManualOverride = false;

          // 5a. Sticky BLACKLIST (D-04) — highest priority.
          if (row.intelligence?.blacklisted === true) {
            newSegment = 'BLACKLIST';
          }
          // 5b. Manual override (D-07) — applied this cycle, cleared after.
          else if (row.intelligence?.manualSegment && row.intelligence.manualSegment !== null) {
            newSegment = row.intelligence.manualSegment as PartySegment;
            appliedManualOverride = true;
          } else if (scoringMode === 'fixed') {
            newSegment = this.deriveFixedThresholdSegment(row, tuning, now);
          } else {
            newSegment = this.deriveQuintileSegment(row, R, F, M, tuning, now);
          }

          // 6. Persist segment + scores.
          const setOps: Record<string, unknown> = {
            'intelligence.segment': newSegment,
            'intelligence.segmentUpdatedAt': now,
          };
          if (scoringMode === 'quintile') {
            setOps['intelligence.rfmR'] = R;
            setOps['intelligence.rfmF'] = F;
            setOps['intelligence.rfmM'] = M;
          }
          const unsetOps: Record<string, unknown> = {};
          // Clear manualSegment after one cycle (except BLACKLIST sticky).
          if (appliedManualOverride && newSegment !== 'BLACKLIST') {
            unsetOps['intelligence.manualSegment'] = '';
          }

          const updateDoc: Record<string, unknown> = { $set: setOps };
          if (Object.keys(unsetOps).length > 0) {
            updateDoc.$unset = unsetOps;
          }

          await this.partyModel.updateOne({ _id: row.partyId }, updateDoc);
          updated++;

          // 7. Emit timeline event on segment change.
          if (previousSegment !== newSegment) {
            segmentChanges++;
            const rfmStr = scoringMode === 'quintile' ? `${R}${F}${M}` : undefined;
            try {
              this.events.emit('party.timeline', {
                type: 'segment.changed',
                workspaceId: row.workspaceId,
                firmId: row.firmId,
                partyId: row.partyId,
                occurredAt: now,
                summary: `Segment changed: ${previousSegment ?? 'NONE'} → ${newSegment}`,
                meta: {
                  from: previousSegment ?? null,
                  to: newSegment,
                  rfm: rfmStr,
                },
              });
            } catch (err) {
              this.logger.warn(
                `Failed to emit timeline event for party=${String(row.partyId)} runId=${opts.runId}: ${(err as Error)?.message ?? err}`,
              );
            }
          }
        }),
      ),
    );

    return {
      updated,
      segmentChanges,
      durationMs: Date.now() - start,
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  /**
   * Aggregation: compute (recencyDays, frequency, monetaryPaise) per party
   * via $lookup into saleinvoices + creditnotes for the trailing 365d.
   * Pitfall 1 — workspaceId wrapped via new Types.ObjectId by caller.
   */
  private async computeDimensions(wsOid: Types.ObjectId): Promise<DimensionsRow[]> {
    const oneYearAgo = new Date(Date.now() - TRAILING_DAYS * MS_PER_DAY);
    const pipeline: any[] = [
      { $match: { workspaceId: wsOid, isDeleted: false } },
      {
        $lookup: {
          from: 'saleinvoices',
          let: {
            pid: '$_id',
            wsId: '$workspaceId',
            firmId: '$firmId',
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$workspaceId', '$$wsId'] },
                    { $eq: ['$firmId', '$$firmId'] },
                    { $eq: ['$partyId', '$$pid'] },
                    { $eq: ['$state', 'posted'] },
                    { $ne: ['$isDeleted', true] },
                    { $gte: ['$voucherDate', oneYearAgo] },
                  ],
                },
              },
            },
            {
              $project: {
                voucherDate: 1,
                netTaxableValue: '$totals.netTaxableValue',
              },
            },
          ],
          as: 'invoices',
        },
      },
      {
        $lookup: {
          from: 'creditnotes',
          let: {
            pid: '$_id',
            wsId: '$workspaceId',
            firmId: '$firmId',
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$workspaceId', '$$wsId'] },
                    { $eq: ['$firmId', '$$firmId'] },
                    { $eq: ['$partyId', '$$pid'] },
                    { $eq: ['$state', 'posted'] },
                    { $ne: ['$isDeleted', true] },
                    { $gte: ['$voucherDate', oneYearAgo] },
                  ],
                },
              },
            },
            {
              $project: {
                netTaxableValue: '$totals.netTaxableValue',
              },
            },
          ],
          as: 'creditNotes',
        },
      },
      {
        $project: {
          partyId: '$_id',
          workspaceId: 1,
          firmId: 1,
          createdAt: 1,
          intelligence: 1,
          frequency: { $size: '$invoices' },
          lastInvoiceDate: { $max: '$invoices.voucherDate' },
          invoiceTotalPaise: {
            $ifNull: [{ $sum: '$invoices.netTaxableValue' }, 0],
          },
          creditTotalPaise: {
            $ifNull: [{ $sum: '$creditNotes.netTaxableValue' }, 0],
          },
        },
      },
    ];

    const raw: any[] = await this.partyModel.aggregate(pipeline);
    const now = Date.now();
    return raw.map((r) => {
      const lastInvoiceDate: Date | null = r.lastInvoiceDate ?? null;
      const recencyDays = lastInvoiceDate
        ? Math.floor((now - new Date(lastInvoiceDate).getTime()) / MS_PER_DAY)
        : 99999; // sentinel for "no invoice in window"
      const monetaryPaise = Number(r.invoiceTotalPaise ?? 0) - Number(r.creditTotalPaise ?? 0);
      return {
        partyId: r.partyId,
        workspaceId: r.workspaceId,
        firmId: r.firmId,
        createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
        intelligence: r.intelligence ?? {},
        recencyDays,
        frequency: Number(r.frequency ?? 0),
        monetaryPaise,
        lastInvoiceDate,
        invoiceTotalPaise: Number(r.invoiceTotalPaise ?? 0),
        creditTotalPaise: Number(r.creditTotalPaise ?? 0),
      } as DimensionsRow;
    });
  }

  /**
   * BulkWrite raw dimensions back to Party.intelligence so $bucketAuto can
   * read them in step 3. Use $set on dotted paths because Party.intelligence
   * may be undefined initially — Mongoose creates the sub-doc on first $set.
   */
  private async persistRawDimensions(rows: DimensionsRow[]): Promise<void> {
    if (rows.length === 0) return;
    const ops = rows.map((r) => ({
      updateOne: {
        filter: { _id: r.partyId },
        update: {
          $set: {
            'intelligence.recencyDays': r.recencyDays,
            'intelligence.frequency': r.frequency,
            'intelligence.monetaryPaise': r.monetaryPaise,
            'intelligence.lastInvoiceDate': r.lastInvoiceDate,
            'intelligence.ltv12mPaise': r.invoiceTotalPaise,
            'intelligence.txCount12m': r.frequency,
          },
        },
      },
    }));
    await this.partyModel.bulkWrite(ops, { ordered: false });
  }

  /**
   * D-03 quintile-based segment derivation. Tuning overrides (D-09) are
   * honoured for newWindowDays + vipRfmFloor + dormant range + churned cutoff.
   *
   * Order: BLACKLIST handled by caller (sticky); here we evaluate
   * NEW > VIP > REGULAR > DORMANT > CHURNED.
   */
  private deriveQuintileSegment(
    row: DimensionsRow,
    R: RfmScore,
    F: RfmScore,
    M: RfmScore,
    tuning: RfmTuning,
    now: Date,
  ): PartySegment {
    const ageDays = (now.getTime() - row.createdAt.getTime()) / MS_PER_DAY;

    // NEW: createdAt within newWindowDays AND frequency ≤ 1
    if (ageDays < tuning.newWindowDays && row.frequency <= 1) {
      return 'NEW';
    }
    // VIP: R≥floor, F≥floor, M≥floor
    if (R >= tuning.vipRfmFloor && F >= tuning.vipRfmFloor && M >= tuning.vipRfmFloor) {
      return 'VIP';
    }
    // REGULAR: R≥3 AND F≥2
    if (R >= 3 && F >= 2) {
      return 'REGULAR';
    }
    // DORMANT: recencyDays in [dormantMin, dormantMax]
    if (row.recencyDays >= tuning.dormantMin && row.recencyDays <= tuning.dormantMax) {
      return 'DORMANT';
    }
    // CHURNED: recency > churnedCutoff OR (frequency=0 AND createdAt > newWindow)
    if (
      row.recencyDays > tuning.churnedCutoff ||
      (row.frequency === 0 && ageDays > tuning.newWindowDays)
    ) {
      return 'CHURNED';
    }
    // Fallback — shouldn't happen given quintile space coverage.
    return 'REGULAR';
  }

  /**
   * D-06 fixed-threshold fallback (active-party count < 5).
   * VIP if M ≥ 50_000 ₹, REGULAR if F ≥ 2, NEW if createdAt < newWindowDays,
   * else DORMANT.
   */
  private deriveFixedThresholdSegment(
    row: DimensionsRow,
    tuning: RfmTuning,
    now: Date,
  ): PartySegment {
    if (row.monetaryPaise >= FIXED_VIP_MONETARY_PAISE) return 'VIP';
    if (row.frequency >= FIXED_REGULAR_FREQUENCY_MIN) return 'REGULAR';
    const ageDays = (now.getTime() - row.createdAt.getTime()) / MS_PER_DAY;
    if (ageDays < tuning.newWindowDays) return 'NEW';
    return 'DORMANT';
  }

  /**
   * Load the workspace's RFM tuning overrides from
   * Workspace.partyIntelligence.rfmTuning (D-09). Defaults match D-03 when
   * any field is missing.
   */
  private async loadTuning(wsOid: Types.ObjectId): Promise<RfmTuning> {
    const ws = await this.workspaceModel
      .findById(wsOid)
      .select('partyIntelligence.rfmTuning')
      .lean();
    const overrides = ws?.partyIntelligence?.rfmTuning ?? {};
    return {
      newWindowDays: overrides.newWindowDays ?? DEFAULT_NEW_WINDOW_DAYS,
      vipRfmFloor: overrides.vipRfmFloor ?? DEFAULT_VIP_RFM_FLOOR,
      dormantMin: overrides.dormantMin ?? DEFAULT_DORMANT_MIN_DAYS,
      dormantMax: overrides.dormantMax ?? DEFAULT_DORMANT_MAX_DAYS,
      churnedCutoff: overrides.churnedCutoff ?? DEFAULT_CHURNED_CUTOFF_DAYS,
    };
  }
}
