import { dayKey } from './leave-request.util';

/**
 * A comp-off day is earnable only for working a day the member was otherwise
 * off — a workspace holiday or one of the member's weekly-off days. Working a
 * normal working day earns no comp-off.
 */
export function isEarnableCompOffDay(
  date: Date,
  holidayKeys: Set<string>,
  weeklyOffDays: Set<number>,
): boolean {
  return holidayKeys.has(dayKey(date)) || weeklyOffDays.has(date.getUTCDay());
}

/** A comp-off lot with remaining balance — caller pre-sorts these FIFO. */
export interface CompOffLot {
  ledgerEntryId: string;
  /** Calendar year the lot was earned in (its ledger bucket). */
  year: number;
  lotRemaining: number;
}

export interface CompOffAllocation {
  ledgerEntryId: string;
  year: number;
  consumed: number;
}

/**
 * Allocate `quantity` days across comp-off lots, oldest-expiry-first (FIFO).
 *
 * `lots` MUST be pre-sorted by expiry ascending. Returns the per-lot
 * allocation and any `shortfall` (days that could not be covered) — the caller
 * decides whether a shortfall is an error.
 */
export function allocateFifo(
  lots: CompOffLot[],
  quantity: number,
): { allocations: CompOffAllocation[]; shortfall: number } {
  const allocations: CompOffAllocation[] = [];
  let remaining = quantity;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const consumed = Math.min(lot.lotRemaining, remaining);
    if (consumed > 0) {
      allocations.push({
        ledgerEntryId: lot.ledgerEntryId,
        year: lot.year,
        consumed,
      });
      remaining -= consumed;
    }
  }
  return { allocations, shortfall: Math.max(0, remaining) };
}
