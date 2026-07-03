import { describe, it, expect } from 'vitest';
import { normalizePlace } from '../company-page-location.helpers';

describe('normalizePlace', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizePlace('  Surat  ')).toBe('Surat');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizePlace('Surat   City')).toBe('Surat City');
    expect(normalizePlace('  Ring   Road  ')).toBe('Ring Road');
  });

  it('normalizes tabs/newlines as whitespace', () => {
    expect(normalizePlace('Varachha\t\nzone')).toBe('Varachha zone');
  });

  it('leaves an already-clean value unchanged', () => {
    expect(normalizePlace('Bhavnagar')).toBe('Bhavnagar');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizePlace('   ')).toBe('');
  });
});
