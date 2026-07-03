/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
/**
 * rbac.service.workspace-isolation.vitest.ts — RBAC hardening Pillar 2.
 *
 * Pins the cross-workspace isolation and role-delete-gate guarantees added in
 * the RBAC hardening pass (2026-06-15):
 *
 * 1. CROSS-WORKSPACE ISOLATION — role delete count is now workspace-scoped
 *    (`workspaceId` AND filter). A member in workspace B with the SAME roleId
 *    must NOT block deleting that role in workspace A.  The fix in RbacService.remove
 *    changed `countDocuments({ roleId })` → `countDocuments({ roleId, workspaceId })`.
 *
 * 2. ROLE-DELETE GATE — deleting a role held by a member in the SAME workspace
 *    (any status — active or removed) must throw BadRequestException. The count
 *    spans ALL statuses so a removed member's FK still protects the role.
 *
 * 3. ROLE NOT FOUND ACROSS TENANTS — `RbacService.remove` fetches the role via
 *    `findOne({ _id, workspaceId })`. A roleId that belongs to workspace A
 *    returns null when queried with workspace B's id → NotFoundException, so
 *    a workspace-B actor cannot delete a workspace-A role.
 */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose before any schema imports to avoid reflect-metadata
// errors under vitest's esbuild transform. We never use Mongoose here.
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
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RbacService } from '../rbac.service';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal chainable Mongoose query stub that resolves to `value`. */
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

// ── shared IDs ───────────────────────────────────────────────────────────────
const wsAId = new Types.ObjectId(); // workspace A
const wsBId = new Types.ObjectId(); // workspace B (the intruding tenant)
const ownerAId = new Types.ObjectId(); // owner of workspace A
const ownerBId = new Types.ObjectId(); // owner of workspace B (unused in most cases)
const roleId = new Types.ObjectId(); // a custom role in workspace A

// ── factory — builds an RbacService with model stubs ─────────────────────────
function makeService(overrides?: { workspaceDoc?: any; roleDoc?: any; memberCount?: number }) {
  const wsDoc = overrides?.workspaceDoc ?? { _id: wsAId, ownerId: ownerAId };
  const roleDoc =
    overrides?.roleDoc !== undefined
      ? overrides.roleDoc
      : { _id: roleId, workspaceId: wsAId, isSystem: false };
  const count = overrides?.memberCount ?? 0;

  const workspaceModel: any = { findById: vi.fn().mockReturnValue(q(wsDoc)) };
  const roleModel: any = {
    findOne: vi.fn().mockReturnValue(q(roleDoc)),
    // deleteOne attached to the role doc itself (Mongoose instance method)
  };
  const memberModel: any = {
    countDocuments: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(count),
    }),
    findOne: vi.fn().mockReturnValue(q(null)),
  };
  const teamMemberModel: any = {
    findOne: vi.fn().mockReturnValue(q(null)),
    aggregate: vi.fn().mockReturnValue(q([])),
  };
  const auditService: any = { logEvent: vi.fn().mockResolvedValue(undefined) };

  return {
    svc: new RbacService(roleModel, workspaceModel, memberModel, teamMemberModel, auditService),
    workspaceModel,
    roleModel,
    memberModel,
  };
}

// ── 1. CROSS-WORKSPACE ISOLATION — countDocuments is workspace-scoped ─────────

