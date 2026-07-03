import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import { BackfillUserHasWorkspaceService } from '../backfill-user-has-workspace';

/**
 * Migration 0046 — backfill User.hasWorkspace from real workspace ownership.
 * Uses the raw Mongo connection, so the tests stub `connection.db.collection`
 * per collection name (mirrors the service's `col()` helper).
 */
function makeService() {
  const wsDistinct = vi.fn();
  const usersUpdateMany = vi.fn();
  const collection = vi.fn((name: string) => {
    if (name === 'workspaces') return { distinct: wsDistinct };
    if (name === 'users') return { updateMany: usersUpdateMany };
    throw new Error(`unexpected collection: ${name}`);
  });
  const connection = { db: { collection } } as unknown as never;
  const svc = new BackfillUserHasWorkspaceService(connection);
  return { svc, wsDistinct, usersUpdateMany };
}

describe('BackfillUserHasWorkspaceService (migration 0046)', () => {
  it('sets live-workspace owners to true and everyone else to explicit false', async () => {
    const owner = new Types.ObjectId();
    const { svc, wsDistinct, usersUpdateMany } = makeService();
    wsDistinct.mockResolvedValue([owner]);
    usersUpdateMany
      .mockResolvedValueOnce({ modifiedCount: 1 }) // owners -> true
      .mockResolvedValueOnce({ modifiedCount: 3 }); // everyone else -> false

    const res = await svc.run();

    // Distinct ownerIds over LIVE (non-deleted) workspaces only.
    expect(wsDistinct).toHaveBeenCalledWith('ownerId', { isDeleted: { $ne: true } });
    // Owners of a live workspace -> true (skip rows already true).
    expect(usersUpdateMany).toHaveBeenNthCalledWith(
      1,
      { _id: { $in: [owner] }, hasWorkspace: { $ne: true } },
      { $set: { hasWorkspace: true } },
    );
    // Everyone else -> explicit false. `$ne: false` also matches a MISSING field,
    // so the never-set/undefined legacy case is normalized in the same pass.
    expect(usersUpdateMany).toHaveBeenNthCalledWith(
      2,
      { _id: { $nin: [owner] }, hasWorkspace: { $ne: false } },
      { $set: { hasWorkspace: false } },
    );
    expect(res).toEqual({ liveOwnerIds: 1, ownersSetTrue: 1, nonOwnersSetFalse: 3, errors: [] });
  });

  it('is a no-op on re-run (nothing matches the $ne filters)', async () => {
    const { svc, wsDistinct, usersUpdateMany } = makeService();
    wsDistinct.mockResolvedValue([]);
    usersUpdateMany.mockResolvedValue({ modifiedCount: 0 });

    const res = await svc.run();

    expect(res.ownersSetTrue).toBe(0);
    expect(res.nonOwnersSetFalse).toBe(0);
    expect(res.errors).toEqual([]);
  });

  it('captures errors without throwing (fail-soft)', async () => {
    const { svc, wsDistinct } = makeService();
    wsDistinct.mockRejectedValue(new Error('mongo down'));

    const res = await svc.run();

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('mongo down');
  });
});
