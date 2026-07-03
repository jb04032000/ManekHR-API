import { Model, Types } from 'mongoose';
import { format } from 'date-fns';
import type { CreditNote } from '../../../../credit-notes/credit-note.schema';

// ─── GSTN CDNUR output types ─────────────────────────────────────────────────

export interface GstnCdnurItmDet {
  txval: number;
  rt: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface GstnCdnurItm {
  num: number;
  itm_det: GstnCdnurItmDet;
}

export interface GstnCdnurNote {
  ntty: 'C' | 'D'; // C = Credit Note, D = Debit Note
  nt_num: string;
  nt_dt: string; // DD-MM-YYYY
  typ: string; // B2CL or EXPWP/EXPWOP for exports
  p_gst: 'Y' | 'N';
  rsn: string;
  val: number;
  pos: string; // 2-digit state code (no ctin for unregistered)
  itms: GstnCdnurItm[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function p2r(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

function fmtDate(d: Date): string {
  return format(d, 'dd-MM-yyyy');
}

// ─── CDNUR builder ───────────────────────────────────────────────────────────

/**
 * buildCdnurSection — Credit/Debit Notes to UNREGISTERED buyers (gstin null/empty).
 *
 * Similar to CDNR but no `ctin` field. Uses `pos` instead.
 * sourceInvoiceId present required per GSTN spec.
 * Returns flat array (no grouping by ctin since buyers are unregistered).
 */
export async function buildCdnurSection(deps: {
  creditNoteModel: Model<CreditNote>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<GstnCdnurNote[]> {
  const { creditNoteModel, wsId, firmId, startDate, endDate } = deps;

  const creditNotes = await creditNoteModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherDate: { $gte: startDate, $lt: endDate },
      cdnrType: 'cdnur', // unregistered party
      sourceInvoiceId: { $exists: true },
      // D11: financial / commercial credit notes (kasar-vatav) carry no GST adjustment and
      // are NOT reported in GSTR-1 CDNUR.
      isCommercial: { $ne: true },
    })
    .lean();

  return creditNotes.map((cn) => ({
    ntty: 'C' as const,
    nt_num: cn.voucherNumber ?? '',
    nt_dt: fmtDate(cn.voucherDate),
    typ: 'B2CL',
    p_gst: 'N' as const,
    rsn: mapReasonCode(cn.reasonCode),
    val: p2r(cn.grandTotalPaise ?? 0),
    pos: String(cn.placeOfSupplyStateCode ?? '').padStart(2, '0'),
    itms: (cn.lineItems ?? []).map((li: any, idx: number) => ({
      num: idx + 1,
      itm_det: {
        txval: p2r(li.taxableValuePaise ?? 0),
        rt: li.taxRate ?? 0,
        iamt: p2r(li.igstPaise ?? 0),
        camt: p2r(li.cgstPaise ?? 0),
        samt: p2r(li.sgstPaise ?? 0),
        csamt: 0,
      },
    })),
  }));
}

// ─── Reason code mapping ─────────────────────────────────────────────────────

function mapReasonCode(reasonCode?: string): string {
  const map: Record<string, string> = {
    sales_return: '01',
    post_sale_discount: '02',
    deficiency_in_services: '03',
    correction_in_invoice: '04',
    change_in_pos: '05',
    finalization_of_provisional_assessment: '06',
    others: '07',
  };
  return map[reasonCode ?? ''] ?? '07';
}