describe('RbacService.remove — workspace-scoped member count (RBAC-hardening Pillar 2)', () => {
  it('deletes the role successfully when the count query is scoped to the correct workspace', async () => {
    // The role has ZERO members in workspace A — safe to delete.
    const deleteOne = vi.fn().mockResolvedValue(undefined);
    const roleDoc = { _id: roleId, workspaceId: wsAId, isSystem: false, deleteOne };

    const { svc, memberModel } = makeService({ roleDoc, memberCount: 0 });

    await svc.remove(wsAId.toString(), roleId.toString(), ownerAId.toString());

    // Verify the countDocuments call includes workspaceId — the isolation fix.
    expect(memberModel.countDocuments).toHaveBeenCalledTimes(1);
    const filter = memberModel.countDocuments.mock.calls[0][0];
    expect(filter.workspaceId).toBeDefined();
    // The workspaceId must equal wsAId (cast to ObjectId in the service).
    expect(filter.workspaceId.toString()).toBe(wsAId.toString());
    expect(filter.roleId.toString()).toBe(roleId.toString());
    // The role was actually hard-deleted.
    expect(deleteOne).toHaveBeenCalledTimes(1);
  });

  it('blocks deletion when members exist IN THE SAME WORKSPACE (count > 0)', async () => {
    // 3 members hold this role in workspace A — deletion must be blocked.
    const deleteOne = vi.fn().mockResolvedValue(undefined);
    const roleDoc = { _id: roleId, workspaceId: wsAId, isSystem: false, deleteOne };

    const { svc } = makeService({ roleDoc, memberCount: 3 });

    await expect(
      svc.remove(wsAId.toString(), roleId.toString(), ownerAId.toString()),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The role must NOT be deleted.
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it('deletes the role when a same-named roleId exists only in workspace B (cross-tenant isolation)', async () => {
    /**
     * Scenario: workspace B has a member assigned to a DIFFERENT role whose
     * _id happens to be roleId (in practice impossible since ObjectIds are
     * globally unique, but the workspace-scoped count makes the guarantee
     * explicit and future-proof). The service scopes the count to wsA →
     * count = 0 for wsA → deletion allowed.
     *
     * What we prove here: the count filter always ANDs workspaceId = wsA so
     * a cross-workspace member row can never inflate the count and block the
     * workspace-A delete.
     */
    const deleteOne = vi.fn().mockResolvedValue(undefined);
    const roleDoc = { _id: roleId, workspaceId: wsAId, isSystem: false, deleteOne };

    const memberModel: any = {
      // Simulate: un-scoped count would return 1 (wsB member), scoped returns 0 (wsA only).
      countDocuments: vi.fn().mockImplementation((filter: any) => {
        // Only return 1 if the workspaceId filter is ABSENT (un-scoped old behaviour).
        const hasWsFilter = filter.workspaceId !== undefined;
        const scopedCount = hasWsFilter ? 0 : 1;
        return { exec: vi.fn().mockResolvedValue(scopedCount) };
      }),
      findOne: vi.fn().mockReturnValue(q(null)),
    };
    const workspaceModel: any = {
      findById: vi.fn().mockReturnValue(q({ _id: wsAId, ownerId: ownerAId })),
    };
    const roleModel: any = { findOne: vi.fn().mockReturnValue(q(roleDoc)) };
    const teamMemberModel: any = {
      findOne: vi.fn().mockReturnValue(q(null)),
    };
    const auditService: any = { logEvent: vi.fn().mockResolvedValue(undefined) };

    const svc = new RbacService(
      roleModel,
      workspaceModel,
      memberModel,
      teamMemberModel,
      auditService,
    );

    // Should succeed: workspace-scoped count = 0, so no block.
    await svc.remove(wsAId.toString(), roleId.toString(), ownerAId.toString());
    expect(deleteOne).toHaveBeenCalledTimes(1);
  });
});

// ── 2. ROLE-DELETE GATE — ANY status blocks deletion ──────────────────────────

describe('RbacService.remove — role-delete gate spans all statuses (RBAC-hardening OQ-R4)', () => {
  it('blocks deletion when a REMOVED member still holds the roleId', async () => {
    /**
     * OQ-R4 decision: Option A — current behavior is correct. The count is
     * ALL statuses (no `status: 'active'` filter in countDocuments). A
     * removed member's WorkspaceMember.roleId is part of the audit trail;
     * deleting the role would orphan that FK.
     */
    const deleteOne = vi.fn().mockResolvedValue(undefined);
    const roleDoc = { _id: roleId, workspaceId: wsAId, isSystem: false, deleteOne };

    // Count = 1 regardless of status (1 removed member still assigned).
    const { svc } = makeService({ roleDoc, memberCount: 1 });

    await expect(
      svc.remove(wsAId.toString(), roleId.toString(), ownerAId.toString()),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(deleteOne).not.toHaveBeenCalled();
  });

  it('allows deletion when count = 0 (no members, any status)', async () => {
    const deleteOne = vi.fn().mockResolvedValue(undefined);
    const roleDoc = { _id: roleId, workspaceId: wsAId, isSystem: false, deleteOne };

    const { svc } = makeService({ roleDoc, memberCount: 0 });

    await expect(
      svc.remove(wsAId.toString(), roleId.toString(), ownerAId.toString()),
    ).resolves.toBeUndefined();

    expect(deleteOne).toHaveBeenCalledTimes(1);
  });
});

// ── 3. CROSS-TENANT ROLE LOOKUP — workspace-scoped findOne blocks cross-tenant reads ──

describe('RbacService.remove — role lookup is workspace-scoped (RBAC-hardening Pillar 2)', () => {
  it('throws NotFoundException when roleId belongs to workspace A but caller provides workspace B id', async () => {
    /**
     * `findOne({ _id: roleId, workspaceId: wsBId })` returns null because
     * the role lives in wsA, not wsB. NotFoundException is the correct response —
     * no information is leaked about whether the role exists elsewhere.
     */
    const workspaceModel: any = {
      // Workspace B exists and ownerBId is the owner.
      findById: vi.fn().mockReturnValue(q({ _id: wsBId, ownerId: ownerBId })),
    };
    const roleModel: any = {
      // Simulates: findOne({ _id: roleId, workspaceId: wsBId }) → null
      // because the role's workspaceId is wsA, not wsB.
      findOne: vi.fn().mockReturnValue(q(null)),
    };
    const memberModel: any = {
      countDocuments: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(0) }),
      findOne: vi.fn().mockReturnValue(q(null)),
    };
    const teamMemberModel: any = { findOne: vi.fn().mockReturnValue(q(null)) };
    const auditService: any = { logEvent: vi.fn().mockResolvedValue(undefined) };

    const svc = new RbacService(
      roleModel,
      workspaceModel,
      memberModel,
      teamMemberModel,
      auditService,
    );

    // Workspace B actor tries to delete a role that only exists in workspace A.
    await expect(
      svc.remove(wsBId.toString(), roleId.toString(), ownerBId.toString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── 4. NON-OWNER CANNOT DELETE SYSTEM ROLES (regression) ─────────────────────

describe('RbacService.remove — system-role protection (regression)', () => {
  it('throws ForbiddenException when a non-owner tries to delete a system role', async () => {
    const nonOwnerId = new Types.ObjectId();
    const systemRoleDoc = {
      _id: roleId,
      workspaceId: wsAId,
      isSystem: true,
      deleteOne: vi.fn(),
    };

    const { svc } = makeService({ roleDoc: systemRoleDoc, memberCount: 0 });

    await expect(
      svc.remove(wsAId.toString(), roleId.toString(), nonOwnerId.toString()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(systemRoleDoc.deleteOne).not.toHaveBeenCalled();
  });
});
