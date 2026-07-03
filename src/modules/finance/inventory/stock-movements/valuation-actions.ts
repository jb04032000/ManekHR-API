import { MovementType } from './stock-movement.schema';

/**
 * Which valuation side effects a stock movement triggers. Pure so the routing
 * rules are unit-testable without a DB session.
 */
export interface ValuationPlan {
  /** Create a FIFO cost layer in the movement's godown. */
  createFifoLayer: boolean;
  /** Recompute the item-global moving-average cost. */
  recalcMovingAvg: boolean;
  /** Consume FIFO layers (outward, fifo firms, stock bucket). */
  consumeFifoLayers: boolean;
}

const NONE: ValuationPlan = {
  createFifoLayer: false,
  recalcMovingAvg: false,
  consumeFifoLayers: false,
};

/**
 * Movement types that relocate or earmark stock WITHOUT changing the item's
 * cost basis, so they must not touch valuation:
 *  - transfer_in / transfer_out: a godown-to-godown move. Item-total quantity
 *    and value are unchanged, so recalculating the moving average (with the
 *    transfer's cost of 0) or minting a zero-cost FIFO layer corrupts COGS.
 *  - so_reserve / so_release: reservation-only movements (costPaise is 0 by
 *    contract); they earmark stock against a sales order, never re-cost it.
 */
const VALUATION_NEUTRAL: ReadonlySet<MovementType> = new Set<MovementType>([
  'transfer_in',
  'transfer_out',
  'so_reserve',
  'so_release',
]);

export function planValuationActions(params: {
  movementType: MovementType;
  isInward: boolean;
  method: 'fifo' | 'moving_average';
  bucketType: string;
}): ValuationPlan {
  const { movementType, isInward, method, bucketType } = params;

  if (VALUATION_NEUTRAL.has(movementType)) {
    return { ...NONE };
  }

  if (isInward) {
    // Only stock-bucket inwards affect stock valuation. Sample / consignment
    // bucket inwards (e.g. draining a sample bucket on accept) are tracked
    // separately via GodownBalance and must not mint a stock FIFO layer or move
    // the stock moving average. Both methods keep FIFO layers + the moving
    // average in parallel (D-04) for the stock bucket.
    if (bucketType === 'stock') {
      return { createFifoLayer: true, recalcMovingAvg: true, consumeFifoLayers: false };
    }
    return { ...NONE };
  }

  // Outward: only FIFO firms consume layers, and only on the real stock bucket
  // (sample / consignment buckets are tracked separately). Moving-average firms
  // carry the pre-outward snapshot already stamped on the movement.
  if (method === 'fifo' && bucketType === 'stock') {
    return { createFifoLayer: false, recalcMovingAvg: false, consumeFifoLayers: true };
  }

  return { ...NONE };
}
