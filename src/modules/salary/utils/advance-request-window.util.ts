/**
 * Worker advance-request timing policy decision (pure, side-effect free).
 *
 * Generalizes the legacy single `disbursementRules.advanceRequestDay` lock into a
 * workspace policy with three modes:
 *   - any_day   : requests accepted any day of the month (modern default for new workspaces)
 *   - window    : accepted between windowStartDay..windowEndDay (inclusive; wraps if end < start)
 *   - fixed_day : accepted only on a single configured day (the legacy behaviour)
 *
 * Backward-compat: when no policy is present (existing workspaces, pre-migration),
 * we fall back to the legacy fixed `advanceRequestDayFallback`.
 *
 * Links: advance-salary-request.service.ts createRequest (the guard caller),
 * payroll-config.schema.ts disbursementRules.advanceRequestPolicy.
 */
export type AdvanceRequestPolicyMode = 'any_day' | 'window' | 'fixed_day';

export interface AdvanceRequestPolicy {
  mode?: AdvanceRequestPolicyMode;
  fixedDay?: number;
  windowStartDay?: number;
  windowEndDay?: number;
}

/**
 * Is the advance-request window open on `todayDay` (1-31, IST)?
 * `advanceRequestDayFallback` is the legacy single day used when no policy / no fixedDay.
 */
export function isAdvanceRequestWindowOpen(
  policy: AdvanceRequestPolicy | undefined,
  advanceRequestDayFallback: number,
  todayDay: number,
): boolean {
  // No policy (pre-migration workspace) -> legacy fixed-day behaviour.
  if (!policy || !policy.mode) {
    return todayDay === advanceRequestDayFallback;
  }

  switch (policy.mode) {
    case 'any_day':
      return true;

    case 'fixed_day':
      return todayDay === (policy.fixedDay ?? advanceRequestDayFallback);

    case 'window': {
      const start = policy.windowStartDay ?? 1;
      const end = policy.windowEndDay ?? 31;
      // Normal range (e.g. 10..20): inclusive between start and end.
      if (start <= end) return todayDay >= start && todayDay <= end;
      // Wrap-around range (e.g. 28..3 across the month boundary).
      return todayDay >= start || todayDay <= end;
    }

    default:
      // Unknown mode -> fail closed to the legacy fixed day.
      return todayDay === advanceRequestDayFallback;
  }
}

/**
 * Human-readable reason for a closed window, surfaced in the
 * ADVANCE_REQUEST_DAY_CLOSED error so the worker knows when to come back.
 */
export function advanceRequestWindowMessage(
  policy: AdvanceRequestPolicy | undefined,
  advanceRequestDayFallback: number,
): string {
  if (!policy || !policy.mode || policy.mode === 'fixed_day') {
    const day = policy?.fixedDay ?? advanceRequestDayFallback;
    return `Advance requests can only be submitted on day ${day} of the month.`;
  }
  if (policy.mode === 'window') {
    const start = policy.windowStartDay ?? 1;
    const end = policy.windowEndDay ?? 31;
    return `Advance requests can only be submitted between day ${start} and day ${end} of the month.`;
  }
  // any_day never closes. The drawer renders this message even when the window
  // is open, so it must read as positive (the old generic "not open right now"
  // text showed as a false-alarm banner on every any_day workspace).
  return 'Advance requests are open — you can request an advance on any day.';
}
