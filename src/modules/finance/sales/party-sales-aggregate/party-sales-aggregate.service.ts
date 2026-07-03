import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, ClientSession } from 'mongoose';
import { PartySalesAggregate } from './party-sales-aggregate.schema';

// ─── TCS constants ───────────────────────────────────────────────────────────

/** ₹50 lakh = 50,00,000 INR × 100 paise = 5,000,000,00 paise */
const TCS_THRESHOLD_PAISE = 5_000_000_00;

/** TCS Section 206C(1H) rate = 0.1% */
const TCS_RATE = 0.001;

/** AATO threshold in lakhs: firm.aato must exceed 100 (Rs 10 Cr) to trigger TCS */
const AATO_THRESHOLD_LAKHS = 100;

/**
 * TCS Sec 206C(1H) was omitted by Finance Act 2025, effective 1 Apr 2025.
 * Invoices dated on or after this carry no 206C(1H) TCS. Earlier invoices
 * still compute it (reprints, amendments, prior-period reports).
 */
const TCS_206C_1H_SUNSET = new Date('2025-04-01T00:00:00.000Z');

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class PartySalesAggregateService {
  private readonly logger = new Logger(PartySalesAggregateService.name);

  constructor(
    @InjectModel(PartySalesAggregate.name)
    private readonly model: Model<PartySalesAggregate>,
  ) {}

  /**
   * Atomically increments the cumulative sales total for a party in a FY.
   * Returns the BEFORE-increment value so the caller can detect the ₹50L crossing.
   *
   * Uses findOneAndUpdate with { new: false } — returns the document AS IT WAS
   * before the $inc. This is the only safe pattern for threshold detection
   * (no read-then-write race condition). Per T-F02-02-02.
   */
  async upsertAndGet(
    workspaceId: string,
    firmId: string,
    partyId: string,
    financialYear: string,
    deltaPaise: number,
    opts: { session?: ClientSession } = {},
  ): Promise<{ beforePaise: number; afterPaise: number }> {
    const doc = await this.model
      .findOneAndUpdate(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
          partyId: new Types.ObjectId(partyId),
          financialYear,
        },
        { $inc: { totalSalesPaise: deltaPaise } },
        {
          upsert: true,
          new: false, // CRITICAL: returns PRE-update document for threshold detection
          session: opts.session,
        },
      )
      .exec();

    // If null → first ever upsert (document did not exist before)
    const beforePaise = doc?.totalSalesPaise ?? 0;
    const afterPaise = beforePaise + deltaPaise;

    return { beforePaise, afterPaise };
  }

  /**
   * Pure TCS computation per D-11 (Section 206C(1H)).
   *
   * Returns TCS paise to add to this invoice.
   * - If firm.aato <= 100 (≤ ₹10 Cr): return 0 (not applicable).
   * - If beforePaise >= threshold: full TCS on invoiceTaxablePaise.
   * - If afterPaise <= threshold: not yet crossed → return 0.
   * - Else (first crossing): marginal TCS only on the portion above threshold.
   */
  computeTcs(
    invoiceTaxablePaise: number,
    beforePaise: number,
    firm: { aato: number },
    invoiceDate: Date,
  ): number {
    // Abolished from 1 Apr 2025 (Finance Act 2025): no TCS on or after the sunset.
    if (invoiceDate && invoiceDate.getTime() >= TCS_206C_1H_SUNSET.getTime()) {
      return 0;
    }

    // D-11: only applies to firms with AATO > Rs 10 Cr
    if (firm.aato <= AATO_THRESHOLD_LAKHS) {
      return 0;
    }

    const afterPaise = beforePaise + invoiceTaxablePaise;

    if (beforePaise >= TCS_THRESHOLD_PAISE) {
      // Already past threshold on prior invoices — full TCS on this invoice
      return Math.round(invoiceTaxablePaise * TCS_RATE);
    }

    if (afterPaise <= TCS_THRESHOLD_PAISE) {
      // Has not crossed threshold with this invoice
      return 0;
    }

    // First crossing: TCS only on the marginal amount above the threshold
    const marginalPaise = afterPaise - TCS_THRESHOLD_PAISE;
    return Math.round(marginalPaise * TCS_RATE);
  }

  /**
   * Decrements the cumulative total — used for invoice cancel / credit-note reversal.
   */
  async revert(
    workspaceId: string,
    firmId: string,
    partyId: string,
    financialYear: string,
    deltaPaise: number,
    opts: { session?: ClientSession } = {},
  ): Promise<void> {
    await this.model
      .findOneAndUpdate(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
          partyId: new Types.ObjectId(partyId),
          financialYear,
        },
        { $inc: { totalSalesPaise: -deltaPaise } },
        { session: opts.session },
      )
      .exec();
  }
}
