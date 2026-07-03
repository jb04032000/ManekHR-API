import { Model, Types } from 'mongoose';
import { format } from 'date-fns';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';

// ─── GSTN B2B output types ──────────────────────────────────────────────────

export interface GstnB2bItmDet {
  txval: number;
  rt: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface GstnB2bItm {
  num: number;
  itm_det: GstnB2bItmDet;
}

export interface GstnB2bInv {
  inum: string;
  idt: string; // DD-MM-YYYY  (GSTR-1 dash format, NOT IRP slash format)
  val: number;
  pos: string; // 2-digit state code (zero-padded)
  rchrg: 'Y' | 'N';
  inv_typ: 'R' | 'SEWP' | 'SEWOP' | 'DE';
  itms: GstnB2bItm[];
}

export interface GstnB2bGroup {
  ctin: string;
  inv: GstnB2bInv[];
}

// ─── Builder deps ────────────────────────────────────────────────────────────

export interface BuilderDeps {
  saleInvoiceModel: Model<SaleInvoice>;
  creditNoteModel?: Model<any>;
  debitNoteModel?: Model<any>;
  voucherSeriesModel?: Model<any>;
  advanceReceiptModel?: Model<any>;
  firmModel?: Model<any>;
  partyModel?: Model<any>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  firmGstin?: string;
  firmStateCode?: string;
  startDate: Date;
  endDate: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function p2r(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

function fmtDate(d: Date): string {
  // GSTR-1 uses DD-MM-YYYY with dashes (distinct from IRP which uses DD/MM/YYYY)
  return format(d, 'dd-MM-yyyy');
}

function getInvType(invoice: any): 'R' | 'SEWP' | 'SEWOP' | 'DE' {
  if (invoice.exportType === 'SEWP') return 'SEWP';
  if (invoice.exportType === 'SEWOP') return 'SEWOP';
  if (invoice.exportType === 'DE') return 'DE';
  return 'R';
}

// ─── B2B builder ─────────────────────────────────────────────────────────────

/**
 * buildB2bSection — Invoice-level B2B supplies grouped by buyer GSTIN.
 *
 * Query: SaleInvoice where:
 *  - workspaceId=wsId, firmId, state='posted', isDeleted:false
 *  - voucherType='sale_invoice', voucherDate ∈ [startDate, endDate)
 *  - partySnapshot.gstin exists and not empty (historical fidelity — snapshot, not live party)
 *
 * Groups invoices by partySnapshot.gstin.
 * T-12-W3-08: workspaceId + firmId scoping prevents cross-firm data access.
 */
export async function buildB2bSection(deps: BuilderDeps): Promise<GstnB2bGroup[]> {
  const { saleInvoiceModel, wsId, firmId, startDate, endDate } = deps;

  const invoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherType: 'sale_invoice',
      voucherDate: { $gte: startDate, $lt: endDate },
      'partySnapshot.gstin': { $exists: true, $ne: '' },
    })
    .lean();

  // Group by buyer GSTIN
  const groupMap = new Map<string, GstnB2bInv[]>();

  for (const inv of invoices) {
    const snap = inv.partySnapshot as Record<string, any>;
    const ctin: string = snap?.gstin ?? '';
    if (!ctin) continue;

    const invRow: GstnB2bInv = {
      inum: inv.voucherNumber ?? '',
      idt: fmtDate(inv.voucherDate),
      val: p2r(inv.grandTotalPaise ?? 0),
      pos: String(inv.placeOfSupplyStateCode ?? '').padStart(2, '0'),
      rchrg: inv.isReverseCharge ? 'Y' : 'N',
      inv_typ: getInvType(inv),
      itms: buildItms(inv.lineItems ?? []),
    };

    if (!groupMap.has(ctin)) groupMap.set(ctin, []);
    groupMap.get(ctin).push(invRow);
  }

  return Array.from(groupMap.entries()).map(([ctin, invArr]) => ({
    ctin,
    inv: invArr,
  }));
}

// ─── Line item helper ─────────────────────────────────────────────────────────

function buildItms(lineItems: any[]): GstnB2bItm[] {
  return lineItems.map((li, idx) => ({
    num: idx + 1,
    itm_det: {
      txval: p2r(li.taxableValuePaise ?? 0),
      rt: li.taxRate ?? 0,
      iamt: p2r(li.igstPaise ?? 0),
      camt: p2r(li.cgstPaise ?? 0),
      samt: p2r(li.sgstPaise ?? 0),
      csamt: p2r(li.cessPaise ?? 0),
    },
  }));
}
