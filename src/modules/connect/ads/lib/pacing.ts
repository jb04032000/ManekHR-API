/**
 * Compute the target number of impressions per minute required to pace an
 * ad campaign evenly across its remaining flight time.
 *
 * @param budgetRemaining - Credits remaining in the campaign budget.
 * @param minutesLeft - Minutes until the campaign end time.
 * @param avgCpm - Cost per 1000 impressions in the campaign billing currency.
 *   For CPM campaigns this is the bid directly; for CPC campaigns the caller
 *   should pass an estimate (e.g. bid * predictedCtr * 1000). Passing the raw
 *   bid value on a CPC campaign would produce a target that is ~1000x too low,
 *   so callers must normalise before calling this function.
 */
export function targetImpressionsPerMinute(
  budgetRemaining: number,
  minutesLeft: number,
  avgCpm: number,
): number {
  if (minutesLeft <= 0 || avgCpm <= 0) return 0;
  return Math.floor((budgetRemaining / minutesLeft / avgCpm) * 1000);
}

export function shouldThrottle(lastMinute: number, target: number): boolean {
  if (target <= 0) return true;
  return lastMinute > target * 1.2;
}
