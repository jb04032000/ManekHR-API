/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migration 0044 (ADR-0003) — purge orphaned Connect profiles (profile present,
 * owning User gone). Verifies the orphan set is computed from the profile-owner
 * vs live-User difference, that only orphans + their dangling graph edges are
 * deleted, and that a clean DB is a no-op. Links: purge-orphan-connect-profiles.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  InjectConnection: () => () => undefined,
}));

import { Types } from 'mongoose';
import { PurgeOrphanConnectProfilesService } from '../purge-orphan-connect-profiles';

function makeCol() {
  return {
    distinct: vi.fn().mockResolvedValue([]),
    find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
  };
}

function buildService(cols: Record<string, ReturnType<typeof makeCol>>) {
  const col = (name: string) => (cols[name] ??= makeCol());
  const connection: any = { db: { collection: (n: string) => col(n) } };
  return { svc: new PurgeOrphanConnectProfilesService(connection), col };
}

describe('PurgeOrphanConnectProfilesService (migration 0044, ADR-0003)', () => {
  it('deletes orphan profiles + their dangling graph edges, keeping live owners', async () => {
    const liveId = new Types.ObjectId(); // profile owner that still has a User
    const orphanId = new Types.ObjectId(); // profile owner whose User is gone

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const { svc, col } = buildService(cols);

    col('connectprofiles').distinct = vi.fn().mockResolvedValue([liveId, orphanId]);
    // Only `liveId` resolves to a live User; `orphanId` does not.
    col('users').find = vi.fn(() => ({
      toArray: vi.fn().mockResolvedValue([{ _id: liveId }]),
    })) as any;
    col('connectprofiles').deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
    col('connectconnections').deleteMany = vi.fn().mockResolvedValue({ deletedCount: 2 });
    col('connectconnectionrequests').deleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
    col('connectfollows').deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });

    const result = await svc.run();

    // Only the orphan owner id is targeted — the live owner is never touched.
    expect(col('connectprofiles').deleteMany).toHaveBeenCalledWith({
      userId: { $in: [orphanId] },
    });
    expect(col('connectconnections').deleteMany).toHaveBeenCalledWith({
      $or: [{ userA: { $in: [orphanId] } }, { userB: { $in: [orphanId] } }],
    });
    expect(col('connectconnectionrequests').deleteMany).toHaveBeenCalledWith({
      $or: [{ fromUserId: { $in: [orphanId] } }, { toUserId: { $in: [orphanId] } }],
    });
    expect(col('connectfollows').deleteMany).toHaveBeenCalledWith({
      $or: [{ followerId: { $in: [orphanId] } }, { followeeId: { $in: [orphanId] } }],
    });

    expect(result.orphanProfilesDeleted).toBe(1);
    expect(result.danglingConnectionsDeleted).toBe(2);
    expect(result.danglingRequestsDeleted).toBe(0);
    expect(result.danglingFollowsDeleted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('is idempotent: every profile owner is live -> no deletes', async () => {
    const liveA = new Types.ObjectId();
    const liveB = new Types.ObjectId();

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const { svc, col } = buildService(cols);

    col('connectprofiles').distinct = vi.fn().mockResolvedValue([liveA, liveB]);
    col('users').find = vi.fn(() => ({
      toArray: vi.fn().mockResolvedValue([{ _id: liveA }, { _id: liveB }]),
    })) as any;

    const result = await svc.run();

    expect(col('connectprofiles').deleteMany).not.toHaveBeenCalled();
    expect(col('connectconnections').deleteMany).not.toHaveBeenCalled();
    expect(col('connectconnectionrequests').deleteMany).not.toHaveBeenCalled();
    expect(col('connectfollows').deleteMany).not.toHaveBeenCalled();
    expect(result.orphanProfilesDeleted).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('no profiles at all -> no-op (never queries users)', async () => {
    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const { svc, col } = buildService(cols);

    col('connectprofiles').distinct = vi.fn().mockResolvedValue([]);

    const result = await svc.run();

    expect(col('users').find).not.toHaveBeenCalled();
    expect(col('connectprofiles').deleteMany).not.toHaveBeenCalled();
    expect(result.orphanProfilesDeleted).toBe(0);
  });
});
