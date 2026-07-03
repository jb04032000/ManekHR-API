import { describe, it, expect } from 'vitest';
import { buildBoardFilter } from '../board-query.helpers';

/**
 * Unit coverage for the board filter builder's multi-select (plural) params.
 *
 * Contract (see the spec "Filter contract" + jobs-board-upgrade plan Task 1.1):
 *   - OR within a facet (csv -> $in), AND across facets.
 *   - district / machineType match case-insensitively.
 *   - plural supersedes the singular field when both are sent (back-compat keeps
 *     the singular "Similar jobs" deep link working).
 * Pure function (no DB), so this runs fast without Mongo.
 */
describe('buildBoardFilter multi-select', () => {
  const now = new Date('2026-06-08T00:00:00Z');

  it('ORs within a facet: districts -> $in (case-insensitive)', () => {
    const f = buildBoardFilter({ districts: 'Varachha,Ring Road' }, now) as any;
    // district matches either, case-insensitive
    expect(f['location.district']).toBeDefined();
    expect(f['location.district'].$in).toHaveLength(2);
    // each entry is a case-insensitive RegExp
    expect(f['location.district'].$in[0]).toBeInstanceOf(RegExp);
    expect(f['location.district'].$in[0].flags).toContain('i');
  });

  it('ANDs across facets: roles + employmentTypes both present', () => {
    const f = buildBoardFilter(
      { roles: 'karigar,operator', employmentTypes: 'full_time' },
      now,
    ) as any;
    expect(f.role).toEqual({ $in: ['karigar', 'operator'] });
    expect(f.employmentType).toEqual({ $in: ['full_time'] });
  });

  it('plural supersedes singular when both present', () => {
    const f = buildBoardFilter({ role: 'designer', roles: 'karigar,operator' }, now) as any;
    expect(f.role).toEqual({ $in: ['karigar', 'operator'] });
  });

  it('keeps the singular param working when no plural is sent', () => {
    const f = buildBoardFilter({ role: 'designer' }, now) as any;
    expect(f.role).toEqual('designer');
  });

  it('skills remain $in', () => {
    const f = buildBoardFilter({ skills: 'Aari,Zardozi' }, now) as any;
    expect(f.skills).toEqual({ $in: ['Aari', 'Zardozi'] });
  });

  it('machineTypes -> case-insensitive $in', () => {
    const f = buildBoardFilter({ machineTypes: 'Schiffli,Multi-head' }, now) as any;
    expect(f.machineType.$in).toHaveLength(2);
    expect(f.machineType.$in[0]).toBeInstanceOf(RegExp);
    expect(f.machineType.$in[0].flags).toContain('i');
  });
});
