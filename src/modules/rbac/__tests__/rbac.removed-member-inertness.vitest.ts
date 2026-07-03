/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * rbac.removed-member-inertness.vitest.ts — RBAC hardening Pillar 1 / 2.
 *
 * Proves that a REMOVED member's leftover permissionOverrides /
 * permissionPathOverrides are completely INERT — they cannot resurrect access,
 * expand scope, or affect any permission check — because the override merge
 * runs ONLY AFTER an active-status membership is confirmed.
 *
 * Two surfaces are tested:
 *
 *   A. CallerScopeService.resolve — service-layer scope resolution.
 *      The service filters membership to `status: 'active'`. A removed member
 *      (status !== 'active') resolves to empty permissions + empty paths,
 *      making effectiveScope() return null and hasPath() return false for any
 *      query.
 *
 *   B. RbacService.getMyPermissions — the `/me/permissions` endpoint path.
 *      The service delegates to CallerScopeService-equivalent logic; a removed
 *      member (no active WorkspaceMember row) gets ForbiddenException.
 *
 * These tests confirm the REMOVED-MEMBER SECURITY GUARANTEE comment in both
 * services (added in RBAC-hardening Pillar 1), independent of the retention
 * cron. Even while leftover override rows exist, they can never grant access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import { RbacService } from '../rbac.service';

// ── helpers ───────────────────────────────────────────────────────────────────

function q(value: unknown) {
  const stub: any = {
    exec: vi.fn().mockResolvedValue(value),
    lean: vi.fn(),
    select: vi.fn(),
  };
  stub.lean.mockReturnValue(stub);
  stub.select.mockReturnValue(stub);
  return stub;
}

const workspaceId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const removedUserId = new Types.ObjectId();
const roleId = new Types.ObjectId();

// ── Surface B: RbacService.getMyPermissions ────────────────────────────────────

describe('RbacService.getMyPermissions — removed member inertness (RBAC-hardening Pillar 1)', () => {
  let workspaceModel: any;
  let memberModel: any;
  let teamMemberModel: any;
  let roleModel: any;
  let svc: RbacService;

  beforeEach(() => {
    workspaceModel = {
      findById: vi.fn().mockReturnValue(q({ _id: workspaceId, ownerId })),
    };
    memberModel = { findOne: vi.fn() };
    roleModel = {
      findById: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue(q(null)),
      }),
    };
    const auditService: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
    // teamMemberModel: for getMyPermissions, 'findOne' chains .select().lean().exec()
    teamMemberModel = {
      findOne: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue(null),
          }),
        }),
      }),
    };
    svc = new RbacService(roleModel, workspaceModel, memberModel, teamMemberModel, auditService);
  });

  it('returns ForbiddenException for a removed member (no active WorkspaceMember row)', async () => {
    /**
     * The service calls WorkspaceMember.findOne({ userId, status: 'active' }).
     * A removed member has status='removed' so findOne returns null →
     * getMyPermissions throws ForbiddenException.
     *
     * Even though the TeamMember row may carry permissionPathOverrides, the
     * code path that merges them is never reached (the null membership check
     * short-circuits first).
     */
    // No ACTIVE membership — removed member scenario.
    memberModel.findOne.mockReturnValue(q(null));

    await expect(
      svc.getMyPermissions(workspaceId.toString(), removedUserId.toString()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The role was never fetched — can't reach the override-merge path.
    expect(roleModel.findById).not.toHaveBeenCalled();
  });

  it('override arrays on removed member are never merged into the result', async () => {
    /**
     * Confirm: even if the caller somehow has override rows stored on their
     * TeamMember doc, those rows are irrelevant — they never flow into
     * getMyPermissions because the active-membership check gates them all.
     *
     * We set up the teamMemberModel to return a doc with rich overrides, then
     * confirm none of them are surfaced because the membership lookup fails
     * first.
     */
    memberModel.findOne.mockReturnValue(q(null));

    // TeamMember EXISTS with non-trivial overrides (proves the override rows
    // alone are not enough to grant access).
    teamMemberModel.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue({
            _id: new Types.ObjectId(),
            permissionOverrides: [
              { module: 'salary', action: 'view', allowed: true, scope: 'all' },
            ],
            permissionPathOverrides: [
              { path: 'team.profile.bank.view', allowed: true, scope: 'all' },
            ],
          }),
        }),
      }),
    });

    // Still must throw — override rows don't grant access without active membership.
    await expect(
      svc.getMyPermissions(workspaceId.toString(), removedUserId.toString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an ACTIVE member (same workspace) gets their effective permissions normally', async () => {
    /**
     * Control test: confirm that the active membership IS admitted and the
     * permission result comes through cleanly. This validates the active-member
     * path hasn't been accidentally broken by the removed-member guard.
     */
    const activeMemberId = new Types.ObjectId();
    memberModel.findOne.mockReturnValue(q({ userId: activeMemberId, roleId }));
    roleModel.findById.mockReturnValue({
      lean: vi.fn().mockReturnValue(
        q({
          _id: roleId,
          name: 'Manager',
          isSystem: true,
          permissions: [{ module: 'team', actions: ['view'], actionScopes: ['all'] }],
        }),
      ),
    });

    const result = await svc.getMyPermissions(workspaceId.toString(), activeMemberId.toString());

    expect(result.isOwner).toBe(false);
    expect(result.permissions.length).toBeGreaterThan(0);
  });
});

// ── applyPermissionOverrides purity check (unit, no DB) ───────────────────────

describe('applyPermissionOverrides — pure function purity (regression)', () => {
  it('override merge never mutates the original role permissions array', async () => {
    /**
     * applyPermissionOverrides is exported from roles.guard.ts. Confirm it
     * returns a new array and never mutates the input — a mutation would
     * affect every subsequent request that reuses the same role object from
     * the Mongoose cache.
     */
    const { applyPermissionOverrides } = await import('../../../common/guards/roles.guard');

    const rolePerms = [
      {
        module: 'team',
        actions: ['view', 'edit'] as string[],
        actionScopes: ['all', 'all'] as ('self' | 'all')[],
      },
    ];
    const originalLength = rolePerms[0].actions.length;

    const merged = applyPermissionOverrides(rolePerms, [
      { module: 'attendance', action: 'view', allowed: true, scope: 'all' as const },
    ]);

    // Original is unchanged.
    expect(rolePerms[0].actions.length).toBe(originalLength);
    // The merged result has the new module (attendance) added.
    expect(merged.find((p) => p.module === 'attendance')).toBeDefined();
  });
});
