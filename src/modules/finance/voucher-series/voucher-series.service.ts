import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { VoucherSeries } from './voucher-series.schema';
import { financialYearOf } from '../common/fiscal-year.util';
import { withFinanceSpan } from '../common/finance-observability';

const DEFAULT_SERIES = [
  { voucherType: 'sale_invoice', prefix: 'INV' },
  { voucherType: 'purchase_bill', prefix: 'PB' },
  { voucherType: 'payment_in', prefix: 'REC' },
  { voucherType: 'payment_out', prefix: 'PAY' },
  { voucherType: 'expense', prefix: 'EXP' },
  { voucherType: 'journal', prefix: 'JNL' },
  { voucherType: 'delivery_challan', prefix: 'DC' },
  { voucherType: 'credit_note', prefix: 'CN' },
  { voucherType: 'debit_note', prefix: 'DN' },
  { voucherType: 'stock_transfer', prefix: 'ST/' },
  { voucherType: 'wastage_entry', prefix: 'WS/' },
  { voucherType: 'sample_voucher', prefix: 'SV/' },
  { voucherType: 'job_work_in', prefix: 'JWI' },
  { voucherType: 'job_work_out', prefix: 'JWO' },
  { voucherType: 'job_work_invoice', prefix: 'JWS' },
  // 2c reverse charge: recipient-issued self-invoice (Rule 47A) + payment voucher (Rule 52).
  { voucherType: 'rcm_self_invoice', prefix: 'RCMSI' },
  { voucherType: 'rcm_payment_voucher', prefix: 'RCMPV' },
];

