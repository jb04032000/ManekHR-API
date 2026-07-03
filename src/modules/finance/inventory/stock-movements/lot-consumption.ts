import { MovementType } from './stock-movement.schema';

/**
 * Movement types that relocate or earmark stock without consuming a lot, so they
 * must NOT change a lot's remaining quantity:
 *  - transfer_in / transfer_out: a godown-to-godown move relocates the physical
 *    batch. The pair references the same lot, so decrementing the out leg (and
 *    not the in leg) would understate a lot that was merely moved.
 *  - so_reserve / so_release: reservation-only movements earmark stock against a
 *    sales order; no goods physically leave, so the lot is untouched.
 */
const LOT_NEUTRAL: ReadonlySet<MovementType> = new Set<MovementType>([
  'transfer_in',
  'transfer_out',
  'so_reserve',
  'so_release',
]);

/**
 * Whether an outward stock movement consumes a lot's remaining quantity.
 *
 * Lot.qtyRemaining must drop on genuine outward consumption (sale, delivery,
 * wastage, purchase return, manufacturing issue) so empty lots become
 * soft-deletable and the lot drill-down reflects reality. This is lot-level
 * bookkeeping, independent of the FIFO / moving-average valuation layers, so it
 * applies to both valuation methods.
 *
 * Inward movements never decrement here: the lot-creating inward (purchase_in /
 * grn_in / opening_stock) already sets qtyRemaining = qtyInward at lot creation,
 * so touching it again would double-count.
 */
export function shouldDecrementLotQty(params: {
  movementType: MovementType;
  isInward: boolean;
  bucketType: string;
}): boolean {
  const { movementType, isInward, bucketType } = params;
  if (isInward) return false;
  if (bucketType !== 'stock') return false;
  if (LOT_NEUTRAL.has(movementType)) return false;
  return true;
}

/**
 * Inward movement types that return previously-consumed goods to an EXISTING
 * lot, so they restore qtyRemaining (the mirror of shouldDecrementLotQty):
 *  - credit_note_in: a sales return (inverse of sale_out).
 *  - manufacturing_in: a manufacturing voucher cancel returns consumed
 *    components to their original lots (inverse of manufacturing_out).
 *
 * Fresh-stock inwards (purchase_in / grn_in / opening_stock) are excluded -
 * they create a NEW lot already initialised to qtyRemaining = qtyInward, so
 * restoring would double-count. Transfers/reservations are lot-neutral. The
 * caller clamps the restore at qtyInward so a lot can never exceed its original
 * size.
 */
const LOT_RESTORE_TYPES: ReadonlySet<MovementType> = new Set<MovementType>([
  'credit_note_in',
  'manufacturing_in',
]);

export function shouldRestoreLotQty(params: {
  movementType: MovementType;
  isInward: boolean;
  bucketType: string;
}): boolean {
  const { movementType, isInward, bucketType } = params;
  if (!isInward) return false;
  if (bucketType !== 'stock') return false;
  return LOT_RESTORE_TYPES.has(movementType);
}
