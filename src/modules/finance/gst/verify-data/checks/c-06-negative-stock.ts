import type { CheckDeps } from './index';
import type { VerifyDataFinding } from '../verify-data.schema';

/**
 * C-06 — Negative stock detected when firm disallows it.
 *
 * Queries GodownBalance where qty < 0 AND firm.allowNegativeStock = false.
 * Negative stock in this case indicates a data integrity issue — stock was
 * issued beyond available quantity, bypassing the guard.
 *
 * Severity: 'warning' — doesn't directly affect GST filing but may indicate
 * unresolved inventory postings that could affect GSTR-1 valuations.
 */
export async function checkC06(deps: CheckDeps): Promise<VerifyDataFinding[]> {
  const { godownBalanceModel, firmModel, wsId, firmId, now } = deps;

  // Check if firm allows negative stock first (avoid querying GodownBalance for
  // firms that have allowNegativeStock = true)
  const firm = await firmModel.findOne({ _id: firmId, workspaceId: wsId }).lean();
  if (!firm || firm.allowNegativeStock) return [];

  const negativeBalances = await godownBalanceModel
    .find({
      workspaceId: wsId,
      firmId,
      qty: { $lt: 0 },
      bucketType: 'stock',
    })
    .lean();

  return negativeBalances.map((bal): VerifyDataFinding => ({
    checkId: 'C-06-negative-stock',
    severity: 'warning',
    message: `Negative stock detected: item ${bal.itemId} in godown ${bal.godownId} has qty ${bal.qty} — firm does not allow negative stock`,
    affectedDocType: 'godown_balance',
    affectedDocId: bal._id as any,
    fixRoute: `/dashboard/finance/firms/${firmId}/inventory/godowns`,
    scannedAt: now,
  }));
}
