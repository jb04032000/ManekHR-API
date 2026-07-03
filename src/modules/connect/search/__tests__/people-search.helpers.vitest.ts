import { describe, it, expect } from 'vitest';
import {
  deriveExperienceYears,
  buildPeopleMeiliFilter,
  buildPeopleMongoConditions,
  hasPeopleFilters,
  normalizeSkillsForIndex,
} from '../people-search.helpers';

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;

describe('deriveExperienceYears', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('returns 0 when there are no experience items', () => {
    expect(deriveExperienceYears([], now)).toBe(0);
  });

  it('counts an ongoing engagement (to null) up to now', () => {
    const from = new Date(now.getTime() - 5 * YEAR);
    expect(deriveExperienceYears([{ from, to: null }], now)).toBe(5);
  });

  it('sums sequential engagements and floors to whole years', () => {
    const items = [
      { from: new Date(now.getTime() - 10 * YEAR), to: new Date(now.getTime() - 8 * YEAR) },
      { from: new Date(now.getTime() - 3 * YEAR), to: new Date(now.getTime() - 0.5 * YEAR) },
    ];
    expect(deriveExperienceYears(items, now)).toBe(4); // 2 + 2.5 = 4.5, floored
  });

  it('ignores items without a from date and never goes negative', () => {
    const items = [
      { to: new Date(now.getTime() - 1 * YEAR) },
      { from: new Date(now.getTime() + 1 * YEAR), to: null },
    ];
    expect(deriveExperienceYears(items, now)).toBe(0);
  });
});

describe('hasPeopleFilters', () => {
  it('is false for an empty filter set', () => {
    expect(hasPeopleFilters({})).toBe(false);
  });

  it('treats an empty skills array as no filter', () => {
    expect(hasPeopleFilters({ skills: [] })).toBe(false);
  });

  it('is true when any facet is set', () => {
    expect(hasPeopleFilters({ openToWork: true })).toBe(true);
    expect(hasPeopleFilters({ skills: ['zari'] })).toBe(true);
    expect(hasPeopleFilters({ district: 'Surat' })).toBe(true);
  });

  it('is true when only providingServices is set', () => {
    expect(hasPeopleFilters({ providingServices: true })).toBe(true);
  });
});

describe('buildPeopleMeiliFilter', () => {
  it('returns no clauses for empty filters', () => {
    expect(buildPeopleMeiliFilter({})).toEqual([]);
  });

  it('lowercases and quotes a skills IN clause', () => {
    expect(buildPeopleMeiliFilter({ skills: ['Zari', 'Aari'] })).toEqual([
      'skills IN ["zari", "aari"]',
    ]);
  });

  it('builds district and openToWork clauses', () => {
    expect(buildPeopleMeiliFilter({ district: 'Surat', openToWork: true })).toEqual([
      'district = "surat"',
      'openToWork = true',
    ]);
  });

  it('builds a providingServices clause', () => {
    expect(buildPeopleMeiliFilter({ providingServices: true })).toEqual([
      'providingServices = true',
    ]);
  });
});

describe('buildPeopleMongoConditions', () => {
  it('returns an empty object for empty filters', () => {
    expect(buildPeopleMongoConditions({})).toEqual({});
  });

  it('matches skills case-insensitively', () => {
    const cond = buildPeopleMongoConditions({ skills: ['Zari'] }) as { skills: { $in: RegExp[] } };
    expect(cond.skills.$in[0]).toBeInstanceOf(RegExp);
    expect(cond.skills.$in[0].source).toBe('^zari$');
    expect(cond.skills.$in[0].flags).toContain('i');
  });

  it('matches district case-insensitively and maps openToWork to openTo.work', () => {
    const cond = buildPeopleMongoConditions({ district: 'Surat', openToWork: true });
    expect((cond['district'] as RegExp).source).toBe('^surat$');
    expect(cond['openTo.work']).toBe(true);
  });

  it('maps providingServices to openTo.customOrders', () => {
    const cond = buildPeopleMongoConditions({ providingServices: true });
    expect(cond['openTo.customOrders']).toBe(true);
  });
});

describe('normalizeSkillsForIndex', () => {
  it('lowercases, trims, and de-duplicates', () => {
    expect(normalizeSkillsForIndex([' Zari ', 'zari', 'Aari'])).toEqual(['zari', 'aari']);
  });
});
