/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing RbacService so that the
// transitive schema imports (Role, Workspace, WorkspaceMember, TeamMember)
// don't trip the "Cannot determine type" reflection error under vitest's
// esbuild transform. We never use Mongoose here — all Models are plain mocks.
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

import { Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { RbacService } from '../rbac.service';

describe('RbacService — Phase 1d invariants on role create/update', () => {
  const workspaceId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const roleId = new Types.ObjectId();

  let roleModel: any;
  let workspaceModel: any;
  let memberModel: any;
  let teamMemberModel: any;
  let auditService: any;
  let svc: RbacService;

  // Chainable Mongoose query stub. `.exec()` / `.lean()` resolve `value`.
  const query = (value: unknown) => {
    const q: any = {
      exec: vi.fn().mockResolvedValue(value),
      select: vi.fn(),
      lean: vi.fn(),
    };
    q.select.mockReturnValue(q);
    q.lean.mockReturnValue(q);
    return q;
  };

  beforeEach(() => {
    workspaceModel = {
      // Workspace owned by ownerId — tests here always use the owner so
      // the ceiling check is bypassed and only Phase 1d invariants are tested.
      findById: vi.fn().mockReturnValue(query({ _id: workspaceId, ownerId })),
    };
    // memberModel not called for owner — but must be present for construction.
    memberModel = {
      findOne: vi.fn().mockReturnValue(query(null)),
    };
    teamMemberModel = {
      findOne: vi.fn().mockReturnValue(query(null)),
      countDocuments: vi.fn().mockResolvedValue(0),
    };

    roleModel = vi.fn().mockImplementation((doc: unknown) => ({
      ...(doc as object),
      save: vi.fn().mockResolvedValue({
        _id: roleId,
        ...(doc as object),
        permissionPaths: (doc as any).permissionPaths ?? [],
      }),
    }));
    roleModel.findById = vi.fn().mockReturnValue(query(null));
    roleModel.findOne = vi.fn().mockReturnValue(query(null));

    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    svc = new RbacService(roleModel, workspaceModel, memberModel, teamMemberModel, auditService);
  });

  it('create rejects incoherent permissionPaths (edit without view)', async () => {
    await expect(
      svc.create(workspaceId.toString(), ownerId.toString(), {
        name: 'Incoherent',
        permissions: [],
        permissionPaths: [{ path: 'team.profile.bank.edit', scope: 'all' }],
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('create rejects unresolved deps (member.delete without directory.view)', async () => {
    await expect(
      svc.create(workspaceId.toString(), ownerId.toString(), {
        name: 'Orphan',
        permissions: [],
        permissionPaths: [
          // Provide the view grant so coherence passes, but omit directory.view
          // so that the dep check on member.delete fails.
          { path: 'team.member.delete', scope: 'all' },
        ],
      } as any),
    ).rejects.toThrow(/team\.directory\.view/);
  });

  it('create succeeds + emits audit with pathDiff on coherent grant', async () => {
    await svc.create(workspaceId.toString(), ownerId.toString(), {
      name: 'Coherent',
      permissions: [],
      permissionPaths: [
        { path: 'team.directory.view', scope: 'all' },
        { path: 'team.profile.bank.view', scope: 'all' },
        { path: 'team.profile.bank.edit', scope: 'all' },
      ],
    } as any);

    // Give the fire-and-forget logEvent promise a tick to resolve.
    await new Promise((r) => setImmediate(r));

    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rbac.role_permissions_changed',
        meta: expect.objectContaining({ op: 'create', pathDiff: expect.any(Object) }),
      }),
    );
  });

  it('update skips audit when permissionPaths is absent from update DTO', async () => {
    const save = vi.fn().mockResolvedValue({ _id: roleId, name: 'Renamed', permissionPaths: [] });
    roleModel.findOne.mockReturnValue(
      query({
        _id: roleId,
        workspaceId,
        isSystem: false,
        permissions: [],
        permissionPaths: [],
        save,
      }),
    );
    auditService.logEvent.mockClear();

    await svc.update(workspaceId.toString(), roleId.toString(), ownerId.toString(), {
      name: 'Renamed',
    });

    await new Promise((r) => setImmediate(r));

    expect(
      auditService.logEvent.mock.calls.filter(
        (c: any[]) => c[0]?.action === 'rbac.role_permissions_changed',
      ),
    ).toHaveLength(0);
  });

  it('update with permissionPaths emits audit pathDiff', async () => {
    const save = vi.fn().mockResolvedValue({
      _id: roleId,
      name: 'WithPaths',
      permissionPaths: [
        { path: 'team.directory.view', scope: 'all' },
        { path: 'team.profile.bank.view', scope: 'all' },
        { path: 'team.profile.bank.edit', scope: 'all' },
      ],
    });
    roleModel.findOne.mockReturnValue(
      query({
        _id: roleId,
        workspaceId,
        isSystem: false,
        permissions: [],
        permissionPaths: [{ path: 'team.directory.view', scope: 'self' }],
        save,
      }),
    );
    auditService.logEvent.mockClear();

    await svc.update(workspaceId.toString(), roleId.toString(), ownerId.toString(), {
      permissionPaths: [
        { path: 'team.directory.view', scope: 'all' },
        { path: 'team.profile.bank.view', scope: 'all' },
        { path: 'team.profile.bank.edit', scope: 'all' },
      ],
    } as any);

    await new Promise((r) => setImmediate(r));

    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rbac.role_permissions_changed',
        meta: expect.objectContaining({
          op: 'update',
          pathDiff: expect.objectContaining({
            added: expect.any(Array),
            scopeChanged: expect.arrayContaining([
              expect.objectContaining({ path: 'team.directory.view', from: 'self', to: 'all' }),
            ]),
          }),
        }),
      }),
    );
  });
});