@Injectable()
export class VoucherSeriesService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Admin CRUD (create/update) + the idempotent seed get spans (no userId in
  // their signatures, so no PostHog events). generateNextNumber is the hot-path
  // per-voucher allocation - intentionally NOT spanned to avoid span-per-write noise.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(VoucherSeries.name)
    private readonly model: Model<VoucherSeries>,
  ) {}

  /** Derives FY string like "2025-26" from fyStartMonth (default April = 4) */
  getCurrentFY(fyStartMonth: number = 4): string {
    return this.getFYForDate(new Date(), fyStartMonth);
  }

  /**
   * Derives the FY string for a specific date - use for ALL vouchers so a
   * back-dated document is numbered into its true fiscal year. Delegates to the
   * canonical `financialYearOf` (shared with the FY-lock window helper).
   */
  getFYForDate(date: Date, fyStartMonth: number = 4): string {
    return financialYearOf(date, fyStartMonth);
  }

  /** Auto-seeds default VoucherSeries for a new firm */
  async seedDefaults(workspaceId: string, firmId: string, fyStartMonth: number = 4): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.seedVoucherSeriesDefaults',
      { workspaceId, firmId },
      async () => {
        const fy = this.getCurrentFY(fyStartMonth);
        const wsId = new Types.ObjectId(workspaceId);
        const fId = new Types.ObjectId(firmId);

        const ops = DEFAULT_SERIES.map((s) => ({
          updateOne: {
            filter: { firmId: fId, voucherType: s.voucherType, financialYear: fy },
            update: {
              $setOnInsert: {
                workspaceId: wsId,
                firmId: fId,
                voucherType: s.voucherType,
                prefix: s.prefix,
                startNumber: 1,
                padDigits: 4,
                financialYear: fy,
                lastUsed: 0,
                isDeleted: false,
              },
            },
            upsert: true,
          },
        }));

        await this.model.bulkWrite(ops);
      },
    );
  }

  async create(workspaceId: string, firmId: string, dto: any): Promise<VoucherSeries> {
    return withFinanceSpan(
      this.tracer,
      'finance.createVoucherSeries',
      { workspaceId, firmId },
      async () => {
        const doc = new this.model({
          ...dto,
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
        });
        return doc.save();
      },
    );
  }

  async findAll(workspaceId: string, firmId: string): Promise<VoucherSeries[]> {
    return this.model
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
  }

  async update(workspaceId: string, firmId: string, id: string, dto: any): Promise<VoucherSeries> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateVoucherSeries',
      { workspaceId, firmId, seriesId: id },
      async () => {
        const doc = await this.model
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(id),
              workspaceId: new Types.ObjectId(workspaceId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: false,
            },
            { $set: dto },
            { new: true },
          )
          .exec();
        if (!doc) throw new NotFoundException('VoucherSeries not found');
        return doc;
      },
    );
  }

  /**
   * Resolves the prefix and padDigits to carry forward when self-healing a new FY row.
   * Exported for unit-testing the pure logic without full service wiring.
   */
  resolveCarryForwardConfig(
    prior: Pick<VoucherSeries, 'prefix' | 'padDigits'> | null,
    voucherType: string,
  ): { prefix: string; padDigits: number } {
    if (prior) {
      return { prefix: prior.prefix, padDigits: prior.padDigits };
    }
    const defaultEntry = DEFAULT_SERIES.find((s) => s.voucherType === voucherType);
    const prefix = defaultEntry
      ? defaultEntry.prefix
      : voucherType
          .toUpperCase()
          .replace(/[^A-Z]/g, '')
          .slice(0, 3);
    return { prefix, padDigits: 4 };
  }

  /**
   * Atomically increments lastUsed and returns the formatted voucher number.
   * Format: {prefix}/{fyShort}/{padded} e.g. "INV/25-26/0001"
   * NEVER read-then-write -- always use atomic $inc.
   *
   * Self-heal: if no series row exists for the requested FY (e.g. firm was
   * created in a prior FY and seedDefaults never ran for the new FY), the
   * method carries config forward from the most-recent prior series and
   * atomically upserts the new-FY row in one operation, ensuring concurrency
   * safety (two simultaneous first-vouchers cannot both insert; the second
   * will just increment the already-inserted row).
   */
  async generateNextNumber(
    firmId: string,
    voucherType: string,
    financialYear: string,
  ): Promise<string> {
    const fId = new Types.ObjectId(firmId);

    // Step 1: fast path -- row already exists for this FY.
    let doc = await this.model
      .findOneAndUpdate(
        { firmId: fId, voucherType, financialYear, isDeleted: false },
        { $inc: { lastUsed: 1 } },
        { new: true },
      )
      .exec();

    if (!doc) {
      // Step 2: self-heal -- find the most recent prior series for this firm
      // and voucherType to carry prefix/padDigits forward.
      const prior = await this.model
        .findOne({ firmId: fId, voucherType, isDeleted: false })
        .sort({ financialYear: -1 })
        .exec();

      let workspaceId: Types.ObjectId;
      if (prior) {
        workspaceId = prior.workspaceId;
      } else {
        // No series exists for this voucherType at all -- fall back to any
        // series for the firm to get workspaceId.
        const anySeries = await this.model.findOne({ firmId: fId }).exec();
        if (!anySeries) {
          throw new NotFoundException(
            `VoucherSeries: no series found for firmId=${firmId}; run seedDefaults first`,
          );
        }
        workspaceId = anySeries.workspaceId;
      }

      const { prefix, padDigits } = this.resolveCarryForwardConfig(prior, voucherType);

      // Step 3: atomic upsert-and-increment so two concurrent first-vouchers
      // of the new FY are safe (the second just increments the inserted row).
      doc = await this.model
        .findOneAndUpdate(
          { firmId: fId, voucherType, financialYear },
          {
            $inc: { lastUsed: 1 },
            $setOnInsert: {
              workspaceId,
              firmId: fId,
              voucherType,
              prefix,
              startNumber: 1,
              padDigits,
              financialYear,
              isDeleted: false,
            },
          },
          { upsert: true, new: true },
        )
        .exec();
    }

    const fyShort = financialYear.slice(2); // "2025-26" -> "25-26"
    const padded = (doc as VoucherSeries).lastUsed
      .toString()
      .padStart((doc as VoucherSeries).padDigits, '0');
    return `${(doc as VoucherSeries).prefix}/${fyShort}/${padded}`;
  }
}
