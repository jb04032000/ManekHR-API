/**
 * Trial reminder nudge cadence — pure threshold logic (no I/O, easily unit
 * tested in isolation; the cron only orchestrates these decisions).
 *
 * The trial reminder is intentionally NOT a daily email. A trial gets a small,
 * fixed set of nudges in its final stretch, fired at distinct `daysRemaining`
 * thresholds and deduped per-threshold so the same trial never gets two emails
 * for the same threshold (see the cron's `trial:<subId>:d<T>` dedup key).
 *
 * Canonical cadence: 5 days out, 2 days out, 1 day out — i.e. an opening
 * heads-up, a mid reminder, and a last-day nudge. ~3 emails over the final 5
 * days, never one-per-day.
 */
export const TRIAL_NUDGE_THRESHOLDS = [5, 2, 1] as const;

/**
 * Derive the set of `daysRemaining` thresholds at which a nudge fires, given
 * the admin-configured window (`BillingPolicy.trial.reminderEmailDaysBeforeEnd`).
 *
 * Derivation:
 *   1. Start from the canonical cadence [5, 2, 1].
 *   2. Drop any point greater than the window (so a 3-day window never fires a
 *      "5 days left" email).
 *   3. ALWAYS include the window value itself as the earliest nudge, so an
 *      admin who narrows the window still gets an opening reminder on the first
 *      day of the window (e.g. window=3 -> a "3 days left" opener).
 *   4. De-dupe + sort descending (earliest threshold first).
 *
 * Examples:
 *   window 5  -> [5, 2, 1]      (3 nudges — the default)
 *   window 3  -> [3, 2, 1]      (3 nudges; 5 dropped, 3 injected)
 *   window 2  -> [2, 1]         (2 nudges)
 *   window 1  -> [1]            (1 nudge — final day only)
 *   window 7  -> [7, 5, 2, 1]   (window opener + canonical cadence)
 *
 * A degenerate window (<= 0) falls back to a single same-day nudge [1] so the
 * customer is never left with zero warning.
 */
export function reminderThresholdsForWindow(windowDays: number): number[] {
  const window = Math.floor(windowDays);
  if (!Number.isFinite(window) || window <= 0) {
    return [1];
  }
  // Canonical points that fit inside the window, plus the window boundary.
  const points = new Set<number>([window, ...TRIAL_NUDGE_THRESHOLDS.filter((t) => t <= window)]);
  return [...points].sort((a, b) => b - a);
}

/**
 * Which threshold(s) fire for a trial that has `daysRemaining` days left under
 * the given window. A threshold T fires precisely on the day `daysRemaining`
 * equals T — exact-match, so the in-between days are deliberately silent (this
 * is what makes the cadence a few nudges rather than a daily email).
 *
 * Returns an array (usually 0 or 1 element) so the cron can iterate + dedup
 * each independently.
 */
export function dueReminderThresholds(daysRemaining: number, windowDays: number): number[] {
  const thresholds = reminderThresholdsForWindow(windowDays);
  return thresholds.filter((t) => t === daysRemaining);
}
