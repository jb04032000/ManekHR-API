import { Model, Types } from 'mongoose';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';

// ─── GSTN NIL output types ───────────────────────────────────────────────────

export interface GstnNilInv {
  sply_ty: 'INTRB2B' | 'INTRB2C' | 'INTRAB2B' | 'INTRAB2C';
  // INTR = Interstate, INTRA = Intrastate, B2B = registered, B2C = unregistered
  expt_amt: number;   // Exempt supply amount
  nil_amt: number;    // Nil-rated supply amount
  ngsup_amt: number;  // Non-GST supply amount
}

export interface NilSection {
  inv: GstnNilInv[];
}

// ─── NIL taxability types ─────────────────────────────────────────────────────

const NIL_TAXABILITY = ['nil', 'nil_rated'];
const EXEMPT_TAXABILITY = ['exempt', 'exempted'];
const NON_GST_TAXABILITY = ['non_gst', 'non-gst', 'non_taxable'];

// ─── NIL builder ─────────────────────────────────────────────────────────────

/**
 * buildNilSection — Nil-rated / exempt / non-GST inward+outward supplies.
 *
 * Queries SaleInvoice posted with line items where:
 *  - taxRate = 0, OR
 *  - item.taxabilityType in ['nil', 'exempt', 'non_gst']
 *
 * Classifies per GSTN sply_ty:
 *  INTRB2B  = Interstate B2B (partySnapshot.gstin exists, POS != firm state)
 *  INTRB2C  = Interstate B2C (no gstin, POS != firm state)
 *  INTRAB2B = Intrastate B2B
 *  INTRAB2C = Intrastate B2C
 */
export async function buildNilSection(deps: {
  saleInvoiceModel: Model<SaleInvoice>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  firmStateCode?: string;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<NilSection> {
  const { saleInvoiceModel, wsId, firmId, firmStateCode, startDate, endDate } = deps;

  const firmState = String(firmStateCode ?? '').padStart(2, '0');

  // Fetch all posted invoices in period — filter by zero-rate or exempt line items
  const invoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherType: 'sale_invoice',
      voucherDate: { $gte: startDate, $lt: endDate },
      // At least one line item with zero rate or exempt taxability
      $or: [
        { 'lineItems.taxRate': 0 },
        { 'lineItems.taxabilityType': { $in: [...NIL_TAXABILITY, ...EXEMPT_TAXABILITY, ...NON_GST_TAXABILITY] } },
      ],
    })
    .lean();

  // Accumulate by supply type in paise (integer) to avoid floating-point drift.
  // WR-05: convert paise → rupees exactly once at export, not per line item.
  type SupplyTypeKey = 'INTRB2B' | 'INTRB2C' | 'INTRAB2B' | 'INTRAB2C';
  const agg: Record<SupplyTypeKey, { expt_amt_paise: number; nil_amt_paise: number; ngsup_amt_paise: number }> = {
    INTRB2B: { expt_amt_paise: 0, nil_amt_paise: 0, ngsup_amt_paise: 0 },
    INTRB2C: { expt_amt_paise: 0, nil_amt_paise: 0, ngsup_amt_paise: 0 },
    INTRAB2B: { expt_amt_paise: 0, nil_amt_paise: 0, ngsup_amt_paise: 0 },
    INTRAB2C: { expt_amt_paise: 0, nil_amt_paise: 0, ngsup_amt_paise: 0 },
  };

  for (const inv of invoices) {
    const snap = inv.partySnapshot as Record<string, any> | undefined;
    const hasGstin = !!(snap?.gstin);
    const pos = String(inv.placeOfSupplyStateCode ?? '').padStart(2, '0');
    const isIntrastate = pos === firmState;

    let supplyType: SupplyTypeKey;
    if (isIntrastate) {
      supplyType = hasGstin ? 'INTRAB2B' : 'INTRAB2C';
    } else {
      supplyType = hasGstin ? 'INTRB2B' : 'INTRB2C';
    }

    for (const li of (inv.lineItems ?? []) as any[]) {
      const rate = li.taxRate ?? 0;
      const taxabilityType = (li.taxabilityType ?? '').toLowerCase();
      const amtPaise = li.taxableValuePaise ?? 0;

      if (NON_GST_TAXABILITY.includes(taxabilityType)) {
        agg[supplyType].ngsup_amt_paise += amtPaise;
      } else if (EXEMPT_TAXABILITY.includes(taxabilityType)) {
        agg[supplyType].expt_amt_paise += amtPaise;
      } else if (NIL_TAXABILITY.includes(taxabilityType) || rate === 0) {
        agg[supplyType].nil_amt_paise += amtPaise;
      }
    }
  }

  // Build output — convert paise to rupees once per bucket, include only non-zero rows
  const inv: GstnNilInv[] = [];
  for (const [sply_ty, vals] of Object.entries(agg) as [SupplyTypeKey, typeof agg[SupplyTypeKey]][]) {
    const expt_amt = Number((vals.expt_amt_paise / 100).toFixed(2));
    const nil_amt = Number((vals.nil_amt_paise / 100).toFixed(2));
    const ngsup_amt = Number((vals.ngsup_amt_paise / 100).toFixed(2));
    if (expt_amt > 0 || nil_amt > 0 || ngsup_amt > 0) {
      inv.push({ sply_ty, expt_amt, nil_amt, ngsup_amt });
    }
  }

  return { inv };
}
