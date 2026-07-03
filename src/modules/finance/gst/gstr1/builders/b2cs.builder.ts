import { Model, Types } from 'mongoose';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';

// ─── GSTN B2CS output types ──────────────────────────────────────────────────

export interface GstnB2csRow {
  sply_ty: 'INTRA' | 'INTER';
  rt: number;
  typ: 'OE' | 'E';   // OE = Other Exempt / E = E-Commerce
  pos: string;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function p2r(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

// ─── B2CS builder ────────────────────────────────────────────────────────────

/**
 * buildB2csSection — B2C Small: state-wise summary for unregistered buyers.
 *
 * Covers:
 *  - All intrastate B2C invoices (any value)
 *  - Interstate B2C invoices with value <= ₹2.5L
 *
 * Aggregated by (place-of-supply, tax rate).
 * sply_ty: 'INTRA' if firmStateCode === pos, else 'INTER'.
 * typ: 'OE' (default); 'E' only for e-commerce (ecomOperator set — not implemented in MVP).
 */
export async function buildB2csSection(deps: {
  saleInvoiceModel: Model<SaleInvoice>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  firmStateCode?: string;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<GstnB2csRow[]> {
  const { saleInvoiceModel, wsId, firmId, firmStateCode, startDate, endDate } = deps;

  const B2CL_THRESHOLD_PAISE = 25_000_000; // ₹2.5L in paise
  const firmState = String(firmStateCode ?? '').padStart(2, '0');

  const invoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherType: 'sale_invoice',
      voucherDate: { $gte: startDate, $lt: endDate },
      $or: [
        { 'partySnapshot.gstin': null },
        { 'partySnapshot.gstin': '' },
        { 'partySnapshot.gstin': { $exists: false } },
      ],
    })
    .lean();

  // Exclude B2CL invoices (interstate + > ₹2.5L) — those go to B2CL section
  const b2csInvoices = invoices.filter((inv) => {
    const pos = String(inv.placeOfSupplyStateCode ?? '').padStart(2, '0');
    const isInterstate = pos !== firmState;
    const isLarge = (inv.grandTotalPaise ?? 0) > B2CL_THRESHOLD_PAISE;
    return !(isInterstate && isLarge); // exclude B2CL
  });

  // Aggregate by (pos, taxRate) across line items
  // Key: `${pos}|${rate}`
  type AggKey = string;
  const agg = new Map<AggKey, { pos: string; rate: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();

  for (const inv of b2csInvoices) {
    const pos = String(inv.placeOfSupplyStateCode ?? '').padStart(2, '0');
    for (const li of (inv.lineItems ?? []) as any[]) {
      const rate = li.taxRate ?? 0;
      const key: AggKey = `${pos}|${rate}`;
      const existing = agg.get(key) ?? { pos, rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      existing.txval += li.taxableValuePaise ?? 0;
      existing.iamt += li.igstPaise ?? 0;
      existing.camt += li.cgstPaise ?? 0;
      existing.samt += li.sgstPaise ?? 0;
      existing.csamt += li.cessPaise ?? 0;
      agg.set(key, existing);
    }
  }

  return Array.from(agg.values()).map((row) => ({
    sply_ty: row.pos === firmState ? 'INTRA' : 'INTER',
    rt: row.rate,
    typ: 'OE' as const,
    pos: row.pos,
    txval: p2r(row.txval),
    iamt: p2r(row.iamt),
    camt: p2r(row.camt),
    samt: p2r(row.samt),
    csamt: p2r(row.csamt),
  }));
}
