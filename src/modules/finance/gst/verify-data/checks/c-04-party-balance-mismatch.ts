import { Types } from 'mongoose';
import type { CheckDeps } from './index';
import type { VerifyDataFinding } from '../verify-data.schema';

/**
 * C-04 — Party ledger balance mismatch.
 *
 * RESEARCH Pitfall 6 mitigation: Single $unwind + $group aggregation pipeline
 * (not per-party iteration) to compute ledger balances for all parties in one pass.
 *
 * Computes: running debit−credit balance per party from LedgerEntry lines.
 * Flags parties where balance delta vs outstanding receivables > ₹1 (100 paise).
 *
 * Severity: 'warning' — balance discrepancies may indicate posting errors.
 */
export async function checkC04(deps: CheckDeps): Promise<VerifyDataFinding[]> {
  const { ledgerEntryModel, saleInvoiceModel, wsId, firmId, endDate, now } = deps;

  // Single $unwind+$group aggregation — Pitfall 6: never iterate per party
  const ledgerBalances: Array<{ _id: Types.ObjectId; balance: number }> =
    await ledgerEntryModel.aggregate([
      {
        $match: {
          workspaceId: wsId,
          firmId,
          isReversed: false,
          entryDate: { $lte: endDate },
        },
      },
      { $unwind: '$lines' },
      {
        $match: {
          'lines.partyId': { $exists: true, $ne: null },
        },
      },
      {
        $group: {
          _id: '$lines.partyId',
          balance: {
            $sum: { $subtract: ['$lines.debit', '$lines.credit'] },
          },
        },
      },
    ]);

  if (!ledgerBalances.length) return [];

  // Build a map of partyId → ledger balance
  const balanceMap = new Map<string, number>();
  for (const row of ledgerBalances) {
    balanceMap.set(row._id.toString(), row.balance);
  }

  // Query outstanding receivables from SaleInvoice (unpaid + partial)
  const outstandingInvoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      paymentStatus: { $in: ['unpaid', 'partial'] },
      voucherDate: { $lte: endDate },
    })
    .select('partyId amountDuePaise')
    .lean();

  // Sum outstanding per party
  const outstandingMap = new Map<string, number>();
  for (const inv of outstandingInvoices) {
    if (!inv.partyId) continue;
    const key = inv.partyId.toString();
    outstandingMap.set(key, (outstandingMap.get(key) ?? 0) + (inv.amountDuePaise ?? 0));
  }

  const findings: VerifyDataFinding[] = [];

  // Compare ledger balance vs outstanding — flag when delta > 100 paise (₹1)
  for (const [partyKey, outstanding] of outstandingMap) {
    const ledgerBalance = balanceMap.get(partyKey) ?? 0;
    const delta = Math.abs(ledgerBalance - outstanding);
    if (delta > 100) {
      findings.push({
        checkId: 'C-04-party-balance-mismatch',
        severity: 'warning',
        message: `Party balance mismatch: ledger shows ₹${(ledgerBalance / 100).toFixed(2)} outstanding but invoice records show ₹${(outstanding / 100).toFixed(2)} (delta ₹${(delta / 100).toFixed(2)})`,
        affectedDocType: 'party',
        affectedDocId: new Types.ObjectId(partyKey),
        fixRoute: `/dashboard/finance/firms/${firmId}/parties/${partyKey}/ledger`,
        scannedAt: now,
      });
    }
  }

  return findings;
}
