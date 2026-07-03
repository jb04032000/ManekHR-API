import { describe, it, expect } from 'vitest';
import { permissionsSatisfy } from '../guards/roles.guard';

describe('permissionsSatisfy — scope-aware match (Path C plumbing)', () => {
  describe('legacy / scope-agnostic requirement (no scope arg)', () => {
    it('grants when (module, action) match — no actionScopes set', () => {
      const role = [{ module: 'team', actions: ['view', 'edit'] }];
      expect(permissionsSatisfy(role, { module: 'team', action: 'view' })).toBe(true);
    });

    it('grants regardless of granted actionScopes (legacy decorator stays unchanged)', () => {
      const role = [{ module: 'team', actions: ['view'], actionScopes: ['self' as const] }];
      expect(permissionsSatisfy(role, { module: 'team', action: 'view' })).toBe(true);
    });

    it('denies when module does not match', () => {
      const role = [{ module: 'team', actions: ['view'] }];
      expect(permissionsSatisfy(role, { module: 'salary', action: 'view' })).toBe(false);
    });

    it('denies when action not in actions[]', () => {
      const role = [{ module: 'team', actions: ['view'] }];
      expect(permissionsSatisfy(role, { module: 'team', action: 'edit' })).toBe(false);
    });

    it('denies on empty role (no permissions)', () => {
      expect(permissionsSatisfy([], { module: 'team', action: 'view' })).toBe(false);
    });
  });

  describe("required scope = 'self'", () => {
    it("grants when granted scope is 'self'", () => {
      const role = [
        {
          module: 'attendance',
          actions: ['mark'],
          actionScopes: ['self' as const],
        },
      ];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'self',
        }),
      ).toBe(true);
    });

    it("grants when granted scope is 'all' ('all' is a strict superset of 'self')", () => {
      const role = [
        {
          module: 'attendance',
          actions: ['mark'],
          actionScopes: ['all' as const],
        },
      ];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'self',
        }),
      ).toBe(true);
    });

    it("grants when actionScopes[] is missing — defaults to 'self' (least-privilege)", () => {
      const role = [
        { module: 'attendance', actions: ['mark'] }, // no actionScopes
      ];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'self',
        }),
      ).toBe(true);
    });

    it("grants when actionScopes[idx] specifically is undefined — defaults to 'self' (partial scope)", () => {
      // mark has no scope; view has 'self'
      const role = [
        {
          module: 'attendance',
          actions: ['view', 'mark'],
          actionScopes: ['self' as const, undefined as unknown as 'self'],
        },
      ];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'self',
        }),
      ).toBe(true);
    });

    it('denies when no permission row matches the (module, action)', () => {
      const role = [
        {
          module: 'team',
          actions: ['view'],
          actionScopes: ['self' as const],
        },
      ];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'self',
        }),
      ).toBe(false);
    });
  });

  describe("required scope = 'all'", () => {
    it("grants when granted scope is 'all'", () => {
      const role = [
        {
          module: 'attendance',
          actions: ['mark'],
          actionScopes: ['all' as const],
        },
      ];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'all',
        }),
      ).toBe(true);
    });

    it("denies when actionScopes[] is missing — defaults to 'self', not 'all' (least-privilege)", () => {
      const role = [{ module: 'attendance', actions: ['mark'] }];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'all',
        }),
      ).toBe(false);
    });

    it("denies when granted scope is only 'self' — Worker can't act on others", () => {
      const role = [
        {
          module: 'attendance',
          actions: ['mark'],
          actionScopes: ['self' as const],
        },
      ];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'all',
        }),
      ).toBe(false);
    });

    it("denies when actionScopes[idx] specifically is 'self' (mixed-scope role)", () => {
      const role = [
        {
          module: 'attendance',
          actions: ['view', 'mark'],
          actionScopes: ['all' as const, 'self' as const],
        },
      ];
      // Workspace-wide view → granted; workspace-wide mark → denied.
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'view',
          scope: 'all',
        }),
      ).toBe(true);
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'all',
        }),
      ).toBe(false);
    });
  });

  describe('multi-row roles', () => {
    it('grants when any row satisfies (module, action, scope)', () => {
      const role = [
        { module: 'team', actions: ['view'] },
        {
          module: 'attendance',
          actions: ['view', 'mark'],
          actionScopes: ['all' as const, 'self' as const],
        },
        { module: 'salary', actions: ['view'] },
      ];
      expect(
        permissionsSatisfy(role, {
          module: 'attendance',
          action: 'mark',
          scope: 'self',
        }),
      ).toBe(true);
    });
  });
});
