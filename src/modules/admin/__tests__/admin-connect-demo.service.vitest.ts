/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AdminConnectDemoService.purge — demo cleanup must be count-honest (ADR-0002).
 * Deleting demo accounts must (a) remove their engagement + seen rows and
 * (b) recompute the denormalized viewCount/reactionCount/commentCount on the
 * REAL posts they had engaged with, so live posts stop showing demo-inflated
 * numbers. Links: admin-connect-demo.service.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  InjectConnection: () => () => undefined,
}));
// Stub AuditService so importing the service under test does not pull the real
// audit module (and its decorated schemas) into the unit test.
vi.mock('../audit/audit.service', () => ({ AuditService: class {} }));

import { Types } from 'mongoose';
import { AdminConnectDemoService } from '../admin-connect-demo.service';

function makeCol() {
  return {
    find: vi.fn(() => ({
      sort: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
      toArray: vi.fn().mockResolvedValue([]),
    })),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    distinct: vi.fn().mockResolvedValue([]),
    countDocuments: vi.fn().mockResolvedValue(0),
    findOne: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockResolvedValue({}),
    insertOne: vi.fn().mockResolvedValue({ insertedId: new Types.ObjectId() }),
    insertMany: vi.fn().mockResolvedValue({}),
    aggregate: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
  };
}

/** Helper: make a `find()` (and its `.sort()` chain) resolve to fixed rows. */
function findReturns(rows: unknown[]) {
  return vi.fn(() => ({
    sort: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue(rows) })),
    toArray: vi.fn().mockResolvedValue(rows),
  }));
}

describe('AdminConnectDemoService.purge — count-honest demo cleanup', () => {
  it('deletes demo engagement/seen rows and recomputes counts on affected real posts', async () => {
    const demoId = new Types.ObjectId();
    const realPostId = new Types.ObjectId();

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const col = (name: string) => (cols[name] ??= makeCol());

    // demoUserIds() reads `users` with a $or filter → one demo account.
    col('users').find = vi.fn(() => ({
      sort: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ _id: demoId }]) })),
      toArray: vi.fn().mockResolvedValue([{ _id: demoId }]),
    })) as any;

    // The demo account viewed one REAL post → it is the affected post to fix up.
    col('connectengagementedges').distinct = vi.fn().mockResolvedValue([realPostId]);
    // Surviving (non-demo) tallies after the demo rows are deleted.
    col('connectengagementedges').countDocuments = vi.fn().mockResolvedValue(3);
    col('connectreactions').countDocuments = vi.fn().mockResolvedValue(2);
    col('connectcomments').countDocuments = vi.fn().mockResolvedValue(1);
    // The affected post is REAL (survives the purge) → recompute applies.
    col('connectposts').findOne = vi.fn().mockResolvedValue({ _id: realPostId });

    const connection: any = { db: { collection: (n: string) => col(n) } };
    const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const svc = new AdminConnectDemoService(connection, audit);

    await svc.clearAll('admin-1');

    // (a) demo engagement edges removed (actored-by OR authored-by a demo user).
    expect(col('connectengagementedges').deleteMany).toHaveBeenCalledWith({
      $or: [{ actorId: { $in: [demoId] } }, { authorId: { $in: [demoId] } }],
    });
    // demo seen rows removed.
    expect(col('connectseenposts').deleteMany).toHaveBeenCalledWith({
      viewerId: { $in: [demoId] },
    });
    // (b) the real post's denormalized counts are recomputed from survivors.
    expect(col('connectposts').updateOne).toHaveBeenCalledWith(
      { _id: realPostId },
      { $set: { viewCount: 3, reactionCount: 2, commentCount: 1 } },
    );
  });

  it('does not recompute a post that no longer exists (a deleted demo post)', async () => {
    const demoId = new Types.ObjectId();
    const demoPostId = new Types.ObjectId();

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const col = (name: string) => (cols[name] ??= makeCol());
    col('users').find = vi.fn(() => ({
      sort: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ _id: demoId }]) })),
      toArray: vi.fn().mockResolvedValue([{ _id: demoId }]),
    })) as any;
    col('connectengagementedges').distinct = vi.fn().mockResolvedValue([demoPostId]);
    // The affected post was a DEMO post → already deleted, findOne returns null.
    col('connectposts').findOne = vi.fn().mockResolvedValue(null);

    const connection: any = { db: { collection: (n: string) => col(n) } };
    const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const svc = new AdminConnectDemoService(connection, audit);

    await svc.clearAll('admin-1');

    expect(col('connectposts').updateOne).not.toHaveBeenCalled();
  });
});

