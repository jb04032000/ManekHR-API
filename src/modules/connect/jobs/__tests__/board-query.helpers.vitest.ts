import { describe, it, expect } from 'vitest';
import { buildBoardFilter, buildBoardSort, type BoardQuery } from '../board-query.helpers';

/**
 * Pure unit tests for the Jobs board filter/sort builders. These power the
 * redesigned board's filter rail + sort control. No DB -- we assert the
 * Mongo query object the service will run.
 */
describe('buildBoardFilter', () => {
  const NOW = new Date('2026-06-02T12:00:00.000Z');

  it('defaults to open jobs only', () => {
    expect(buildBoardFilter({}, NOW)).toEqual({ status: 'open' });
  });

  it('includes filled roles when includeFilled is set (drops closed)', () => {
    expect(buildBoardFilter({ includeFilled: true }, NOW)).toEqual({
      status: { $in: ['open', 'filled'] },
    });
  });

  it('filters by category', () => {
    const f = buildBoardFilter({ category: 'embroidery-zari' }, NOW);
    expect(f.category).toBe('embroidery-zari');
  });

  it('filters by wageType and role', () => {
    const f = buildBoardFilter({ wageType: 'daily', role: 'karigar' }, NOW);
    expect(f.wageType).toBe('daily');
    expect(f.role).toBe('karigar');
  });

  it('filters by district on the nested location field (case-insensitive regex)', () => {
    // district is free-text vocab (users type any casing), so the singular param
    // matches via a case-insensitive $regex, not an exact string.
    const f = buildBoardFilter({ district: 'Varachha' }, NOW);
    expect(f['location.district']).toEqual({ $regex: /Varachha/i });
  });

  it('splits a comma-separated skills string into an $in match', () => {
    const f = buildBoardFilter({ skills: 'Aari, Zardozi ,, Sequins' }, NOW);
    expect(f.skills).toEqual({ $in: ['Aari', 'Zardozi', 'Sequins'] });
  });

  it('omits the skills filter when the string is empty/whitespace', () => {
    expect(buildBoardFilter({ skills: ' , ' }, NOW).skills).toBeUndefined();
  });

  it('maps payMin to wageMax>=min and payMax to wageMin<=max (range overlap)', () => {
    const f = buildBoardFilter({ payMin: 500, payMax: 800 }, NOW);
    expect(f.wageMax).toEqual({ $gte: 500 });
    expect(f.wageMin).toEqual({ $lte: 800 });
  });

  it('filters by posted-within window relative to now', () => {
    const f = buildBoardFilter({ postedWithinDays: 7 }, NOW);
    expect(f.createdAt).toEqual({ $gte: new Date('2026-05-26T12:00:00.000Z') });
  });

  it('ignores a non-positive posted-within window', () => {
    expect(buildBoardFilter({ postedWithinDays: 0 }, NOW).createdAt).toBeUndefined();
  });

  it('combines multiple filters', () => {
    const q: BoardQuery = { category: 'job-work', wageType: 'piece', district: 'Katargam' };
    expect(buildBoardFilter(q, NOW)).toEqual({
      status: 'open',
      category: 'job-work',
      wageType: 'piece',
      'location.district': { $regex: /Katargam/i },
    });
  });

  it('adds a case-insensitive regex over title/description/category/role for a text query', () => {
    const f = buildBoardFilter({ q: 'aari' }, NOW);
    expect(f.$or).toEqual([
      { title: /aari/i },
      { description: /aari/i },
      { category: /aari/i },
      { role: /aari/i },
    ]);
  });

  it('escapes regex metacharacters in the text query', () => {
    const f = buildBoardFilter({ q: 'a.b+c' }, NOW);
    expect(f.$or).toEqual([
      { title: /a\.b\+c/i },
      { description: /a\.b\+c/i },
      { category: /a\.b\+c/i },
      { role: /a\.b\+c/i },
    ]);
  });

  it('omits the text search when q is blank', () => {
    expect(buildBoardFilter({ q: '   ' }, NOW).$or).toBeUndefined();
  });
});

describe('buildBoardSort', () => {
  // Every sort now PREPENDS `{ isDemo: 1 }` (Demo Content scope) so real jobs sort
  // ahead of seeded sample jobs while the community grows; the user's chosen sort
  // is preserved as the secondary key.
  it('defaults to newest first, real before sample', () => {
    expect(buildBoardSort(undefined)).toEqual({ isDemo: 1, createdAt: -1 });
    expect(buildBoardSort('recent')).toEqual({ isDemo: 1, createdAt: -1 });
  });

  it('sorts by most openings, newest as tie-breaker, real before sample', () => {
    expect(buildBoardSort('openings')).toEqual({ isDemo: 1, openings: -1, createdAt: -1 });
  });

  it('treats the retired pay sort as newest-first (no 400, just falls through)', () => {
    // `pay` (wageMax desc) was removed because it mixed pay periods; a stale
    // ?sort=pay now falls through to the recent default.
    expect(buildBoardSort('pay')).toEqual({ isDemo: 1, createdAt: -1 });
  });

  it('sorts by closing soonest, newest as tie-breaker, real before sample', () => {
    expect(buildBoardSort('closing')).toEqual({ isDemo: 1, closesAt: 1, createdAt: -1 });
  });

  it('falls back to newest first for an unknown sort key', () => {
    expect(buildBoardSort('bogus')).toEqual({ isDemo: 1, createdAt: -1 });
  });
});
