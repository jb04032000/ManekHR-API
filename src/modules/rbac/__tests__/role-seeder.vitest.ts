/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing RoleSeederService —
// transitive schema imports would otherwise trip vitest's reflect-metadata.
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
import { RoleSeederService } from '../role-seeder.service';
import { DEFAULT_PARTNER_ROLE } from '../role-seeder.constants';

describe('RoleSeederService.seedDefaultRolesForWorkspace', () => {
  let roleModel: any;
  let svc: RoleSeederService;
  const workspaceId = new Types.ObjectId();

  beforeEach(() => {
    roleModel = {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    };
    svc = new RoleSeederService(roleModel);
  });

  function findOneReturns(value: any) {
    roleModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(value),
    });
  }

  function findOneAndUpdateReturns(value: any) {
    roleModel.findOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockResolvedValue(value),
    });
  }

  it('creates all default roles when absent + reports them as created', async () => {
    findOneReturns(null);
    findOneAndUpdateReturns({
      _id: new Types.ObjectId(),
      workspaceId,
      isSystem: true,
    });

    const result = await svc.seedDefaultRolesForWorkspace(workspaceId.toString());

    expect(result.created).toEqual(['Partner', 'Manager', 'Accountant', 'Employee']);
    expect(result.skipped).toEqual([]);
    expect(roleModel.findOneAndUpdate).toHaveBeenCalledTimes(4);

    // Validate the Partner payload (first upsert) — workspaceId cast to
    // ObjectId, isSystem=true, permissions match the constant. Partner is the
    // top non-owner role, blocked from self-edit (separation of duties).
    const [filter, update, opts] = roleModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ workspaceId, name: 'Partner' });
    expect(opts).toMatchObject({ upsert: true, new: true });
    expect(update.$setOnInsert.isSystem).toBe(true);
    expect(update.$setOnInsert.name).toBe('Partner');
    expect(update.$setOnInsert.selfProfileEdit).toBe('block');
    expect(update.$setOnInsert.permissions).toEqual(DEFAULT_PARTNER_ROLE.permissions);
    // Phase 1a — hierarchical Team grants seeded inline alongside the legacy
    // flat permissions.
    expect(update.$setOnInsert.permissionPaths).toEqual(DEFAULT_PARTNER_ROLE.permissionPaths);

    // Manager (second upsert) carries the self-edit hierarchy block, unchanged.
    const managerInsert = roleModel.findOneAndUpdate.mock.calls[1][1].$setOnInsert;
    expect(managerInsert.name).toBe('Manager');
    expect(managerInsert.selfProfileEdit).toBe('block');
  });

  it('skips default roles that already exist for the workspace (idempotent)', async () => {
    findOneReturns({
      _id: new Types.ObjectId(),
      workspaceId,
      isSystem: true,
    });

    const result = await svc.seedDefaultRolesForWorkspace(workspaceId.toString());

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(['Partner', 'Manager', 'Accountant', 'Employee']);
    expect(roleModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('records error + continues when upsert throws (best-effort seed)', async () => {
    findOneReturns(null);
    roleModel.findOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockRejectedValue(new Error('mongo down')),
    });

    const result = await svc.seedDefaultRolesForWorkspace(workspaceId.toString());

    // No role created, no skipped marker either — error path.
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('casts workspaceId string → ObjectId in the upsert filter', async () => {
    findOneReturns(null);
    findOneAndUpdateReturns({
      _id: new Types.ObjectId(),
    });

    await svc.seedDefaultRolesForWorkspace(workspaceId.toString());

    const [filter] = roleModel.findOneAndUpdate.mock.calls[0];
    expect(filter.workspaceId).toBeInstanceOf(Types.ObjectId);
    expect(filter.workspaceId.toString()).toBe(workspaceId.toString());
  });
});
