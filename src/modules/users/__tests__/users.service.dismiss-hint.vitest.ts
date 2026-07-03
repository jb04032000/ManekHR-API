import { describe, it, expect, vi } from 'vitest';
import type { Model } from 'mongoose';

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

/** Minimal `Model<User>` mock — `findByIdAndUpdate(...).select(...).lean().exec()`. */
function mockUserModel(result: { dismissedHints?: string[] } | null) {
  const chain = {
    select: vi.fn(() => chain),
    lean: vi.fn(() => chain),
    exec: () => Promise.resolve(result),
  };
  const findByIdAndUpdate = vi.fn(() => chain);
  return {
    model: { findByIdAndUpdate } as unknown as Model<User>,
    findByIdAndUpdate,
  };
}

const userId = '6a0a8f515ea9af111dd403bd';

describe('UsersService.dismissHint', () => {
  it('adds the hint via $addToSet and returns the updated list', async () => {
    const { model, findByIdAndUpdate } = mockUserModel({ dismissedHints: ['connect_explore'] });
    const result = await new UsersService(model).dismissHint(userId, 'connect_explore');
    expect(findByIdAndUpdate).toHaveBeenCalledWith(
      userId,
      { $addToSet: { dismissedHints: 'connect_explore' } },
      { returnDocument: 'after' },
    );
    expect(result).toEqual({ dismissedHints: ['connect_explore'] });
  });

  it('returns an empty list when the user record is missing', async () => {
    const { model } = mockUserModel(null);
    const result = await new UsersService(model).dismissHint(userId, 'connect_explore');
    expect(result).toEqual({ dismissedHints: [] });
  });
});
