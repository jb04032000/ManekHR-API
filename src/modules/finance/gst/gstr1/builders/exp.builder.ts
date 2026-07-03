import { Model, Types } from 'mongoose';
import { format } from 'date-fns';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';

// ─── GSTN EXP output types ───────────────────────────────────────────────────

export interface GstnExpItmDet {
  rt: number;
  txval: number;
  iamt: number;
  csamt: number;
}

export interface GstnExpItm {
  num: number;
  itm_det: GstnExpItmDet;
}

export interface GstnExpInv {
  inum: string;
  idt: string;        // DD-MM-YYYY
  val: number;
  sbnum?: string;     // Shipping Bill number
  sbdt?: string;      // Shipping Bill date
  sbpcode?: string;   // Shipping Bill port code
  itms: GstnExpItm[];
}

export interface GstnExpGroup {
  exp_typ: 'WPAY' | 'WOPAY';  // With Payment / Without Payment of tax
  inv: GstnExpInv[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function p2r(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

function fmtDate(d: Date): string {
  return format(d, 'dd-MM-yyyy');
}

// ─── EXP builder ─────────────────────────────────────────────────────────────

/**
 * buildExpSection — Export supplies (WITH payment / WITHOUT payment of tax).
 *
 * Query: SaleInvoice posted where exportType in ['WPAY', 'WOPAY'].
 * Grouped by exportType.
 *
 * WPAY = exports with payment of IGST (taxed exports)
 * WOPAY = exports under LUT/bond (zero-rated without IGST payment)
 */
export async function buildExpSection(deps: {
  saleInvoiceModel: Model<SaleInvoice>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<GstnExpGroup[]> {
  const { saleInvoiceModel, wsId, firmId, startDate, endDate } = deps;

  const invoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherType: 'sale_invoice',
      voucherDate: { $gte: startDate, $lt: endDate },
      exportType: { $in: ['WPAY', 'WOPAY'] },
    })
    .lean();

  const wpayInvs: GstnExpInv[] = [];
  const wopayInvs: GstnExpInv[] = [];

  for (const inv of invoices) {
    const expType = (inv as any).exportType as 'WPAY' | 'WOPAY';
    const shipping = (inv as any).shipping as Record<string, any> | undefined;

    const invRow: GstnExpInv = {
      inum: inv.voucherNumber ?? '',
      idt: fmtDate(inv.voucherDate),
      val: p2r(inv.grandTotalPaise ?? 0),
      sbnum: shipping?.shippingBillNumber,
      sbdt: shipping?.shippingBillDate ? fmtDate(new Date(shipping.shippingBillDate)) : undefined,
      sbpcode: shipping?.portCode,
      itms: (inv.lineItems ?? []).map((li: any, idx: number) => ({
        num: idx + 1,
        itm_det: {
          rt: li.taxRate ?? 0,
          txval: p2r(li.taxableValuePaise ?? 0),
          iamt: p2r(li.igstPaise ?? 0),
          csamt: p2r(li.cessPaise ?? 0),
        },
      })),
    };

    if (expType === 'WPAY') {
      wpayInvs.push(invRow);
    } else {
      wopayInvs.push(invRow);
    }
  }

  const result: GstnExpGroup[] = [];
  if (wpayInvs.length > 0) result.push({ exp_typ: 'WPAY', inv: wpayInvs });
  if (wopayInvs.length > 0) result.push({ exp_typ: 'WOPAY', inv: wopayInvs });

  return result;
}
