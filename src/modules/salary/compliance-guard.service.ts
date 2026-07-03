import { Injectable } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ComplianceGuardInput {
  /** Proposed monthly deduction for this advance installment (Rs). */
  proposedInstallment: number;
  /** Sum of ALL other active deductions for the same month (excluding this installment). */
  currentTotalDeductions: number;
  /** Gross salary for the month: baseSalary + additions, before any deductions. */
  grossSalaryForMonth: number;
  /** Net salary as computed by calculateNetSalary with existing deductions already applied
   *  but BEFORE adding the proposed installment deduction. */
  netSalaryBeforeRecovery: number;
  /** Resolved minimum wage (per-member override or workspace default). Null = not configured. */
  minimumWageMonthly: number | null;
  /** Deduction cap as a percentage of gross (50 for standard; 75 for co-op society). */
  deductionCapPercent: number;
  /** Full advance principal (informational; used in breach detail messages). */
  totalAdvanceAmount: number;
  /** That month's gross wages used for the one-third advisory norm. */
  periodicWages: number;
  // Rule 5 (ADVISORY_12_MONTH) is only evaluable when the schedule context is known.
  // Callers that preview or create a full schedule should pass both fields; if either
  // is absent the rule is silently skipped rather than incorrectly emitting or blocking.
  /** Total planned schedule length in months (installmentCount + any carry months). */
  scheduleMonths?: number;
  /** Advisory maximum tenor in months (from PayrollConfig.compliance.installmentAdvisoryMaxMonths). */
  advisoryMaxMonths?: number;
}

export type ComplianceBreach = {
  code: 'DEDUCTION_CAP' | 'MIN_WAGE_FLOOR';
  detail: string;
  reducedTo: number;
};

export type ComplianceWarning = {
  code: 'ADVISORY_ONE_THIRD' | 'ADVISORY_12_MONTH' | 'MIN_WAGE_UNCONFIGURED';
  detail: string;
};

