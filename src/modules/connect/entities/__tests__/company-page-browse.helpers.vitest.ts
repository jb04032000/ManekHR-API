import { describe, it, expect } from 'vitest';
import { pickBrowseSort, toFacets } from '../company-page-browse.helpers';

describe('pickBrowseSort', () => {
  it('sorts by name ascending when sort=name', () => {
    expect(pickBrowseSort('name')).toEqual({ name: 1 });
  });

  it('sorts ERP-verified (consent-gated) first then newest when sort=erpVerified', () => {
    // ADR-0004: leads with a `verified` erpLink.status, not a dangling pointer.
    expect(pickBrowseSort('erpVerified')).toEqual({
      'erpLink.status': -1,
      erpWorkspaceId: -1,
      createdAt: -1,
    });
  });

  it('defaults to newest first for undefined / unknown sort', () => {
    expect(pickBrowseSort(undefined)).toEqual({ createdAt: -1 });
    expect(pickBrowseSort('recent')).toEqual({ createdAt: -1 });
    expect(pickBrowseSort('bogus')).toEqual({ createdAt: -1 });
  });
});

describe('toFacets', () => {
  it('maps group rows to clean facet entries', () => {
    expect(
      toFacets([
        { _id: 'weaving', count: 17 },
        { _id: 'dyeing', count: 14 },
      ]),
    ).toEqual([
      { value: 'weaving', count: 17 },
      { value: 'dyeing', count: 14 },
    ]);
  });

  it('drops blank tags and zero / missing counts', () => {
    expect(
      toFacets([
        { _id: '  ', count: 5 },
        { _id: 'printing', count: 0 },
        { _id: 'embroidery', count: 3 },
        { _id: null, count: 9 },
        { count: 2 },
      ]),
    ).toEqual([{ value: 'embroidery', count: 3 }]);
  });

  it('trims tags and caps to the limit', () => {
    const rows = [
      { _id: ' job-work ', count: 4 },
      { _id: 'a', count: 3 },
      { _id: 'b', count: 2 },
    ];
    expect(toFacets(rows, 2)).toEqual([
      { value: 'job-work', count: 4 },
      { value: 'a', count: 3 },
    ]);
  });
});
