import { describe, it, expect } from 'vitest';
import { flatGrantsToPaths, flatTeamOverrideToPathOverrides } from '../permission-path.converter';
import { isValidPermissionPath } from '../permission-registry';

describe('flatGrantsToPaths', () => {
  it('maps legacy team.view to the non-sensitive view leaves', () => {
    const out = flatGrantsToPaths([{ module: 'team', actions: ['view'], actionScopes: ['self'] }]);
    expect(out.map((g) => g.path).sort()).toEqual([
      'team.directory.view',
      'team.profile.documents.view',
      'team.profile.job.view',
      'team.profile.personal.view',
    ]);
    expect(out.every((g) => g.scope === 'self')).toBe(true);
  });

  it('maps create/remove to member lifecycle paths', () => {
    const out = flatGrantsToPaths([
      { module: 'team', actions: ['create', 'remove'], actionScopes: ['all', 'all'] },
    ]);
    expect(out.map((g) => g.path).sort()).toEqual(['team.member.create', 'team.member.delete']);
  });

  it('skips modules not in the registry', () => {
    expect(flatGrantsToPaths([{ module: 'finance', actions: ['view'] }])).toEqual([]);
  });

  it("widens scope to 'all' when a path is granted at both scopes (any order)", () => {
    const a = flatGrantsToPaths([
      { module: 'team', actions: ['view'], actionScopes: ['self'] },
      { module: 'team', actions: ['view'], actionScopes: ['all'] },
    ]);
    const b = flatGrantsToPaths([
      { module: 'team', actions: ['view'], actionScopes: ['all'] },
      { module: 'team', actions: ['view'], actionScopes: ['self'] },
    ]);
    expect(a.every((g) => g.scope === 'all')).toBe(true);
    expect(b.every((g) => g.scope === 'all')).toBe(true);
  });

  it('defaults a missing scope to self', () => {
    expect(flatGrantsToPaths([{ module: 'team', actions: ['create'] }])).toEqual([
      { path: 'team.member.create', scope: 'self' },
    ]);
  });

  it('only ever emits valid registry paths', () => {
    const out = flatGrantsToPaths([
      { module: 'team', actions: ['view', 'edit', 'create', 'remove', 'delete'] },
    ]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((g) => isValidPermissionPath(g.path))).toBe(true);
  });
});

describe('flatTeamOverrideToPathOverrides', () => {
  it('expands an allow override to the non-sensitive paths it currently grants', () => {
    const out = flatTeamOverrideToPathOverrides({
      module: 'team',
      action: 'edit',
      allowed: true,
      scope: 'all',
    });
    expect(out).toContainEqual({ path: 'team.profile.personal.edit', allowed: true, scope: 'all' });
    expect(out).toContainEqual({ path: 'team.profile.job.edit', allowed: true, scope: 'all' });
    expect(out.find((o) => o.path === 'team.profile.bank.edit')).toBeUndefined();
  });

  it('expands a deny override to every leaf the coarse action governed', () => {
    const out = flatTeamOverrideToPathOverrides({
      module: 'team',
      action: 'edit',
      allowed: false,
    });
    expect(out).toContainEqual({ path: 'team.profile.bank.edit', allowed: false });
    expect(out).toContainEqual({ path: 'team.profile.personal.edit', allowed: false });
  });

  it('returns [] for a non-team override', () => {
    expect(
      flatTeamOverrideToPathOverrides({ module: 'attendance', action: 'view', allowed: true }),
    ).toEqual([]);
  });
});

describe('flatGrantsToPaths — attendance / leave (Attendance rollout Phase A)', () => {
  it('maps attendance.view to only the member-facing record read (not analytics)', () => {
    const out = flatGrantsToPaths([
      { module: 'attendance', actions: ['view'], actionScopes: ['self'] },
    ]);
    expect(out).toEqual([{ path: 'attendance.record.view', scope: 'self' }]);
  });

  it('maps attendance.mark to record.mark + selfPunch.create', () => {
    const out = flatGrantsToPaths([
      { module: 'attendance', actions: ['mark'], actionScopes: ['self'] },
    ]);
    expect(out.map((g) => g.path).sort()).toEqual([
      'attendance.record.mark',
      'attendance.selfPunch.create',
    ]);
    expect(out.every((g) => g.scope === 'self')).toBe(true);
  });

  it('maps manage_regularizations to ONLY the self-service request lifecycle (no approval/settings)', () => {
    const out = flatGrantsToPaths([
      { module: 'attendance', actions: ['manage_regularizations'], actionScopes: ['all'] },
    ]);
    expect(out.map((g) => g.path).sort()).toEqual([
      'regularization.request.apply',
      'regularization.request.cancel',
      'regularization.request.view',
    ]);
    expect(out.some((g) => g.path === 'regularization.approval.decide')).toBe(false);
    expect(out.some((g) => g.path === 'regularization.settings.manage')).toBe(false);
  });

  it('maps leave.apply_leave to the self-service request + comp-off lifecycle', () => {
    const out = flatGrantsToPaths([
      { module: 'leave', actions: ['apply_leave'], actionScopes: ['self'] },
    ]);
    expect(out.map((g) => g.path).sort()).toEqual([
      'leave.compOff.apply',
      'leave.request.apply',
      'leave.request.cancel',
    ]);
  });

  it('maps leave.approve_leave to the approval + delegation capability', () => {
    const out = flatGrantsToPaths([
      { module: 'leave', actions: ['approve_leave'], actionScopes: ['all'] },
    ]);
    expect(out.map((g) => g.path).sort()).toEqual([
      'leave.approval.decide',
      'leave.compOff.decide',
      'leave.delegation.manage',
    ]);
  });

  it('only ever emits valid registry paths for attendance + leave', () => {
    const out = flatGrantsToPaths([
      {
        module: 'attendance',
        actions: ['view', 'mark', 'edit', 'export', 'manage_anomalies', 'manage_regularizations'],
      },
      { module: 'leave', actions: ['view', 'apply_leave', 'approve_leave', 'manage_leave'] },
    ]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((g) => isValidPermissionPath(g.path))).toBe(true);
  });
});
