/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Neutralise @nestjs/mongoose decorators before the migration (and the
// TeamMember schema graph it imports) is evaluated.
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
import { BackfillTeamMemberWorkspaceIdObjectIdService } from '../backfill-team-member-workspaceid-objectid';

const VALID_ID_STR = '64b2f00000000000000000aa';

describe('BackfillTeamMemberWorkspaceIdObjectIdService', () => {
  let teamModel: any;

  beforeEach(() => vi.clearAllMocks());

  /**
   * Build a mock model whose find() returns the full
   * find().select().lean().exec() chain.
   */
  function makeModel(members: any[], updateOneMock?: ReturnType<typeof vi.fn>) {
    const updateOne = updateOneMock ?? vi.fn().mockResolvedValue({});
    teamModel = {
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue(members),
          }),
        }),
      }),
      updateOne,
    };
    return { svc: new BackfillTeamMemberWorkspaceIdObjectIdService(teamModel), updateOne };
  }

  it('casts a member whose workspaceId is a valid 24-hex string to ObjectId', async () => {
    const memberId = new Types.ObjectId();
    const { svc, updateOne } = makeModel([{ _id: memberId, workspaceId: VALID_ID_STR }]);

    const result = await svc.run();

    expect(result.fixed).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: memberId });
    const castId: Types.ObjectId = update.$set.workspaceId;
    expect(castId).toBeInstanceOf(Types.ObjectId);
    expect(castId.toHexString()).toBe(VALID_ID_STR);
  });

  it('skips an invalid (non-ObjectId) string: records an error, does not call updateOne', async () => {
    const memberId = new Types.ObjectId();
    const { svc, updateOne } = makeModel([{ _id: memberId, workspaceId: 'not-an-id' }]);

    const result = await svc.run();

    expect(result.fixed).toBe(0);
    expect(result.scanned).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not-an-id');
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('is idempotent when no string workspaceIds exist: fixed === 0, no updateOne', async () => {
    const { svc, updateOne } = makeModel([]);

    const result = await svc.run();

    expect(result.fixed).toBe(0);
    expect(result.scanned).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(updateOne).not.toHaveBeenCalled();
  });
});
