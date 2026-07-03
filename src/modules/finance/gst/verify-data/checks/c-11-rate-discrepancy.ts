import { Types } from 'mongoose';
import type { CheckDeps } from './index';
import type { VerifyDataFinding } from '../verify-data.schema';

/**
 * C-11 — GST rate discrepancy (closes phase success criterion #5).
 *
 * Compares the charged GST rate on each line item against the historical
 * applicable rate from GstRateHistoryService.getRateAsOf(hsnCode, voucherDate).
 *
 * Tolerance: > 0.5% absolute difference (filters rounding noise across composite
 * rates, allows for minor discrepancies from rate blending).
 *
 * Note: Returns null from getRateAsOf when no rate-history coverage found →
 * those line items are skipped (don't flag what we can't verify).
 *
 * WR-09: Batching strategy — collect all unique (hsn, txnDate) pairs from the
 * full invoice batch first, resolve each pair exactly once via getRateAsOf,
 * build an in-memory lookup map, then resolve each line item without additional
 * DB calls. This reduces worst-case N×M sequential queries to unique_pairs queries
 * (typically much smaller: same period date, limited HSN variety per firm).
 *
 * Severity: 'warning' — prompts user review without blocking filing.
 */
export async function checkC11(deps: CheckDeps): Promise<VerifyDataFinding[]> {
  const { saleInvoiceModel, gstRateHistoryService, wsId, firmId, startDate, endDate, now } = deps;

  const findings: VerifyDataFinding[] = [];

  // Pull all posted sale invoices in the period
  const invoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherType: 'sale_invoice',
      voucherDate: { $gte: startDate, $lt: endDate },
    })
    .lean();

  // ── WR-09: Batch phase — collect unique (hsn, txnDate) pairs ────────────────
  const uniquePairs = new Map<string, { hsn: string; txnDate: Date }>();
  for (const inv of invoices) {
    for (const item of (inv.lineItems ?? []) as any[]) {
      const hsn: string | undefined = item.hsnSacCode;
      const charged: number | undefined = item.taxRate;
      if (!hsn || charged == null) continue;
      const dateKey = (inv.voucherDate as Date).toISOString().slice(0, 10);
      const pairKey = `${hsn}|${dateKey}`;
      if (!uniquePairs.has(pairKey)) {
        uniquePairs.set(pairKey, { hsn, txnDate: inv.voucherDate as Date });
      }
    }
  }

  // ── Resolve all unique pairs in parallel (bounded by unique HSN×date count) ──
  const rateCache = new Map<string, number | null>();
  await Promise.all(
    Array.from(uniquePairs.entries()).map(async ([pairKey, { hsn, txnDate }]) => {
      const historical = await gstRateHistoryService.getRateAsOf(hsn, txnDate);
      rateCache.set(pairKey, historical ? historical.igstRate : null);
    }),
  );

  // ── Check phase — resolve from cache, no additional DB calls ─────────────────
  for (const inv of invoices) {
    for (const item of (inv.lineItems ?? []) as any[]) {
      const hsn: string | undefined = item.hsnSacCode;
      const charged: number | undefined = item.taxRate;
      if (!hsn || charged == null) continue;

      const dateKey = (inv.voucherDate as Date).toISOString().slice(0, 10);
      const pairKey = `${hsn}|${dateKey}`;
      const historicalRate = rateCache.get(pairKey);

      if (historicalRate == null) continue; // no rate-history coverage → skip; don't flag

      if (Math.abs(charged - historicalRate) > 0.5) {
        findings.push({
          checkId: 'C-11-rate-discrepancy',
          severity: 'warning',
          message: `GST rate mismatch on invoice ${inv.voucherNumber ?? inv._id}: line item HSN ${hsn} charges ${charged}% but rate history shows ${historicalRate}% as of ${dateKey}`,
          affectedDocType: 'sale_invoice',
          affectedDocId: inv._id as Types.ObjectId,
          affectedDocNo: inv.voucherNumber,
          affectedPartyId: inv.partyId as Types.ObjectId | undefined,
          fixRoute: `/dashboard/finance/firms/${firmId}/sales/invoices/${inv._id}`,
          scannedAt: now,
        });
      }
    }
  }

  return findings;
}
