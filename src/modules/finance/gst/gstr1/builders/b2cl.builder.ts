import { Model, Types } from 'mongoose';
import { format } from 'date-fns';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';

// ─── GSTN B2CL output types ──────────────────────────────────────────────────

export interface GstnB2clItmDet {
  txval: number;
  rt: number;
  iamt: number;
  csamt: number;
}

export interface GstnB2clItm {
  num: number;
  itm_det: GstnB2clItmDet;
}

export interface GstnB2clInv {
  inum: string;
  idt: string;      // DD-MM-YYYY
  val: number;
  itms: GstnB2clItm[];
}

export interface GstnB2clGroup {
  pos: string;
  inv: GstnB2clInv[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function p2r(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

function fmtDate(d: Date): string {
  return format(d, 'dd-MM-yyyy');
}

// ─── B2CL builder ────────────────────────────────────────────────────────────

/**
 * buildB2clSection — B2C Large: unregistered buyer, interstate supply, value > ₹2.5 Lakh.
 *
 * Threshold: grandTotalPaise > 25_000_000 paise (₹2,50,000 = ₹2.5L in paise)
 * Interstate: placeOfSupplyStateCode !== firmStateCode
 * Unregistered: partySnapshot.gstin null or empty
 *
 * Grouped by place-of-supply state code.
 */
export async function buildB2clSection(deps: {
  saleInvoiceModel: Model<SaleInvoice>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  firmStateCode?: string;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<GstnB2clGroup[]> {
  const { saleInvoiceModel, wsId, firmId, firmStateCode, startDate, endDate } = deps;

  // ₹2.5L = 2,50,000 rupees = 25,000,000 paise
  const B2CL_THRESHOLD_PAISE = 25_000_000;

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
      grandTotalPaise: { $gt: B2CL_THRESHOLD_PAISE },
    })
    .lean();

  // Filter: interstate only (POS != firm state code)
  const firmState = String(firmStateCode ?? '').padStart(2, '0');
  const interstateInvoices = invoices.filter((inv) => {
    const pos = String(inv.placeOfSupplyStateCode ?? '').padStart(2, '0');
    return pos !== firmState;
  });

  // Group by place-of-supply
  const groupMap = new Map<string, GstnB2clInv[]>();

  for (const inv of interstateInvoices) {
    const pos = String(inv.placeOfSupplyStateCode ?? '').padStart(2, '0');

    const invRow: GstnB2clInv = {
      inum: inv.voucherNumber ?? '',
      idt: fmtDate(inv.voucherDate),
      val: p2r(inv.grandTotalPaise ?? 0),
      itms: (inv.lineItems ?? []).map((li: any, idx: number) => ({
        num: idx + 1,
        itm_det: {
          txval: p2r(li.taxableValuePaise ?? 0),
          rt: li.taxRate ?? 0,
          iamt: p2r(li.igstPaise ?? 0),
          csamt: p2r(li.cessPaise ?? 0),
        },
      })),
    };

    if (!groupMap.has(pos)) groupMap.set(pos, []);
    groupMap.get(pos)!.push(invRow);
  }

  return Array.from(groupMap.entries()).map(([pos, invArr]) => ({
    pos,
    inv: invArr,
  }));
}
