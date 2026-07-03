import { describe, it, expect } from 'vitest';
import { validateGstin, gstinCheckDigit, isValidGstin } from '../gstin-validator';

// Pure offline GSTIN validation (no Nest/Mongo). Golden case 27AAPFU0939F1ZV is a
// well-known valid GSTIN whose check digit 'V' was verified by hand against the GSTN
// mod-36 algorithm.

describe('gstinCheckDigit', () => {
  it('computes the GSTN check digit for a known prefix', () => {
    expect(gstinCheckDigit('27AAPFU0939F1Z')).toBe('V');
  });
});

describe('validateGstin', () => {
  it('accepts a valid GSTIN', () => {
    expect(validateGstin('27AAPFU0939F1ZV')).toEqual({ valid: true, stateCode: '27' });
  });

  it('normalises case + whitespace', () => {
    expect(isValidGstin('  27aapfu0939f1zv ')).toBe(true);
  });

  it('rejects a wrong length / bad format', () => {
    expect(validateGstin('27AAPFU0939F1Z')).toEqual({ valid: false, reason: 'format' });
    expect(validateGstin('ABCDE1234F1Z5XY')).toMatchObject({ valid: false, reason: 'format' });
  });

  it('rejects an unknown state code (passes format)', () => {
    // 99 is not a valid GST state code; rest mirrors the golden GSTIN shape.
    const res = validateGstin('99AAPFU0939F1ZV');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('state_code');
  });

  it('rejects a wrong check digit (typo that passes format + state)', () => {
    // Same as the golden GSTIN but the 15th char is flipped V -> U.
    const res = validateGstin('27AAPFU0939F1ZU');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('check_digit');
    expect(res.stateCode).toBe('27');
  });

  it('accepts a Gujarat (state 24) GSTIN with a valid computed check digit', () => {
    const first14 = '24AAPFU0939F1Z';
    const gstin = first14 + gstinCheckDigit(first14);
    expect(validateGstin(gstin)).toEqual({ valid: true, stateCode: '24' });
  });
});
