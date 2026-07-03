import { Model, Types } from 'mongoose';

// ─── GSTN AT/ATADJ output types ──────────────────────────────────────────────

export interface GstnAtRow {
  pos: string;          // 2-digit state code
  sply_ty: 'INTRA' | 'INTER';
  rt: number;           // tax rate
  ad_amt: number;       // advance amount (taxable)
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface GstnAtAdjRow {
  pos: string;
  sply_ty: 'INTRA' | 'INTER';
  rt: number;
  ad_amt: number;       // advance adjusted (negative sign per GSTN spec)
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface AtSection {
  at: GstnAtRow[];
  atadj: GstnAtAdjRow[];
}

// ─── AT/ATADJ builder ────────────────────────────────────────────────────────

/**
 * buildAtSection — Advances received (AT) + advances adjusted against invoices (ATADJ).
 *
 * CRITICAL: This single builder returns BOTH arrays.
 * The service MUST unpack them as SEPARATE top-level keys in the GSTR-1 JSON:
 *   at: atPair.at        → "at" key at top-level
 *   atadj: atPair.atadj  → "atadj" key at top-level
 *
 * (Per CONTEXT D-05 and plan must_haves — T-12-W3-13 mitigation)
 *
 * AdvanceReceipt model: if not yet implemented, returns empty arrays (graceful degradation).
 * The advanceReceiptModel is optional in deps (nullable guard below).
 */
export async function buildAtSection(deps: {
  advanceReceiptModel?: Model<any>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  firmStateCode?: string;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<AtSection> {
  const { advanceReceiptModel, wsId, firmId, firmStateCode, startDate, endDate } = deps;

  const at = await buildAdvancesReceived({ advanceReceiptModel, wsId, firmId, firmStateCode, startDate, endDate });
  const atadj = await buildAdvancesAdjusted({ advanceReceiptModel, wsId, firmId, firmStateCode, startDate, endDate });

  return { at, atadj };
}

// ─── Advances received ────────────────────────────────────────────────────────

async function buildAdvancesReceived(deps: {
  advanceReceiptModel?: Model<any>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  firmStateCode?: string;
  startDate: Date;
  endDate: Date;
}): Promise<GstnAtRow[]> {
  const { advanceReceiptModel, wsId, firmId, firmStateCode, startDate, endDate } = deps;

  if (!advanceReceiptModel) return [];

  const firmState = String(firmStateCode ?? '').padStart(2, '0');

  let receipts: any[] = [];
  try {
    receipts = await advanceReceiptModel
      .find({
        workspaceId: wsId,
        firmId,
        state: 'posted',
        isDeleted: false,
        receiptDate: { $gte: startDate, $lt: endDate },
      })
      .lean();
  } catch {
    // AdvanceReceipt collection may not exist yet — return empty gracefully
    return [];
  }

  // Aggregate by (pos, taxRate)
  type AggKey = string;
  const agg = new Map<AggKey, { pos: string; rate: number; ad_amt: number; iamt: number; camt: number; samt: number; csamt: number }>();

  for (const r of receipts) {
    const pos = String(r.placeOfSupplyStateCode ?? r.pos ?? firmState).padStart(2, '0');
    const rate = r.taxRate ?? 0;
    const key: AggKey = `${pos}|${rate}`;
    const existing = agg.get(key) ?? { pos, rate, ad_amt: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    existing.ad_amt += r.taxableValuePaise ?? r.advanceAmountPaise ?? 0;
    existing.iamt += r.igstPaise ?? 0;
    existing.camt += r.cgstPaise ?? 0;
    existing.samt += r.sgstPaise ?? 0;
    existing.csamt += r.cessPaise ?? 0;
    agg.set(key, existing);
  }

  return Array.from(agg.values()).map((row) => ({
    pos: row.pos,
    sply_ty: row.pos === firmState ? 'INTRA' : 'INTER',
    rt: row.rate,
    ad_amt: p2r(row.ad_amt),
    iamt: p2r(row.iamt),
    camt: p2r(row.camt),
    samt: p2r(row.samt),
    csamt: p2r(row.csamt),
  }));
}

// ─── Advances adjusted ────────────────────────────────────────────────────────

async function buildAdvancesAdjusted(deps: {
  advanceReceiptModel?: Model<any>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  firmStateCode?: string;
  startDate: Date;
  endDate: Date;
}): Promise<GstnAtAdjRow[]> {
  const { advanceReceiptModel, wsId, firmId, firmStateCode, startDate, endDate } = deps;

  if (!advanceReceiptModel) return [];

  const firmState = String(firmStateCode ?? '').padStart(2, '0');

  let adjustments: any[] = [];
  try {
    // AdvanceAdjustment = receipts that have been adjusted against invoices in this period
    adjustments = await advanceReceiptModel
      .find({
        workspaceId: wsId,
        firmId,
        state: 'posted',
        isDeleted: false,
        adjustedDate: { $gte: startDate, $lt: endDate },
        adjustedAgainstInvoiceId: { $exists: true },
      })
      .lean();
  } catch {
    return [];
  }

  type AggKey = string;
  const agg = new Map<AggKey, { pos: string; rate: number; ad_amt: number; iamt: number; camt: number; samt: number; csamt: number }>();

  for (const r of adjustments) {
    const pos = String(r.placeOfSupplyStateCode ?? r.pos ?? firmState).padStart(2, '0');
    const rate = r.taxRate ?? 0;
    const key: AggKey = `${pos}|${rate}`;
    const existing = agg.get(key) ?? { pos, rate, ad_amt: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    existing.ad_amt += r.adjustedAmountPaise ?? r.taxableValuePaise ?? 0;
    existing.iamt += r.igstPaise ?? 0;
    existing.camt += r.cgstPaise ?? 0;
    existing.samt += r.sgstPaise ?? 0;
    existing.csamt += r.cessPaise ?? 0;
    agg.set(key, existing);
  }

  return Array.from(agg.values()).map((row) => ({
    pos: row.pos,
    sply_ty: row.pos === firmState ? 'INTRA' : 'INTER',
    rt: row.rate,
    ad_amt: p2r(row.ad_amt),
    iamt: p2r(row.iamt),
    camt: p2r(row.camt),
    samt: p2r(row.samt),
    csamt: p2r(row.csamt),
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function p2r(paise: number): number {
  return Number((paise / 100).toFixed(2));
}
