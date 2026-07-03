import { Model, Types } from 'mongoose';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';
import type { CreditNote } from '../../../../credit-notes/credit-note.schema';
import type { DebitNote } from '../../../../debit-notes/debit-note.schema';
import type { Firm } from '../../../../firms/firm.schema';
import type { Party } from '../../../../parties/party.schema';
import type { VerifyDataFinding } from '../../verify-data/verify-data.schema';

// ─── Check dependency bundle ──────────────────────────────────────────────────

export interface CommonCheckDeps {
  saleInvoiceModel: Model<SaleInvoice>;
  creditNoteModel: Model<CreditNote>;
  debitNoteModel: Model<DebitNote>;
  firmModel: Model<Firm>;
  partyModel: Model<Party>;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  now: Date;
}

// ─── C-01: Missing GSTIN on B2B invoices ─────────────────────────────────────

/**
 * checkC01Common — Missing GSTIN on B2B invoices.
 *
 * Detects: SaleInvoice posted in period where taxes are charged (igst > 0 OR cgst > 0)
 * but partySnapshot.gstin is null/empty. This means the invoice should have been
 * classified B2B but is missing the buyer's GSTIN.
 *
 * Severity: 'error' — GSTN rejects B2B invoices without buyer GSTIN.
 *
 * Re-used by Plan 12-06 (Verify-My-Data) — DO NOT RE-IMPLEMENT there.
 */
export async function checkC01Common(deps: CommonCheckDeps): Promise<VerifyDataFinding[]> {
  const { saleInvoiceModel, wsId, firmId, startDate, endDate, now } = deps;

  const invoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherDate: { $gte: startDate, $lt: endDate },
      // IGST > 0 (interstate B2B) or CGST > 0 (intrastate B2B)
      $or: [
        { igstPaise: { $gt: 0 } },
        { cgstPaise: { $gt: 0 } },
      ],
      // Missing GSTIN in snapshot
      $and: [
        {
          $or: [
            { 'partySnapshot.gstin': null },
            { 'partySnapshot.gstin': '' },
            { 'partySnapshot.gstin': { $exists: false } },
          ],
        },
      ],
    })
    .lean();

  return invoices.map((inv): VerifyDataFinding => ({
    checkId: 'C-01-missing-gstin',
    severity: 'error',
    message: `Invoice ${inv.voucherNumber ?? inv._id} has tax charges but missing buyer GSTIN — will not appear in B2B section`,
    affectedDocType: 'sale_invoice',
    affectedDocId: inv._id as Types.ObjectId,
    affectedDocNo: inv.voucherNumber,
    affectedPartyId: inv.partyId as Types.ObjectId | undefined,
    fixRoute: `/dashboard/finance/sales/invoices/${inv._id}`,
    scannedAt: now,
  }));
}

// ─── C-02: Place-of-supply mismatch ──────────────────────────────────────────

/**
 * checkC02Common — POS mismatch.
 *
 * Detects two flavours:
 * 1. Registered party: placeOfSupplyStateCode !== partySnapshot.gstin[0:2]
 *    (POS must match buyer state per GST rules unless specified otherwise)
 * 2. Interstate charge (igst > 0) but POS == firm state code
 *    (if IGST is charged, supply must be to a different state than firm)
 *
 * Severity: 'error'.
 *
 * Re-used by Plan 12-06.
 */
