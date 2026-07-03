import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { PurchaseBill } from '../../purchases/purchase-bill/purchase-bill.schema';
import { Firm } from '../../firms/firm.schema';
import { Gstr3bAdjustment } from './gstr3b-adjustment.schema';
import { netOutward31a, netItc4a } from './gstr3b-netting.util';

// ─── Account code constants ─────────────────────────────────────────────────
const IGST_PAYABLE = '2006';
const CGST_PAYABLE = '2007';
const SGST_PAYABLE = '2008';
const IGST_INPUT = '1100';
const CGST_INPUT = '1101';
const SGST_INPUT = '1102';
// Sales/revenue income account — legacy CoA: credit notes debit this for their
// taxable value when 4009 is not seeded.
const SALES_INCOME = '4001';
// Sales Returns contra-revenue (4009) — modern CoA: credit notes debit this for
// their taxable value (ledger-posting.service.ts #14, falls back to 4001). Both
// codes must be matched + mapped to txval in the 3.1(a) credit-note netting.
const SALES_RETURNS = '4009';

const OUTPUT_TAX_CODES = [IGST_PAYABLE, CGST_PAYABLE, SGST_PAYABLE];
const INPUT_TAX_CODES = [IGST_INPUT, CGST_INPUT, SGST_INPUT];

// ─── GSTR-3B cell key allowlist ────────────────────────────────────────────
const CELL_KEY_PATTERN =
  /^(3\.1\.[abcde]\.(txval|igst|cgst|sgst|cess)|3\.2\.\d{2}\.(unreg|comp|uin)\.(txval|igst)|4A\.[135]\.(igst|cgst|sgst|cess)|4B\.[12]\.(igst|cgst|sgst|cess)|4D\.(igst|cgst|sgst|cess)|5\.(exempt|nil|non_gst|composition)\.(inter|intra)|6\.1\.(igst|cgst|sgst|cess))$/;

// ─── Output types ──────────────────────────────────────────────────────────

export interface TaxCells {
  txval?: number;
  igst: number;
  cgst?: number;
  sgst?: number;
  cess: number;
}

export interface StateEntry {
  stateCode: string;
  txval: number;
  igst: number;
}

export interface Gstr3bAutoReport {
  gstin: string;
  fp: string; // MMYYYY
  sec_3_1_a: { txval: number; igst: number; cgst: number; sgst: number; cess: number };
  sec_3_1_b: { txval: number; igst: number; cess: number };
  sec_3_1_c: { txval: number };
  sec_3_1_d: { txval: number; igst: number; cgst: number; sgst: number; cess: number };
  sec_3_1_e: { txval: number };
  sec_3_2: { to_unreg: StateEntry[]; to_comp: StateEntry[]; to_uin: StateEntry[] };
  sec_4A_1: { igst: number; cess: number };
  sec_4A_3: { igst: number; cgst: number; sgst: number; cess: number };
  sec_4A_5: { igst: number; cgst: number; sgst: number; cess: number };
  sec_4B_1: { igst: number; cgst: number; sgst: number; cess: number };
  sec_4B_2: { igst: number; cgst: number; sgst: number; cess: number };
  sec_4D: { igst: number; cgst: number; sgst: number; cess: number };
  sec_5: {
    // Each supply type split by inter-state vs intra-state (GSTN Table 5 requirement)
    exempt_inter: number;
    exempt_intra: number;
    nil_inter: number;
    nil_intra: number;
    non_gst_inter: number;
    non_gst_intra: number;
    composition_inter: number;
    composition_intra: number;
  };
  sec_6_1: { igst: number; cgst: number; sgst: number; cess: number };
}

export interface MergedCell {
  autoValue: number;
  manualValue: number;
  isManual: boolean;
  nov2025Locked?: boolean;
}

