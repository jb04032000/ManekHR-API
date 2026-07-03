import { describe, it, expect } from 'vitest';
import { assembleCompanyPageStats } from '../company-page-stats.helpers';

describe('assembleCompanyPageStats', () => {
  const pages = [
    { _id: 'p1', slug: 'a', name: 'Alpha', logo: '' },
    { _id: 'p2', slug: 'b', name: 'Beta', logo: 'l.png' },
  ];

  it('returns empty stats and zero totals for no pages', () => {
    expect(assembleCompanyPageStats([], new Map(), new Map(), new Map())).toEqual({
      pages: [],
      totals: { pages: 0, followers: 0, posts: 0, openJobs: 0 },
    });
  });

  it('stitches count maps onto pages, defaulting missing counts to 0', () => {
    const res = assembleCompanyPageStats(
      pages,
      new Map([['p1', 12]]),
      new Map([
        ['p1', 3],
        ['p2', 5],
      ]),
      new Map([['p2', 2]]),
    );
    expect(res.pages).toEqual([
      { pageId: 'p1', slug: 'a', name: 'Alpha', logo: '', followers: 12, posts: 3, openJobs: 0 },
      { pageId: 'p2', slug: 'b', name: 'Beta', logo: 'l.png', followers: 0, posts: 5, openJobs: 2 },
    ]);
  });

  it('rolls up KPI totals across all pages', () => {
    const res = assembleCompanyPageStats(
      pages,
      new Map([
        ['p1', 12],
        ['p2', 8],
      ]),
      new Map([
        ['p1', 3],
        ['p2', 5],
      ]),
      new Map([
        ['p1', 1],
        ['p2', 2],
      ]),
    );
    expect(res.totals).toEqual({ pages: 2, followers: 20, posts: 8, openJobs: 3 });
  });
});
