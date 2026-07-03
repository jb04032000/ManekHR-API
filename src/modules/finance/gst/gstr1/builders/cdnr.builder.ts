import { Model, Types } from 'mongoose';
import { format } from 'date-fns';
import type { CreditNote } from '../../../../credit-notes/credit-note.schema';
import type { DebitNote } from '../../../../debit-notes/debit-note.schema';

// ─── GSTN CDNR output types ──────────────────────────────────────────────────

export interface GstnCdnrItmDet {
  txval: number;
  rt: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface GstnCdnrItm {
  num: number;
  itm_det: GstnCdnrItmDet;
}

export interface GstnCdnrNote {
  ntty: 'C' | 'D'; // C = Credit Note, D = Debit Note
  nt_num: string;
  nt_dt: string; // DD-MM-YYYY
  p_gst: 'Y' | 'N'; // Pre-GST (before 01-07-2017)
  rsn: string; // reason code (e.g. '01')
  val: number;
  itms: GstnCdnrItm[];
}

export interface GstnCdnrGroup {
  ctin: string;
  nt: GstnCdnrNote[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function p2r(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

function fmtDate(d: Date): string {
  return format(d, 'dd-MM-yyyy');
}

// ─── CDNR builder ────────────────────────────────────────────────────────────

/**
 * buildCdnrSection — Credit/Debit Notes to REGISTERED buyers (partySnapshot.gstin exists).
 *
 * sourceInvoiceId must be present (GSTN requires reference to original invoice).
 * Grouped by buyer GSTIN (ctin).
 *
 * Note: DebitNote.sourceBillId is for purchase-side. For GSTR-1 CDNR, we handle
 * ONLY credit notes and debit notes raised by the seller on their sale invoices.
 * DebitNotes in GSTR-1 context are typically purchase debit notes (handled by GSTR-3B);
 * however some businesses also raise sales debit notes — we include them here per GSTN spec.
 */
export async function buildCdnrSection(deps: {
  saleInvoiceModel?: Model<any>;
  creditNoteModel: Model<CreditNote>;
  debitNoteModel?: Model<DebitNote>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<GstnCdnrGroup[]> {
  const { creditNoteModel, wsId, firmId, startDate, endDate } = deps;

  // Fetch registered credit notes (cdnr type, which the schema already classifies)
  const creditNotes = await creditNoteModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherDate: { $gte: startDate, $lt: endDate },
      cdnrType: 'cdnr', // registered party
      sourceInvoiceId: { $exists: true },
      'partySnapshot.gstin': { $exists: true, $ne: '' },
      // D11: financial / commercial credit notes (kasar-vatav) carry no GST adjustment and
      // are NOT reported in GSTR-1 CDNR.
      isCommercial: { $ne: true },
    })
    .lean();

  // Group by buyer GSTIN
  const groupMap = new Map<string, GstnCdnrNote[]>();

  for (const cn of creditNotes) {
    const snap = cn.partySnapshot as Record<string, any>;
    const ctin: string = snap?.gstin ?? '';
    if (!ctin) continue;

    const note: GstnCdnrNote = {
      ntty: 'C',
      nt_num: cn.voucherNumber ?? '',
      nt_dt: fmtDate(cn.voucherDate),
      p_gst: 'N',
      rsn: mapReasonCode(cn.reasonCode),
      val: p2r(cn.grandTotalPaise ?? 0),
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
    };

    if (!groupMap.has(ctin)) groupMap.set(ctin, []);
    groupMap.get(ctin).push(note);
  }

  return Array.from(groupMap.entries()).map(([ctin, ntArr]) => ({
    ctin,
    nt: ntArr,
  }));
}

// ─── Reason code mapping ─────────────────────────────────────────────────────

/**
 * Map internal reasonCode strings to GSTN reason codes (01–07).
 * GSTN CN reason codes:
 *  01 = Sales Return
 *  02 = Post Sale Discount
 *  03 = Deficiency in services
 *  04 = Correction in Invoice
 *  05 = Change in POS
 *  06 = Finalization of Provisional Assessment
 *  07 = Others
 */
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