export interface Gstr3bMergedReport {
  auto: Gstr3bAutoReport;
  adjustments: Record<string, number>;
  nov2025Locked: boolean;
  finalValues: Record<string, MergedCell>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decompose period 'MMYYYY' into UTC month-start / month-end bounds.
 * e.g. '042025' → 2025-04-01T00:00:00Z .. 2025-04-30T23:59:59.999Z
 */
function periodToDates(period: string): { startDate: Date; endDate: Date } {
  const mm = parseInt(period.slice(0, 2), 10);
  const yyyy = parseInt(period.slice(2), 10);
  const startDate = new Date(Date.UTC(yyyy, mm - 1, 1));
  const endDate = new Date(Date.UTC(yyyy, mm, 1)); // exclusive upper bound
  return { startDate, endDate };
}

/**
 * Determine if Table 3.2 cells should be flagged nov2025Locked.
 * From Nov 2025 (period >= '112025'), GSTN portal auto-populates 3.2 from GSTR-1.
 * ManekHR still computes the values (for JSON export) but UI shows a lock warning.
 */
function isNov2025Locked(period: string): boolean {
  const mm = parseInt(period.slice(0, 2), 10);
  const yyyy = parseInt(period.slice(2), 10);
  // Nov 2025 = month 11, year 2025; lock all periods after
  return yyyy > 2025 || (yyyy === 2025 && mm >= 11);
}

/** Sum lines in aggregation result by accountCode → value map. */
function sumByCode(
  rows: Array<{ _id: string; total: number }>,
  codeMap: Record<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = codeMap[row._id];
    if (key) out[key] = (out[key] ?? 0) + (row.total ?? 0);
  }
  return out;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class Gstr3bService {
  // Platform-bar observability: shared finance tracer (mirrors Gstr1Service / SaleInvoiceService).
  // computeAuto / getReport / exportJson are read/compute -> spans only.
  // saveAdjustments is a true write -> span + fire-and-forget PostHog event (gst. prefix).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntry>,
    @InjectModel(SaleInvoice.name) private readonly saleInvoiceModel: Model<SaleInvoice>,
    @InjectModel(PurchaseBill.name) private readonly purchaseBillModel: Model<PurchaseBill>,
    @InjectModel(Firm.name) private readonly firmModel: Model<Firm>,
    @InjectModel(Gstr3bAdjustment.name) private readonly adjustmentModel: Model<Gstr3bAdjustment>,
    // @Global PostHogService - fire-and-forget product analytics on the adjustments write only.
    private readonly postHog: PostHogService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Method 1: computeAuto — aggregate LedgerEntry + SaleInvoice + PurchaseBill
  // ──────────────────────────────────────────────────────────────────────────

  async computeAuto(wsId: string, firmId: string, period: string): Promise<Gstr3bAutoReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.computeGstr3bAuto',
      { workspaceId: wsId, firmId, period },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const { startDate, endDate } = periodToDates(period);

        const baseMatch = {
          workspaceId: wsOid,
          firmId: firmOid,
          isReversed: false,
          entryDate: { $gte: startDate, $lt: endDate },
        };

        const firm = await this.firmModel.findOne({ _id: firmOid, workspaceId: wsOid }).lean();
        const gstin = firm?.gstin ?? '';

        // ── 3.1(a) Outward taxable — sale_invoice lines, credit side of tax accounts ──
        const [
          outwardTaxLines,
          outwardTxval,
          zeroRatedInvoices,
          nilExemptAgg,
          rcmInwardLines,
          rcmTxvalAgg,
          nonGstAgg,
          stateBreakdown,
          importItcLines,
          standardItcLines,
          rcmItcLines,
          rule4243Lines,
          sec1705Lines,
          ineligibleAgg,
          exemptInwardAgg,
          lateFeeLines,
          creditNoteAdjLines,
          debitNoteItcReversalLines,
        ] = await Promise.all([
          // 3.1(a) — Tax lines on sale invoices. Exclude export/SEZ invoices: their
          // IGST is zero-rated and belongs in 3.1(b) only — summing it here as well
          // would double-count the output liability (the 3.1(a) taxable-value query
          // below already excludes exports, so the tax side must match).
          this.ledgerEntryModel.aggregate([
            { $match: { ...baseMatch, entryType: 'sale_invoice' } },
            {
              $lookup: {
                from: 'saleinvoices',
                localField: 'sourceVoucherId',
                foreignField: '_id',
                as: 'inv',
              },
            },
            { $unwind: { path: '$inv', preserveNullAndEmptyArrays: false } },
            {
              $match: {
                'inv.exportType': { $nin: ['WPAY', 'WOPAY'] },
                'inv.sez': { $ne: true },
              },
            },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: OUTPUT_TAX_CODES } } },
            { $group: { _id: '$lines.accountCode', total: { $sum: '$lines.credit' } } },
          ]),

