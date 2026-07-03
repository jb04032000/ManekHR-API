import { describe, it, expect } from 'vitest';
import { understandQuery } from '../query-understanding';

/**
 * Unit coverage for `understandQuery` (S1.5) — the pure, rule-based
 * Query-Understanding seam. No ML: it strips `#` markers (keeping the bare word
 * searchable), extracts hashtags for alias->slug resolution, and detects a
 * small set of unambiguous intent phrases into facets. Unicode hashtags
 * (Gujarati / Hindi script) are first-class so emergent non-Latin vocabulary is
 * never dropped.
 */
describe('understandQuery', () => {
  it('strips the # marker, keeps the bare word in text, and extracts the hashtag', () => {
    const u = understandQuery('#zardozi designer');
    expect(u.text).toBe('zardozi designer');
    expect(u.hashtags).toEqual(['zardozi']);
    expect(u.facets).toEqual({});
  });

  it('detects an unambiguous open-to-work phrase into a facet and removes it from text', () => {
    const u = understandQuery('zari open to work');
    expect(u.text).toBe('zari');
    expect(u.facets.openToWork).toBe(true);
    expect(u.hashtags).toEqual([]);
  });

  it('lowercases and de-duplicates hashtags and text words', () => {
    const u = understandQuery('#Zari #ZARI');
    expect(u.hashtags).toEqual(['zari']);
    expect(u.text).toBe('zari');
  });

  it('does NOT treat a bare ambiguous word as an intent (conservative, no false positives)', () => {
    const u = understandQuery('available designer');
    expect(u.facets).toEqual({});
    expect(u.text).toBe('available designer');
  });

  it('returns empty fields for a blank query', () => {
    const u = understandQuery('   ');
    expect(u.text).toBe('');
    expect(u.hashtags).toEqual([]);
    expect(u.facets).toEqual({});
    expect(u.raw).toBe('   ');
  });

  it('keeps a non-Latin (Gujarati) hashtag intact', () => {
    const u = understandQuery('#જરી work');
    expect(u.hashtags).toEqual(['જરી']);
    expect(u.text).toContain('જરી');
  });

  // ── SRCH-I18N-1 — Gujarati -> Latin transliteration folded into the text ──

  it('folds the Latin romanization of a Gujarati query into the search text', () => {
    // `સાડી` romanizes to `sadi`, which the `saree` synonym group already lists,
    // so a Gujarati-script query reaches the same listings as `saree`.
    const u = understandQuery('સાડી');
    const words = u.text.split(' ');
    expect(words).toContain('સાડી'); // original kept (matches Gujarati-script content)
    expect(words).toContain('sadi'); // romanized variant added (reaches the synonym)
  });

  it('keeps the original Gujarati word AND adds the romanized form for a mixed query', () => {
    const u = understandQuery('જરી work');
    const words = u.text.split(' ');
    expect(words).toContain('જરી');
    expect(words).toContain('work');
    expect(words).toContain('jari'); // જરી -> jari (reaches the zari synonym group)
  });

  it('leaves a pure-Latin query unchanged (no spurious romanized tokens)', () => {
    const u = understandQuery('saree designer');
    expect(u.text).toBe('saree designer');
  });
});