export async function checkC02Common(deps: CommonCheckDeps): Promise<VerifyDataFinding[]> {
  const { saleInvoiceModel, firmModel, wsId, firmId, startDate, endDate, now } = deps;

  const [invoices, firm] = await Promise.all([
    saleInvoiceModel
      .find({
        workspaceId: wsId,
        firmId,
        state: 'posted',
        isDeleted: false,
        voucherDate: { $gte: startDate, $lt: endDate },
      })
      .lean(),
    firmModel.findOne({ _id: firmId, workspaceId: wsId }).lean(),
  ]);

  if (!firm) return [];

  const firmStateCode = String(firm.gstin?.slice(0, 2) ?? '').padStart(2, '0');
  const findings: VerifyDataFinding[] = [];

  for (const inv of invoices) {
    const snap = inv.partySnapshot as Record<string, any> | undefined;
    const pos = String(inv.placeOfSupplyStateCode ?? '').padStart(2, '0');

    // Flavour 1: registered party — POS should match buyer state (first 2 chars of GSTIN)
    if (snap?.gstin) {
      const buyerState = String(snap.gstin).slice(0, 2).padStart(2, '0');
      if (pos && buyerState && pos !== buyerState) {
        findings.push({
          checkId: 'C-02-pos-mismatch',
          severity: 'error',
          message: `Invoice ${inv.voucherNumber ?? inv._id}: POS ${pos} does not match buyer state ${buyerState} from GSTIN`,
          affectedDocType: 'sale_invoice',
          affectedDocId: inv._id as Types.ObjectId,
          affectedDocNo: inv.voucherNumber,
          affectedPartyId: inv.partyId as Types.ObjectId | undefined,
          fixRoute: `/dashboard/finance/sales/invoices/${inv._id}`,
          scannedAt: now,
        });
        continue;
      }
    }

    // Flavour 2: IGST charged but POS == firm state (intrastate shouldn't have IGST)
    if ((inv.igstPaise ?? 0) > 0 && pos === firmStateCode) {
      findings.push({
        checkId: 'C-02-pos-mismatch',
        severity: 'error',
        message: `Invoice ${inv.voucherNumber ?? inv._id}: IGST charged but POS ${pos} matches firm state — should use CGST+SGST`,
        affectedDocType: 'sale_invoice',
        affectedDocId: inv._id as Types.ObjectId,
        affectedDocNo: inv.voucherNumber,
        affectedPartyId: inv.partyId as Types.ObjectId | undefined,
        fixRoute: `/dashboard/finance/sales/invoices/${inv._id}`,
        scannedAt: now,
      });
    }
  }

  return findings;
}

// ─── C-03: Missing/short HSN ─────────────────────────────────────────────────

/**
 * checkC03Common — Missing or insufficiently short HSN codes.
 *
 * - Missing HSN (null/empty): 'error' — GSTN rejects rows with no HSN.
 * - 4-digit HSN when firm.aato > 5 Crores: 'warning' — GSTN mandates 6-digit HSN for higher turnover.
 *   NOTE: firm.aato is in CRORES (per RESEARCH Pitfall 9) — NOT paise, NOT rupees.
 *
 * Re-used by Plan 12-06.
 */
export async function checkC03Common(deps: CommonCheckDeps): Promise<VerifyDataFinding[]> {
  const { saleInvoiceModel, firmModel, wsId, firmId, startDate, endDate, now } = deps;

  const [invoices, firm] = await Promise.all([
    saleInvoiceModel
      .find({
        workspaceId: wsId,
        firmId,
        state: 'posted',
        isDeleted: false,
        voucherDate: { $gte: startDate, $lt: endDate },
      })
      .lean(),
    firmModel.findOne({ _id: firmId, workspaceId: wsId }).lean(),
  ]);

  if (!firm) return [];

  // firm.aato is in Crores per RESEARCH Pitfall 9 — threshold is 5 Crores
  const highTurnover = (firm.aato ?? 0) > 5;
  const findings: VerifyDataFinding[] = [];

  for (const inv of invoices) {
    for (const li of (inv.lineItems ?? []) as any[]) {
      const hsn = String(li.hsnSacCode ?? '').trim();

      if (!hsn) {
        findings.push({
          checkId: 'C-03-missing-hsn',
          severity: 'error',
          message: `Invoice ${inv.voucherNumber ?? inv._id}: line item "${li.itemName ?? ''}" has no HSN/SAC code`,
          affectedDocType: 'sale_invoice',
          affectedDocId: inv._id as Types.ObjectId,
          affectedDocNo: inv.voucherNumber,
          affectedPartyId: inv.partyId as Types.ObjectId | undefined,
          fixRoute: `/dashboard/finance/sales/invoices/${inv._id}`,
          scannedAt: now,
        });
      } else if (highTurnover && hsn.length === 4) {
        findings.push({
          checkId: 'C-03-short-hsn',
          severity: 'warning',
          message: `Invoice ${inv.voucherNumber ?? inv._id}: line item "${li.itemName ?? ''}" uses 4-digit HSN but firm AATO > ₹5 Cr (6-digit required)`,
          affectedDocType: 'sale_invoice',
          affectedDocId: inv._id as Types.ObjectId,
          affectedDocNo: inv.voucherNumber,
          affectedPartyId: inv.partyId as Types.ObjectId | undefined,
          fixRoute: `/dashboard/finance/sales/invoices/${inv._id}`,
          scannedAt: now,
        });
      }
    }
  }

  return findings;
}

