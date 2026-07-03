import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { CallerScopeService } from '../caller-scope.service';

describe('CallerScopeService.effectivePathScope', () => {
  const svc = new CallerScopeService({} as never);

  it('returns the granted scope for a held path', () => {
    const ctx = {
      isOwner: false,
      teamMemberId: 't1',
      permissions: [],

      permissionPaths: [{ path: 'team.directory.view', scope: 'all' as const }],
    };
    expect(svc.effectivePathScope(ctx, 'team.directory.view')).toBe('all');
  });

  it('returns null for an unheld path', () => {
    const ctx = {
      isOwner: false,
      teamMemberId: 't1',
      permissions: [],

      permissionPaths: [],
    };
    expect(svc.effectivePathScope(ctx, 'team.directory.view')).toBeNull();
  });

  it('returns "all" for the owner regardless of paths', () => {
    const ctx = {
      isOwner: true,
      teamMemberId: null,
      permissions: [],

      permissionPaths: [],
    };
    expect(svc.effectivePathScope(ctx, 'team.directory.view')).toBe('all');
  });

  it('returns "self" for a self-scoped held path', () => {
    const ctx = {
      isOwner: false,
      teamMemberId: 't1',
      permissions: [],

      permissionPaths: [{ path: 'team.directory.view', scope: 'self' as const }],
    };
    expect(svc.effectivePathScope(ctx, 'team.directory.view')).toBe('self');
  });
});

describe('CallerScopeService.selfPathFilterValue', () => {
  const svc = new CallerScopeService({} as never);
  const anchor = new Types.ObjectId().toHexString();

  it('returns null for the owner — no narrowing', () => {
    const ctx = {
      isOwner: true,
      teamMemberId: anchor,
      permissions: [],

      permissionPaths: [],
    };
    expect(svc.selfPathFilterValue(ctx, 'team.directory.view')).toBeNull();
  });

  it('returns null for an all-scoped grant — no narrowing', () => {
    const ctx = {
      isOwner: false,
      teamMemberId: anchor,
      permissions: [],

      permissionPaths: [{ path: 'team.directory.view', scope: 'all' as const }],
    };
    expect(svc.selfPathFilterValue(ctx, 'team.directory.view')).toBeNull();
  });

  it('returns the teamMemberId ObjectId for a self-scoped grant', () => {
    const ctx = {
      isOwner: false,
      teamMemberId: anchor,
      permissions: [],

      permissionPaths: [{ path: 'team.directory.view', scope: 'self' as const }],
    };
    const out = svc.selfPathFilterValue(ctx, 'team.directory.view');
    expect(out).toBeInstanceOf(Types.ObjectId);
    expect(String(out)).toBe(anchor);
  });

  it('returns "no-self-anchor" for a self-scoped caller with no directory row', () => {
    const ctx = {
      isOwner: false,
      teamMemberId: null,
      permissions: [],

      permissionPaths: [{ path: 'team.directory.view', scope: 'self' as const }],
    };
    expect(svc.selfPathFilterValue(ctx, 'team.directory.view')).toBe('no-self-anchor');
  });
});
