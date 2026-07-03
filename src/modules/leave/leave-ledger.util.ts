import type { LeaveLedgerEntryType } from './schemas/leave-ledger.schema';

/**
 * Running balance accumulators folded from the immutable ledger. `pending` is
 * owned by the L3 request lifecycle, not the ledger — it is carried through
 * unchanged so `computeAvailable` stays correct.
 */
export interface LeaveBalanceTotals {
  opening: number;
  credited: number;
  used: number;
  pending: number;
  lapsed: number;
  encashed: number;
}

export function emptyTotals(): LeaveBalanceTotals {
  return {
    opening: 0,
    credited: 0,
    used: 0,
    pending: 0,
    lapsed: 0,
    encashed: 0,
  };
}

/**
 * Fold one immutable ledger entry into running balance totals. `quantity` is
 * signed (credits positive, debits negative). Returns a new object — the input
 * is not mutated.
 */
export function applyEntryToTotals(
  totals: LeaveBalanceTotals,
  entryType: LeaveLedgerEntryType,
  quantity: number,
): LeaveBalanceTotals {
  const next = { ...totals };
  switch (entryType) {
    case 'opening':
      next.opening += quantity;
      break;
    case 'accrual':
    case 'carry_forward':
    case 'comp_off_credit':
    case 'adjustment':
      // `adjustment` is signed — a negative correction reduces credited.
      next.credited += quantity;
      break;
    case 'usage':
    case 'usage_reversal':
      // usage qty < 0 raises `used`; usage_reversal qty > 0 lowers it.
      next.used += -quantity;
      break;
    case 'lapse':
    case 'comp_off_expiry':
      next.lapsed += -quantity;
      break;
    case 'encashment':
      next.encashed += -quantity;
      break;
  }
  return next;
}

/** available = opening + credited − used − pending − lapsed − encashed. */
export function computeAvailable(totals: LeaveBalanceTotals): number {
  return (
    totals.opening +
    totals.credited -
    totals.used -
    totals.pending -
    totals.lapsed -
    totals.encashed
  );
}
