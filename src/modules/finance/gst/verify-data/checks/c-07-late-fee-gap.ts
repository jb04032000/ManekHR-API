import { Types } from 'mongoose';
import type { CheckDeps } from './index';
import type { VerifyDataFinding } from '../verify-data.schema';

/**
 * C-07 — Late fee gap: invoice has late-fee schedule enabled but no late-fee
 * ledger entry has been posted for it this period.
 *
 * Detects invoices where:
 *   - lateFeeSchedule.enabled = true
 *   - paymentStatus is 'unpaid' or 'partial'
 *   - dueDate + graceDays is in the past (overdue beyond grace period)
 *   - No LedgerEntry of entryType 'late_fee' exists for this invoice in the period
 *
 * Severity: 'warning' — late fee is not yet accrued; may cause under-billing.
 */
export async function checkC07(deps: CheckDeps): Promise<VerifyDataFinding[]> {
  const { saleInvoiceModel, ledgerEntryModel, wsId, firmId, startDate, endDate, now } = deps;

  // Find overdue invoices with late-fee schedule enabled
  const overdueInvoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      paymentStatus: { $in: ['unpaid', 'partial'] },
      'lateFeeSchedule.enabled': true,
      // dueDate must exist and be in the past
      dueDate: { $lt: now, $exists: true },
    })
    .lean();

  if (!overdueInvoices.length) return [];

  // Check which ones have no late-fee ledger entry in the period
  const overdueInvoiceIds = overdueInvoices.map((inv) => inv._id as Types.ObjectId);

  const existingLateFeeEntries = await ledgerEntryModel
    .find({
      workspaceId: wsId,
      firmId,
      entryType: 'late_fee',
      sourceVoucherId: { $in: overdueInvoiceIds },
      entryDate: { $gte: startDate, $lt: endDate },
    })
    .select('sourceVoucherId')
    .lean();

  const coveredIds = new Set(
    existingLateFeeEntries.map((e) => e.sourceVoucherId.toString()),
  );

  const findings: VerifyDataFinding[] = [];

  for (const inv of overdueInvoices) {
    const invId = (inv._id as Types.ObjectId).toString();
    if (coveredIds.has(invId)) continue;

    // Check grace period: dueDate + graceDays < now
    const graceDays = inv.lateFeeSchedule?.graceDays ?? 0;
    const graceDeadline = new Date(
      (inv.dueDate as Date).getTime() + graceDays * 86400000,
    );
    if (graceDeadline >= now) continue;  // still within grace period

    findings.push({
      checkId: 'C-07-late-fee-gap',
      severity: 'warning',
      message: `Invoice ${inv.voucherNumber ?? inv._id} is overdue (due ${(inv.dueDate as Date).toISOString().slice(0, 10)}) with late-fee schedule enabled but no late-fee entry posted this period`,
      affectedDocType: 'sale_invoice',
      affectedDocId: inv._id as Types.ObjectId,
      affectedDocNo: inv.voucherNumber,
      affectedPartyId: inv.partyId as Types.ObjectId | undefined,
      fixRoute: `/dashboard/finance/firms/${firmId}/sales/invoices/${inv._id}`,
      scannedAt: now,
    });
  }

  return findings;
}
