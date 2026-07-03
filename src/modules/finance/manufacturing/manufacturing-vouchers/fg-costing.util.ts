/**
 * Finished-goods (FG) inventory costing for a completed manufacturing voucher.
 *
 * The completion ledger (actual-cost mode) debits Finished Goods NET of
 * by-product NRV: fgDebit = totalInputCost - sum(byProduct.costAllocatedPaise);
 * the by-products separately re-enter inventory as raw material at their NRV.
 * The FG stock movement must use the same net cost, otherwise the FG inventory
 * layer overstates value by the by-product NRV whenever the BoM has by-products
 * (inventory value != ledger FG debit).
 */

/** Net input cost absorbed by finished goods, clamped at 0. */
export function fgNetInputCostPaise(
  totalInputCostPaise: number,
  byProductNrvPaise: number,
): number {
  return Math.max(0, totalInputCostPaise - byProductNrvPaise);
}

/**
 * Per-unit FG cost for the FG manufacturing_in stock movement, net of
 * by-product NRV. Returns 0 when no units were produced (no divide-by-zero).
 */
export function fgInwardUnitCostPaise(
  totalInputCostPaise: number,
  byProductNrvPaise: number,
  actualFinishedQty: number,
): number {
  if (actualFinishedQty <= 0) return 0;
  return Math.round(
    fgNetInputCostPaise(totalInputCostPaise, byProductNrvPaise) / actualFinishedQty,
  );
}

/**
 * Per-unit standard FG cost from a BoM's batch standard cost. The BoM's
 * standardCostPaise is the cost to produce its outputQty units, so the per-unit
 * standard (what mv.standardFgCostPaise and the completion ledger expect) is
 * that batch cost divided by the output quantity.
 */
export function perUnitStandardCostPaise(
  batchStandardCostPaise: number,
  outputQty: number,
): number {
  if (outputQty <= 0) return 0;
  return Math.round(batchStandardCostPaise / outputQty);
}

/**
 * Per-unit cost for the FG manufacturing_in movement.
 *
 * In standard-cost mode the FG inventory layer is valued at the per-unit
 * standard cost so it matches the completion ledger's FG debit
 * (standardFgCostPaise * actualFinishedQty); the actual-vs-standard difference
 * is absorbed by the variance ledger line. If no standard cost is available it
 * falls back to actual costing. In actual-cost mode it is always the actual cost
 * net of by-product NRV.
 */
export function fgMovementUnitCostPaise(params: {
  costMethod: 'actual' | 'standard';
  totalInputCostPaise: number;
  byProductNrvPaise: number;
  actualFinishedQty: number;
  standardFgCostPaise?: number;
}): number {
  const { costMethod, totalInputCostPaise, byProductNrvPaise, actualFinishedQty } = params;
  if (costMethod === 'standard' && (params.standardFgCostPaise ?? 0) > 0) {
    return params.standardFgCostPaise;
  }
  return fgInwardUnitCostPaise(totalInputCostPaise, byProductNrvPaise, actualFinishedQty);
}