          // 3.1(a) — Taxable value from SaleInvoice
          this.saleInvoiceModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: { $ne: true },
                voucherDate: { $gte: startDate, $lt: endDate },
                exportType: { $nin: ['WPAY', 'WOPAY'] },
                sez: { $ne: true },
              },
            },
            { $group: { _id: null, txval: { $sum: '$taxableValuePaise' } } },
          ]),

          // 3.1(b) — Zero-rated: export + SEZ invoices
          this.saleInvoiceModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: { $ne: true },
                voucherDate: { $gte: startDate, $lt: endDate },
                $or: [{ exportType: { $in: ['WPAY', 'WOPAY'] } }, { sez: true }],
              },
            },
            {
              $group: {
                _id: null,
                txval: { $sum: '$taxableValuePaise' },
                igst: { $sum: '$igstPaise' },
                cess: { $sum: '$cessPaise' },
              },
            },
          ]),

          // 3.1(c) — Nil/exempt: sum exemptAmountPaise + nilAmountPaise (if these fields exist)
          this.saleInvoiceModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: { $ne: true },
                voucherDate: { $gte: startDate, $lt: endDate },
              },
            },
            {
              $group: {
                _id: null,
                txval: {
                  $sum: {
                    $add: [
                      { $ifNull: ['$exemptAmountPaise', 0] },
                      { $ifNull: ['$nilAmountPaise', 0] },
                    ],
                  },
                },
              },
            },
          ]),

          // 3.1(d) — RCM output liability: purchase_bill where isReverseCharge=true,
          // CREDIT side of the output payable accounts. This is the self-assessed RCM
          // tax that postPurchaseBill posts (see purchase-bill-rcm.rules); it is a
          // liability the recipient owes, claimed back as ITC in 4A(5).
          this.ledgerEntryModel.aggregate([
            { $match: { ...baseMatch, entryType: 'purchase_bill' } },
            {
              $lookup: {
                from: 'purchasebills',
                localField: 'sourceVoucherId',
                foreignField: '_id',
                as: 'bill',
              },
            },
            { $unwind: { path: '$bill', preserveNullAndEmptyArrays: false } },
            { $match: { 'bill.isReverseCharge': true } },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: OUTPUT_TAX_CODES } } },
            { $group: { _id: '$lines.accountCode', total: { $sum: '$lines.credit' } } },
          ]),

          // 3.1(d) txval — taxable value of reverse-charge inward supplies in the period
          this.purchaseBillModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: { $ne: true },
                voucherDate: { $gte: startDate, $lt: endDate },
                isReverseCharge: true,
              },
            },
            { $group: { _id: null, txval: { $sum: '$taxableValuePaise' } } },
          ]),

          // 3.1(e) — Non-GST outward: sum nonGstAmountPaise
          this.saleInvoiceModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: { $ne: true },
                voucherDate: { $gte: startDate, $lt: endDate },
              },
            },
            {
              $group: {
                _id: null,
                txval: { $sum: { $ifNull: ['$nonGstAmountPaise', 0] } },
              },
            },
          ]),

          // 3.2 — State-wise B2C breakdown (unregistered, composition, UIN)
          this.saleInvoiceModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: { $ne: true },
                voucherDate: { $gte: startDate, $lt: endDate },
                placeOfSupplyStateCode: { $exists: true, $ne: null },
              },
            },
            {
              $group: {
                _id: {
                  stateCode: '$placeOfSupplyStateCode',
                  partyType: {
                    $cond: [
                      { $eq: ['$b2cPartyType', 'composition'] },
                      'comp',
                      {
                        $cond: [{ $eq: ['$b2cPartyType', 'uin'] }, 'uin', 'unreg'],
                      },
                    ],
                  },
                },
                txval: { $sum: '$taxableValuePaise' },
                igst: { $sum: '$igstPaise' },
              },
            },
          ]),

          // 4A(1) — Import IGST: purchase_bill where importFlag=true, debit on 1100
          this.ledgerEntryModel.aggregate([
            { $match: { ...baseMatch, entryType: 'purchase_bill' } },
            {
              $lookup: {
                from: 'purchasebills',
                localField: 'sourceVoucherId',
                foreignField: '_id',
                as: 'bill',
              },
            },
            { $unwind: { path: '$bill', preserveNullAndEmptyArrays: false } },
            { $match: { 'bill.importFlag': true } },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: [IGST_INPUT] } } },
            {
              $group: {
                _id: '$lines.accountCode',
                total: { $sum: '$lines.debit' },
              },
            },
          ]),

          // 4A(3) — Standard ITC: purchase_bill, reverseCharge=false, importFlag=false
          this.ledgerEntryModel.aggregate([
            { $match: { ...baseMatch, entryType: 'purchase_bill' } },
            {
              $lookup: {
                from: 'purchasebills',
                localField: 'sourceVoucherId',
                foreignField: '_id',
                as: 'bill',
              },
            },
            { $unwind: { path: '$bill', preserveNullAndEmptyArrays: false } },
            {
              $match: {
                $or: [
                  { 'bill.isReverseCharge': { $ne: true } },
                  { 'bill.isReverseCharge': { $exists: false } },
                ],
                $and: [
                  {
                    $or: [
                      { 'bill.importFlag': { $ne: true } },
                      { 'bill.importFlag': { $exists: false } },
                    ],
                  },
                ],
              },
            },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: INPUT_TAX_CODES } } },
            {
              $group: {
                _id: '$lines.accountCode',
                total: { $sum: '$lines.debit' },
              },
            },
          ]),

          // 4A(5) — RCM ITC: purchase_bill where reverseCharge=true
          this.ledgerEntryModel.aggregate([
            { $match: { ...baseMatch, entryType: 'purchase_bill' } },
            {
              $lookup: {
                from: 'purchasebills',
                localField: 'sourceVoucherId',
                foreignField: '_id',
                as: 'bill',
              },
            },
            { $unwind: { path: '$bill', preserveNullAndEmptyArrays: false } },
            { $match: { 'bill.isReverseCharge': true } },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: INPUT_TAX_CODES } } },
            {
              $group: {
                _id: '$lines.accountCode',
                total: { $sum: '$lines.debit' },
              },
            },
          ]),

          // 4B(1) — Rule 42/43 reversals: journal entries with narration match
          this.ledgerEntryModel.aggregate([
            {
              $match: {
                ...baseMatch,
                entryType: 'journal',
                narration: { $regex: /rule[_\s]?4[23]/i },
              },
            },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: INPUT_TAX_CODES } } },
            {
              $group: {
                _id: '$lines.accountCode',
                total: { $sum: '$lines.credit' },
              },
            },
          ]),

          // 4B(2) — Sec 17(5) reversals: journal entries with narration match
          this.ledgerEntryModel.aggregate([
            {
              $match: {
                ...baseMatch,
                entryType: 'journal',
                narration: { $regex: /sec[_\s]?17.5|blocked\s*itc/i },
              },
            },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: INPUT_TAX_CODES } } },
            {
              $group: {
                _id: '$lines.accountCode',
                total: { $sum: '$lines.credit' },
              },
            },
          ]),

          // 4D — ITC ineligible: PurchaseBill where itcIneligible flag set
          this.purchaseBillModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: { $ne: true },
                voucherDate: { $gte: startDate, $lt: endDate },
                itcIneligible: true,
              },
            },
            {
              $group: {
                _id: null,
                igst: { $sum: '$igstPaise' },
                cgst: { $sum: '$cgstPaise' },
                sgst: { $sum: '$sgstPaise' },
                cess: { $sum: { $ifNull: ['$cessPaise', 0] } },
              },
            },
          ]),

          // 5 — Exempt inward supply values, split by inter-state vs intra-state
          // CR-04: GSTN Table 5 requires per-supply-type inter/intra split.
          // isIntraState: placeOfSupplyStateCode matches firm stateCode; default intra when unknown.
          this.purchaseBillModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: { $ne: true },
                voucherDate: { $gte: startDate, $lt: endDate },
              },
            },
            {
              $group: {
                _id: null,
                exempt_intra: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$supplyType', 'exempt'] },
                          {
                            $or: [
                              { $eq: ['$placeOfSupplyStateCode', firm?.stateCode ?? ''] },
                              { $not: { $ifNull: ['$placeOfSupplyStateCode', false] } },
                            ],
                          },
                        ],
                      },
                      '$taxableValuePaise',
                      0,
                    ],
                  },
                },
                exempt_inter: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$supplyType', 'exempt'] },
                          { $ifNull: ['$placeOfSupplyStateCode', false] },
                          { $ne: ['$placeOfSupplyStateCode', firm?.stateCode ?? ''] },
                        ],
                      },
                      '$taxableValuePaise',
                      0,
                    ],
                  },
                },
                nil_intra: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$supplyType', 'nil'] },
                          {
                            $or: [
                              { $eq: ['$placeOfSupplyStateCode', firm?.stateCode ?? ''] },
                              { $not: { $ifNull: ['$placeOfSupplyStateCode', false] } },
                            ],
                          },
                        ],
                      },
                      '$taxableValuePaise',
                      0,
                    ],
                  },
                },
                nil_inter: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$supplyType', 'nil'] },
                          { $ifNull: ['$placeOfSupplyStateCode', false] },
                          { $ne: ['$placeOfSupplyStateCode', firm?.stateCode ?? ''] },
                        ],
                      },
                      '$taxableValuePaise',
                      0,
                    ],
                  },
                },
                non_gst_intra: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$supplyType', 'non_gst'] },
                          {
                            $or: [
                              { $eq: ['$placeOfSupplyStateCode', firm?.stateCode ?? ''] },
                              { $not: { $ifNull: ['$placeOfSupplyStateCode', false] } },
                            ],
                          },
                        ],
                      },
                      '$taxableValuePaise',
                      0,
                    ],
                  },
                },
                non_gst_inter: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$supplyType', 'non_gst'] },
                          { $ifNull: ['$placeOfSupplyStateCode', false] },
                          { $ne: ['$placeOfSupplyStateCode', firm?.stateCode ?? ''] },
                        ],
                      },
                      '$taxableValuePaise',
                      0,
                    ],
                  },
                },
                composition_intra: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$supplyType', 'composition'] },
                          {
                            $or: [
                              { $eq: ['$placeOfSupplyStateCode', firm?.stateCode ?? ''] },
                              { $not: { $ifNull: ['$placeOfSupplyStateCode', false] } },
                            ],
                          },
                        ],
                      },
                      '$taxableValuePaise',
                      0,
                    ],
                  },
                },
                composition_inter: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$supplyType', 'composition'] },
                          { $ifNull: ['$placeOfSupplyStateCode', false] },
                          { $ne: ['$placeOfSupplyStateCode', firm?.stateCode ?? ''] },
                        ],
                      },
                      '$taxableValuePaise',
                      0,
                    ],
                  },
                },
              },
            },
          ]),

          // 6.1 — Interest + late fees
          this.ledgerEntryModel.aggregate([
            {
              $match: {
                ...baseMatch,
                entryType: { $in: ['late_fee', 'interest_accrual'] },
              },
            },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: OUTPUT_TAX_CODES } } },
            {
              $group: {
                _id: '$lines.accountCode',
                total: { $sum: '$lines.credit' },
              },
            },
          ]),

          // 3.1(a) credit-note adjustment — GSTN reports 3.1(a) NET of credit notes
          // issued in the period. The CN ledger entry debits Sales Returns (4009),
          // or Sales (4001) on legacy CoAs, for the taxable value and the output-tax
          // accounts (2006/7/8) for the tax it reverses; all are summed here (debit
          // side) and subtracted from 3.1(a). Both revenue codes are matched because
          // a firm's CN debits one or the other (never both); the codeMap maps each
          // to txval so whichever fired nets correctly. Credit notes carry no
          // export/SEZ flag in this system and a zero-rated CN reverses zero tax, so
          // no export split is needed.
          this.ledgerEntryModel.aggregate([
            { $match: { ...baseMatch, entryType: 'credit_note' } },
            { $unwind: '$lines' },
            {
              $match: {
                'lines.accountCode': { $in: [SALES_INCOME, SALES_RETURNS, ...OUTPUT_TAX_CODES] },
              },
            },
            { $group: { _id: '$lines.accountCode', total: { $sum: '$lines.debit' } } },
          ]),

          // 4A(3) debit-note ITC reversal — a purchase debit note (purchase return)
          // reverses the ITC originally claimed by crediting the input-tax accounts
          // (1100/1101/1102). 4A(3) summed only purchase-bill ITC debits, so net
          // available ITC was overstated; these credits are subtracted below.
          // (Capital-goods reversals credit 1103, outside the 4A(3) input codes.)
          this.ledgerEntryModel.aggregate([
            { $match: { ...baseMatch, entryType: 'debit_note' } },
            { $unwind: '$lines' },
            { $match: { 'lines.accountCode': { $in: INPUT_TAX_CODES } } },
            { $group: { _id: '$lines.accountCode', total: { $sum: '$lines.credit' } } },
          ]),
        ]);

        // ── Map account codes to field names ────────────────────────────────────
        const outputCodeMap: Record<string, string> = {
          [IGST_PAYABLE]: 'igst',
          [CGST_PAYABLE]: 'cgst',
          [SGST_PAYABLE]: 'sgst',
        };
        const inputCodeMap: Record<string, string> = {
          [IGST_INPUT]: 'igst',
          [CGST_INPUT]: 'cgst',
          [SGST_INPUT]: 'sgst',
        };

        // ── 3.1(a) ──────────────────────────────────────────────────────────────
        // Gross outward (sale invoices) net of the period's credit notes (GSTN
        // reports 3.1(a) net of CDN). cnAdj maps the CN debit totals: Sales (4001)
        // → taxable value, output-tax codes → tax.
        const outwardTax = sumByCode(outwardTaxLines, outputCodeMap);
        // Map both revenue codes to txval; sumByCode accumulates, so the one the
        // CN actually debited (4009 modern, 4001 legacy) lands in txval.
        const cnAdj = sumByCode(creditNoteAdjLines, {
          ...outputCodeMap,
          [SALES_INCOME]: 'txval',
          [SALES_RETURNS]: 'txval',
        });
        const sec_3_1_a = netOutward31a(
          {
            txval: outwardTxval[0]?.txval ?? 0,
            igst: outwardTax['igst'] ?? 0,
            cgst: outwardTax['cgst'] ?? 0,
            sgst: outwardTax['sgst'] ?? 0,
          },
          {
            txval: cnAdj['txval'] ?? 0,
            igst: cnAdj['igst'] ?? 0,
            cgst: cnAdj['cgst'] ?? 0,
            sgst: cnAdj['sgst'] ?? 0,
          },
        );

        // ── 3.1(b) ──────────────────────────────────────────────────────────────
        const zr = zeroRatedInvoices[0] ?? { txval: 0, igst: 0, cess: 0 };
        const sec_3_1_b = {
          txval: zr.txval ?? 0,
          igst: zr.igst ?? 0,
          cess: zr.cess ?? 0,
        };

        // ── 3.1(c) ──────────────────────────────────────────────────────────────
        const sec_3_1_c = { txval: nilExemptAgg[0]?.txval ?? 0 };

        // ── 3.1(d) ──────────────────────────────────────────────────────────────
        const rcmTax = sumByCode(rcmInwardLines, outputCodeMap);
        const sec_3_1_d = {
          txval: rcmTxvalAgg[0]?.txval ?? 0,
          igst: rcmTax['igst'] ?? 0,
          cgst: rcmTax['cgst'] ?? 0,
          sgst: rcmTax['sgst'] ?? 0,
          cess: 0,
        };

        // ── 3.1(e) ──────────────────────────────────────────────────────────────
        const sec_3_1_e = { txval: nonGstAgg[0]?.txval ?? 0 };

        // ── 3.2 ─────────────────────────────────────────────────────────────────
        const to_unreg: StateEntry[] = [];
        const to_comp: StateEntry[] = [];
        const to_uin: StateEntry[] = [];
        for (const row of stateBreakdown) {
          const entry: StateEntry = {
            stateCode: row._id.stateCode as string,
            txval: row.txval as number,
            igst: row.igst as number,
          };
          const partyType = row._id.partyType as string;
          if (partyType === 'comp') to_comp.push(entry);
          else if (partyType === 'uin') to_uin.push(entry);
          else to_unreg.push(entry);
        }
        const sec_3_2 = { to_unreg, to_comp, to_uin };

        // ── 4A(1) ────────────────────────────────────────────────────────────────
        const importItc = sumByCode(importItcLines, inputCodeMap);
        const sec_4A_1 = { igst: importItc['igst'] ?? 0, cess: 0 };

        // ── 4A(3) ────────────────────────────────────────────────────────────────
        // Standard ITC net of purchase debit-note (purchase return) ITC reversals.
        const stdItc = sumByCode(standardItcLines, inputCodeMap);
        const dnItcReversal = sumByCode(debitNoteItcReversalLines, inputCodeMap);
        const sec_4A_3 = netItc4a(
          { igst: stdItc['igst'] ?? 0, cgst: stdItc['cgst'] ?? 0, sgst: stdItc['sgst'] ?? 0 },
          {
            igst: dnItcReversal['igst'] ?? 0,
            cgst: dnItcReversal['cgst'] ?? 0,
            sgst: dnItcReversal['sgst'] ?? 0,
          },
        );

        // ── 4A(5) ────────────────────────────────────────────────────────────────
        const rcmItc = sumByCode(rcmItcLines, inputCodeMap);
        const sec_4A_5 = {
          igst: rcmItc['igst'] ?? 0,
          cgst: rcmItc['cgst'] ?? 0,
          sgst: rcmItc['sgst'] ?? 0,
          cess: 0,
        };

        // ── 4B(1) ────────────────────────────────────────────────────────────────
        const rev4243 = sumByCode(rule4243Lines, inputCodeMap);
        const sec_4B_1 = {
          igst: rev4243['igst'] ?? 0,
          cgst: rev4243['cgst'] ?? 0,
          sgst: rev4243['sgst'] ?? 0,
          cess: 0,
        };

        // ── 4B(2) ────────────────────────────────────────────────────────────────
        const rev1705 = sumByCode(sec1705Lines, inputCodeMap);
        const sec_4B_2 = {
          igst: rev1705['igst'] ?? 0,
          cgst: rev1705['cgst'] ?? 0,
          sgst: rev1705['sgst'] ?? 0,
          cess: 0,
        };

        // ── 4D ──────────────────────────────────────────────────────────────────
        const inelig = ineligibleAgg[0] ?? { igst: 0, cgst: 0, sgst: 0, cess: 0 };
        const sec_4D = {
          igst: inelig.igst ?? 0,
          cgst: inelig.cgst ?? 0,
          sgst: inelig.sgst ?? 0,
          cess: inelig.cess ?? 0,
        };

        // ── 5 ───────────────────────────────────────────────────────────────────
        // CR-04: split each supply type by inter/intra state for GSTN Table 5
        const exemptInward = exemptInwardAgg[0] ?? {};
        const sec_5 = {
          exempt_inter: exemptInward.exempt_inter ?? 0,
          exempt_intra: exemptInward.exempt_intra ?? 0,
          nil_inter: exemptInward.nil_inter ?? 0,
          nil_intra: exemptInward.nil_intra ?? 0,
          non_gst_inter: exemptInward.non_gst_inter ?? 0,
          non_gst_intra: exemptInward.non_gst_intra ?? 0,
          composition_inter: exemptInward.composition_inter ?? 0,
          composition_intra: exemptInward.composition_intra ?? 0,
        };

        // ── 6.1 ─────────────────────────────────────────────────────────────────
        const lateFee = sumByCode(lateFeeLines, outputCodeMap);
        const sec_6_1 = {
          igst: lateFee['igst'] ?? 0,
          cgst: lateFee['cgst'] ?? 0,
          sgst: lateFee['sgst'] ?? 0,
          cess: 0,
        };

        return {
          gstin,
          fp: period,
          sec_3_1_a,
          sec_3_1_b,
          sec_3_1_c,
          sec_3_1_d,
          sec_3_1_e,
          sec_3_2,
          sec_4A_1,
          sec_4A_3,
          sec_4A_5,
          sec_4B_1,
          sec_4B_2,
          sec_4D,
          sec_5,
          sec_6_1,
        };
      },
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Method 2: getReport — merge auto-compute + adjustments
  // ──────────────────────────────────────────────────────────────────────────

  async getReport(wsId: string, firmId: string, period: string): Promise<Gstr3bMergedReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getGstr3bReport',
      { workspaceId: wsId, firmId, period },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        const [auto, adj] = await Promise.all([
          this.computeAuto(wsId, firmId, period),
          this.adjustmentModel.findOne({ workspaceId: wsOid, firmId: firmOid, period }).lean(),
        ]);

        const adjMap: Record<string, number> = adj?.adjustments ?? {};
        const nov2025Locked = isNov2025Locked(period);

        // Build flat auto-value map from the nested report
        const autoFlat = this._flattenAutoReport(auto, nov2025Locked);

        const finalValues: Record<string, MergedCell> = {};
        for (const [key, autoValue] of Object.entries(autoFlat)) {
          const isManual = key in adjMap;
          const is32 = key.startsWith('3.2.');
          finalValues[key] = {
            autoValue,
            manualValue: isManual ? adjMap[key] : autoValue,
            isManual,
            ...(is32 ? { nov2025Locked } : {}),
          };
        }

        return {
          auto,
          adjustments: adjMap,
          nov2025Locked,
          finalValues,
        };
      },
    );
  }

  /** Flatten nested Gstr3bAutoReport into cell-key → paise map. */
  private _flattenAutoReport(
    auto: Gstr3bAutoReport,
    _nov2025Locked: boolean,
  ): Record<string, number> {
    const flat: Record<string, number> = {};

    flat['3.1.a.txval'] = auto.sec_3_1_a.txval;
    flat['3.1.a.igst'] = auto.sec_3_1_a.igst;
    flat['3.1.a.cgst'] = auto.sec_3_1_a.cgst;
    flat['3.1.a.sgst'] = auto.sec_3_1_a.sgst;
    flat['3.1.a.cess'] = auto.sec_3_1_a.cess;

    flat['3.1.b.txval'] = auto.sec_3_1_b.txval;
    flat['3.1.b.igst'] = auto.sec_3_1_b.igst;
    flat['3.1.b.cess'] = auto.sec_3_1_b.cess;

    flat['3.1.c.txval'] = auto.sec_3_1_c.txval;

    flat['3.1.d.txval'] = auto.sec_3_1_d.txval;
    flat['3.1.d.igst'] = auto.sec_3_1_d.igst;
    flat['3.1.d.cgst'] = auto.sec_3_1_d.cgst;
    flat['3.1.d.sgst'] = auto.sec_3_1_d.sgst;
    flat['3.1.d.cess'] = auto.sec_3_1_d.cess;

    flat['3.1.e.txval'] = auto.sec_3_1_e.txval;

    for (const entry of auto.sec_3_2.to_unreg) {
      flat[`3.2.${entry.stateCode}.unreg.txval`] = entry.txval;
      flat[`3.2.${entry.stateCode}.unreg.igst`] = entry.igst;
    }
    for (const entry of auto.sec_3_2.to_comp) {
      flat[`3.2.${entry.stateCode}.comp.txval`] = entry.txval;
      flat[`3.2.${entry.stateCode}.comp.igst`] = entry.igst;
    }
    for (const entry of auto.sec_3_2.to_uin) {
      flat[`3.2.${entry.stateCode}.uin.txval`] = entry.txval;
      flat[`3.2.${entry.stateCode}.uin.igst`] = entry.igst;
    }

    flat['4A.1.igst'] = auto.sec_4A_1.igst;
    flat['4A.1.cess'] = auto.sec_4A_1.cess;

    flat['4A.3.igst'] = auto.sec_4A_3.igst;
    flat['4A.3.cgst'] = auto.sec_4A_3.cgst;
    flat['4A.3.sgst'] = auto.sec_4A_3.sgst;
    flat['4A.3.cess'] = auto.sec_4A_3.cess;

    flat['4A.5.igst'] = auto.sec_4A_5.igst;
    flat['4A.5.cgst'] = auto.sec_4A_5.cgst;
    flat['4A.5.sgst'] = auto.sec_4A_5.sgst;
    flat['4A.5.cess'] = auto.sec_4A_5.cess;

    flat['4B.1.igst'] = auto.sec_4B_1.igst;
    flat['4B.1.cgst'] = auto.sec_4B_1.cgst;
    flat['4B.1.sgst'] = auto.sec_4B_1.sgst;
    flat['4B.1.cess'] = auto.sec_4B_1.cess;

    flat['4B.2.igst'] = auto.sec_4B_2.igst;
    flat['4B.2.cgst'] = auto.sec_4B_2.cgst;
    flat['4B.2.sgst'] = auto.sec_4B_2.sgst;
    flat['4B.2.cess'] = auto.sec_4B_2.cess;

    flat['4D.igst'] = auto.sec_4D.igst;
    flat['4D.cgst'] = auto.sec_4D.cgst;
    flat['4D.sgst'] = auto.sec_4D.sgst;
    flat['4D.cess'] = auto.sec_4D.cess;

    flat['5.exempt.inter'] = auto.sec_5.exempt_inter;
    flat['5.exempt.intra'] = auto.sec_5.exempt_intra;
    flat['5.nil.inter'] = auto.sec_5.nil_inter;
    flat['5.nil.intra'] = auto.sec_5.nil_intra;
    flat['5.non_gst.inter'] = auto.sec_5.non_gst_inter;
    flat['5.non_gst.intra'] = auto.sec_5.non_gst_intra;
    flat['5.composition.inter'] = auto.sec_5.composition_inter;
    flat['5.composition.intra'] = auto.sec_5.composition_intra;

    flat['6.1.igst'] = auto.sec_6_1.igst;
    flat['6.1.cgst'] = auto.sec_6_1.cgst;
    flat['6.1.sgst'] = auto.sec_6_1.sgst;
    flat['6.1.cess'] = auto.sec_6_1.cess;

    return flat;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Method 3: saveAdjustments — upsert per (wsId, firmId, period)
  // ──────────────────────────────────────────────────────────────────────────

  async saveAdjustments(
    wsId: string,
    firmId: string,
    period: string,
    adjustments: Record<string, number>,
    narration?: string,
    savedBy?: string,
  ): Promise<Gstr3bAdjustment> {
    return withFinanceSpan(
      this.tracer,
      'finance.saveGstr3bAdjustments',
      { workspaceId: wsId, firmId, period },
      async () => {
        // Validate cell keys and paise values (T-12-W3-15 mitigation)
        this.validateAdjustments(adjustments);

        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const savedByOid = savedBy ? new Types.ObjectId(savedBy) : undefined;

        // Upsert pattern per RESEARCH Pitfall 8 — never create() to avoid duplicate key violations
        const saved = (await this.adjustmentModel
          .findOneAndUpdate(
            { workspaceId: wsOid, firmId: firmOid, period },
            {
              $set: {
                adjustments,
                ...(narration !== undefined ? { narration } : {}),
                ...(savedByOid ? { savedBy: savedByOid } : {}),
                savedAt: new Date(),
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          )
          .lean()) as Gstr3bAdjustment;

        // Fire-and-forget product analytics on the successful adjustments write (ids + counts only,
        // never the raw cell values). Skipped automatically when savedBy is absent.
        if (savedBy) {
          this.postHog?.capture({
            distinctId: savedBy,
            event: 'gst.saved_gstr3b_adjustments',
            properties: {
              workspaceId: wsId,
              firmId,
              period,
              cellCount: Object.keys(adjustments).length,
            },
          });
        }

        return saved;
      },
    );
  }

  /**
   * Validate adjustment cell keys and paise integer values.
   * T-12-W3-15 mitigation: reject unknown keys before persistence.
   */
  validateAdjustments(adjustments: Record<string, number>): void {
    for (const [key, value] of Object.entries(adjustments)) {
      if (!CELL_KEY_PATTERN.test(key)) {
        throw new BadRequestException(`Unknown GSTR-3B cell key: ${key}`);
      }
      if (!Number.isInteger(value) || value < 0) {
        throw new BadRequestException(
          `Cell value must be a non-negative integer (paise): ${key} = ${value}`,
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Method 4: exportJson — GSTN-spec GSTR-3B JSON
  // ──────────────────────────────────────────────────────────────────────────

  async exportJson(
    wsId: string,
    firmId: string,
    period: string,
  ): Promise<{ filename: string; payload: object }> {
    return withFinanceSpan(
      this.tracer,
      'finance.exportGstr3bJson',
      { workspaceId: wsId, firmId, period },
      async () => {
        const report = await this.getReport(wsId, firmId, period);
        const { auto } = report;

        // Helper: paise → rupees (2 decimal places as per GSTN spec)
        const toRs = (p: number) => parseFloat((p / 100).toFixed(2));

        // ── sup_details ─────────────────────────────────────────────────────────
        const sup_details = {
          osup_det: {
            txval: toRs(auto.sec_3_1_a.txval),
            iamt: toRs(auto.sec_3_1_a.igst),
            camt: toRs(auto.sec_3_1_a.cgst),
            samt: toRs(auto.sec_3_1_a.sgst),
            csamt: toRs(auto.sec_3_1_a.cess),
          },
          osup_zero: {
            txval: toRs(auto.sec_3_1_b.txval),
            iamt: toRs(auto.sec_3_1_b.igst),
            csamt: toRs(auto.sec_3_1_b.cess),
          },
          osup_nil_exmp: {
            txval: toRs(auto.sec_3_1_c.txval),
          },
          isup_rev: {
            txval: toRs(auto.sec_3_1_d.txval),
            iamt: toRs(auto.sec_3_1_d.igst),
            camt: toRs(auto.sec_3_1_d.cgst),
            samt: toRs(auto.sec_3_1_d.sgst),
            csamt: toRs(auto.sec_3_1_d.cess),
          },
          osup_nongst: {
            txval: toRs(auto.sec_3_1_e.txval),
          },
        };

        // ── inter_sup (Table 3.2) ────────────────────────────────────────────────
        const inter_sup = {
          unreg_details: auto.sec_3_2.to_unreg.map((e) => ({
            pos: e.stateCode,
            txval: toRs(e.txval),
            iamt: toRs(e.igst),
          })),
          comp_details: auto.sec_3_2.to_comp.map((e) => ({
            pos: e.stateCode,
            txval: toRs(e.txval),
            iamt: toRs(e.igst),
          })),
          uin_details: auto.sec_3_2.to_uin.map((e) => ({
            pos: e.stateCode,
            txval: toRs(e.txval),
            iamt: toRs(e.igst),
          })),
        };

        // ── itc_elg (Table 4) ────────────────────────────────────────────────────
        const itc_avl = [
          {
            ty: 'IMPG',
            iamt: toRs(auto.sec_4A_1.igst),
            csamt: toRs(auto.sec_4A_1.cess),
          },
          {
            ty: 'ISRC',
            iamt: toRs(auto.sec_4A_3.igst),
            camt: toRs(auto.sec_4A_3.cgst),
            samt: toRs(auto.sec_4A_3.sgst),
            csamt: toRs(auto.sec_4A_3.cess),
          },
          {
            ty: 'RCM',
            iamt: toRs(auto.sec_4A_5.igst),
            camt: toRs(auto.sec_4A_5.cgst),
            samt: toRs(auto.sec_4A_5.sgst),
            csamt: toRs(auto.sec_4A_5.cess),
          },
        ];

        const itc_rev = [
          {
            ty: 'RUL',
            iamt: toRs(auto.sec_4B_1.igst),
            camt: toRs(auto.sec_4B_1.cgst),
            samt: toRs(auto.sec_4B_1.sgst),
            csamt: toRs(auto.sec_4B_1.cess),
          },
          {
            ty: 'OTH',
            iamt: toRs(auto.sec_4B_2.igst),
            camt: toRs(auto.sec_4B_2.cgst),
            samt: toRs(auto.sec_4B_2.sgst),
            csamt: toRs(auto.sec_4B_2.cess),
          },
        ];

        const itc_net = {
          iamt: toRs(
            auto.sec_4A_1.igst +
              auto.sec_4A_3.igst +
              auto.sec_4A_5.igst -
              auto.sec_4B_1.igst -
              auto.sec_4B_2.igst,
          ),
          camt: toRs(
            auto.sec_4A_3.cgst + auto.sec_4A_5.cgst - auto.sec_4B_1.cgst - auto.sec_4B_2.cgst,
          ),
          samt: toRs(
            auto.sec_4A_3.sgst + auto.sec_4A_5.sgst - auto.sec_4B_1.sgst - auto.sec_4B_2.sgst,
          ),
          csamt: toRs(
            auto.sec_4A_1.cess +
              auto.sec_4A_3.cess +
              auto.sec_4A_5.cess -
              auto.sec_4B_1.cess -
              auto.sec_4B_2.cess,
          ),
        };

        const itc_inelg = [
          {
            ty: 'ITC',
            iamt: toRs(auto.sec_4D.igst),
            camt: toRs(auto.sec_4D.cgst),
            samt: toRs(auto.sec_4D.sgst),
            csamt: toRs(auto.sec_4D.cess),
          },
        ];

        const itc_elg = { itc_avl, itc_rev, itc_net, itc_inelg };

        // ── inward_sup (Table 5) ──────────────────────────────────────────────────
        // CR-04: GSTN GSTR-3B JSON schema v3.1 requires isup_details as an array
        // with four separate rows keyed by supply type (ty field).
        // Each row has inter and intra amounts in rupees (paise converted once here).
        const inward_sup = {
          isup_details: [
            {
              ty: 'GST',
              inter: toRs(auto.sec_5.exempt_inter),
              intra: toRs(auto.sec_5.exempt_intra),
            },
            {
              ty: 'NONGST',
              inter: toRs(auto.sec_5.non_gst_inter),
              intra: toRs(auto.sec_5.non_gst_intra),
            },
            {
              ty: 'NILSUP',
              inter: toRs(auto.sec_5.nil_inter),
              intra: toRs(auto.sec_5.nil_intra),
            },
            {
              ty: 'COMPOSI',
              inter: toRs(auto.sec_5.composition_inter),
              intra: toRs(auto.sec_5.composition_intra),
            },
          ],
        };

        // ── intr_ltfee (Table 6.1) ───────────────────────────────────────────────
        const intr_ltfee = {
          intr_details: { iamt: 0, camt: 0, samt: 0, csamt: 0 }, // interest — placeholder (set to 0 if no interest_accrual entries separated)
          ltfee_details: {
            iamt: toRs(auto.sec_6_1.igst),
            camt: toRs(auto.sec_6_1.cgst),
            samt: toRs(auto.sec_6_1.sgst),
            csamt: toRs(auto.sec_6_1.cess),
          },
        };

        const payload = {
          gstin: auto.gstin,
          ret_period: period,
          sup_details,
          inter_sup,
          itc_elg,
          inward_sup,
          intr_ltfee,
        };

        const filename = `GSTR3B_${auto.gstin}_${period}.json`;

        return { filename, payload };
      },
    );
  }
}