export interface ComplianceGuardResult {
  breaches: ComplianceBreach[];
  warnings: ComplianceWarning[];
  /** Installment reduced to the maximum compliant value (may equal proposedInstallment if compliant). */
  allowedInstallment: number;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Round to 2 decimal places (paise precision), consistent with salary module. */
function roundPaise(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Pure synchronous compliance evaluation for advance recovery installments.
 *
 * No constructor dependencies - all inputs are pre-loaded by the caller so
 * this service requires no DB access and can be instantiated or injected freely.
 *
 * Guard execution order:
 *   1. Deduction cap (hard) - clamps allowedInstallment if total deductions exceed cap.
 *   2. Minimum-wage floor (hard) - clamps allowedInstallment if net would fall below floor.
 *   3. Minimum-wage unconfigured (soft) - warning when floor cannot be applied.
 *   4. One-third advisory (soft) - warning when installment exceeds 1/3 of periodic wages.
 *   5. 12-month tenor advisory (soft, optional input) - warning when schedule is too long.
 *
 * Rules 1 and 2 apply in sequence so allowedInstallment is the tightest (smallest)
 * compliant value at all times. It is never below 0.
 */
@Injectable()
export class ComplianceGuardService {
  evaluate(input: ComplianceGuardInput): ComplianceGuardResult {
    const breaches: ComplianceBreach[] = [];
    const warnings: ComplianceWarning[] = [];

    // Working variable - start at the proposed value and tighten through each guard.
    let allowedInstallment = input.proposedInstallment;

    // -------------------------------------------------------------------------
    // Rule 1: Deduction cap (hard)
    // Legal basis: Payment of Wages Act 1936 s.7(3) / Code on Wages 2019.
    // Total deductions (existing + proposed) must not exceed cap% of gross.
    // -------------------------------------------------------------------------
    const capCeiling = roundPaise((input.grossSalaryForMonth * input.deductionCapPercent) / 100);
    const totalWithProposed = roundPaise(input.currentTotalDeductions + allowedInstallment);

    if (totalWithProposed > capCeiling) {
      const maxAllowedByCapRule = roundPaise(
        Math.max(0, capCeiling - input.currentTotalDeductions),
      );
      breaches.push({
        code: 'DEDUCTION_CAP',
        detail:
          `Total deductions including this installment (Rs.${totalWithProposed}) ` +
          `would exceed ${input.deductionCapPercent}% of gross salary ` +
          `(Rs.${input.grossSalaryForMonth}). ` +
          `Maximum compliant installment: Rs.${maxAllowedByCapRule}.`,
        reducedTo: maxAllowedByCapRule,
      });
      allowedInstallment = maxAllowedByCapRule;
    }

    // -------------------------------------------------------------------------
    // Rule 2: Minimum-wage floor (hard) - applied AFTER rule 1 clamp
    // Legal basis: Minimum Wages Act 1948.
    // Net salary after recovery must not fall below the applicable minimum wage.
    // -------------------------------------------------------------------------
    if (input.minimumWageMonthly !== null) {
      // Use the already-clamped allowedInstallment to check the net after recovery.
      const netAfterRecovery = roundPaise(input.netSalaryBeforeRecovery - allowedInstallment);

      if (netAfterRecovery < input.minimumWageMonthly) {
        const maxAllowedByFloorRule = roundPaise(
          Math.max(0, input.netSalaryBeforeRecovery - input.minimumWageMonthly),
        );
        breaches.push({
          code: 'MIN_WAGE_FLOOR',
          detail:
            `Recovering Rs.${allowedInstallment} would leave net salary at ` +
            `Rs.${netAfterRecovery}, below the applicable minimum wage of ` +
            `Rs.${input.minimumWageMonthly}. ` +
            `Maximum compliant installment: Rs.${maxAllowedByFloorRule}.`,
          reducedTo: maxAllowedByFloorRule,
        });
        // Tighten allowedInstallment further if the floor rule is more restrictive.
        allowedInstallment = Math.min(allowedInstallment, maxAllowedByFloorRule);
      }
    } else {
      // Rule 3: Minimum-wage unconfigured (soft warning, no clamping)
      warnings.push({
        code: 'MIN_WAGE_UNCONFIGURED',
        detail:
          'Minimum wage is not configured for this workspace or member. ' +
          'The minimum-wage floor guard cannot be applied. ' +
          'Configure the minimum wage in Payroll Config to enable this check.',
      });
    }

    // Clamp to zero to ensure allowedInstallment is never negative.
    allowedInstallment = Math.max(0, allowedInstallment);

    // -------------------------------------------------------------------------
    // Rule 4: Advisory one-third installment norm (soft)
    // Legal basis: Payment of Wages Act s.12A advisory; soft check only.
    // Ownership can consciously set a higher installment without being blocked.
    // -------------------------------------------------------------------------
    if (input.proposedInstallment > input.periodicWages / 3) {
      const oneThird = roundPaise(input.periodicWages / 3);
      warnings.push({
        code: 'ADVISORY_ONE_THIRD',
        detail:
          `Proposed installment (Rs.${input.proposedInstallment}) exceeds ` +
          `one-third of periodic wages (Rs.${oneThird}). ` +
          'This is advisory per Payment of Wages Act s.12A. ' +
          'You may proceed, but consider reducing the installment.',
      });
    }

    // -------------------------------------------------------------------------
    // Rule 5: Advisory 12-month tenor (soft, optional-input driven)
    // Only evaluable when the caller passes both scheduleMonths and advisoryMaxMonths.
    // Callers that cannot determine the full schedule length (e.g. per-installment
    // preview without the carry-forward count) should omit these fields; the rule
    // is silently skipped rather than incorrectly emitting.
    // -------------------------------------------------------------------------
    if (
      input.scheduleMonths !== undefined &&
      input.advisoryMaxMonths !== undefined &&
      input.scheduleMonths > input.advisoryMaxMonths
    ) {
      warnings.push({
        code: 'ADVISORY_12_MONTH',
        detail:
          `Recovery schedule spans ${input.scheduleMonths} months, ` +
          `exceeding the advisory maximum of ${input.advisoryMaxMonths} months. ` +
          'Consider increasing the installment amount to shorten the tenor.',
      });
    }

    return { breaches, warnings, allowedInstallment };
  }
}
