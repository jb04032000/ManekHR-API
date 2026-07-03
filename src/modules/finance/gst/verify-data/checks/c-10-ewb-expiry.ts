import { Types } from 'mongoose';
import type { CheckDeps } from './index';
import type { VerifyDataFinding } from '../verify-data.schema';

/**
 * C-10 — e-Way Bill expiry approaching within 8 hours.
 *
 * Detects active e-Way Bills that will expire within 8 hours of now,
 * on invoices that are not yet paid (still in transit).
 *
 * Severity: 'warning' — user needs to extend EWB before it expires.
 *
 * Note: Does not flag already-expired EWBs (status='expired') — those are
 * historical records. Only flags 'active' EWBs approaching expiry.
 */
export async function checkC10(deps: CheckDeps): Promise<VerifyDataFinding[]> {
  const { saleInvoiceModel, wsId, firmId, now } = deps;

  // Window: validUpto within 8 hours of now (8 * 3600 seconds = 28800000 ms)
  const eightHoursFromNow = new Date(now.getTime() + 8 * 3600 * 1000);

  const expiringInvoices = await saleInvoiceModel
    .find({
      workspaceId: wsId,
      firmId,
      state: 'posted',
      isDeleted: false,
      'ewayBill.status': 'active',
      'ewayBill.validUpto': { $lte: eightHoursFromNow, $gte: now },
      paymentStatus: { $ne: 'paid' },
    })
    .lean();

  return expiringInvoices.map((inv): VerifyDataFinding => {
    const validUpto = inv.ewayBill?.validUpto as Date;
    const minsLeft = Math.floor((validUpto.getTime() - now.getTime()) / 60000);
    const hoursLeft = Math.floor(minsLeft / 60);
    const minsRemainder = minsLeft % 60;
    const timeStr = hoursLeft > 0
      ? `${hoursLeft}h ${minsRemainder}m`
      : `${minsRemainder}m`;

    return {
      checkId: 'C-10-ewb-expiry',
      severity: 'warning',
      message: `e-Way Bill for invoice ${inv.voucherNumber ?? inv._id} expires in ${timeStr} (EWB ${inv.ewayBill?.ewbNo ?? 'unknown'})`,
      affectedDocType: 'sale_invoice',
      affectedDocId: inv._id as Types.ObjectId,
      affectedDocNo: inv.voucherNumber,
      affectedPartyId: inv.partyId as Types.ObjectId | undefined,
      fixRoute: `/dashboard/finance/firms/${firmId}/gst/ewaybill`,
      scannedAt: now,
    };
  });
}
