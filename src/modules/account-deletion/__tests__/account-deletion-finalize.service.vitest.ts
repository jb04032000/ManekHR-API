/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * Account-deletion Phase 2 — the targeted Day-30 finalize
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3C purge phase, §6).
 *
 *   - finalizeDuePending: sweeps accounts whose `accountDeletion.state==='pending'`
 *     AND `purgeAfter <= now`, finalizing each (per-account, fault-isolated).
 *   - finalizeOne: calls eraseAccount(allowSelf, initiatedBy:'self-serve') — which
 *     re-asserts the sole-admin guard under the ADMIN_ROSTER_LOCK internally — then
 *     flips the marker pending -> purged and audits `account_deletion_purged`. A
 *     sole-admin block keeps the account recoverable (no flip); other errors leave
 *     it pending for the next run.
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
import { ConflictException } from '@nestjs/common';
import { AccountDeletionFinalizeService } from '../account-deletion-finalize.service';

const DAY = 24 * 60 * 60 * 1000;

describe('AccountDeletionFinalizeService (Phase 2 Day-30 finalize)', () => {
  const userId = new Types.ObjectId();
  const userIdHex = userId.toString();

  let userModel: any;
  let accountErasure: { eraseAccount: ReturnType<typeof vi.fn> };
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let svc: AccountDeletionFinalizeService;

  beforeEach(() => {
    userModel = {
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
        }),
      }),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
    };
    accountErasure = { eraseAccount: vi.fn().mockResolvedValue({ ok: true }) };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    svc = new AccountDeletionFinalizeService(userModel, accountErasure as any, auditService as any);
  });

  const settle = () => new Promise((r) => setImmediate(r));

  // ── finalizeOne ───────────────────────────────────────────────────────────

  it('finalizeOne erases self-serve (allowSelf, actor=self) then flips marker pending -> purged + audits', async () => {
    const outcome = await svc.finalizeOne(userIdHex);

    expect(outcome).toBe('purged');
    // eraseAccount called with the real userId as BOTH target and actor + the
    // self-serve options (the admin self-block is bypassed only for this path).
    expect(accountErasure.eraseAccount).toHaveBeenCalledWith(
      userIdHex,
      userIdHex,
      expect.any(String),
      { allowSelf: true, initiatedBy: 'self-serve' },
    );
    // Marker advanced to 'purged' (the audit/state trail on the now-anonymized stub).
    const set = userModel.updateOne.mock.calls[0][1].$set;
    expect(set['accountDeletion.state']).toBe('purged');

    await settle();
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'account_deletion_purged',
    );
    expect(call).toBeDefined();
    expect(call[0].actorId).toBe(userIdHex);
  });

  it('finalizeOne keeps a SOLE ADMIN recoverable: on ERASURE_LAST_ADMIN_BLOCKED it does NOT flip or audit purged', async () => {
    accountErasure.eraseAccount.mockRejectedValue(
      new ConflictException({ code: 'ERASURE_LAST_ADMIN_BLOCKED' }),
    );

    const outcome = await svc.finalizeOne(userIdHex);

    expect(outcome).toBe('blocked');
    // Recoverable: the pending marker is untouched (no flip to purged).
    expect(userModel.updateOne).not.toHaveBeenCalled();
    const purged = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'account_deletion_purged',
    );
    expect(purged).toBeUndefined();
  });

  it('finalizeOne leaves the account pending for retry when erase fails for another reason', async () => {
    accountErasure.eraseAccount.mockRejectedValue(new Error('mongo down'));

    const outcome = await svc.finalizeOne(userIdHex);

    expect(outcome).toBe('failed');
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  // ── Phase 7 processor cascade (DPDP s.8(7)) ───────────────────────────────

  it('finalizeOne runs the processor cascade with the photo URL captured BEFORE the scrub', async () => {
    const processorErasure = { eraseAtProcessors: vi.fn().mockResolvedValue({}) };
    // findById(...).select('profilePicture').lean().exec() returns the photo URL
    // the scrub is about to null.
    const ppUserModel = {
      ...userModel,
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: () => Promise.resolve({ profilePicture: 'https://cdn.example/pp/x.jpg' }),
          }),
        }),
      }),
    };
    const localSvc = new AccountDeletionFinalizeService(
      ppUserModel,
      accountErasure as any,
      auditService as any,
      undefined, // connectPurge (@Optional)
      processorErasure as any, // processorErasure (@Optional)
    );

    const outcome = await localSvc.finalizeOne(userIdHex);

    expect(outcome).toBe('purged');
    expect(accountErasure.eraseAccount).toHaveBeenCalled();
    // Cascade ran with the photo URL captured before the scrub nulled it.
    expect(processorErasure.eraseAtProcessors).toHaveBeenCalledWith(userIdHex, {
      profilePicture: 'https://cdn.example/pp/x.jpg',
    });
  });

  it('finalizeOne does NOT run the processor cascade when the erase is blocked (sole admin)', async () => {
    const processorErasure = { eraseAtProcessors: vi.fn() };
    accountErasure.eraseAccount.mockRejectedValue(
      new ConflictException({ code: 'ERASURE_LAST_ADMIN_BLOCKED' }),
    );
    const localSvc = new AccountDeletionFinalizeService(
      userModel,
      accountErasure as any,
      auditService as any,
      undefined,
      processorErasure as any,
    );

    const outcome = await localSvc.finalizeOne(userIdHex);

    expect(outcome).toBe('blocked');
    // No scrub committed → nothing to erase at the vendor.
    expect(processorErasure.eraseAtProcessors).not.toHaveBeenCalled();
  });

  // ── eraseUserCompletely (admin-initiated complete erase) ──────────────────

  it('eraseUserCompletely runs the FULL flow: Connect purge -> scrub (ADMIN actor) -> processor cascade', async () => {
    const connectPurge = {
      purgeUserConnectContent: vi.fn().mockResolvedValue({ failures: [] }),
    };
    const processorErasure = { eraseAtProcessors: vi.fn().mockResolvedValue({}) };
    const ppUserModel = {
      ...userModel,
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: () => Promise.resolve({ profilePicture: 'https://cdn.example/pp/x.jpg' }),
          }),
        }),
      }),
    };
    const svcFull = new AccountDeletionFinalizeService(
      ppUserModel,
      accountErasure as any,
      auditService as any,
      connectPurge as any,
      processorErasure as any,
    );

    await svcFull.eraseUserCompletely(userIdHex, 'admin-actor-id', 'DPDP ticket 42');

    // Connect content purged BEFORE the scrub.
    expect(connectPurge.purgeUserConnectContent).toHaveBeenCalledWith(userIdHex);
    // Identity scrub with the ADMIN as actor (NOT allowSelf — admin != target).
    expect(accountErasure.eraseAccount).toHaveBeenCalledWith(
      userIdHex,
      'admin-actor-id',
      'DPDP ticket 42',
    );
    // Files erased at the vendor AFTER the scrub.
    expect(processorErasure.eraseAtProcessors).toHaveBeenCalledWith(userIdHex, {
      profilePicture: 'https://cdn.example/pp/x.jpg',
    });
  });

  it('eraseUserCompletely propagates an erase failure (e.g. last active admin) to the caller', async () => {
    accountErasure.eraseAccount.mockRejectedValue(
      new ConflictException({ code: 'ERASURE_LAST_ADMIN_BLOCKED' }),
    );
    const svcFull = new AccountDeletionFinalizeService(
      userModel,
      accountErasure as any,
      auditService as any,
    );

    await expect(
      svcFull.eraseUserCompletely(userIdHex, 'admin-actor-id', 'x'),
    ).rejects.toMatchObject({ response: { code: 'ERASURE_LAST_ADMIN_BLOCKED' } });
  });

  // ── finalizeDuePending ────────────────────────────────────────────────────

  it('finalizeDuePending only selects PENDING accounts whose purgeAfter has elapsed', async () => {
    await svc.finalizeDuePending();

    const filter = userModel.find.mock.calls[0][0];
    expect(filter['accountDeletion.state']).toBe('pending');
    // purgeAfter <= now (elapsed window only — future-dated accounts are skipped).
    expect(filter['accountDeletion.purgeAfter']).toHaveProperty('$lte');
    expect(filter['accountDeletion.purgeAfter'].$lte).toBeInstanceOf(Date);
  });

  it('finalizeDuePending finalizes each due account and returns a summary', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    userModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: () =>
            Promise.resolve([
              {
                _id: a,
                accountDeletion: { state: 'pending', purgeAfter: new Date(Date.now() - DAY) },
              },
              {
                _id: b,
                accountDeletion: { state: 'pending', purgeAfter: new Date(Date.now() - DAY) },
              },
            ]),
        }),
      }),
    });

    const res = await svc.finalizeDuePending();

    expect(accountErasure.eraseAccount).toHaveBeenCalledTimes(2);
    expect(res.purged).toBe(2);
    expect(res.scanned).toBe(2);
  });

  it('finalizeDuePending is fault-isolated: one failing account does not stop the rest', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    userModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: () =>
            Promise.resolve([
              {
                _id: a,
                accountDeletion: { state: 'pending', purgeAfter: new Date(Date.now() - DAY) },
              },
              {
                _id: b,
                accountDeletion: { state: 'pending', purgeAfter: new Date(Date.now() - DAY) },
              },
            ]),
        }),
      }),
    });
    // First account blows up, second succeeds.
    accountErasure.eraseAccount
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });

    const res = await svc.finalizeDuePending();

    expect(accountErasure.eraseAccount).toHaveBeenCalledTimes(2);
    expect(res.purged).toBe(1);
    expect(res.failed).toBe(1);
  });
});
