import { Model, Types, PipelineStage } from 'mongoose';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';

// ─── UQC mapping (shared with EInvoice payload builder) ──────────────────────

const UQC_MAP: Record<string, string> = {
  pcs: 'PCS', piece: 'PCS', pieces: 'PCS', pc: 'PCS',
  mtr: 'MTR', metre: 'MTR', meter: 'MTR', m: 'MTR',
  cm: 'CMS',
  kg: 'KGS', kgs: 'KGS', kilogram: 'KGS',
  gm: 'GMS', gram: 'GMS',
  nos: 'NOS', no: 'NOS', number: 'NOS',
  ltr: 'LTR', litre: 'LTR', liter: 'LTR', l: 'LTR',
  ml: 'MLT',
  box: 'BOX', set: 'SET',
  pair: 'PRS', prs: 'PRS',
  sqmt: 'SQM', sqft: 'SQF', sqyd: 'SQY', mtr2: 'SQM',
  unit: 'UNT', roll: 'ROL', pack: 'PAC',
  bag: 'BAG', bale: 'BAL', drum: 'DRM',
  can: 'CAN', bottle: 'BTL', tube: 'TUB',
  dozen: 'DOZ', gross: 'GRS',
  hour: 'HRS', hrs: 'HRS', day: 'DAY', month: 'MON', year: 'YRS',
  job: 'JOB', lump: 'LSM', ls: 'LSM',
};

function toUQC(unit: string): string {
  return UQC_MAP[(unit ?? '').toLowerCase()] ?? 'NOS';
}

// ─── GSTN HSN output types ───────────────────────────────────────────────────

export interface HsnRow {
  num: number;
  ty: 'B2B' | 'B2C';    // MANDATORY post-May 2025 GSTN notification (RESEARCH Pitfall 2)
  hsn_sc: string;
  desc: string;
  uqc: string;
  qty: number;
  rt: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface HsnSection {
  data: HsnRow[];
}

// ─── Aggregation helper ───────────────────────────────────────────────────────

interface AggResult {
  _id: { hsn: string; unit: string; rate: number };
  qty: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  cess: number;
  desc: string;
}

async function aggregateLineItems(
  model: Model<SaleInvoice>,
  wsId: Types.ObjectId,
  firmId: Types.ObjectId,
  startDate: Date,
  endDate: Date,
  partyGstinFilter: Record<string, any>,
): Promise<AggResult[]> {
  const pipeline: PipelineStage[] = [
    {
      $match: {
        workspaceId: wsId,
        firmId,
        state: 'posted',
        isDeleted: false,
        voucherType: 'sale_invoice',
        voucherDate: { $gte: startDate, $lt: endDate },
        ...partyGstinFilter,
      },
    },
    { $unwind: '$lineItems' },
    {
      $group: {
        _id: {
          hsn: '$lineItems.hsnSacCode',
          unit: '$lineItems.unit',
          rate: '$lineItems.taxRate',
        },
        qty: { $sum: '$lineItems.qty' },
        txval: { $sum: '$lineItems.taxableValuePaise' },
        iamt: { $sum: '$lineItems.igstPaise' },
        camt: { $sum: '$lineItems.cgstPaise' },
        samt: { $sum: '$lineItems.sgstPaise' },
        cess: { $sum: '$lineItems.cessPaise' },
        desc: { $first: '$lineItems.itemName' },
      },
    },
    { $sort: { '_id.hsn': 1, '_id.rate': 1 } },
  ];

  return model.aggregate<AggResult>(pipeline);
}

function p2r(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

// ─── HSN builder — TWO PASSES (mandatory May 2025 GSTN mandate) ──────────────

/**
 * buildHsnSection — HSN-wise summary with MANDATORY B2B/B2C split.
 *
 * Per GSTN May 2025 notification (RESEARCH Pitfall 2), Table 12 of GSTR-1 now
 * requires separate rows for B2B and B2C invoices. Each row carries `ty: 'B2B'`
 * or `ty: 'B2C'` field.
 *
 * Two passes:
 *  Pass 1: B2B invoices (partySnapshot.gstin exists and not empty) → ty='B2B'
 *  Pass 2: B2C invoices (partySnapshot.gstin null/empty) → ty='B2C'
 *
 * Uses $unwind + $group aggregation pipeline (server-side, no full document hydration).
 */
export async function buildHsnSection(deps: {
  saleInvoiceModel: Model<SaleInvoice>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  [key: string]: any;
}): Promise<HsnSection> {
  const { saleInvoiceModel, wsId, firmId, startDate, endDate } = deps;

  // Pass 1: B2B invoices (registered buyers)
  const b2bAgg = await aggregateLineItems(
    saleInvoiceModel,
    wsId,
    firmId,
    startDate,
    endDate,
    { 'partySnapshot.gstin': { $exists: true, $ne: '' } },
  );

  // Pass 2: B2C invoices (unregistered buyers — B2CS + B2CL combined)
  const b2cAgg = await aggregateLineItems(
    saleInvoiceModel,
    wsId,
    firmId,
    startDate,
    endDate,
    {
      $or: [
        { 'partySnapshot.gstin': null },
        { 'partySnapshot.gstin': '' },
        { 'partySnapshot.gstin': { $exists: false } },
      ],
    },
  );

  const rows: HsnRow[] = [];
  let num = 1;

  for (const r of b2bAgg) {
    rows.push({
      num: num++,
      ty: 'B2B',
      hsn_sc: r._id.hsn ?? '',
      desc: r.desc ?? '',
      uqc: toUQC(r._id.unit ?? ''),
      qty: Number((r.qty ?? 0).toFixed(3)),
      rt: r._id.rate ?? 0,
      txval: p2r(r.txval ?? 0),
      iamt: p2r(r.iamt ?? 0),
      camt: p2r(r.camt ?? 0),
      samt: p2r(r.samt ?? 0),
      csamt: p2r(r.cess ?? 0),
    });
  }

  for (const r of b2cAgg) {
    rows.push({
      num: num++,
      ty: 'B2C',
      hsn_sc: r._id.hsn ?? '',
      desc: r.desc ?? '',
      uqc: toUQC(r._id.unit ?? ''),
      qty: Number((r.qty ?? 0).toFixed(3)),
      rt: r._id.rate ?? 0,
      txval: p2r(r.txval ?? 0),
      iamt: p2r(r.iamt ?? 0),
      camt: p2r(r.camt ?? 0),
      samt: p2r(r.samt ?? 0),
      csamt: p2r(r.cess ?? 0),
    });
  }

  return { data: rows };
}
