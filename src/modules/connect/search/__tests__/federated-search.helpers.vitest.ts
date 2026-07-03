import { describe, it, expect } from 'vitest';
import {
  VERTICAL_WEIGHTS,
  orderGroupsByWeight,
  mergePeopleFacets,
  mergeListingFacets,
  composeSearchText,
} from '../federated-search.helpers';

/**
 * Unit coverage for the pure federation helpers (S1.5): per-vertical weight
 * ordering (the seam that ranks verticals against each other once 2+ are
 * live), facet merge (explicit query params ⊕ inferred intent), and the
 * alias->slug text composition that folds a hashtag's canonical slug into the
 * search text for extra recall.
 */
describe('federated-search helpers', () => {
  describe('orderGroupsByWeight', () => {
    it('orders groups by descending vertical weight', () => {
      const groups = [
        { type: 'listings', results: [] },
        { type: 'people', results: [] },
      ];
      const ordered = orderGroupsByWeight(groups, { people: 100, listings: 50 });
      expect(ordered.map((g) => g.type)).toEqual(['people', 'listings']);
    });

    it('treats an unweighted vertical as weight 0 (sorts last) and does not mutate input', () => {
      const groups = [
        { type: 'mystery', results: [] },
        { type: 'people', results: [] },
      ];
      const ordered = orderGroupsByWeight(groups, { people: 100 });
      expect(ordered.map((g) => g.type)).toEqual(['people', 'mystery']);
      expect(groups[0].type).toBe('mystery'); // original array untouched
    });

    it('defines a positive weight for the live people vertical', () => {
      expect(VERTICAL_WEIGHTS.people).toBeGreaterThan(0);
    });
  });

  describe('mergePeopleFacets', () => {
    it('unions skills, prefers explicit district, and ORs openToWork', () => {
      const merged = mergePeopleFacets(
        { skills: ['zari'], district: 'Surat' },
        { skills: ['kundan'], openToWork: true },
      );
      expect(merged.skills).toEqual(['zari', 'kundan']);
      expect(merged.district).toBe('Surat');
      expect(merged.openToWork).toBe(true);
    });

    it('omits absent facets entirely (no empty skills array)', () => {
      const merged = mergePeopleFacets({}, {});
      expect(merged).toEqual({});
    });
  });

  describe('mergeListingFacets', () => {
    it('carries a non-empty categoryIn set through (blended browse)', () => {
      const merged = mergeListingFacets({ categoryIn: ['consulting', 'maintenance'] });
      expect(merged.categoryIn).toEqual(['consulting', 'maintenance']);
    });

    it('drops an empty categoryIn so the clean-shape contract holds', () => {
      const merged = mergeListingFacets({ categoryIn: [] });
      expect(merged).not.toHaveProperty('categoryIn');
    });

    it('carries both a single category and categoryIn through (precedence resolved downstream)', () => {
      const merged = mergeListingFacets({ category: 'weaving', categoryIn: ['consulting'] });
      expect(merged.category).toBe('weaving');
      expect(merged.categoryIn).toEqual(['consulting']);
    });
  });

  describe('composeSearchText', () => {
    it('appends a canonical slug for extra recall, lowercased + de-duplicated', () => {
      expect(composeSearchText('zardozi', ['zari'])).toBe('zardozi zari');
      expect(composeSearchText('zari', ['Zari'])).toBe('zari'); // already present
    });

    it('returns the slugs alone when the text is blank', () => {
      expect(composeSearchText('', ['zari'])).toBe('zari');
    });
  });
});
