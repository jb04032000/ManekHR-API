import { Types } from 'mongoose';
import type { CheckDeps } from './index';
import type { VerifyDataFinding } from '../verify-data.schema';

/**
 * C-09 — IRN backlog: posted sale invoices above AATO threshold without IRN generated.
 *
 * RESEARCH Pitfall 9 mitigation: firm.aato is in CRORES — threshold is 5 (not 5_00_00_000).
 *
 * Severity escalation:
 *   - Invoice age 7–25 days without IRN: 'warning'
 *   - Invoice age > 25 days without IRN: 'error' (NIC blocks IRN generation after 30 days)
 */
export async function checkC09(deps: CheckDeps): Promise<VerifyDataFinding[]> {
  const { saleInvoiceModel, firmModel, wsId, firmId, now } = deps;

  // firm.aato is in Crores per RESEARCH Pitfall 9 — threshold is 5 (not 5_00_00_000)
  const firm = await firmModel.findOne({ _id: firmId, workspaceId: wsId }).lean();
  if (!firm || firm.aato <= 5) return [];  // Below e-invoicing threshold; IRN not required

  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const twentyFiveDaysAgo = new Date(now.getTime() - 25 * 86400000);

  // Find invoices older than 7 days that don't have a generated/cancelled IRN
  const invoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      voucherType: 'sale_invoice',
      voucherDate: { $lt: sevenDaysAgo },
      'eInvoice.status': { $nin: ['generated', 'cancelled', 'not_applicable'] },
    })
    .lean();

  return invoices.map((inv): VerifyDataFinding => {
    const voucherDate = inv.voucherDate as Date;
    const daysOld = Math.floor((now.getTime() - voucherDate.getTime()) / 86400000);
    // Severity escalates from warning to error when invoice age > 25 days
    const severity: 'error' | 'warning' = voucherDate < twentyFiveDaysAgo ? 'error' : 'warning';

    return {
      checkId: 'C-09-irn-backlog',
      severity,
      message: `Invoice ${inv.voucherNumber ?? inv._id} above AATO threshold without IRN (${daysOld} days old)${severity === 'error' ? ' — approaching NIC 30-day deadline' : ''}`,
      affectedDocType: 'sale_invoice',
      affectedDocId: inv._id as Types.ObjectId,
      affectedDocNo: inv.voucherNumber,
      affectedPartyId: inv.partyId as Types.ObjectId | undefined,
      fixRoute: `/dashboard/finance/firms/${firmId}/gst/einvoice`,
      scannedAt: now,
    };
  });
}
