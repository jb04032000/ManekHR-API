import { describe, it, expect, vi } from 'vitest';
import type { Model } from 'mongoose';

// Stub @nestjs/mongoose BEFORE importing the service — it transitively imports
// the `User` schema, whose `@Prop()` decorators trip vitest's SWC reflect-
// metadata pipeline. The service is unit-tested with a plain mock model.
// Mirrors `connect-profile.service.vitest.ts`.
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

/**
 * Minimal `Model<User>` mock — supports `findById(...).select(...).lean().exec()`
 * and `updateOne(...).exec()`, the only builder chains the ERP-policy methods use.
 */
function mockUserModel(user: { erpPolicyAcceptedAt?: Date | null } | null): Model<User> {
  const chain = {
    select: vi.fn(() => chain),
    lean: vi.fn(() => chain),
    exec: () => Promise.resolve(user),
  };
  const updateChain = { exec: vi.fn(() => Promise.resolve({ modifiedCount: 1 })) };
  return {
    findById: vi.fn(() => chain),
    updateOne: vi.fn(() => updateChain),
  } as unknown as Model<User>;
}

const userId = '6a0a8f515ea9af111dd403bd';

describe('UsersService.getErpPolicyState', () => {
  it('reports erpPolicyAccepted=false when the field is unset', async () => {
    const svc = new UsersService(mockUserModel({ erpPolicyAcceptedAt: null }));
    await expect(svc.getErpPolicyState(userId)).resolves.toEqual({ erpPolicyAccepted: false });
  });

  it('reports erpPolicyAccepted=false when the user record is missing', async () => {
    const svc = new UsersService(mockUserModel(null));
    await expect(svc.getErpPolicyState(userId)).resolves.toEqual({ erpPolicyAccepted: false });
  });

  it('reports erpPolicyAccepted=true when erpPolicyAcceptedAt is stamped', async () => {
    const svc = new UsersService(mockUserModel({ erpPolicyAcceptedAt: new Date() }));
    await expect(svc.getErpPolicyState(userId)).resolves.toEqual({ erpPolicyAccepted: true });
  });
});

describe('UsersService.acceptErpPolicy', () => {
  it('returns the acceptedAt timestamp after stamping', async () => {
    const stampedAt = new Date('2026-05-19T10:00:00.000Z');
    const svc = new UsersService(mockUserModel({ erpPolicyAcceptedAt: stampedAt }));
    const result = await svc.acceptErpPolicy(userId);
    expect(result.acceptedAt).toBeInstanceOf(Date);
  });

  it('falls back to now when the user record is missing (idempotent)', async () => {
    const svc = new UsersService(mockUserModel(null));
    const result = await svc.acceptErpPolicy(userId);
    expect(result.acceptedAt).toBeInstanceOf(Date);
  });

  it('stamps with the idempotency guard filter (first-write-wins)', async () => {
    const updateOneMock = vi.fn(() => ({
      exec: vi.fn(() => Promise.resolve({ modifiedCount: 1 })),
    }));
    const model = {
      findById: vi.fn(() => ({
        select: vi.fn(function (this: unknown) {
          return this;
        }),
        lean: vi.fn(function (this: unknown) {
          return this;
        }),
        exec: () => Promise.resolve({ erpPolicyAcceptedAt: new Date() }),
      })),
      updateOne: updateOneMock,
    } as unknown as import('mongoose').Model<User>;
    await new UsersService(model).acceptErpPolicy(userId);
    expect(updateOneMock).toHaveBeenCalledWith(
      { _id: userId, erpPolicyAcceptedAt: { $in: [null, undefined] } },
      { $set: { erpPolicyAcceptedAt: expect.any(Date) } },
    );
  });
});