describe('AdminConnectDemoService — safe purge (CLEAN hard-delete vs ENTANGLED stub)', () => {
  it('ENTANGLED demo (shares a thread with a real user) is stubbed, NOT hard-deleted', async () => {
    const demoId = new Types.ObjectId();
    const realUserId = new Types.ObjectId();

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const col = (name: string) => (cols[name] ??= makeCol());
    col('users').find = findReturns([{ _id: demoId }]) as any;
    // A 2-party thread between the demo account and a REAL user → entangled.
    col('connect_threads').find = findReturns([
      { _id: new Types.ObjectId(), participantIds: [demoId, realUserId] },
    ]) as any;

    const connection: any = { db: { collection: (n: string) => col(n) } };
    const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const svc = new AdminConnectDemoService(connection, audit);

    const res = await svc.clearAll('admin-1');

    // Stubbed, not hard-deleted.
    expect(res).toMatchObject({ hardDeleted: 0, stubbed: 1 });
    // The User row is NEVER hard-deleted for an entangled account.
    expect(col('users').deleteMany).not.toHaveBeenCalled();
    // It is anonymized to a permanent "Sample account no longer available" stub.
    expect(col('users').updateOne).toHaveBeenCalledWith(
      { _id: demoId },
      expect.objectContaining({
        $set: expect.objectContaining({
          name: 'Sample account no longer available',
          email: null,
          mobile: null,
          isActive: false,
          isDemo: false,
        }),
      }),
    );
    // Shared relationship rows are KEPT — the real user's thread must survive.
    expect(col('connect_threads').deleteMany).not.toHaveBeenCalled();
    expect(col('connect_messages').deleteMany).not.toHaveBeenCalled();
    expect(col('connectconnections').deleteMany).not.toHaveBeenCalled();
    // But the demo's OWN content is still removed.
    expect(col('connectposts').deleteMany).toHaveBeenCalledWith({ authorId: { $in: [demoId] } });
  });

  it('CLEAN demo (only edges with OTHER demo accounts) is hard-deleted', async () => {
    const demoA = new Types.ObjectId();
    const demoB = new Types.ObjectId();

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const col = (name: string) => (cols[name] ??= makeCol());
    col('users').find = findReturns([{ _id: demoA }, { _id: demoB }]) as any;
    // A thread BETWEEN two demo accounts is NOT entanglement (both are demo).
    col('connect_threads').find = findReturns([
      { _id: new Types.ObjectId(), participantIds: [demoA, demoB] },
    ]) as any;
    col('users').deleteMany = vi.fn().mockResolvedValue({ deletedCount: 2 });

    const connection: any = { db: { collection: (n: string) => col(n) } };
    const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const svc = new AdminConnectDemoService(connection, audit);

    const res = await svc.clearAll('admin-1');

    expect(res).toMatchObject({ hardDeleted: 2, stubbed: 0 });
    // Hard purge runs — users + shared rows deleted (both parties are demo).
    expect(col('users').deleteMany).toHaveBeenCalledWith({ _id: { $in: [demoA, demoB] } });
    expect(col('connect_threads').deleteMany).toHaveBeenCalled();
    // No stub update for a clean account.
    expect(col('users').updateOne).not.toHaveBeenCalled();
  });

  it('dryRun reports the clean/stub split WITHOUT mutating anything', async () => {
    const demoId = new Types.ObjectId();
    const realUserId = new Types.ObjectId();

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const col = (name: string) => (cols[name] ??= makeCol());
    col('users').find = findReturns([{ _id: demoId }]) as any;
    // Entangled via a connection edge with a real user.
    col('connectconnections').find = findReturns([{ userA: demoId, userB: realUserId }]) as any;

    const connection: any = { db: { collection: (n: string) => col(n) } };
    const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const svc = new AdminConnectDemoService(connection, audit);

    const report = await svc.dryRun('admin-1');

    expect(report).toMatchObject({ demoAccounts: 1, hardDeleted: 0, stubbed: 1 });
    expect(Array.isArray(report.rows)).toBe(true);
    // NO mutation in a dry run.
    for (const name of Object.keys(cols)) {
      expect(cols[name].deleteMany).not.toHaveBeenCalled();
      expect(cols[name].updateOne).not.toHaveBeenCalled();
    }
    // The dry run is still audited (read-only event).
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_dryrun_connect_demo' }),
    );
  });

  it('recomputes RFQ quotesCount/lowestQuotePrice + job applicationsCount after a clean purge', async () => {
    const demoId = new Types.ObjectId();
    const realRfqId = new Types.ObjectId();
    const realJobId = new Types.ObjectId();

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const col = (name: string) => (cols[name] ??= makeCol());
    col('users').find = findReturns([{ _id: demoId }]) as any;
    // Demo seller quoted a REAL rfq; demo applicant applied to a REAL job.
    col('connect_quotes').distinct = vi.fn().mockResolvedValue([realRfqId]);
    col('connect_job_applications').distinct = vi.fn().mockResolvedValue([realJobId]);
    // Both real records survive the purge.
    col('connect_rfqs').findOne = vi.fn().mockResolvedValue({ _id: realRfqId });
    col('connect_jobs').findOne = vi.fn().mockResolvedValue({ _id: realJobId });
    // Surviving (non-demo) tallies.
    col('connect_quotes').countDocuments = vi.fn().mockResolvedValue(2);
    col('connect_quotes').aggregate = vi.fn(() => ({
      toArray: vi.fn().mockResolvedValue([{ low: 500 }]),
    })) as any;
    col('connect_job_applications').countDocuments = vi.fn().mockResolvedValue(4);

    const connection: any = { db: { collection: (n: string) => col(n) } };
    const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const svc = new AdminConnectDemoService(connection, audit);

    await svc.clearAll('admin-1');

    expect(col('connect_rfqs').updateOne).toHaveBeenCalledWith(
      { _id: realRfqId },
      { $set: { quotesCount: 2, lowestQuotePrice: 500 } },
    );
    expect(col('connect_jobs').updateOne).toHaveBeenCalledWith(
      { _id: realJobId },
      { $set: { applicationsCount: 4 } },
    );
  });
});
