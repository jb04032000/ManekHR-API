/**
 * The first month a newly created fixed asset should be depreciated.
 *
 * Companies Act 2013 Schedule II requires depreciation pro-rata from the date
 * the asset is available for use, so the acquisition month itself must be
 * depreciated (the depreciation-math service pro-rates the partial month from
 * purchaseDate to month-end). Setting the cursor to purchaseDate + 1 month
 * skipped the acquisition month entirely, under-depreciating the first year.
 *
 * Returns a "YYYY-MM" cursor (the depreciation-run query compares it as a
 * string), based on the purchase date's own calendar month.
 */
export function firstDepreciationMonth(purchaseDate: Date): string {
  const y = purchaseDate.getFullYear();
  const m = String(purchaseDate.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
