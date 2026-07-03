/**
 * D-06: shape a component's available stock lots into the FIFO lot-suggestion
 * entry the web form consumes (`ManufacturingVoucherForm` + `types/index.ts`
 * `lotSuggestions`). Pure so the FIFO ordering and field mapping are unit
 * testable without a DB.
 *
 * Contract (must match the web type exactly):
 *   { itemId, suggestions: [{ lotId, batchId, qty, inwardDate }] }
 * ordered oldest-inward-first, excluding lots with no remaining quantity.
 */
export interface LotLike {
  _id: unknown;
  lotNo?: string;
  inwardDate?: Date | string | number | null;
  qtyRemaining?: number;
}

export interface LotSuggestionEntry {
  lotId: string;
  batchId?: string;
  qty: number;
  inwardDate: string;
}

export interface LotSuggestion {
  itemId: string;
  suggestions: LotSuggestionEntry[];
}

export function buildLotSuggestion(itemId: string, lots: LotLike[]): LotSuggestion {
  const suggestions = lots
    .filter((l) => (l.qtyRemaining ?? 0) > 0)
    .sort((a, b) => new Date(a.inwardDate ?? 0).getTime() - new Date(b.inwardDate ?? 0).getTime())
    .map((l) => ({
      lotId: String(l._id),
      batchId: l.lotNo,
      qty: l.qtyRemaining,
      inwardDate: new Date(l.inwardDate ?? 0).toISOString(),
    }));
  return { itemId, suggestions };
}
