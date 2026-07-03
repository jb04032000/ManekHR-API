import { Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { FiscalYear } from './fiscal-year.schema';
import { getFiscalYearOfDate } from '../common/fiscal-year.util';
import { withFinanceSpan } from '../common/finance-observability';
import { FirmsService } from '../firms/firms.service';

/**
 * FiscalYear CRUD + auto-seed on firm creation + idempotent backfill on
 * first getCurrentFy() call (D-12).
 *
 * Single source of truth for FY windows: delegates date math to
 * `getFiscalYearOfDate()` from `finance/common/fiscal-year.util.ts` (created
 * by Plan 02; Plan 03 imports — never duplicates).
 */
@Injectable()
export class FiscalYearService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // seedDefaultFy is an idempotent internal seed (auto-fired on firm create and
  // lazy backfill) with no userId in its signature - span only, no PostHog event.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(FiscalYear.name)
    private readonly fyModel: Model<FiscalYear>,
    @Inject(forwardRef(() => FirmsService))
    private readonly firmsService: any,
  ) {}

  /**
   * Idempotent — returns the existing Apr–Mar (or fyStartMonth-based) FY for
   * the firm if one exists; otherwise creates one.
   *
   * Called from FirmsService.create() after a firm is persisted, AND lazily
   * from getCurrentFy() so legacy firms predating this phase pick up an FY on
   * first read.
   */
  async seedDefaultFy(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    fyStartMonth = 4,
    referenceDate: Date = new Date(),
  ): Promise<FiscalYear> {
    return withFinanceSpan(
      this.tracer,
      'finance.seedDefaultFiscalYear',
      { workspaceId: String(wsId), firmId: String(firmId) },
      async () => {
        const window = getFiscalYearOfDate(referenceDate, fyStartMonth);

        // Atomic find-or-create on (wsId, firmId, startDate) — the unique index
        // guarantees no duplicates across concurrent calls.
        const doc = await this.fyModel
          .findOneAndUpdate(
            {
              wsId: new Types.ObjectId(wsId),
              firmId: new Types.ObjectId(firmId),
              startDate: window.startDate,
            },
            {
              $setOnInsert: {
                wsId: new Types.ObjectId(wsId),
                firmId: new Types.ObjectId(firmId),
                startDate: window.startDate,
                endDate: window.endDate,
                status: 'OPEN',
                auditTrail: [],
              },
            },
            { upsert: true, new: true },
          )
          .exec();

        return doc as FiscalYear;
      },
    );
  }

  /**
   * Returns the FY row whose startDate ≤ today ≤ endDate for this firm.
   *
   * Idempotent backfill: if no row exists, creates the default FY for the
   * current Indian FY (or firm.fyStartMonth-derived window) and returns it.
   */
  async getCurrentFy(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
  ): Promise<FiscalYear> {
    const today = new Date();
    const existing = await this.fyModel
      .findOne({
        wsId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        startDate: { $lte: today },
        endDate: { $gte: today },
      })
      .exec();
    if (existing) return existing;

    // Backfill — load firm to derive fyStartMonth (default 4 if firm absent).
    let fyStartMonth = 4;
    try {
      const firm: any = await this.firmsService.findOne(wsId.toString(), firmId.toString());
      if (firm?.fyStartMonth) fyStartMonth = firm.fyStartMonth;
    } catch {
      // firm not loadable in test contexts — fall back to default 4.
    }
    return this.seedDefaultFy(wsId, firmId, fyStartMonth, today);
  }

  /** Returns all FY rows for a firm sorted by startDate desc. */
  async listForFirm(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
  ): Promise<FiscalYear[]> {
    return this.fyModel
      .find({
        wsId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
      })
      .sort({ startDate: -1 })
      .exec();
  }

  async getById(id: string | Types.ObjectId): Promise<FiscalYear> {
    const doc = await this.fyModel.findById(new Types.ObjectId(id)).exec();
    if (!doc) throw new NotFoundException('FiscalYear not found');
    return doc;
  }
}
