import { describe, it, expect } from 'vitest';
import { HSN_SEEDS, matchHsn } from '../hsn-seeds';

// Pure plain-language HSN/SAC search (no Nest/Mongo). Verifies a Surat trader's terms map
// to the right code + rate and that ranking/limit behave.

const codesFor = (q: string) => matchHsn(HSN_SEEDS, q).map((s) => s.code);

describe('matchHsn', () => {
  it('finds a saree', () => {
    expect(codesFor('saree')).toContain('5007');
  });

  it('finds grey fabric (cotton + synthetic)', () => {
    const hits = codesFor('grey fabric');
    expect(hits).toContain('5208');
    expect(hits).toContain('5407');
  });

  it('maps Gujarati trade terms (taka / than -> fabric)', () => {
    expect(codesFor('taka').length).toBeGreaterThan(0);
    expect(codesFor('than')).toContain('5208');
  });

  it('dyeing job work -> 9988 at 18%', () => {
    const top = matchHsn(HSN_SEEDS, 'dyeing')[0];
    expect(top.code).toBe('9988');
    expect(top.gstRate).toBe(18);
  });

  it('dalali -> commission SAC 996111 at 18%', () => {
    const top = matchHsn(HSN_SEEDS, 'dalali')[0];
    expect(top.code).toBe('996111');
    expect(top.gstRate).toBe(18);
  });

  it('searches by code prefix', () => {
    expect(codesFor('5208')).toEqual(['5208']);
  });

  it('empty query returns nothing; limit is respected', () => {
    expect(matchHsn(HSN_SEEDS, '')).toEqual([]);
    expect(matchHsn(HSN_SEEDS, 'fabric', 2).length).toBeLessThanOrEqual(2);
  });
});

describe('HSN_SEEDS integrity', () => {
  it('has no duplicate codes and valid rates/types', () => {
    const seen = new Set<string>();
    for (const s of HSN_SEEDS) {
      expect(seen.has(s.code)).toBe(false);
      seen.add(s.code);
      expect(['hsn', 'sac']).toContain(s.type);
      expect(s.gstRate).toBeGreaterThanOrEqual(0);
      expect(s.synonyms.length).toBeGreaterThan(0);
    }
  });
});
