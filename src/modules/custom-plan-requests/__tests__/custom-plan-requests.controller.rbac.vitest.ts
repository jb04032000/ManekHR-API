/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the controller — the
// controller's transitive service/schema imports would otherwise trip vitest's
// reflect-metadata pipeline (same stub the sibling service spec uses).
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import {
  AdminCustomPlanRequestsController,
  CustomPlanRequestsController,
} from '../custom-plan-requests.controller';
import { LEGACY_UNCLASSIFIED_KEY } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * RBAC contract lock for the custom-plan-requests controllers.
 *
 * Incident (2026-06-25): both POST subscriptions/custom-plan-request and
 * GET admin/custom-plan-requests 403'd with "You do not have permission for
 * this action". Root cause was a stale running process (it had loaded the
 * controller into memory BEFORE the @LegacyUnclassified tag was compiled in);
 * the code itself was correct. This test does NOT reproduce that environmental
 * issue — instead it locks the underlying contract so the failure can never
 * become a real code regression: if a future edit strips @LegacyUnclassified
 * (or no per-route real marker replaces it), the global deny-by-default
 * RolesGuard would 403 these routes, and this test fails in CI first.
 *
 * It reads the marker via the EXACT path RolesGuard uses at step 5 —
 * `Reflector.getAllAndOverride(LEGACY_UNCLASSIFIED_KEY, [handler, class])` —
 * so it asserts what the guard actually resolves, not just raw class metadata.
 */
describe('custom-plan-requests controllers — RBAC marker contract', () => {
  const reflector = new Reflector();

  function resolvesLegacyMarker(controller: any, method: string): boolean {
    return (
      reflector.getAllAndOverride<boolean>(LEGACY_UNCLASSIFIED_KEY, [
        controller.prototype[method],
        controller,
      ]) === true
    );
  }

  it('user controller create (POST) resolves @LegacyUnclassified for RolesGuard', () => {
    expect(
      resolvesLegacyMarker(CustomPlanRequestsController, 'create'),
      'CustomPlanRequestsController.create lost its RBAC marker — deny-by-default RolesGuard will 403 the custom-plan-request lead form',
    ).toBe(true);
  });

  it('admin controller list (GET) resolves @LegacyUnclassified for RolesGuard', () => {
    expect(
      resolvesLegacyMarker(AdminCustomPlanRequestsController, 'list'),
      'AdminCustomPlanRequestsController.list lost its RBAC marker — deny-by-default RolesGuard will 403 the admin triage queue (before IsAdminGuard even runs)',
    ).toBe(true);
  });

  it('admin controller update (PATCH) resolves @LegacyUnclassified for RolesGuard', () => {
    expect(resolvesLegacyMarker(AdminCustomPlanRequestsController, 'update')).toBe(true);
  });

  it('the marker is set at class level on both controllers', () => {
    expect(Reflect.getMetadata(LEGACY_UNCLASSIFIED_KEY, CustomPlanRequestsController)).toBe(true);
    expect(Reflect.getMetadata(LEGACY_UNCLASSIFIED_KEY, AdminCustomPlanRequestsController)).toBe(
      true,
    );
  });
});
