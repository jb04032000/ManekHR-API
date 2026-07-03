/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing LeaveTypeSeederService —
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
import { LeaveTypeSeederService } from '../leave-type-seeder.service';
import { LEAVE_TYPE_PRESETS } from '../constants/leave-type-presets';

describe('LeaveTypeSeederService.seedDefaultLeaveTypesForWorkspace', () => {
  let leaveTypeModel: any;
  let svc: LeaveTypeSeederService;
  const workspaceId = new Types.ObjectId();
  const allCodes = LEAVE_TYPE_PRESETS.map((p) => p.code);

  beforeEach(() => {
    leaveTypeModel = {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    };
    svc = new LeaveTypeSeederService(leaveTypeModel);
  });

  function findOneReturns(value: any) {
    leaveTypeModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(value),
    });
  }

  function findOneAndUpdateReturns(value: any) {
    leaveTypeModel.findOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockResolvedValue(value),
    });
  }

  it('creates every preset leave type when absent + reports them as created', async () => {
    findOneReturns(null);
    findOneAndUpdateReturns({ _id: new Types.ObjectId() });

    const result = await svc.seedDefaultLeaveTypesForWorkspace(workspaceId.toString());

    expect(result.created).toEqual(allCodes);
    expect(result.skipped).toEqual([]);
    expect(leaveTypeModel.findOneAndUpdate).toHaveBeenCalledTimes(allCodes.length);

    // First upsert = CL: workspaceId cast to ObjectId, isActive=true, system fields set.
    const [filter, update, opts] = leaveTypeModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ workspaceId, code: 'CL' });
    expect(opts).toMatchObject({ upsert: true, new: true });
    expect(update.$setOnInsert.code).toBe('CL');
    expect(update.$setOnInsert.isActive).toBe(true);
    expect(update.$setOnInsert.createdBy).toBeNull();
  });

  it('skips leave types that already exist for the workspace (idempotent)', async () => {
    findOneReturns({ _id: new Types.ObjectId() });

    const result = await svc.seedDefaultLeaveTypesForWorkspace(workspaceId.toString());

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(allCodes);
    expect(leaveTypeModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('records error + continues when an upsert throws (best-effort seed)', async () => {
    findOneReturns(null);
    leaveTypeModel.findOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockRejectedValue(new Error('mongo down')),
    });

    const result = await svc.seedDefaultLeaveTypesForWorkspace(workspaceId.toString());

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('casts workspaceId string → ObjectId in the upsert filter', async () => {
    findOneReturns(null);
    findOneAndUpdateReturns({ _id: new Types.ObjectId() });

    await svc.seedDefaultLeaveTypesForWorkspace(workspaceId.toString());

    const [filter] = leaveTypeModel.findOneAndUpdate.mock.calls[0];
    expect(filter.workspaceId).toBeInstanceOf(Types.ObjectId);
    expect(filter.workspaceId.toString()).toBe(workspaceId.toString());
  });
});
