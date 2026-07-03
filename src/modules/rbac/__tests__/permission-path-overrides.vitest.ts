import { describe, it, expect } from 'vitest';
import { applyPathOverrides } from '../permission-path-overrides';

describe('applyPathOverrides', () => {
  const rolePaths = [
    { path: 'team.directory.view', scope: 'self' as const },
    { path: 'team.profile.personal.edit', scope: 'self' as const },
  ];

  it('allow-override adds a new path at the given scope', () => {
    const out = applyPathOverrides(rolePaths, [
      { path: 'team.profile.bank.edit', allowed: true, scope: 'all' },
    ]);
    expect(out).toContainEqual({ path: 'team.profile.bank.edit', scope: 'all' });
  });

  it('allow-override upgrades the scope of an existing path', () => {
    const out = applyPathOverrides(rolePaths, [
      { path: 'team.directory.view', allowed: true, scope: 'all' },
    ]);
    expect(out).toContainEqual({ path: 'team.directory.view', scope: 'all' });
  });

  it('deny-override removes a role-granted path', () => {
    const out = applyPathOverrides(rolePaths, [
      { path: 'team.profile.personal.edit', allowed: false },
    ]);
    expect(out.find((g) => g.path === 'team.profile.personal.edit')).toBeUndefined();
  });

  it('applies overrides in array order — last write wins', () => {
    const out = applyPathOverrides(rolePaths, [
      { path: 'team.profile.pay.edit', allowed: true, scope: 'all' },
      { path: 'team.profile.pay.edit', allowed: false },
    ]);
    expect(out.find((g) => g.path === 'team.profile.pay.edit')).toBeUndefined();
  });

  it('defaults a scope-less allow-override to self (least-privilege)', () => {
    const out = applyPathOverrides([], [{ path: 'team.profile.job.edit', allowed: true }]);
    expect(out).toContainEqual({ path: 'team.profile.job.edit', scope: 'self' });
  });

  it('does not mutate the inputs', () => {
    const role = [{ path: 'team.directory.view', scope: 'self' as const }];
    applyPathOverrides(role, [{ path: 'team.directory.view', allowed: false }]);
    expect(role).toHaveLength(1);
  });

  it('second allow-override replaces the scope of an earlier allow-override', () => {
    const out = applyPathOverrides(
      [],
      [
        { path: 'team.profile.bank.edit', allowed: true, scope: 'all' },
        { path: 'team.profile.bank.edit', allowed: true },
      ],
    );
    expect(out).toContainEqual({ path: 'team.profile.bank.edit', scope: 'self' });
  });
});
