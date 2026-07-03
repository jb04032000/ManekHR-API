import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { PurchaseBill } from '../../purchases/purchase-bill/purchase-bill.schema';
import { withFinanceSpan } from '../../common/finance-observability';
import { parseGstr2b, reconcileGstr2b, type BillRow, type ReconResult } from './gstr2b-recon';

/**
 * Gstr2bService - GSTR-2B (ITC) reconciliation.
 *
 * What it does: takes an uploaded GSTN GSTR-2B JSON for a tax period, loads the
 * firm's POSTED purchase bills for that period, and runs the pure reconciler
 * (gstr2b-recon.ts) to bucket every row into matched / partial / missing-in-books
 * / missing-in-2b, with per-row amount deltas and total ITC-at-risk.
 *
 * Cross-links: reads PurchaseBill (purchase-bill.schema - state='posted',
 * partySnapshot.gstin, vendorBillNumber, vendorBillDate, taxableValuePaise,
 * cgst/sgst/igstPaise). Exposed by Gstr2bController. STATELESS: the upload is not
 * persisted (no schema change) - reconciliation is computed on demand and returned.
 * Watch: period (MMYYYY) bounds filter on voucherDate, mirroring Gstr1Service.
 */
@Injectable()
export class Gstr2bService {
  private readonly logger = new Logger(Gstr2bService.name);
  // Platform-bar observability: shared finance tracer (mirrors Gstr1Service / Gstr3bService).
  // reconcile is read/compute (the upload is NOT persisted - stateless), so it gets a span only;
  // there is no request-scoped userId in the signature, so no PostHog write event is emitted.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(PurchaseBill.name)
    private readonly purchaseBillModel: Model<PurchaseBill>,
  ) {}

  async reconcile(
    wsId: string,
    firmId: string,
    period: string,
    twoBJson: unknown,
  ): Promise<ReconResult & { period: string; billsInPeriod: number; twoBRows: number }> {
    return withFinanceSpan(
      this.tracer,
      'finance.reconcileGstr2b',
      { workspaceId: wsId, firmId, period },
      async () => {
        const { startDate, endDate } = this.periodBounds(period);

        // Posted purchase bills in the period are the books side of the match.
        const bills = await this.purchaseBillModel
          .find({
            workspaceId: new Types.ObjectId(wsId),
            firmId: new Types.ObjectId(firmId),
            state: 'posted',
            isDeleted: { $ne: true },
            voucherDate: { $gte: startDate, $lt: endDate },
          })
          .select(
            'voucherNumber vendorBillNumber vendorBillDate partySnapshot taxableValuePaise cgstPaise sgstPaise igstPaise',
          )
          .lean()
          .exec();

        const billRows: BillRow[] = bills.map((b: any) => ({
          billId: String(b._id),
          voucherNumber: b.voucherNumber,
          partyName:
            b.partySnapshot?.name ?? b.partySnapshot?.legalName ?? b.partySnapshot?.partyName,
          gstin: b.partySnapshot?.gstin,
          vendorBillNumber: b.vendorBillNumber,
          vendorBillDate: b.vendorBillDate
            ? new Date(b.vendorBillDate).toISOString().slice(0, 10)
            : undefined,
          taxablePaise: b.taxableValuePaise ?? 0,
          igstPaise: b.igstPaise ?? 0,
          cgstPaise: b.cgstPaise ?? 0,
          sgstPaise: b.sgstPaise ?? 0,
        }));

        const twoBRows = parseGstr2b(twoBJson);
        const result = reconcileGstr2b(twoBRows, billRows);

        this.logger.log(
          `GSTR-2B reconcile ws=${wsId} firm=${firmId} period=${period}: ` +
            `${twoBRows.length} 2B rows vs ${billRows.length} bills -> ` +
            `${result.summary.matched} matched, ${result.summary.partial} partial, ` +
            `${result.summary.missingInBooks} missing-in-books, ${result.summary.missingIn2b} missing-in-2B`,
        );

        return {
          ...result,
          period,
          billsInPeriod: billRows.length,
          twoBRows: twoBRows.length,
        };
      },
    );
  }

  // Mirror of Gstr1Service.periodBounds - MMYYYY -> [start, nextMonthStart).
  private periodBounds(period: string): { startDate: Date; endDate: Date } {
    const month = parseInt(period.slice(0, 2), 10);
    const year = parseInt(period.slice(2), 10);
    return { startDate: new Date(year, month - 1, 1), endDate: new Date(year, month, 1) };
  }
}
