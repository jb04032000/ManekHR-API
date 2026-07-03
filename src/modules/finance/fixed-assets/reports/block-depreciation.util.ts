/**
 * Income-Tax Act block-of-assets depreciation (s.32 + s.43(6)).
 *
 * Half-rate proviso (s.32(1), 2nd proviso): an asset ACQUIRED and PUT TO USE
 * for LESS THAN 180 days in the previous year gets half the normal block rate
 * in that year. Assets used for 180 days or more get the full rate. The block
 * summary previously halved EVERY addition, which under-depreciates assets held
 * for the full year. Acquisition date is used as the put-to-use proxy.
 */

const MS_PER_DAY = 86_400_000;

/** True when an asset acquired on purchaseDate was usable < 180 days up to fyEnd. */
export function isHalfYearAddition(purchaseDate: Date, fyEnd: Date): boolean {
  const usedDays = Math.floor((fyEnd.getTime() - purchaseDate.getTime()) / MS_PER_DAY) + 1;
  return usedDays < 180;
}

export interface BlockDepreciationInput {
  openingWdvPaise: number;
  /** Additions used >= 180 days (full rate). */
  additionsFullPaise: number;
  /** Additions used < 180 days (half rate). */
  additionsHalfPaise: number;
  /** s.43(6): block reduced by moneys payable on disposals (sale proceeds). */
  disposalsPaise: number;
  /** IT Act block rate as a fraction, e.g. 0.15 for 15%. */
  itActRate: number;
}

export interface BlockDepreciationResult {
  depreciationPaise: number;
  closingWdvPaise: number;
}

/**
 * Full rate on (opening WDV + full-rate additions - disposals), plus half rate
 * on the half-year additions. Disposals reduce the full-rate base first; if it
 * goes non-positive no full-rate depreciation is charged.
 */
export function computeBlockDepreciation(input: BlockDepreciationInput): BlockDepreciationResult {
  const { openingWdvPaise, additionsFullPaise, additionsHalfPaise, disposalsPaise, itActRate } =
    input;

  const fullBase = openingWdvPaise + additionsFullPaise - disposalsPaise;
  const fullDep = Math.round(Math.max(0, fullBase) * itActRate);
  const halfDep = Math.round(Math.max(0, additionsHalfPaise) * (itActRate / 2));
  const depreciationPaise = fullDep + halfDep;

  const closingWdvPaise =
    openingWdvPaise + additionsFullPaise + additionsHalfPaise - disposalsPaise - depreciationPaise;

  return { depreciationPaise, closingWdvPaise };
}
