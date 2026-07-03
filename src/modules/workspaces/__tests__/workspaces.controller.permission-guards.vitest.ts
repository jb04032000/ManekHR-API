/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the controller — the
// transitive schema imports would otherwise trip vitest's esbuild
// "Cannot determine type" reflection error.
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import 'reflect-metadata';
import { WorkspacesController } from '../workspaces.controller';
import { PERMISSIONS_KEY } from '../../../common/guards/roles.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import {
  AUTHENTICATED_ONLY_KEY,
  REQUIRE_PERMISSION_KEY,
} from '../../../common/decorators/require-permission.decorator';
import { LEGACY_UNCLASSIFIED_KEY } from '../../../common/decorators/legacy-unclassified.decorator';
import { IS_ALLOW_WITHOUT_PIN_KEY } from '../../../common/decorators/allow-without-pin.decorator';

/**
 * RBAC Remediation Tier 1 (2026-05-18) — confirm that the previously-ungated
 * workspace endpoints now carry `@RequirePermissions(WORKSPACES, VIEW)`.
 *
 * Before this fix, four GET endpoints had no `@RequirePermissions` decorator,
 * allowing any authenticated member (regardless of role) to read full workspace
 * data + all member PII. This test locks the guard contract so a future
 * refactor that accidentally strips the decorator fails CI instead of silently
 * re-opening the leak.
 *
 * Pattern: reads the NestJS `PERMISSIONS_KEY` metadata set by
 * `@RequirePermissions(module, action)` → `SetMetadata(PERMISSIONS_KEY, …)`
 * directly off the prototype method, without mounting the DI container.
 */
describe('WorkspacesController — RBAC Remediation Tier 1 permission guards', () => {
  function getPermissionMeta(methodName: string): any {
    return Reflect.getMetadata(
      PERMISSIONS_KEY,
      (WorkspacesController.prototype as any)[methodName],
    );
  }

  /**
   * Confirms `@RequirePermissions(WORKSPACES, VIEW)` is present on the method.
   * Returns the metadata object so callers can assert on module + action.
   */
  function expectWorkspacesViewGuard(methodName: string) {
    const meta = getPermissionMeta(methodName);
    expect(
      meta,
      `Expected @RequirePermissions(WORKSPACES, VIEW) on WorkspacesController.${methodName} — missing guard re-opens the workspace data leak`,
    ).toBeDefined();
    expect(meta.module).toBe(AppModule.WORKSPACES);
    expect(meta.action).toBe(ModuleAction.VIEW);
    return meta;
  }

  it('findOne (GET :id) requires WORKSPACES.VIEW', () => {
    expectWorkspacesViewGuard('findOne');
  });

  it('getMembers (GET :id/members) requires WORKSPACES.VIEW', () => {
    expectWorkspacesViewGuard('getMembers');
  });

  it('getBranding (GET :id/branding) requires WORKSPACES.VIEW', () => {
    expectWorkspacesViewGuard('getBranding');
  });

  it('getEmployeeCodeSettings (GET :id/employee-code-settings) requires WORKSPACES.VIEW', () => {
    expectWorkspacesViewGuard('getEmployeeCodeSettings');
  });

  // Regression guard for already-protected write endpoints — confirms
  // they still carry WORKSPACES.EDIT so no future "polish" pass silently
  // down-grades them.
  it('update (PATCH :id) still requires WORKSPACES.EDIT', () => {
    const meta = getPermissionMeta('update');
    expect(meta).toBeDefined();
    expect(meta.module).toBe(AppModule.WORKSPACES);
    expect(meta.action).toBe(ModuleAction.EDIT);
  });

  it('remove (DELETE :id) still requires WORKSPACES.REMOVE', () => {
    const meta = getPermissionMeta('remove');
    expect(meta).toBeDefined();
    expect(meta.module).toBe(AppModule.WORKSPACES);
    expect(meta.action).toBe(ModuleAction.REMOVE);
  });

  // ── AC-2.1 — SEC-5 reclassification (LegacyUnclassified removed) ──────────
  describe('AC-2.1 route reclassification', () => {
    function authenticatedOnly(methodName: string): boolean {
      return !!Reflect.getMetadata(
        AUTHENTICATED_ONLY_KEY,
        (WorkspacesController.prototype as any)[methodName],
      );
    }

    it('the class no longer carries the @LegacyUnclassified debt marker', () => {
      expect(Reflect.getMetadata(LEGACY_UNCLASSIFIED_KEY, WorkspacesController)).toBeFalsy();
    });

    it('user-self routes are marked @AuthenticatedOnly', () => {
      for (const m of [
        'findAll',
        'create',
        'joinWithToken',
        'listRestorable',
        'restore',
        'leaveWorkspace',
      ]) {
        expect(authenticatedOnly(m), `${m} must be @AuthenticatedOnly`).toBe(true);
      }
    });

    // App-Lock onboarding fix (2026-06-20): a no-PIN user (e.g. a Connect-only
    // account that has never set a Quick PIN) must be able to create their FIRST
    // workspace, which precedes PIN setup. `create` carries @AllowWithoutPin so
    // the global PinUnlockGuard lets a PIN-less caller through (a PIN-holder who
    // is locked is still blocked — see pin-unlock.guard.vitest.ts). Without this
    // the create POST 423'd and the /auth/setup-workspace form failed.
    it('create (POST) carries @AllowWithoutPin for pre-PIN onboarding', () => {
      const allow = Reflect.getMetadata(
        IS_ALLOW_WITHOUT_PIN_KEY,
        (WorkspacesController.prototype as any).create,
      ) as boolean | undefined;
      expect(allow).toBe(true);
    });

    it('only create carries @AllowWithoutPin (not findAll / update / remove)', () => {
      for (const m of ['findAll', 'update', 'remove']) {
        const allow = Reflect.getMetadata(
          IS_ALLOW_WITHOUT_PIN_KEY,
          (WorkspacesController.prototype as any)[m],
        ) as boolean | undefined;
        expect(allow, `${m} must NOT be @AllowWithoutPin`).toBeFalsy();
      }
    });

    it('every public-surface method carries SOME explicit RBAC marker (no unmarked route)', () => {
      // Sample the methods that previously relied on the class-level marker —
      // each must now carry a real per-route marker so the deny-by-default guard
      // does not fail-closed them.
      const methodsWithMarker = [
        'findAll',
        'create',
        'listRestorable',
        'restore',
        'leaveWorkspace',
        'joinWithToken',
      ];
      for (const m of methodsWithMarker) {
        const hasAuthOnly = authenticatedOnly(m);
        const hasPerm = !!Reflect.getMetadata(
          PERMISSIONS_KEY,
          (WorkspacesController.prototype as any)[m],
        );
        const hasPathPerm = !!Reflect.getMetadata(
          REQUIRE_PERMISSION_KEY,
          (WorkspacesController.prototype as any)[m],
        );
        expect(hasAuthOnly || hasPerm || hasPathPerm, `${m} must carry an RBAC marker`).toBe(true);
      }
    });
  });
});
