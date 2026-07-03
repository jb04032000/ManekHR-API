import { describe, it, expect } from 'vitest';
import {
  CANONICAL_DISTRICT_TOKENS,
  CANONICAL_DISTRICT_NAMES,
  isRecognizedDistrict,
  lookupCanonicalDistrict,
  lookupCanonicalDistrictBySlug,
} from '../india-districts';

/**
 * Guards the canonical-district recognition + backfill helpers used by the boost
 * region-targeting fix. Keep in step with the india-geo dataset (a refresh
 * changes recognized values + collisions).
 */
describe('india-districts', () => {
  describe('isRecognizedDistrict', () => {
    it('recognizes a canonical district by display name (case-insensitive)', () => {
      expect(isRecognizedDistrict('Surat')).toBe(true);
      expect(isRecognizedDistrict('surat')).toBe(true);
      expect(isRecognizedDistrict('  SURAT  ')).toBe(true);
    });

    it('recognizes across separator/spacing differences (slug-ish vs spaced name)', () => {
      expect(isRecognizedDistrict('east godavari')).toBe(true);
      expect(isRecognizedDistrict('east-godavari')).toBe(true);
      expect(isRecognizedDistrict('eastgodavari')).toBe(true);
    });

    it('does NOT recognize blank / unknown free text', () => {
      expect(isRecognizedDistrict('')).toBe(false);
      expect(isRecognizedDistrict(null)).toBe(false);
      expect(isRecognizedDistrict(undefined)).toBe(false);
      expect(isRecognizedDistrict('Some Unknown Place')).toBe(false);
      expect(isRecognizedDistrict('Gandhidham')).toBe(false); // a city, not a district
    });
  });

  describe('lookupCanonicalDistrict', () => {
    it('resolves a unique district to NAME + slug + state', () => {
      const c = lookupCanonicalDistrict('surat');
      expect(c?.name).toBe('Surat');
      expect(c?.districtSlug).toBe('surat');
      expect(c?.stateSlug).toBe('gujarat');
    });

    it('returns null for blank / unrecognized values', () => {
      expect(lookupCanonicalDistrict('')).toBeNull();
      expect(lookupCanonicalDistrict(null)).toBeNull();
      expect(lookupCanonicalDistrict('Some Unknown Place')).toBeNull();
    });

    it('marks a cross-state collision as ambiguous (stateSlug null) but keeps the NAME', () => {
      // "Bilaspur" exists in both Chhattisgarh and Himachal Pradesh.
      const c = lookupCanonicalDistrict('Bilaspur');
      expect(c).not.toBeNull();
      expect(c?.name).toBe('Bilaspur');
      expect(c?.districtSlug).toBe('bilaspur');
      expect(c?.stateSlug).toBeNull(); // ambiguous -> backfill must not guess state
    });
  });

  describe('lookupCanonicalDistrictBySlug', () => {
    it('resolves a slug to the canonical NAME', () => {
      expect(lookupCanonicalDistrictBySlug('east-godavari')?.name).toBe('East Godavari');
      expect(lookupCanonicalDistrictBySlug('surat')?.name).toBe('Surat');
    });

    it('returns null for empty / unknown slugs', () => {
      expect(lookupCanonicalDistrictBySlug('')).toBeNull();
      expect(lookupCanonicalDistrictBySlug(null)).toBeNull();
      expect(lookupCanonicalDistrictBySlug('not-a-real-slug')).toBeNull();
    });
  });

  describe('exported sets', () => {
    it('CANONICAL_DISTRICT_TOKENS is a non-trivial recognition set including surat', () => {
      expect(CANONICAL_DISTRICT_TOKENS.size).toBeGreaterThan(500);
      expect(CANONICAL_DISTRICT_TOKENS.has('surat')).toBe(true);
    });

    it('CANONICAL_DISTRICT_NAMES is deduped by token (one entry per name token)', () => {
      expect(CANONICAL_DISTRICT_NAMES.length).toBe(CANONICAL_DISTRICT_TOKENS.size);
    });
  });
});
