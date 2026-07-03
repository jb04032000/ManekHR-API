import { describe, it, expect } from 'vitest';
import {
  gujaratiToLatin,
  hasGujarati,
  romanizeGujaratiTokens,
  romanizedIndexField,
} from '../transliteration';

/**
 * Unit coverage for the Gujarati -> Latin transliteration (SRCH-I18N-1). The
 * romanizer is the bridge that lets a Gujarati-script query reach the existing
 * Latin/Romanized textile synonym dictionary (e.g. `સાડી` -> `sadi`, which the
 * `saree` synonym group already lists). Pure + deterministic, so it unit-tests
 * in isolation with no Meili / Nest.
 */
describe('gujaratiToLatin', () => {
  it('romanizes સાડી to "sadi" (the headline checklist case → reaches the saree synonym)', () => {
    expect(gujaratiToLatin('સાડી')).toBe('sadi');
  });

  it('romanizes જરી to "jari" (Gujarati for zari → reaches the zari synonym group)', () => {
    expect(gujaratiToLatin('જરી')).toBe('jari');
  });

  it('applies the inherent vowel "a" to a bare consonant', () => {
    // ક + મ + લ — each consonant carries its inherent 'a' (no matra / virama).
    expect(gujaratiToLatin('કમલ')).toBe('kamala');
  });

  it('a matra replaces the inherent vowel of its consonant', () => {
    expect(gujaratiToLatin('કિ')).toBe('ki'); // ka -> ki via the i-matra
  });

  it('the virama (halant) suppresses the inherent vowel (consonant cluster)', () => {
    expect(gujaratiToLatin('ક્ય')).toBe('kya');
  });

  it('the anusvara becomes a nasal "n"', () => {
    expect(gujaratiToLatin('રં')).toBe('ran');
  });

  it('maps Gujarati digits to Latin digits', () => {
    expect(gujaratiToLatin('૫')).toBe('5');
  });

  it('passes Latin text through unchanged (idempotent on romanized input)', () => {
    expect(gujaratiToLatin('zari')).toBe('zari');
    expect(gujaratiToLatin('saree designer')).toBe('saree designer');
  });

  it('is total on the empty string', () => {
    expect(gujaratiToLatin('')).toBe('');
  });
});

describe('hasGujarati', () => {
  it('detects Gujarati script', () => {
    expect(hasGujarati('સાડી')).toBe(true);
    expect(hasGujarati('zari સાડી')).toBe(true);
  });

  it('is false for pure-Latin / empty input', () => {
    expect(hasGujarati('saree')).toBe(false);
    expect(hasGujarati('')).toBe(false);
  });
});

describe('romanizeGujaratiTokens', () => {
  it('romanizes ONLY the Gujarati tokens, leaving Latin tokens out', () => {
    expect(romanizeGujaratiTokens('zari સાડી work')).toEqual(['sadi']);
  });

  it('returns [] when there is no Gujarati script', () => {
    expect(romanizeGujaratiTokens('open to work')).toEqual([]);
    expect(romanizeGujaratiTokens('')).toEqual([]);
  });

  it('romanizes every Gujarati token in a multi-word Gujarati phrase', () => {
    // જરી સાડી -> ['jari', 'sadi']
    expect(romanizeGujaratiTokens('જરી સાડી')).toEqual(['jari', 'sadi']);
  });
});

describe('romanizedIndexField', () => {
  it('flattens string + array parts and romanizes only the Gujarati tokens', () => {
    expect(romanizedIndexField('zari saree', ['સાડી', 'cotton'])).toBe('sadi');
  });

  it('is empty for all-Latin parts (no index bloat on Latin-only docs)', () => {
    expect(romanizedIndexField('zari saree', ['cotton'])).toBe('');
  });

  it('tolerates undefined / null / empty parts', () => {
    expect(romanizedIndexField(undefined, null, '', [])).toBe('');
    expect(romanizedIndexField('જરી', undefined)).toBe('jari');
  });
});
