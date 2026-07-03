/**
 * bonus.util.ts - Pure statutory-bonus computation helpers.
 *
 * These functions are stateless and depend only on their arguments. They
 * implement the Payment of Bonus Act / Code on Wages (India) math. Each is
 * independently unit-tested in bonus.util.vitest.ts.
 *
 * Vocabulary (binding - phase-3-clarity-and-overview.md):
 *   "Statutory Bonus" = legally required under the Act (8.33-20%, wage ceiling)
 *   "Festival/Discretionary Bonus" = free-form employer grant; NOT re-derived here
 *
 * CONFIRM WITH CA BEFORE PRODUCTION DISBURSAL.
 * Statutory thresholds (eligibilityWageCeiling=21000, calculationWageFloor=7000,
 * minPercent=8.33, maxPercent=20) are admin-configurable in PayrollConfig.bonusConfig
 * and passed in as arguments - never hard-coded here.
 */

/**
 * Determine whether a member is eligible for statutory bonus.
 *
 * Eligibility rules (Payment of Bonus Act s.2(13) + s.8):
 *   - Monthly wages at or below eligibilityWageCeiling (Rs 21,000 by default).
 *     "Wages" = last active baseSalary. Admin-configurable; CA confirms.
 *   - At least 30 working days in the accounting year (expressed as monthsWorked >= 1
 *     where each month credit = at least one working day in that calendar month).
 *     This converts to: monthsWorked > 0 for proportionate cases.
 *     The Act requires 30 days across the whole year, not necessarily contiguous.
 *
 * Returns { eligible: boolean; reason: string }.
 */
export function isStatutoryBonusEligible(opts: {
  lastMonthlyWage: number;
  eligibilityWageCeiling: number;
  monthsWorked: number;
  newEstablishment?: boolean;
}): { eligible: boolean; reason: string } {
  const { lastMonthlyWage, eligibilityWageCeiling, monthsWorked, newEstablishment = false } = opts;

  if (newEstablishment) {
    return {
      eligible: false,
      reason:
        'New establishment exemption: statutory bonus is not payable for the first five years (Payment of Bonus Act s.16). Confirm with CA.',
    };
  }

  if (lastMonthlyWage > eligibilityWageCeiling) {
    return {
      eligible: false,
      reason: `Monthly wages Rs ${lastMonthlyWage} exceed the eligibility ceiling Rs ${eligibilityWageCeiling}. Not eligible under Payment of Bonus Act s.2(13).`,
    };
  }

  if (monthsWorked < 1) {
    return {
      eligible: false,
      reason:
        'Member worked fewer than 30 days in the accounting year. Minimum 30 days required (Payment of Bonus Act s.8).',
    };
  }

  return { eligible: true, reason: 'Eligible' };
}

/**
 * Derive the calculation wage base for statutory bonus.
 *
 * Per the Act, bonus is computed on min(actualWage, calculationWageFloor_or_minWage).
 * The "floor" is max(calculationWageFloor, applicableMinWage) - i.e. we use whichever
 * is higher: the statutory floor (Rs 7,000) or the applicable state minimum wage.
 *
 *   calcWage = min(actualMonthlyWage, max(calculationWageFloor, minimumWageMonthly))
 *
 * Both thresholds are admin-configurable. CA must confirm the minimum wage applicable
 * to the specific establishment category (skilled/semi-skilled/unskilled/factory).
 */
export function deriveBonusCalcWage(opts: {
  actualMonthlyWage: number;
  calculationWageFloor: number;
  minimumWageMonthly: number | null;
}): number {
  const { actualMonthlyWage, calculationWageFloor, minimumWageMonthly } = opts;
  const floor = Math.max(calculationWageFloor, minimumWageMonthly ?? 0);
  return Math.min(actualMonthlyWage, floor);
}

/**
 * Clamp the applicable bonus percent to the statutory range [minPercent, maxPercent].
 *
 * When allocableSurplusPercent is 0 or not set, the minimum statutory rate applies
 * (8.33% = 1/12). Admin sets the allocable surplus percent after CA certification.
 * Valid range: 8.33 (1/12) to 20.
 */
export function deriveApplicableBonusPercent(opts: {
  allocableSurplusPercent: number;
  minPercent: number;
  maxPercent: number;
}): number {
  const { allocableSurplusPercent, minPercent, maxPercent } = opts;
  if (allocableSurplusPercent <= 0) {
    return minPercent;
  }
  return Math.min(Math.max(allocableSurplusPercent, minPercent), maxPercent);
}

/**
 * Compute the statutory bonus amount for one member.
 *
 * Formula: calcWage * (applicablePercent / 100) * (monthsWorked / 12)
 * Rounded to nearest rupee. The Act is silent on rounding direction for
 * proportionate cases; round half-up is industry standard.
 *
 * The result is always >= calcWage * (minPercent / 100) * (monthsWorked / 12)
 * when monthsWorked > 0. This is enforced by the percent clamp above.
 */
export function computeStatutoryBonusAmount(opts: {
  calcWage: number;
  applicablePercent: number;
  monthsWorked: number;
}): number {
  const { calcWage, applicablePercent, monthsWorked } = opts;
  const raw = calcWage * (applicablePercent / 100) * (monthsWorked / 12);
  return Math.round(raw);
}

/**
 * Count the number of months worked in an accounting year from salary records.
 *
 * A month is credited when presentDays >= 1 in that salary record.
 * (The Act requires 30 days in the year, treated as: each month where work
 * occurred = 1 credit; the month count is used for proportionate calculation.)
 *
 * salaryMonths: array of { month, year, presentDays } for a member within the FY.
 * fyStartYear: e.g. 2025 for FY 2025-26 (April 2025 - March 2026).
 */
export function countMonthsWorked(
  salaryMonths: Array<{ month: number; year: number; presentDays: number }>,
  fyStartYear: number,
): number {
  const fyMonths = buildFyMonthSet(fyStartYear);
  let count = 0;
  for (const row of salaryMonths) {
    const key = `${row.year}-${row.month}`;
    if (fyMonths.has(key) && row.presentDays >= 1) {
      count++;
    }
  }
  return count;
}

/**
 * Build the set of "year-month" keys for an Indian FY (Apr-Mar).
 * fyStartYear=2025 -> April 2025 through March 2026.
 */
export function buildFyMonthSet(fyStartYear: number): Set<string> {
  const keys = new Set<string>();
  // April to December (same year)
  for (let m = 4; m <= 12; m++) {
    keys.add(`${fyStartYear}-${m}`);
  }
  // January to March (next year)
  for (let m = 1; m <= 3; m++) {
    keys.add(`${fyStartYear + 1}-${m}`);
  }
  return keys;
}
