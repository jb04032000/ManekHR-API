import { describe, it, expect } from 'vitest';
import {
  applyPermissionOverrides,
  permissionsSatisfy,
  type PermissionOverride,
} from '../guards/roles.guard';

describe('applyPermissionOverrides — per-member override merge (P3)', () => {
  describe('allow-override', () => {
    it('adds an action that the role does not grant', () => {
      const role = [{ module: 'team', actions: ['view'] }];
      const overrides: PermissionOverride[] = [{ module: 'team', action: 'edit', allowed: true }];
      const merged = applyPermissionOverrides(role, overrides);
      expect(permissionsSatisfy(merged, { module: 'team', action: 'edit' })).toBe(true);
      expect(permissionsSatisfy(merged, { module: 'team', action: 'view' })).toBe(true);
    });

    it('creates a brand-new module row when the role had nothing in that module', () => {
      const role = [{ module: 'team', actions: ['view'] }];
      const overrides: PermissionOverride[] = [{ module: 'salary', action: 'view', allowed: true }];
      const merged = applyPermissionOverrides(role, overrides);
      expect(permissionsSatisfy(merged, { module: 'salary', action: 'view' })).toBe(true);
    });

    it('upgrades scope from self to all when allow-override provides a wider scope', () => {
      const role = [{ module: 'attendance', actions: ['mark'], actionScopes: ['self' as const] }];
      const overrides: PermissionOverride[] = [
        { module: 'attendance', action: 'mark', allowed: true, scope: 'all' },
      ];
      const merged = applyPermissionOverrides(role, overrides);
      expect(
        permissionsSatisfy(merged, { module: 'attendance', action: 'mark', scope: 'all' }),
      ).toBe(true);
    });

    it('downgrades scope from all to self when allow-override provides a narrower scope', () => {
      const role = [{ module: 'attendance', actions: ['mark'], actionScopes: ['all' as const] }];
      const overrides: PermissionOverride[] = [
        { module: 'attendance', action: 'mark', allowed: true, scope: 'self' },
      ];
      const merged = applyPermissionOverrides(role, overrides);
      expect(
        permissionsSatisfy(merged, { module: 'attendance', action: 'mark', scope: 'self' }),
      ).toBe(true);
      expect(
        permissionsSatisfy(merged, { module: 'attendance', action: 'mark', scope: 'all' }),
      ).toBe(false);
    });

    it("defaults override scope to 'self' when not provided on a new row (least-privilege)", () => {
      const role = [{ module: 'team', actions: ['view'] }];
      const overrides: PermissionOverride[] = [
        { module: 'attendance', action: 'view', allowed: true },
      ];
      const merged = applyPermissionOverrides(role, overrides);
      expect(
        permissionsSatisfy(merged, { module: 'attendance', action: 'view', scope: 'self' }),
      ).toBe(true);
      expect(
        permissionsSatisfy(merged, { module: 'attendance', action: 'view', scope: 'all' }),
      ).toBe(false);
    });
  });

  describe('deny-override', () => {
    it('removes an action the role grants', () => {
      const role = [{ module: 'team', actions: ['view', 'edit'] }];
      const overrides: PermissionOverride[] = [{ module: 'team', action: 'edit', allowed: false }];
      const merged = applyPermissionOverrides(role, overrides);
      expect(permissionsSatisfy(merged, { module: 'team', action: 'edit' })).toBe(false);
      expect(permissionsSatisfy(merged, { module: 'team', action: 'view' })).toBe(true);
    });

    it('is a no-op when the role does not grant the action', () => {
      const role = [{ module: 'team', actions: ['view'] }];
      const overrides: PermissionOverride[] = [{ module: 'team', action: 'edit', allowed: false }];
      const merged = applyPermissionOverrides(role, overrides);
      expect(merged).toEqual([{ module: 'team', actions: ['view'], actionScopes: ['self'] }]);
    });

    it('removes the matching scope from actionScopes in lockstep', () => {
      const role = [
        {
          module: 'attendance',
          actions: ['view', 'mark'],
          actionScopes: ['all' as const, 'self' as const],
        },
      ];
      const overrides: PermissionOverride[] = [
        { module: 'attendance', action: 'view', allowed: false },
      ];
      const merged = applyPermissionOverrides(role, overrides);
      expect(merged[0].actions).toEqual(['mark']);
      expect(merged[0].actionScopes).toEqual(['self']);
    });
  });

  describe('immutability + edge cases', () => {
    it('does not mutate the input role permissions array', () => {
      const role = [{ module: 'team', actions: ['view'] }];
      const overrides: PermissionOverride[] = [{ module: 'team', action: 'edit', allowed: true }];
      applyPermissionOverrides(role, overrides);
      expect(role).toEqual([{ module: 'team', actions: ['view'] }]);
    });

    it('returns role permissions unchanged when overrides is empty', () => {
      const role = [{ module: 'team', actions: ['view', 'edit'] }];
      const merged = applyPermissionOverrides(role, []);
      expect(merged).toEqual([
        { module: 'team', actions: ['view', 'edit'], actionScopes: undefined },
      ]);
    });

    it('is idempotent when the same override is applied twice', () => {
      const role = [{ module: 'team', actions: ['view'] }];
      const overrides: PermissionOverride[] = [{ module: 'team', action: 'edit', allowed: true }];
      const once = applyPermissionOverrides(role, overrides);
      const twice = applyPermissionOverrides(once, overrides);
      expect(permissionsSatisfy(twice, { module: 'team', action: 'edit' })).toBe(true);
      expect(twice[0].actions.filter((a) => a === 'edit').length).toBe(1);
    });

    it('deny-then-allow sequence ends with action granted', () => {
      const role = [{ module: 'team', actions: ['view', 'edit'] }];
      const overrides: PermissionOverride[] = [
        { module: 'team', action: 'edit', allowed: false },
        { module: 'team', action: 'edit', allowed: true },
      ];
      const merged = applyPermissionOverrides(role, overrides);
      expect(permissionsSatisfy(merged, { module: 'team', action: 'edit' })).toBe(true);
    });

    it('allow-then-deny sequence ends with action denied', () => {
      const role = [{ module: 'team', actions: ['view'] }];
      const overrides: PermissionOverride[] = [
        { module: 'team', action: 'edit', allowed: true },
        { module: 'team', action: 'edit', allowed: false },
      ];
      const merged = applyPermissionOverrides(role, overrides);
      expect(permissionsSatisfy(merged, { module: 'team', action: 'edit' })).toBe(false);
    });
  });
});
