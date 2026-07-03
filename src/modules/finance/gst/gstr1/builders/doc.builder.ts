import { Model, Types } from 'mongoose';
import type { VoucherSeries } from '../../../../voucher-series/voucher-series.schema';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';

// ─── GSTN DOC output types ───────────────────────────────────────────────────

export interface GstnDocEntry {
  num: number;
  from: string;   // from document number
  to: string;     // to document number
  totnum: number; // total docs in series
  cancel: number; // cancelled count
  net_issue: number; // net issued = totnum - cancel
}

export interface GstnDocDet {
  doc_num: number;    // serial (1-based)
  doc_typ: string;    // e.g., 'Invoices for outward supply', 'Invoices for inward supply', etc.
  docs: GstnDocEntry[];
}

export interface DocSection {
  doc_det: GstnDocDet[];
}

// ─── DOC type name mapping ────────────────────────────────────────────────────

const DOC_TYPE_NAMES: Record<string, string> = {
  sale_invoice: 'Invoices for outward supply',
  credit_note: 'Credit Notes',
  debit_note: 'Debit Notes',
  delivery_challan: 'Delivery Challans',
  proforma: 'Advance Payment Vouchers',
};

// GSTR-1 DOC section covers specific voucher types only
const GSTR1_DOC_TYPES = ['sale_invoice', 'credit_note', 'debit_note', 'delivery_challan'];

// ─── DOC builder ─────────────────────────────────────────────────────────────

/**
 * buildDocSection — Document series summary for GSTR-1 Table 13.
 *
 * Queries VoucherSeries for the firm to determine series ranges.
 * Counts cancelled invoices in each series for the period.
 *
 * Note: VoucherSeries.lastUsed tracks the current number. Total docs = lastUsed - startNumber + 1.
 * Cancelled count: query SaleInvoice for cancelled docs in period within the series range.
 */
export async function buildDocSection(deps: {
  saleInvoiceModel: Model<SaleInvoice>;
  voucherSeriesModel: Model<VoucherSeries>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<DocSection> {
  const { voucherSeriesModel, saleInvoiceModel, wsId, firmId, startDate, endDate } = deps;

  // Determine financial year from period (approximate from startDate)
  const fy = getFinancialYear(startDate);

  // Fetch all voucher series for the firm + FY for GSTR-1 relevant types
  const seriesList = await voucherSeriesModel
    .find({
      workspaceId: wsId,
      firmId,
      isDeleted: false,
      voucherType: { $in: GSTR1_DOC_TYPES },
      financialYear: fy,
    })
    .lean();

  const docDet: GstnDocDet[] = [];
  let docNum = 1;

  for (const series of seriesList) {
    const typeName = DOC_TYPE_NAMES[series.voucherType] ?? series.voucherType;
    const fromNo = series.startNumber;
    const toNo = series.lastUsed > 0 ? series.lastUsed : series.startNumber;
    const totnum = toNo >= fromNo ? toNo - fromNo + 1 : 0;

    // Count cancelled vouchers in this series within the period.
    // WR-04: scope cancel count to the series' serial range to avoid counting
    // cancellations from other concurrent series of the same voucherType.
    const fromDocNo = buildDocNumber(series.prefix, fromNo, series.padDigits);
    const toDocNo = buildDocNumber(series.prefix, toNo, series.padDigits);
    const cancelCount = await saleInvoiceModel.countDocuments({
      workspaceId: wsId,
      firmId,
      voucherType: series.voucherType,
      state: 'cancelled',
      isDeleted: false,
      voucherDate: { $gte: startDate, $lt: endDate },
      voucherNumber: { $gte: fromDocNo, $lte: toDocNo },
    });

    const net_issue = Math.max(0, totnum - cancelCount);

    docDet.push({
      doc_num: docNum++,
      doc_typ: typeName,
      docs: [
        {
          num: 1,
          from: buildDocNumber(series.prefix, fromNo, series.padDigits),
          to: buildDocNumber(series.prefix, toNo, series.padDigits),
          totnum,
          cancel: cancelCount,
          net_issue,
        },
      ],
    });
  }

  return { doc_det: docDet };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDocNumber(prefix: string, num: number, padDigits: number): string {
  const padded = String(num).padStart(padDigits, '0');
  return `${prefix}${padded}`;
}

function getFinancialYear(date: Date): string {
  const month = date.getMonth() + 1; // 1-indexed
  const year = date.getFullYear();
  // FY starts April (month 4)
  if (month >= 4) {
    return `${year}-${String(year + 1).slice(2)}`;
  } else {
    return `${year - 1}-${String(year).slice(2)}`;
  }
}
