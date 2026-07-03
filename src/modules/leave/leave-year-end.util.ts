export interface YearEndRuleInput {
  carryForwardCap: number;
  lapseExcess: boolean;
  encashable: boolean;
  encashmentCap: number | null;
}

export interface YearEndDistribution {
  encashed: number;
  carriedForward: number;
  lapsed: number;
}

/**
 * Split a leave year's closing `available` balance into encashment,
 * carry-forward, and lapse, applying a leave type's year-end rule.
 *
 * Order: encash first (capped by `encashmentCap`), carry the rest forward
 * (capped by `carryForwardCap`), then lapse whatever remains when
 * `lapseExcess` is set. With `lapseExcess` false, an uncarried remainder
 * simply stays in the closed year (an explicit "never lapse" choice).
 */
export function computeYearEndDistribution(
  available: number,
  rule: YearEndRuleInput,
): YearEndDistribution {
  if (available <= 0) {
    return { encashed: 0, carriedForward: 0, lapsed: 0 };
  }
  let remaining = available;

  let encashed = 0;
  if (rule.encashable) {
    encashed = rule.encashmentCap != null ? Math.min(remaining, rule.encashmentCap) : remaining;
    remaining -= encashed;
  }

  const carriedForward = Math.min(remaining, Math.max(0, rule.carryForwardCap));
  remaining -= carriedForward;

  const lapsed = rule.lapseExcess ? remaining : 0;
  return { encashed, carriedForward, lapsed };
}
