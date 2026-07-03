import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, ClientSession } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';
import { GstRateHistory } from './gst-rate-history.schema';
import { GST_RATE_HISTORY_SEED } from './seeds/gst-rates-2017-2026.seed';

/**
 * GstRateHistoryService — rate-as-of lookup for HSN/SAC codes.
 *
 * Core algorithm: longest-prefix match within the date window.
 * Given hsnCode "5208" and txnDate, generates prefixes ["5", "52", "520", "5208"],
 * fetches all with fromDate <= txnDate and (toDate null OR toDate > txnDate),
 * then returns the candidate with the longest hsnPrefix (most specific match).
 */
@Injectable()
export class GstRateHistoryService {
  private readonly logger = new Logger(GstRateHistoryService.name);
  // Platform-bar observability: shared finance tracer (mirrors Gstr1Service / Gstr3bService).
  // Only the boot-time seed write gets a span. getRateAsOf / listChangesInPeriod are hot-path
  // inner lookups (called per-HSN-line / per-check by builders + verify-data), so they are
  // intentionally NOT wrapped - one span per line would be high-cardinality trace noise.
  // No request-scoped userId reaches this service, so no PostHog write event is emitted.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(GstRateHistory.name)
    private readonly model: Model<GstRateHistory>,
  ) {}

  // NOTE: seeding moved off boot — `seedIfEmpty()` is now run by the ledgered
  // migration runner (ADR-0001 Slice 2), unit `0008_finance_seed_gst_rate_history`.
  // Do NOT re-add an onModuleInit seed hook here on merge.

  /**
   * Seed the collection on first boot if empty. Idempotent.
   */
  async seedIfEmpty(): Promise<void> {
    return withFinanceSpan(this.tracer, 'finance.seedGstRateHistory', {}, async () => {
      const count = await this.model.countDocuments();
      if (count === 0) {
        this.logger.log(
          `GstRateHistory collection empty — seeding ${GST_RATE_HISTORY_SEED.length} records`,
        );
        await this.model.insertMany(GST_RATE_HISTORY_SEED as any[]);
        this.logger.log('GstRateHistory seed complete');
      }
    });
  }

  /**
   * Look up the applicable GST rate for a given HSN/SAC code at a given transaction date.
   *
   * Algorithm:
   * 1. Generate all prefixes of hsnCode (length 1 up to hsnCode.length).
   * 2. Query for records matching any prefix AND effective at txnDate.
   * 3. Return the record with the longest (most specific) hsnPrefix.
   *
   * Returns null if no matching rate is found (caller should handle as 0-rated or flag for review).
   */
  async getRateAsOf(hsnCode: string, txnDate: Date): Promise<GstRateHistory | null> {
    // Generate prefixes: ['5', '52', '520', '5208'] for hsnCode '5208'
    const prefixes: string[] = [];
    for (let len = 1; len <= hsnCode.length; len++) {
      prefixes.push(hsnCode.slice(0, len));
    }

    const candidates = await this.model
      .find({
        hsnPrefix: { $in: prefixes },
        fromDate: { $lte: txnDate },
        $or: [
          { toDate: null },
          { toDate: { $exists: false } },
          { toDate: { $gte: txnDate } }, // WR-03: inclusive upper boundary — rate valid on boundary date
        ],
      })
      .lean();

    if (!candidates.length) return null;

    // Longest hsnPrefix wins (most specific rate takes precedence)
    return candidates.reduce((a, b) =>
      a.hsnPrefix.length >= b.hsnPrefix.length ? a : b,
    ) as GstRateHistory;
  }

  /**
   * List all GST rate changes that took effect within a given date range.
   * Used by the Verify-My-Data scanner (Wave 5) to flag invoices that may have
   * used stale rates when a rate change occurred mid-period.
   */
  async listChangesInPeriod(startDate: Date, endDate: Date): Promise<GstRateHistory[]> {
    return this.model
      .find({ fromDate: { $gte: startDate, $lt: endDate } })
      .sort({ fromDate: 1 })
      .lean() as Promise<GstRateHistory[]>;
  }

  /** Full rate history for one HSN/SAC prefix (oldest first) — for the admin rate editor. */
  async listForPrefix(hsnPrefix: string): Promise<GstRateHistory[]> {
    return this.model.find({ hsnPrefix }).sort({ fromDate: 1 }).lean() as Promise<GstRateHistory[]>;
  }

  /**
   * R6: browse ALL rate rows (paginated), not just one prefix — powers the admin rate editor's
   * default table so an admin can scan/search the whole registry. Optional `q` matches the prefix
   * (prefix-anchored) or the description (contains). Newest changes first.
   */
  async listAll(opts: {
    q?: string;
    skip?: number;
    limit?: number;
  }): Promise<{ data: GstRateHistory[]; total: number }> {
    const filter: Record<string, unknown> = {};
    const q = opts.q?.trim();
    if (q) {
      // WR-05: escape regex metacharacters from user input (ReDoS-safe).
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { hsnPrefix: { $regex: `^${esc}`, $options: 'i' } },
        { description: { $regex: esc, $options: 'i' } },
      ];
    }
    const skip = Math.max(0, opts.skip ?? 0);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ fromDate: -1 }).skip(skip).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);
    return { data: data as GstRateHistory[], total };
  }

  /**
   * D15: record a rate revision for an HSN/SAC prefix effective `fromDate`, with NO deploy.
   * End-dates the currently-open row (toDate = day before the new rate starts) and inserts the
   * new open-ended row, so the timeline never overlaps and old invoices keep their old rate.
   * Append-forward only: fromDate must be after the current rate's start. Caller (admin
   * controller) enforces platform-admin authority + audit; run inside a txn for atomicity.
   */
  async reviseRate(
    input: {
      hsnPrefix: string;
      fromDate: Date;
      cgstRate: number;
      sgstRate: number;
      igstRate: number;
      cessRate?: number;
      description?: string;
      notification?: string;
      revisedBy?: string; // R6: stamp the acting admin onto the new row
      revisedByName?: string;
    },
    opts: { session?: ClientSession } = {},
  ): Promise<GstRateHistory> {
    // D16: the two dependent writes (end-date the current row + insert the new one) MUST be
    // atomic. A crash between them leaves the prefix with two open rows or a gap, corrupting
    // longest-prefix getRateAsOf for EVERY tenant. Run in a transaction; reuse a caller session.
    if (opts.session) {
      return this.reviseRateTxn(input, opts.session);
    }
    const session = await this.model.db.startSession();
    try {
      let created: GstRateHistory | undefined;
      await session.withTransaction(async () => {
        created = await this.reviseRateTxn(input, session);
      });
      return created;
    } finally {
      await session.endSession();
    }
  }

  private async reviseRateTxn(
    input: {
      hsnPrefix: string;
      fromDate: Date;
      cgstRate: number;
      sgstRate: number;
      igstRate: number;
      cessRate?: number;
      description?: string;
      notification?: string;
      revisedBy?: string;
      revisedByName?: string;
    },
    session: ClientSession,
  ): Promise<GstRateHistory> {
    const { hsnPrefix, fromDate } = input;

    // The currently-open rate for this exact prefix (most recent with no toDate).
    const current = await this.model
      .findOne({ hsnPrefix, $or: [{ toDate: null }, { toDate: { $exists: false } }] }, undefined, {
        session,
      })
      .sort({ fromDate: -1 });

    if (current) {
      if (fromDate.getTime() <= new Date(current.fromDate).getTime()) {
        throw new BadRequestException(
          `New rate effective date must be after the current rate's start (${new Date(
            current.fromDate,
          )
            .toISOString()
            .slice(0, 10)}).`,
        );
      }
      // End-date the current row the day before the new rate starts (inclusive, no overlap).
      current.toDate = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
      await current.save({ session });
    }

    const created = new this.model({
      hsnPrefix,
      description: input.description ?? current?.description,
      fromDate,
      toDate: undefined, // open-ended = currently applicable
      cgstRate: input.cgstRate,
      sgstRate: input.sgstRate,
      igstRate: input.igstRate,
      cessRate: input.cessRate ?? 0,
      notification: input.notification,
      revisedBy: input.revisedBy, // R6: who/when audit on the row
      revisedByName: input.revisedByName,
    });
    return created.save({ session });
  }
}
