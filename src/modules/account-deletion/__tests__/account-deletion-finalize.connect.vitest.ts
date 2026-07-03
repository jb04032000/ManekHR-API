/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * Account-deletion Phase 3 — the Connect purge wiring on the finalize service
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A / §3C):
 *   - finalizeOne (Scope 3) runs the Connect content purge at the documented seam
 *     BEFORE the identity scrub, and proceeds to erase even if the purge fails;
 *   - finalizeDueConnectPending / finalizeConnectOne (Scope 1) purge Connect and
 *     advance the marker pending->purged, leaving it pending to retry on failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { Types } from 'mongoose';
import { AccountDeletionFinalizeService } from '../account-deletion-finalize.service';

const DAY = 24 * 60 * 60 * 1000;

describe('AccountDeletionFinalizeService — Connect purge wiring (Phase 3)', () => {
  const userId = new Types.ObjectId();
  const userIdHex = userId.toString();

  let userModel: any;
  let accountErasure: { eraseAccount: ReturnType<typeof vi.fn> };
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let connectPurge: { purgeUserConnectContent: ReturnType<typeof vi.fn> };
  let svc: AccountDeletionFinalizeService;
  let order: string[];

  const okSummary = (failures: any[] = []) => ({
    userId: userIdHex,
    collectionsProcessed: 55,
    rowsDeleted: 3,
    rowsModified: 1,
    failures,
  });

  beforeEach(() => {
    order = [];
    userModel = {
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
        }),
      }),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
    };
    accountErasure = {
      eraseAccount: vi.fn().mockImplementation(() => {
        order.push('erase');
        return Promise.resolve({ ok: true });
      }),
    };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    connectPurge = {
      purgeUserConnectContent: vi.fn().mockImplementation(() => {
        order.push('purge');
        return Promise.resolve(okSummary());
      }),
    };
    svc = new AccountDeletionFinalizeService(
      userModel,
      accountErasure as any,
      auditService as any,
      connectPurge as any,
    );
  });

  const settle = () => new Promise((r) => setImmediate(r));

  // ── Scope 3 finalizeOne ────────────────────────────────────────────────────

  it('runs the Connect purge BEFORE the identity scrub (the §3C order)', async () => {
    await svc.finalizeOne(userIdHex);
    expect(connectPurge.purgeUserConnectContent).toHaveBeenCalledWith(userIdHex);
    expect(order).toEqual(['purge', 'erase']);
  });

  it('still erases when the Connect purge throws (best-effort, §8 scrub-wins)', async () => {
    connectPurge.purgeUserConnectContent.mockRejectedValue(new Error('mongo blip'));
    const outcome = await svc.finalizeOne(userIdHex);
    expect(outcome).toBe('purged');
    expect(accountErasure.eraseAccount).toHaveBeenCalled();
  });

  // ── Scope 1 finalizeConnectOne ─────────────────────────────────────────────

  it('finalizeConnectOne purges then advances the marker connect pending->purged + audits', async () => {
    const outcome = await svc.finalizeConnectOne(userIdHex);

    expect(outcome).toBe('purged');
    expect(connectPurge.purgeUserConnectContent).toHaveBeenCalledWith(userIdHex);
    // It must NOT erase the identity (Connect-only deletion keeps the ERP account).
    expect(accountErasure.eraseAccount).not.toHaveBeenCalled();
    const set = userModel.updateOne.mock.calls[0][1].$set;
    expect(set['connectDeletion.state']).toBe('purged');

    await settle();
    const audit = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'connect_deletion_purged',
    );
    expect(audit).toBeDefined();
    expect(audit[0].meta.scope).toBe('connect');
  });

  it('finalizeConnectOne leaves the account pending (no marker flip) when a collection failed', async () => {
    connectPurge.purgeUserConnectContent.mockResolvedValue(
      okSummary([{ collection: 'connectposts', error: 'boom' }]),
    );

    const outcome = await svc.finalizeConnectOne(userIdHex);

    expect(outcome).toBe('failed');
    expect(userModel.updateOne).not.toHaveBeenCalled(); // not marked purged → retried next run
  });

  it('finalizeDueConnectPending selects PENDING connect deletions whose window elapsed', async () => {
    await svc.finalizeDueConnectPending();
    const filter = userModel.find.mock.calls[0][0];
    expect(filter['connectDeletion.state']).toBe('pending');
    expect(filter['connectDeletion.purgeAfter']).toHaveProperty('$lte');
  });

  it('finalizeDueConnectPending finalizes each due account and summarizes', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    userModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: () =>
            Promise.resolve([
              {
                _id: a,
                connectDeletion: { state: 'pending', purgeAfter: new Date(Date.now() - DAY) },
              },
              {
                _id: b,
                connectDeletion: { state: 'pending', purgeAfter: new Date(Date.now() - DAY) },
              },
            ]),
        }),
      }),
    });

    const res = await svc.finalizeDueConnectPending();

    expect(connectPurge.purgeUserConnectContent).toHaveBeenCalledTimes(2);
    expect(res.purged).toBe(2);
    expect(res.scanned).toBe(2);
  });
});
