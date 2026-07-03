import { describe, it, expect } from 'vitest';
import { resolveStateCode, isIntraState } from '../gst-state-codes';

describe('resolveStateCode - passthrough for valid 2-digit codes', () => {
  it('returns Gujarat code unchanged', () => {
    expect(resolveStateCode('24')).toBe('24');
  });

  it('returns Maharashtra code unchanged', () => {
    expect(resolveStateCode('27')).toBe('27');
  });

  it('returns code 01 (Jammu and Kashmir) unchanged', () => {
    expect(resolveStateCode('01')).toBe('01');
  });

  it('returns code 38 (Ladakh) unchanged', () => {
    expect(resolveStateCode('38')).toBe('38');
  });

  it('returns code 97 (Other Territory) unchanged', () => {
    expect(resolveStateCode('97')).toBe('97');
  });

  it('returns code 99 (Centre Jurisdiction) unchanged', () => {
    expect(resolveStateCode('99')).toBe('99');
  });
});

describe('resolveStateCode - name to code', () => {
  it('resolves exact name Gujarat', () => {
    expect(resolveStateCode('Gujarat')).toBe('24');
  });

  it('resolves lowercase name gujarat', () => {
    expect(resolveStateCode('gujarat')).toBe('24');
  });

  it('resolves uppercase name GUJARAT', () => {
    expect(resolveStateCode('GUJARAT')).toBe('24');
  });

  it('resolves name with leading/trailing whitespace', () => {
    expect(resolveStateCode('  gujarat  ')).toBe('24');
  });

  it('resolves MAHARASHTRA to 27', () => {
    expect(resolveStateCode('MAHARASHTRA')).toBe('27');
  });

  it('resolves Maharashtra to 27', () => {
    expect(resolveStateCode('Maharashtra')).toBe('27');
  });

  it('resolves West Bengal to 19', () => {
    expect(resolveStateCode('West Bengal')).toBe('19');
  });

  it('resolves Tamil Nadu to 33', () => {
    expect(resolveStateCode('Tamil Nadu')).toBe('33');
  });

  it('resolves Telangana to 36', () => {
    expect(resolveStateCode('Telangana')).toBe('36');
  });

  it('resolves Andhra Pradesh to 37', () => {
    expect(resolveStateCode('Andhra Pradesh')).toBe('37');
  });

  it('resolves Andhra Pradesh (old) to 28', () => {
    expect(resolveStateCode('Andhra Pradesh (old)')).toBe('28');
  });

  it('resolves Ladakh to 38', () => {
    expect(resolveStateCode('Ladakh')).toBe('38');
  });

  it('resolves Dadra and Nagar Haveli and Daman and Diu to 26', () => {
    expect(resolveStateCode('Dadra and Nagar Haveli and Daman and Diu')).toBe('26');
  });
});

describe('resolveStateCode - unknown or empty inputs', () => {
  it('returns empty string for empty string', () => {
    expect(resolveStateCode('')).toBe('');
  });

  it('returns empty string for whitespace-only string', () => {
    expect(resolveStateCode('   ')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(resolveStateCode(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(resolveStateCode(undefined)).toBe('');
  });

  it('returns empty string for unknown name Atlantis', () => {
    expect(resolveStateCode('Atlantis')).toBe('');
  });

  it('returns empty string for a 2-digit code not in the map (e.g. 25)', () => {
    // 25 was Daman and Diu, merged into 26; not in current map
    expect(resolveStateCode('25')).toBe('');
  });

  it('returns empty string for a numeric string that is not 2-digit (e.g. 240)', () => {
    expect(resolveStateCode('240')).toBe('');
  });

  it('returns empty string for a non-numeric 2-char string', () => {
    expect(resolveStateCode('GJ')).toBe('');
  });
});

describe('isIntraState', () => {
  it('returns true when both codes are equal and non-empty', () => {
    expect(isIntraState('24', '24')).toBe(true);
  });

  it('returns false when codes differ', () => {
    expect(isIntraState('24', '27')).toBe(false);
  });

  it('returns false when supplier code is empty', () => {
    expect(isIntraState('', '24')).toBe(false);
  });

  it('returns false when place-of-supply code is empty', () => {
    expect(isIntraState('24', '')).toBe(false);
  });

  it('returns false when both codes are empty', () => {
    expect(isIntraState('', '')).toBe(false);
  });

  it('returns false for different but valid codes', () => {
    expect(isIntraState('07', '33')).toBe(false);
  });
});
