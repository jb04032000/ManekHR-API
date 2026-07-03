import { describe, it, expect, vi } from 'vitest';
import type { Model } from 'mongoose';
import { BadRequestException } from '@nestjs/common';

// Stub @nestjs/mongoose BEFORE importing the service — it transitively imports
// the `User` schema, whose `@Prop()` decorators trip vitest's SWC reflect-
// metadata pipeline. The service is unit-tested with a plain mock model.
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

import { UsersService } from '../users.service';
import type { User } from '../schemas/user.schema';

/** Minimal `Model<User>` mock — `updateOne(...).exec()`. */
function mockUserModel() {
  const chain = { exec: () => Promise.resolve({ acknowledged: true, modifiedCount: 1 }) };
  const updateOne = vi.fn(() => chain);
  return {
    model: { updateOne } as unknown as Model<User>,
    updateOne,
  };
}

/**
 * Mock for the `findById(...).select(...).lean().exec()` read chain used by
 * `getAppLockIdleMs`. `doc` is what `.exec()` resolves to.
 */
function mockReadModel(doc: { appLockIdleMs?: number | null } | null) {
  const exec = vi.fn(() => Promise.resolve(doc));
  const lean = vi.fn(() => ({ exec }));
  const select = vi.fn(() => ({ lean }));
  const findById = vi.fn(() => ({ select }));
  return {
    model: { findById } as unknown as Model<User>,
    findById,
    select,
  };
}

const userId = '6a0a8f515ea9af111dd403bd';

describe('UsersService.setAppLockIdleMs', () => {
  it('persists a valid preset and returns it', async () => {
    const { model, updateOne } = mockUserModel();
    const result = await new UsersService(model).setAppLockIdleMs(userId, 300_000);
    expect(updateOne).toHaveBeenCalledWith({ _id: userId }, { $set: { appLockIdleMs: 300_000 } });
    expect(result).toEqual({ appLockIdleMs: 300_000 });
  });

  it('persists `null` to clear the override and returns it', async () => {
    const { model, updateOne } = mockUserModel();
    const result = await new UsersService(model).setAppLockIdleMs(userId, null);
    expect(updateOne).toHaveBeenCalledWith({ _id: userId }, { $set: { appLockIdleMs: null } });
    expect(result).toEqual({ appLockIdleMs: null });
  });

  it('rejects a non-preset value with BadRequestException — defensive guard', async () => {
    const { model, updateOne } = mockUserModel();
    await expect(new UsersService(model).setAppLockIdleMs(userId, 12_345)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('UsersService.getAppLockIdleMs', () => {
  it('returns the persisted per-user override', async () => {
    const { model, findById, select } = mockReadModel({ appLockIdleMs: 600_000 });
    const result = await new UsersService(model).getAppLockIdleMs(userId);
    expect(findById).toHaveBeenCalledWith(userId);
    expect(select).toHaveBeenCalledWith('appLockIdleMs');
    expect(result).toBe(600_000);
  });

  it('returns null when the user has no override set', async () => {
    const { model } = mockReadModel({ appLockIdleMs: null });
    expect(await new UsersService(model).getAppLockIdleMs(userId)).toBeNull();
  });

  it('returns null when the user document is missing', async () => {
    const { model } = mockReadModel(null);
    expect(await new UsersService(model).getAppLockIdleMs(userId)).toBeNull();
  });

  it('short-circuits to null on an invalid ObjectId without hitting the model', async () => {
    const { model, findById } = mockReadModel({ appLockIdleMs: 300_000 });
    expect(await new UsersService(model).getAppLockIdleMs('not-an-objectid')).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });
});
