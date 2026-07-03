import { describe, it, expect } from 'vitest';
import { pathGrantSatisfies, type GrantedPermission } from '../permission-matcher';

const grants: GrantedPermission[] = [
  { path: 'team.profile.personal.view', scope: 'self' },
  { path: 'team.directory.view', scope: 'all' },
];

describe('pathGrantSatisfies', () => {
  it('denies when no grant matches the path (fail-closed)', () => {
    expect(pathGrantSatisfies(grants, { path: 'team.profile.bank.view' })).toBe(false);
    expect(pathGrantSatisfies([], { path: 'team.directory.view' })).toBe(false);
  });

  it('allows a matching path when no scope is required', () => {
    expect(pathGrantSatisfies(grants, { path: 'team.profile.personal.view' })).toBe(true);
  });

  it("treats 'all' as a superset of 'self'", () => {
    expect(pathGrantSatisfies(grants, { path: 'team.directory.view', scope: 'self' })).toBe(true);
  });

  it("requires 'all' when the route demands 'all'", () => {
    expect(pathGrantSatisfies(grants, { path: 'team.directory.view', scope: 'all' })).toBe(true);
    expect(pathGrantSatisfies(grants, { path: 'team.profile.personal.view', scope: 'all' })).toBe(
      false,
    );
  });
});
