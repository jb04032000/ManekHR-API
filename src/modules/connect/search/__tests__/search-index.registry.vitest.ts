import { describe, it, expect } from 'vitest';
import {
  TEXTILE_SYNONYM_GROUPS,
  buildSynonymMap,
  mergeSynonymMaps,
} from '../dictionaries/textile-terms';
import {
  CONNECT_PEOPLE_INDEX,
  CONNECT_STOREFRONTS_INDEX,
  CONNECT_PAGES_INDEX,
  CONNECT_SEARCH_INDEXES,
} from '../search-index.registry';

/**
 * S1.1 - search foundation primitives. Pure-TS unit cover for the textile
 * synonym dictionary + the per-index settings registry. The behavioural search
 * paths (live Meili synonym expansion, Mongo fallback) are covered by the
 * S1.2 service spec + the Meili-ON smoke; this spec locks the data + the
 * composition logic, including the owner's "unknown terms are never gated"
 * guarantee expressed as the additive-merge invariant.
 */

describe('TEXTILE_SYNONYM_GROUPS', () => {
  it('declares only well-formed groups (>=2 lowercase, trimmed, unique terms)', () => {
    for (const group of TEXTILE_SYNONYM_GROUPS) {
      expect(group.terms.length).toBeGreaterThanOrEqual(2);
      for (const term of group.terms) {
        expect(term).toBe(term.toLowerCase());
        expect(term).toBe(term.trim());
        expect(term.length).toBeGreaterThan(0);
      }
      expect(new Set(group.terms).size).toBe(group.terms.length);
    }
  });

  it('covers the core textile families the owner named (#zari, #moti)', () => {
    const groups = TEXTILE_SYNONYM_GROUPS.map((g) => g.terms);
    const zari = groups.find((terms) => terms.includes('zari')) ?? [];
    const moti = groups.find((terms) => terms.includes('moti')) ?? [];
    expect(zari).toEqual(expect.arrayContaining(['zari', 'zardozi', 'jari']));
    expect(moti).toEqual(expect.arrayContaining(['moti', 'beads', 'pearl']));
  });
});

describe('buildSynonymMap', () => {
  const map = buildSynonymMap(TEXTILE_SYNONYM_GROUPS);

  it('expands a term to its group peers, bidirectionally, never to itself', () => {
    expect(map['zari']).toEqual(expect.arrayContaining(['zardozi', 'jari']));
    expect(map['zari']).not.toContain('zari');
    expect(map['zardozi']).toContain('zari');
  });

  it('emits lowercase keys and values only', () => {
    for (const [key, values] of Object.entries(map)) {
      expect(key).toBe(key.toLowerCase());
      for (const value of values) expect(value).toBe(value.toLowerCase());
    }
  });
});

describe('mergeSynonymMaps (the growth / no-gating seam)', () => {
  it('is purely additive: seed associations survive and new aliases are added', () => {
    const seed = buildSynonymMap(TEXTILE_SYNONYM_GROUPS);
    // an alias contribution for a term we never seeded (mirrors ConnectTag.aliases in S1.3)
    const aliasContribution = { zari: ['kasab-thread'] };
    const merged = mergeSynonymMaps(seed, aliasContribution);

    for (const peer of seed['zari']) expect(merged['zari']).toContain(peer);
    expect(merged['zari']).toContain('kasab-thread');
  });

  it('unions duplicate keys without duplicating values', () => {
    const merged = mergeSynonymMaps({ a: ['b', 'c'] }, { a: ['c', 'd'] });
    expect([...merged['a']].sort()).toEqual(['b', 'c', 'd']);
  });
});

describe('CONNECT_SEARCH_INDEXES registry', () => {
  const people = CONNECT_SEARCH_INDEXES.people;

  it('declares the connect_people index uid', () => {
    expect(people.uid).toBe('connect_people');
    expect(CONNECT_PEOPLE_INDEX).toBe('connect_people');
  });

  it('keeps the real content fields searchable so the dictionary never gates a direct match', () => {
    expect(people.settings.searchableAttributes).toEqual(
      expect.arrayContaining(['name', 'headline', 'skills']),
    );
  });

  it('provisions the textile synonyms onto the people index', () => {
    expect(people.settings.synonyms).toEqual(buildSynonymMap(TEXTILE_SYNONYM_GROUPS));
  });

  it('declares no stop word that would strip a seeded textile query term', () => {
    const stopWords = people.settings.stopWords ?? [];
    for (const term of TEXTILE_SYNONYM_GROUPS.flatMap((g) => g.terms)) {
      expect(stopWords).not.toContain(term);
    }
  });
});

describe('CONNECT_SEARCH_INDEXES — SRCH-VERT-1 storefronts + pages', () => {
  const storefronts = CONNECT_SEARCH_INDEXES.storefronts;
  const pages = CONNECT_SEARCH_INDEXES.pages;

  it('declares the two new index uids', () => {
    expect(storefronts.uid).toBe('connect_storefronts');
    expect(CONNECT_STOREFRONTS_INDEX).toBe('connect_storefronts');
    expect(pages.uid).toBe('connect_pages');
    expect(CONNECT_PAGES_INDEX).toBe('connect_pages');
  });

  it('makes the storefront name searchable and the owner id filterable (gate inheritance)', () => {
    expect(storefronts.settings.searchableAttributes).toEqual(
      expect.arrayContaining(['name', 'description', 'categories']),
    );
    // ownerUserId MUST be filterable so the block filter + author-active gate can
    // reason about the shop's owner exactly like listings.
    expect(storefronts.settings.filterableAttributes).toContain('ownerUserId');
  });

  it('makes the page name searchable and both owner id + kind filterable', () => {
    expect(pages.settings.searchableAttributes).toEqual(
      expect.arrayContaining(['name', 'about', 'tags']),
    );
    expect(pages.settings.filterableAttributes).toContain('ownerUserId');
    // `kind` filterable so institute vs business can be narrowed / labelled.
    expect(pages.settings.filterableAttributes).toContain('kind');
  });

  it('provisions the textile synonyms onto both new indexes', () => {
    expect(storefronts.settings.synonyms).toEqual(buildSynonymMap(TEXTILE_SYNONYM_GROUPS));
    expect(pages.settings.synonyms).toEqual(buildSynonymMap(TEXTILE_SYNONYM_GROUPS));
  });
});

describe('CONNECT_SEARCH_INDEXES — SRCH-I18N-1 transliteration recall', () => {
  const indexes = Object.values(CONNECT_SEARCH_INDEXES);

  it('adds `romanized` as the lowest-rank searchable attribute on every index', () => {
    for (const def of indexes) {
      const attrs = def.settings.searchableAttributes ?? [];
      expect(attrs).toContain('romanized');
      // Appended last = lowest ranking weight, so a romanized-recall hit never
      // outranks a real name / title / body match.
      expect(attrs[attrs.length - 1]).toBe('romanized');
    }
  });

  it('declares Gujarati locale tokenizer hints (localizedAttributes) on every index', () => {
    for (const def of indexes) {
      const locales = (def.settings.localizedAttributes ?? []).flatMap((l) => l.locales);
      expect(locales).toContain('guj');
    }
  });
});
