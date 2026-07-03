import { describe, it, expect, beforeEach } from 'vitest';
import { ComplianceGuardService, ComplianceGuardInput } from '../compliance-guard.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fully-compliant baseline input. Override individual fields per test. */
function makeInput(overrides: Partial<ComplianceGuardInput> = {}): ComplianceGuardInput {
  return {
    proposedInstallment: 3000,
    currentTotalDeductions: 2000,
    grossSalaryForMonth: 20000,
    netSalaryBeforeRecovery: 16000, // gross - currentTotalDeductions = 18000, but some may have been pre-applied
    minimumWageMonthly: 8000,
    deductionCapPercent: 50,
    totalAdvanceAmount: 30000,
    periodicWages: 20000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComplianceGuardService', () => {
  let service: ComplianceGuardService;

  beforeEach(() => {
    // No injected dependencies - instantiate directly.
    service = new ComplianceGuardService();
  });

  // -------------------------------------------------------------------------
  // Rule 1: Deduction cap
  // -------------------------------------------------------------------------

  describe('Rule 1 - deduction cap (hard)', () => {
    it('clamps allowedInstallment and emits DEDUCTION_CAP when total deductions exceed cap', () => {
      // cap ceiling = 20000 * 50% = 10000
      // currentTotalDeductions = 8000; proposedInstallment = 5000
      // totalWithProposed = 13000 > 10000 => breach
      // maxAllowedByCapRule = 10000 - 8000 = 2000
      const input = makeInput({
        currentTotalDeductions: 8000,
        proposedInstallment: 5000,
        grossSalaryForMonth: 20000,
        deductionCapPercent: 50,
        // set min wage high enough that it does not interfere
        minimumWageMonthly: null,
        netSalaryBeforeRecovery: 12000,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);

      expect(result.breaches).toHaveLength(1);
      expect(result.breaches[0].code).toBe('DEDUCTION_CAP');
      expect(result.allowedInstallment).toBe(2000);
      // MIN_WAGE_UNCONFIGURED is emitted because minimumWageMonthly is null
      expect(result.warnings.some((w) => w.code === 'MIN_WAGE_UNCONFIGURED')).toBe(true);
    });

    it('uses 75% cap when deductionCapPercent is 75 (co-op society)', () => {
      // cap ceiling = 20000 * 75% = 15000
      // currentTotalDeductions = 8000; proposedInstallment = 8000
      // totalWithProposed = 16000 > 15000 => breach
      // maxAllowed = 15000 - 8000 = 7000
      const input = makeInput({
        currentTotalDeductions: 8000,
        proposedInstallment: 8000,
        grossSalaryForMonth: 20000,
        deductionCapPercent: 75,
        minimumWageMonthly: null,
        netSalaryBeforeRecovery: 12000,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);

      expect(result.breaches).toHaveLength(1);
      expect(result.breaches[0].code).toBe('DEDUCTION_CAP');
      expect(result.allowedInstallment).toBe(7000);
    });

    it('does NOT breach when total deductions equal the cap ceiling exactly', () => {
      // cap ceiling = 20000 * 50% = 10000
      // currentTotalDeductions = 7000; proposedInstallment = 3000 => total = 10000 (not over)
      const input = makeInput({
        currentTotalDeductions: 7000,
        proposedInstallment: 3000,
        grossSalaryForMonth: 20000,
        deductionCapPercent: 50,
        minimumWageMonthly: null,
        netSalaryBeforeRecovery: 13000,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);
      const capBreaches = result.breaches.filter((b) => b.code === 'DEDUCTION_CAP');
      expect(capBreaches).toHaveLength(0);
      expect(result.allowedInstallment).toBe(3000);
    });

    it('clamps allowedInstallment to 0 when existing deductions already fill the cap', () => {
      // cap ceiling = 20000 * 50% = 10000
      // currentTotalDeductions = 10000; proposedInstallment = 1000
      // maxAllowed = max(0, 10000 - 10000) = 0
      const input = makeInput({
        currentTotalDeductions: 10000,
        proposedInstallment: 1000,
        grossSalaryForMonth: 20000,
        deductionCapPercent: 50,
        minimumWageMonthly: null,
        netSalaryBeforeRecovery: 10000,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);
      expect(result.breaches.some((b) => b.code === 'DEDUCTION_CAP')).toBe(true);
      expect(result.allowedInstallment).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Rule 2: Minimum-wage floor
  // -------------------------------------------------------------------------

  describe('Rule 2 - minimum-wage floor (hard)', () => {
    it('clamps allowedInstallment and emits MIN_WAGE_FLOOR when net would fall below floor', () => {
      // netSalaryBeforeRecovery = 10000; minimumWageMonthly = 8000
      // proposedInstallment = 3000 => netAfterRecovery = 7000 < 8000 => breach
      // maxAllowed = 10000 - 8000 = 2000
      const input = makeInput({
        proposedInstallment: 3000,
        currentTotalDeductions: 1000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 10000,
        minimumWageMonthly: 8000,
        deductionCapPercent: 50,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);

      expect(result.breaches.some((b) => b.code === 'MIN_WAGE_FLOOR')).toBe(true);
      expect(result.allowedInstallment).toBe(2000);
    });

    it('does NOT breach when net after recovery exactly equals minimum wage', () => {
      // netSalaryBeforeRecovery = 10000; minimumWageMonthly = 8000
      // proposedInstallment = 2000 => netAfterRecovery = 8000 (equal, not below)
      const input = makeInput({
        proposedInstallment: 2000,
        currentTotalDeductions: 1000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 10000,
        minimumWageMonthly: 8000,
        deductionCapPercent: 50,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);
      const floorBreaches = result.breaches.filter((b) => b.code === 'MIN_WAGE_FLOOR');
      expect(floorBreaches).toHaveLength(0);
      expect(result.allowedInstallment).toBe(2000);
    });

    it('clamps allowedInstallment to 0 when net is already at or below minimum wage', () => {
      // netSalaryBeforeRecovery = 7000 < minimumWageMonthly = 8000
      // maxAllowed = max(0, 7000 - 8000) = 0
      const input = makeInput({
        proposedInstallment: 1000,
        currentTotalDeductions: 500,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 7000,
        minimumWageMonthly: 8000,
        deductionCapPercent: 50,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);
      expect(result.breaches.some((b) => b.code === 'MIN_WAGE_FLOOR')).toBe(true);
      expect(result.allowedInstallment).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Rules 1 + 2 together: tightest clamp wins
  // -------------------------------------------------------------------------

  describe('Rules 1 + 2 combined - tightest clamp', () => {
    it('applies both clamps and allowedInstallment is the smaller of the two', () => {
      // Rule 1: cap ceiling = 20000 * 50% = 10000; currentTotalDeductions = 8000
      //   => maxAllowedByCapRule = 10000 - 8000 = 2000
      // After rule 1 clamp: allowedInstallment = 2000
      // Rule 2: netSalaryBeforeRecovery = 10000; minimumWageMonthly = 9000
      //   netAfterRecovery with 2000 = 8000 < 9000 => breach
      //   maxAllowedByFloorRule = 10000 - 9000 = 1000
      // Final: allowedInstallment = min(2000, 1000) = 1000
      const input = makeInput({
        proposedInstallment: 5000,
        currentTotalDeductions: 8000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 10000,
        minimumWageMonthly: 9000,
        deductionCapPercent: 50,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);

      expect(result.breaches.some((b) => b.code === 'DEDUCTION_CAP')).toBe(true);
      expect(result.breaches.some((b) => b.code === 'MIN_WAGE_FLOOR')).toBe(true);
      expect(result.allowedInstallment).toBe(1000);
    });

    it('when cap clamp is tighter than floor clamp, cap value wins', () => {
      // Rule 1: cap ceiling = 20000 * 50% = 10000; currentTotalDeductions = 9500
      //   => maxAllowedByCapRule = 500
      // After rule 1 clamp: allowedInstallment = 500
      // Rule 2: netSalaryBeforeRecovery = 12000; minimumWageMonthly = 8000
      //   netAfterRecovery with 500 = 11500 >= 8000 => NO floor breach
      // Final: allowedInstallment = 500
      const input = makeInput({
        proposedInstallment: 3000,
        currentTotalDeductions: 9500,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 12000,
        minimumWageMonthly: 8000,
        deductionCapPercent: 50,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);

      expect(result.breaches.some((b) => b.code === 'DEDUCTION_CAP')).toBe(true);
      expect(result.breaches.some((b) => b.code === 'MIN_WAGE_FLOOR')).toBe(false);
      expect(result.allowedInstallment).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // Rule 3: Minimum-wage unconfigured
  // -------------------------------------------------------------------------

  describe('Rule 3 - MIN_WAGE_UNCONFIGURED warning', () => {
    it('emits MIN_WAGE_UNCONFIGURED warning when minimumWageMonthly is null', () => {
      const input = makeInput({
        minimumWageMonthly: null,
        proposedInstallment: 2000,
        currentTotalDeductions: 1000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 15000,
        deductionCapPercent: 50,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);

      expect(result.warnings.some((w) => w.code === 'MIN_WAGE_UNCONFIGURED')).toBe(true);
    });

    it('does NOT clamp allowedInstallment for MIN_WAGE_UNCONFIGURED (soft only)', () => {
      const input = makeInput({
        minimumWageMonthly: null,
        proposedInstallment: 2000,
        currentTotalDeductions: 1000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 15000,
        deductionCapPercent: 50,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);

      // No breaches from floor rule; allowedInstallment stays at proposed (no cap breach either)
      expect(result.breaches.filter((b) => b.code === 'MIN_WAGE_FLOOR')).toHaveLength(0);
      expect(result.allowedInstallment).toBe(2000);
    });
  });

  // -------------------------------------------------------------------------
  // Rule 4: Advisory one-third norm
  // -------------------------------------------------------------------------

  describe('Rule 4 - ADVISORY_ONE_THIRD warning', () => {
    it('emits ADVISORY_ONE_THIRD when proposedInstallment exceeds periodicWages / 3', () => {
      // periodicWages / 3 = 12000 / 3 = 4000; proposedInstallment = 5000 > 4000
      const input = makeInput({
        proposedInstallment: 5000,
        currentTotalDeductions: 1000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 15000,
        minimumWageMonthly: null,
        deductionCapPercent: 50,
        periodicWages: 12000,
      });

      const result = service.evaluate(input);

      expect(result.warnings.some((w) => w.code === 'ADVISORY_ONE_THIRD')).toBe(true);
    });

    it('does NOT emit ADVISORY_ONE_THIRD when proposedInstallment equals periodicWages / 3', () => {
      // periodicWages / 3 = 12000 / 3 = 4000; proposedInstallment = 4000 (not over)
      const input = makeInput({
        proposedInstallment: 4000,
        currentTotalDeductions: 1000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 15000,
        minimumWageMonthly: null,
        deductionCapPercent: 50,
        periodicWages: 12000,
      });

      const result = service.evaluate(input);

      expect(result.warnings.some((w) => w.code === 'ADVISORY_ONE_THIRD')).toBe(false);
    });

    it('emits ADVISORY_ONE_THIRD as a soft warning only (no clamping)', () => {
      const input = makeInput({
        proposedInstallment: 5000,
        currentTotalDeductions: 1000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 15000,
        minimumWageMonthly: null,
        deductionCapPercent: 50,
        periodicWages: 12000,
      });

      const result = service.evaluate(input);

      // Warning is emitted but allowedInstallment stays at proposed (no hard breach)
      expect(result.warnings.some((w) => w.code === 'ADVISORY_ONE_THIRD')).toBe(true);
      expect(result.allowedInstallment).toBe(5000);
    });
  });

  // -------------------------------------------------------------------------
  // Rule 5: Advisory 12-month tenor
  // -------------------------------------------------------------------------

  describe('Rule 5 - ADVISORY_12_MONTH warning', () => {
    it('emits ADVISORY_12_MONTH when scheduleMonths > advisoryMaxMonths', () => {
      const input = makeInput({
        scheduleMonths: 15,
        advisoryMaxMonths: 12,
      });

      const result = service.evaluate(input);

      expect(result.warnings.some((w) => w.code === 'ADVISORY_12_MONTH')).toBe(true);
    });

    it('does NOT emit ADVISORY_12_MONTH when scheduleMonths equals advisoryMaxMonths', () => {
      const input = makeInput({
        scheduleMonths: 12,
        advisoryMaxMonths: 12,
      });

      const result = service.evaluate(input);

      expect(result.warnings.some((w) => w.code === 'ADVISORY_12_MONTH')).toBe(false);
    });

    it('does NOT emit ADVISORY_12_MONTH when only scheduleMonths is provided (missing advisoryMaxMonths)', () => {
      const input = makeInput({
        scheduleMonths: 15,
        // advisoryMaxMonths intentionally omitted
      });

      const result = service.evaluate(input);

      expect(result.warnings.some((w) => w.code === 'ADVISORY_12_MONTH')).toBe(false);
    });

    it('does NOT emit ADVISORY_12_MONTH when only advisoryMaxMonths is provided (missing scheduleMonths)', () => {
      const input = makeInput({
        advisoryMaxMonths: 12,
        // scheduleMonths intentionally omitted
      });

      const result = service.evaluate(input);

      expect(result.warnings.some((w) => w.code === 'ADVISORY_12_MONTH')).toBe(false);
    });

    it('emits ADVISORY_12_MONTH as a soft warning only (no clamping)', () => {
      const input = makeInput({
        scheduleMonths: 15,
        advisoryMaxMonths: 12,
        // ensure no hard breaches interfere
        proposedInstallment: 2000,
        currentTotalDeductions: 1000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 15000,
        minimumWageMonthly: null,
        deductionCapPercent: 50,
        periodicWages: 20000,
      });

      const result = service.evaluate(input);

      expect(result.warnings.some((w) => w.code === 'ADVISORY_12_MONTH')).toBe(true);
      expect(result.allowedInstallment).toBe(2000);
    });
  });

  // -------------------------------------------------------------------------
  // Fully-compliant input: no breaches, no warnings, allowedInstallment = proposed
  // -------------------------------------------------------------------------

  describe('fully-compliant input', () => {
    it('returns no breaches, no warnings, and allowedInstallment equals proposedInstallment', () => {
      // cap ceiling = 20000 * 50% = 10000; currentTotalDeductions = 2000; proposed = 3000
      // totalWithProposed = 5000 < 10000 => no cap breach
      // netAfterRecovery = 16000 - 3000 = 13000 >= minimumWageMonthly = 8000 => no floor breach
      // periodicWages / 3 = 20000 / 3 = 6666.67; proposedInstallment = 3000 < 6666.67 => no advisory
      // scheduleMonths = 10 <= advisoryMaxMonths = 12 => no tenor advisory
      const input = makeInput({
        proposedInstallment: 3000,
        currentTotalDeductions: 2000,
        grossSalaryForMonth: 20000,
        netSalaryBeforeRecovery: 16000,
        minimumWageMonthly: 8000,
        deductionCapPercent: 50,
        periodicWages: 20000,
        scheduleMonths: 10,
        advisoryMaxMonths: 12,
      });

      const result = service.evaluate(input);

      expect(result.breaches).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.allowedInstallment).toBe(3000);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases: rounding and boundary precision
  // -------------------------------------------------------------------------

  describe('rounding precision', () => {
    it('rounds allowedInstallment to 2 decimal places (paise precision)', () => {
      // cap ceiling = 10000 * 50% = 5000; currentTotalDeductions = 3333.34
      // maxAllowed = 5000 - 3333.34 = 1666.66
      const input = makeInput({
        proposedInstallment: 3000,
        currentTotalDeductions: 3333.34,
        grossSalaryForMonth: 10000,
        netSalaryBeforeRecovery: 6666.66,
        minimumWageMonthly: null,
        deductionCapPercent: 50,
        periodicWages: 10000,
      });

      const result = service.evaluate(input);
      // Pinned expected value: 5000 cap ceiling - 3333.34 existing = 1666.66,
      // exact to paise (no floating point leak like 1666.6599999999999).
      expect(result.allowedInstallment).toBe(1666.66);
    });
  });
});
