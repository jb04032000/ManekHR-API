import { describe, it, expect } from 'vitest';
import {
  isEInvoiceMandatory,
  irn30DayApplicable,
  itc04Frequency,
  hsnDigitsRequired,
  defaultJobWorkType,
  type FirmComplianceInput,
} from '../firm-compliance';

/** Build a firm fixture with an AATO (in lakhs) and an optional compliance block. */
function firm(
  aato: number | undefined,
  compliance?: FirmComplianceInput['compliance'],
): FirmComplianceInput {
  return { aato, compliance };
}

// Boundary values exercised across the Rs 5 cr (500 lakh) and Rs 10 cr
// (1000 lakh) band cuts: 499 / 500 / 501 and 999 / 1000 / 1001.
describe('firm-compliance derivations', () => {
  describe('isEInvoiceMandatory (AATO > 500)', () => {
    it('is false at and below the Rs 5 cr cut', () => {
      expect(isEInvoiceMandatory(firm(499))).toBe(false);
      expect(isEInvoiceMandatory(firm(500))).toBe(false); // strictly greater than
    });
    it('is true above the Rs 5 cr cut', () => {
      expect(isEInvoiceMandatory(firm(501))).toBe(true);
      expect(isEInvoiceMandatory(firm(1000))).toBe(true);
      expect(isEInvoiceMandatory(firm(1001))).toBe(true);
    });
  });

  describe('irn30DayApplicable (AATO >= 1000)', () => {
    it('is false below the Rs 10 cr cut', () => {
      expect(irn30DayApplicable(firm(499))).toBe(false);
      expect(irn30DayApplicable(firm(500))).toBe(false);
      expect(irn30DayApplicable(firm(501))).toBe(false);
      expect(irn30DayApplicable(firm(999))).toBe(false);
    });
    it('is true at and above the Rs 10 cr cut', () => {
      expect(irn30DayApplicable(firm(1000))).toBe(true); // inclusive
      expect(irn30DayApplicable(firm(1001))).toBe(true);
    });
  });

  describe('itc04Frequency', () => {
    it('defaults to annual at and below Rs 5 cr', () => {
      expect(itc04Frequency(firm(499))).toBe('annual');
      expect(itc04Frequency(firm(500))).toBe('annual');
    });
    it('defaults to half_yearly above Rs 5 cr', () => {
      expect(itc04Frequency(firm(501))).toBe('half_yearly');
      expect(itc04Frequency(firm(1000))).toBe('half_yearly');
      expect(itc04Frequency(firm(1001))).toBe('half_yearly');
    });
    it('honors an explicit override regardless of AATO band', () => {
      // Override forces half_yearly even when the band would pick annual.
      expect(itc04Frequency(firm(400, { itc04FrequencyOverride: 'half_yearly' }))).toBe(
        'half_yearly',
      );
      // Override forces annual even when the band would pick half_yearly.
      expect(itc04Frequency(firm(900, { itc04FrequencyOverride: 'annual' }))).toBe('annual');
    });
  });

  describe('hsnDigitsRequired', () => {
    it('is 4 at and below Rs 5 cr', () => {
      expect(hsnDigitsRequired(firm(499))).toBe(4);
      expect(hsnDigitsRequired(firm(500))).toBe(4);
    });
    it('is 6 above Rs 5 cr', () => {
      expect(hsnDigitsRequired(firm(501))).toBe(6);
      expect(hsnDigitsRequired(firm(1000))).toBe(6);
      expect(hsnDigitsRequired(firm(1001))).toBe(6);
    });
  });

  describe('defaultJobWorkType', () => {
    it('falls back to general_textile when the profile is unset', () => {
      expect(defaultJobWorkType(firm(500))).toBe('general_textile');
      expect(defaultJobWorkType(firm(500, {}))).toBe('general_textile');
    });
    it('returns the configured type when present', () => {
      expect(defaultJobWorkType(firm(500, { defaultJobWorkType: 'dyeing_printing' }))).toBe(
        'dyeing_printing',
      );
      expect(defaultJobWorkType(firm(500, { defaultJobWorkType: 'other' }))).toBe('other');
    });
  });

  describe('compliance block undefined (whole profile missing)', () => {
    it('every derivation falls back safely', () => {
      const bare: FirmComplianceInput = { aato: 700 }; // no compliance key at all
      expect(isEInvoiceMandatory(bare)).toBe(true);
      expect(irn30DayApplicable(bare)).toBe(false);
      expect(itc04Frequency(bare)).toBe('half_yearly');
      expect(hsnDigitsRequired(bare)).toBe(6);
      expect(defaultJobWorkType(bare)).toBe('general_textile');
    });
  });

  describe('aato undefined (firm with no turnover recorded)', () => {
    it('treats missing AATO as 0 (all small-firm defaults)', () => {
      const noAato: FirmComplianceInput = { aato: undefined };
      expect(isEInvoiceMandatory(noAato)).toBe(false);
      expect(irn30DayApplicable(noAato)).toBe(false);
      expect(itc04Frequency(noAato)).toBe('annual');
      expect(hsnDigitsRequired(noAato)).toBe(4);
    });
  });
});
