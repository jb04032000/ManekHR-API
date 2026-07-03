import { describe, it, expect } from 'vitest';
import { mergeBrowseCounts, type BrowseItemBase } from '../company-page-browse-counts.helpers';

/** A minimal base item as `CompanyPageService.browse` emits it (pre-merge). */
function baseItem(over: Partial<BrowseItemBase> = {}): BrowseItemBase {
  return {
    id: 'p1',
    ownerUserId: 'o1',
    slug: 'alpha',
    name: 'Alpha',
    logo: '',
    about: '',
    location: { district: '', city: '', state: '' },
    specialization: [],
    erpLinked: false,
    ...over,
  };
}

describe('mergeBrowseCounts', () => {
  it('returns an empty array for no items', () => {
    expect(mergeBrowseCounts([], new Map(), new Map(), new Map())).toEqual([]);
  });

  it('carries the owner id through to the public item (used to start a DM)', () => {
    const [item] = mergeBrowseCounts(
      [baseItem({ ownerUserId: 'owner-9' })],
      new Map(),
      new Map(),
      new Map(),
    );
    expect(item.ownerUserId).toBe('owner-9');
  });

  it('folds follower + open-job counts onto each item, defaulting missing to 0', () => {
    const items = [
      baseItem({ id: 'p1', ownerUserId: 'o1' }),
      baseItem({ id: 'p2', ownerUserId: 'o2', slug: 'beta', name: 'Beta' }),
    ];
    const merged = mergeBrowseCounts(items, new Map([['p1', 12]]), new Map([['p2', 4]]), new Map());
    expect(merged[0].followerCount).toBe(12);
    expect(merged[0].openJobsCount).toBe(0);
    expect(merged[1].followerCount).toBe(0);
    expect(merged[1].openJobsCount).toBe(4);
  });

  it('defaults productCount to 0 and fills it from the page-keyed map', () => {
    const items = [
      baseItem({ id: 'p1', ownerUserId: 'o1' }),
      baseItem({ id: 'p2', ownerUserId: 'o2' }),
    ];
    const merged = mergeBrowseCounts(items, new Map(), new Map(), new Map([['p1', 7]]));
    expect(merged[0].productCount).toBe(7);
    expect(merged[1].productCount).toBe(0);
  });

  it('attaches rating only when the owner has a rated aggregate', () => {
    const items = [
      baseItem({ id: 'p1', ownerUserId: 'o1' }),
      baseItem({ id: 'p2', ownerUserId: 'o2' }),
    ];
    const merged = mergeBrowseCounts(
      items,
      new Map(),
      new Map(),
      new Map(),
      new Map([['o1', { ratingAvg: 4.5, ratingCount: 12 }]]),
    );
    expect(merged[0].rating).toEqual({ ratingAvg: 4.5, ratingCount: 12 });
    expect(merged[1]).not.toHaveProperty('rating');
  });

  it('omits rating entirely when ratingCount is 0 (unrated owner)', () => {
    const items = [baseItem({ id: 'p1', ownerUserId: 'o1' })];
    const merged = mergeBrowseCounts(
      items,
      new Map(),
      new Map(),
      new Map(),
      new Map([['o1', { ratingAvg: 0, ratingCount: 0 }]]),
    );
    expect(merged[0]).not.toHaveProperty('rating');
  });

  it('shares one owner aggregate across that owner’s several pages', () => {
    const items = [
      baseItem({ id: 'p1', ownerUserId: 'o1' }),
      baseItem({ id: 'p2', ownerUserId: 'o1', slug: 'beta', name: 'Beta' }),
    ];
    const merged = mergeBrowseCounts(
      items,
      new Map(),
      new Map(),
      new Map(),
      new Map([['o1', { ratingAvg: 4.2, ratingCount: 5 }]]),
    );
    expect(merged[0].rating).toEqual({ ratingAvg: 4.2, ratingCount: 5 });
    expect(merged[1].rating).toEqual({ ratingAvg: 4.2, ratingCount: 5 });
  });

  it('preserves the base card fields verbatim', () => {
    const item = baseItem({
      id: 'p1',
      ownerUserId: 'o1',
      slug: 'alpha-textiles',
      name: 'Alpha Textiles',
      logo: 'logo.png',
      about: 'We weave.',
      location: { district: 'Surat', city: 'Surat', state: 'Gujarat' },
      specialization: ['weaving', 'dyeing'],
      erpLinked: true,
    });
    const [merged] = mergeBrowseCounts([item], new Map(), new Map(), new Map());
    expect(merged).toMatchObject({
      id: 'p1',
      slug: 'alpha-textiles',
      name: 'Alpha Textiles',
      logo: 'logo.png',
      about: 'We weave.',
      location: { district: 'Surat', city: 'Surat', state: 'Gujarat' },
      specialization: ['weaving', 'dyeing'],
      erpLinked: true,
      followerCount: 0,
      openJobsCount: 0,
      productCount: 0,
    });
  });
});

describe('roundRatingAvg', () => {
  it('rounds to one decimal place', async () => {
    const { roundRatingAvg } = await import('../company-page-browse-counts.helpers');
    expect(roundRatingAvg(4.25)).toBe(4.3);
    expect(roundRatingAvg(4.249)).toBe(4.2);
    expect(roundRatingAvg(5)).toBe(5);
    expect(roundRatingAvg(0)).toBe(0);
  });
});
