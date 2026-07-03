import { describe, it, expect } from 'vitest';
import {
  buildRfqBoardFilter,
  buildRfqBoardSort,
  type RfqBoardQuery,
} from '../rfq-board-query.helpers';

/**
 * Pure unit tests for the RFQ board filter/sort builders. These power the
 * redesigned RFQ board's filter rail + sort control. No DB -- we assert the
 * Mongo query object the service will run. Mirrors the Jobs board helper.
 */
describe('buildRfqBoardFilter', () => {
  const NOW = new Date('2026-06-02T12:00:00.000Z');

  it('defaults to open requests only', () => {
    expect(buildRfqBoardFilter({}, NOW)).toEqual({ status: 'open' });
  });

  it('includes closed and awarded requests when includeClosed is set', () => {
    expect(buildRfqBoardFilter({ includeClosed: true }, NOW)).toEqual({
      status: { $in: ['open', 'awarded', 'closed'] },
    });
  });

  it('filters by category', () => {
    expect(buildRfqBoardFilter({ category: 'embroidery-zari' }, NOW).category).toBe(
      'embroidery-zari',
    );
  });

  it('filters by district on the nested location field', () => {
    expect(buildRfqBoardFilter({ district: 'Varachha' }, NOW)['location.district']).toBe(
      'Varachha',
    );
  });

  it('maps budgetMin to budgetMax>=min and budgetMax to budgetMin<=max (range overlap)', () => {
    const f = buildRfqBoardFilter({ budgetMin: 5000, budgetMax: 20000 }, NOW);
    expect(f.budgetMax).toEqual({ $gte: 5000 });
    expect(f.budgetMin).toEqual({ $lte: 20000 });
  });

  it('filters by posted-within window relative to now', () => {
    expect(buildRfqBoardFilter({ postedWithinDays: 7 }, NOW).createdAt).toEqual({
      $gte: new Date('2026-05-26T12:00:00.000Z'),
    });
  });

  it('ignores a non-positive posted-within window', () => {
    expect(buildRfqBoardFilter({ postedWithinDays: 0 }, NOW).createdAt).toBeUndefined();
  });

  it('adds a case-insensitive title/description/category regex for a text query', () => {
    const f = buildRfqBoardFilter({ q: 'cotton' }, NOW);
    expect(f.$or).toEqual([
      { title: /cotton/i },
      { description: /cotton/i },
      { category: /cotton/i },
    ]);
  });

  it('escapes regex metacharacters in the text query', () => {
    const f = buildRfqBoardFilter({ q: 'a.b+c' }, NOW);
    expect(f.$or).toEqual([
      { title: /a\.b\+c/i },
      { description: /a\.b\+c/i },
      { category: /a\.b\+c/i },
    ]);
  });

  it('omits the text search when q is blank', () => {
    expect(buildRfqBoardFilter({ q: '  ' }, NOW).$or).toBeUndefined();
  });

  it('combines multiple filters', () => {
    const q: RfqBoardQuery = { category: 'job-work', district: 'Katargam' };
    expect(buildRfqBoardFilter(q, NOW)).toEqual({
      status: 'open',
      category: 'job-work',
      'location.district': 'Katargam',
    });
  });

  // The closing-soon window uses LOCAL start-of-day (same as boardStats), so the
  // expectations derive it the same way instead of hardcoding a UTC instant.
  const dayStart = new Date(NOW);
  dayStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(dayStart.getTime() + 4 * 24 * 60 * 60 * 1000);

  it('plural districts supersede the singular as a case-insensitive $in', () => {
    const f = buildRfqBoardFilter({ districts: 'Varachha, Ring Road', district: 'Sachin' }, NOW);
    expect(f['location.district']).toEqual({ $in: [/^Varachha$/i, /^Ring Road$/i] });
  });

  it('selecting only the closing-soon bucket bounds neededBy to the window', () => {
    const f = buildRfqBoardFilter({ statuses: 'closing-soon' }, NOW);
    expect(f.status).toBe('open');
    expect(f.neededBy).toEqual({ $gte: dayStart, $lt: windowEnd });
  });

  it('selecting the open bucket excludes the closing-soon window', () => {
    const f = buildRfqBoardFilter({ statuses: 'open' }, NOW);
    expect(f.status).toBe('open');
    expect(f.$or).toEqual([
      { neededBy: null },
      { neededBy: { $lt: dayStart } },
      { neededBy: { $gte: windowEnd } },
    ]);
  });

  it('multiple status buckets OR together', () => {
    const f = buildRfqBoardFilter({ statuses: 'open,closing-soon' }, NOW);
    const or = f.$or as Array<Record<string, unknown>>;
    expect(or).toHaveLength(2);
    expect(or.every((c) => c.status === 'open')).toBe(true);
  });

  it('budget filter excludes negotiable requests by default', () => {
    const f = buildRfqBoardFilter({ budgetMin: 5000 }, NOW);
    expect(f.budgetMax).toEqual({ $gte: 5000 });
  });

  it('includeNegotiable ORs the null-budget requests back into a budget filter', () => {
    const f = buildRfqBoardFilter({ budgetMin: 5000, includeNegotiable: true }, NOW);
    expect(f.budgetMax).toBeUndefined();
    expect(f.$or).toEqual([{ budgetMax: { $gte: 5000 } }, { budgetMin: null, budgetMax: null }]);
  });

  it('composes status buckets + text search via $and (no $or clobbering)', () => {
    const f = buildRfqBoardFilter({ statuses: 'closing-soon', q: 'silk' }, NOW);
    const and = f.$and as Array<Record<string, unknown>>;
    expect(and).toHaveLength(2);
    expect(and[0].status).toBe('open');
    expect(and[1].$or).toEqual([
      { title: /silk/i },
      { description: /silk/i },
      { category: /silk/i },
    ]);
  });
});

describe('buildRfqBoardSort', () => {
  // isDemo leads EVERY branch (real first; false < true) so seeded demo/sample
  // RFQs sink below real ones within each sort, without being filtered out.
  it('defaults to newest first (real before demo)', () => {
    expect(buildRfqBoardSort(undefined)).toEqual({ isDemo: 1, createdAt: -1 });
    expect(buildRfqBoardSort('recent')).toEqual({ isDemo: 1, createdAt: -1 });
  });

  it('sorts by highest budget (real before demo)', () => {
    expect(buildRfqBoardSort('budget')).toEqual({ isDemo: 1, budgetMax: -1 });
  });

  it('sorts by closing soonest (needed-by), newest as tie-breaker (real before demo)', () => {
    expect(buildRfqBoardSort('closing')).toEqual({ isDemo: 1, neededBy: 1, createdAt: -1 });
  });

  it('falls back to newest first for an unknown sort key (real before demo)', () => {
    expect(buildRfqBoardSort('bogus')).toEqual({ isDemo: 1, createdAt: -1 });
  });
});
