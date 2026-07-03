import { describe, it, expect } from 'vitest';
import { computePermissionVersion } from '../permission-version';

describe('computePermissionVersion', () => {
  const baseArgs = {
    roleId: 'role-abc-123',
    rolePermissions: [
      {
        module: 'team',
        actions: ['view', 'edit'],
        actionScopes: ['all' as const, 'self' as const],
      },
    ],
    rolePermissionPaths: [{ path: 'team.profile.view', scope: 'all' as const }],
    memberPermissionOverrides: [
      { module: 'salary', action: 'view', allowed: true, scope: 'self' as const },
    ],
    memberPermissionPathOverrides: [{ path: 'team.bank.view', allowed: false }],
  };

  it('produces a 16-char hex string', () => {
    const v = computePermissionVersion(baseArgs);
    expect(v).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — same inputs produce same hash', () => {
    const v1 = computePermissionVersion(baseArgs);
    const v2 = computePermissionVersion({ ...baseArgs });
    expect(v1).toBe(v2);
  });

  it('changes when roleId changes', () => {
    const v1 = computePermissionVersion(baseArgs);
    const v2 = computePermissionVersion({ ...baseArgs, roleId: 'role-xyz-999' });
    expect(v1).not.toBe(v2);
  });

  it('changes when a flat permission override is added', () => {
    const v1 = computePermissionVersion(baseArgs);
    const v2 = computePermissionVersion({
      ...baseArgs,
      memberPermissionOverrides: [
        ...baseArgs.memberPermissionOverrides,
        { module: 'attendance', action: 'create', allowed: true, scope: 'all' as const },
      ],
    });
    expect(v1).not.toBe(v2);
  });

  it('changes when a path override changes', () => {
    const v1 = computePermissionVersion(baseArgs);
    const v2 = computePermissionVersion({
      ...baseArgs,
      memberPermissionPathOverrides: [{ path: 'team.bank.view', allowed: true }],
    });
    expect(v1).not.toBe(v2);
  });

  it('is order-independent for permissionOverrides array', () => {
    const v1 = computePermissionVersion({
      ...baseArgs,
      memberPermissionOverrides: [
        { module: 'salary', action: 'view', allowed: true },
        { module: 'attendance', action: 'edit', allowed: false },
      ],
    });
    const v2 = computePermissionVersion({
      ...baseArgs,
      memberPermissionOverrides: [
        { module: 'attendance', action: 'edit', allowed: false },
        { module: 'salary', action: 'view', allowed: true },
      ],
    });
    expect(v1).toBe(v2);
  });

  it('is order-independent for pathOverrides array', () => {
    const v1 = computePermissionVersion({
      ...baseArgs,
      memberPermissionPathOverrides: [
        { path: 'team.bank.view', allowed: false },
        { path: 'team.profile.edit', allowed: true },
      ],
    });
    const v2 = computePermissionVersion({
      ...baseArgs,
      memberPermissionPathOverrides: [
        { path: 'team.profile.edit', allowed: true },
        { path: 'team.bank.view', allowed: false },
      ],
    });
    expect(v1).toBe(v2);
  });

  it('is order-independent for rolePermissions module order', () => {
    const v1 = computePermissionVersion({
      ...baseArgs,
      rolePermissions: [
        { module: 'attendance', actions: ['view'] },
        { module: 'team', actions: ['view', 'edit'] },
      ],
    });
    const v2 = computePermissionVersion({
      ...baseArgs,
      rolePermissions: [
        { module: 'team', actions: ['view', 'edit'] },
        { module: 'attendance', actions: ['view'] },
      ],
    });
    expect(v1).toBe(v2);
  });

  it('handles empty inputs — returns a stable hash', () => {
    const v1 = computePermissionVersion({});
    const v2 = computePermissionVersion({});
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles null inputs gracefully', () => {
    const v = computePermissionVersion({
      roleId: null,
      rolePermissions: null,
      rolePermissionPaths: null,
      memberPermissionOverrides: null,
      memberPermissionPathOverrides: null,
    });
    expect(v).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces a different hash for null vs non-null roleId', () => {
    const withRole = computePermissionVersion({ roleId: 'abc' });
    const withoutRole = computePermissionVersion({ roleId: null });
    expect(withRole).not.toBe(withoutRole);
  });

  // C4 — action/scope pairing correctness
  it('action-order independence: swapping action+scope pairs produces same hash', () => {
    const v1 = computePermissionVersion({
      rolePermissions: [
        { module: 'team', actions: ['view', 'edit'], actionScopes: ['self', 'all'] },
      ],
    });
    const v2 = computePermissionVersion({
      rolePermissions: [
        { module: 'team', actions: ['edit', 'view'], actionScopes: ['all', 'self'] },
      ],
    });
    expect(v1).toBe(v2);
  });

  it('action scope change produces different hash', () => {
    const v1 = computePermissionVersion({
      rolePermissions: [{ module: 'team', actions: ['view'], actionScopes: ['self'] }],
    });
    const v2 = computePermissionVersion({
      rolePermissions: [{ module: 'team', actions: ['view'], actionScopes: ['all'] }],
    });
    expect(v1).not.toBe(v2);
  });

  // 2026-05-22 loop fix: the /me/permissions body (service, hydrated Mongoose
  // doc) and the X-Permission-Version header (interceptor, .lean() POJO) MUST
  // hash identically. Hydrated subdocs carry extra props (_id, $__, getters)
  // that lean POJOs don't. computePermissionVersion projects only canonical
  // fields, so those extra props must NOT affect the hash. If this test fails,
  // the FE will see permanent version drift and loop infinitely.
  it('ignores non-canonical row props (hydrated-vs-lean parity)', () => {
    const lean = computePermissionVersion({
      roleId: 'r1',
      rolePermissions: [
        { module: 'team', actions: ['view', 'edit'], actionScopes: ['all', 'self'] },
      ],
      rolePermissionPaths: [{ path: 'team.profile.view', scope: 'all' }],
      memberPermissionOverrides: [
        { module: 'salary', action: 'view', allowed: true, scope: 'self' },
      ],
      memberPermissionPathOverrides: [{ path: 'team.bank.view', allowed: false }],
    });
    // Same logical data but every row carries the junk fields a hydrated
    // Mongoose subdoc would expose when spread (the original loop trigger).
    const hydratedLike = computePermissionVersion({
      roleId: 'r1',
      rolePermissions: [
        {
          module: 'team',
          actions: ['view', 'edit'],
          actionScopes: ['all', 'self'],
          _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          $__: { activePaths: {} },
          $isNew: false,
        } as never,
      ],
      rolePermissionPaths: [
        { path: 'team.profile.view', scope: 'all', _id: 'bbbbbbbbbbbbbbbbbbbbbbbb' } as never,
      ],
      memberPermissionOverrides: [
        {
          module: 'salary',
          action: 'view',
          allowed: true,
          scope: 'self',
          _id: 'cccccccccccccccccccccccc',
        } as never,
      ],
      memberPermissionPathOverrides: [
        { path: 'team.bank.view', allowed: false, _id: 'dddddddddddddddddddddddd' } as never,
      ],
    });
    expect(lean).toBe(hydratedLike);
  });
});