// ─── C-05: CN/DN without sourceInvoiceId ─────────────────────────────────────

/**
 * checkC05Common — Credit/Debit Notes without sourceInvoiceId.
 *
 * GSTN requires every CN/DN to reference the original invoice (Table 9B/9A).
 * Without sourceInvoiceId, the CDNR/CDNUR builder will produce invalid rows.
 *
 * Severity: 'error'.
 *
 * Re-used by Plan 12-06.
 */
export async function checkC05Common(deps: CommonCheckDeps): Promise<VerifyDataFinding[]> {
  const { creditNoteModel, wsId, firmId, startDate, endDate, now } = deps;

  const creditNotes = await creditNoteModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherDate: { $gte: startDate, $lt: endDate },
      $or: [
        { sourceInvoiceId: null },
        { sourceInvoiceId: { $exists: false } },
      ],
    })
    .lean();

  return creditNotes.map((cn): VerifyDataFinding => ({
    checkId: 'C-05-cdnr-no-source',
    severity: 'error',
    message: `Credit note ${cn.voucherNumber ?? cn._id} has no source invoice reference — will be excluded from CDNR/CDNUR section`,
    affectedDocType: 'credit_note',
    affectedDocId: cn._id as Types.ObjectId,
    affectedDocNo: cn.voucherNumber,
    affectedPartyId: cn.partyId as Types.ObjectId | undefined,
    fixRoute: `/dashboard/finance/credit-notes/${cn._id}`,
    scannedAt: now,
  }));
}

// ─── C-08: CGST+SGST rounding delta ──────────────────────────────────────────

/**
 * checkC08Common — Intrastate invoices where |CGST - SGST| > 1 paise.
 *
 * CGST and SGST must always be equal on intrastate supplies. A delta > 1 paise
 * indicates a rounding error in the voucher calculation engine.
 *
 * Severity: 'warning' — GSTN may flag but won't necessarily reject.
 *
 * Re-used by Plan 12-06.
 */
export async function checkC08Common(deps: CommonCheckDeps): Promise<VerifyDataFinding[]> {
  const { saleInvoiceModel, wsId, firmId, startDate, endDate, now } = deps;

  const invoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherDate: { $gte: startDate, $lt: endDate },
      // Only intrastate invoices have CGST+SGST (not IGST)
      igstPaise: { $eq: 0 },
      $expr: {
        $gt: [
          { $abs: { $subtract: ['$cgstPaise', '$sgstPaise'] } },
          1,
        ],
      },
    })
    .lean();

  return invoices.map((inv): VerifyDataFinding => ({
    checkId: 'C-08-cgst-sgst-delta',
    severity: 'warning',
    message: `Invoice ${inv.voucherNumber ?? inv._id}: CGST (${inv.cgstPaise}p) ≠ SGST (${inv.sgstPaise}p) by more than 1 paise — recalculate`,
    affectedDocType: 'sale_invoice',
    affectedDocId: inv._id as Types.ObjectId,
    affectedDocNo: inv.voucherNumber,
    affectedPartyId: inv.partyId as Types.ObjectId | undefined,
    fixRoute: `/dashboard/finance/sales/invoices/${inv._id}`,
    scannedAt: now,
  }));
}
