import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InvoiceSequence } from '../schemas/invoice-sequence.schema';

/**
 * Atomic GST invoice numbering (D1f).
 *
 * Indian fiscal year starts 1 April. An invoice raised on 2026-03-31
 * belongs to FY 2025-26; one raised on 2026-04-01 belongs to FY 2026-27.
 *
 * Format: `<PREFIX>-FY<YY>-<SEQ:6>` e.g. `ZAR-FY26-000123`. The two-
 * digit YY uses the END year of the FY (`FY26` = 2025-26, `FY27` =
 * 2026-27) — convention used by most Indian B2B invoicing tools.
 *
 * GST law requires invoice numbers to be unique, sequential, and
 * unbroken within an FY. The `InvoiceSequence` collection's atomic
 * `$inc` upsert guarantees all three across concurrent workers.
 */
@Injectable()
export class InvoiceNumberService {
  constructor(
    @InjectModel(InvoiceSequence.name)
    private readonly sequenceModel: Model<InvoiceSequence>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Reserve the next invoice number for the FY containing `date`.
   *
   * The reserved number is committed atomically — even if the caller
   * crashes before persisting it onto a `SubscriptionPayment`, the
   * counter does NOT roll back. GST law treats this as a "voided"
   * invoice number that must be retained as a sequence-gap explanation
   * in filings. The trade-off vs reset-on-fail is deliberate:
   * non-unique invoice numbers are a far worse compliance risk than
   * occasional gaps.
   */
  async nextInvoiceNumber(date: Date = new Date()): Promise<string> {
    const fyKey = this.fiscalYearKey(date);
    const updated = await this.sequenceModel
      .findOneAndUpdate(
        { fyKey },
        { $inc: { value: 1 } },
        { upsert: true, new: true },
      )
      .exec();

    const prefix =
      this.configService.get<string>('app.platformLegalEntity.invoiceNumberPrefix') ??
      'INV';
    const seq = String(updated.value).padStart(6, '0');
    return `${prefix}-${fyKey}-${seq}`;
  }

  /**
   * `FY<YY>` for the END year of the Indian fiscal year containing the
   * given date. Boundaries: dates 1 Apr → 31 Mar belong to the same FY.
   */
  private fiscalYearKey(date: Date): string {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth(); // 0=Jan, 3=Apr
    const fyEndYear = month >= 3 ? year + 1 : year;
    return `FY${String(fyEndYear).slice(-2)}`;
  }
}
