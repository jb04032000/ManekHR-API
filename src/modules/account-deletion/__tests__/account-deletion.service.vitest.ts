/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * Account-deletion Phase 1 — the auth-gating SCHEDULE + admin RESTORE primitives
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3C soft phase, §5, §A.4).
 *
 *   - scheduleAccountDeletion: stamps accountDeletion.state='pending' (30-day
 *     timer) AND suspends (isActive=false) + revokes sessions + drops the claims
 *     cache. email/mobile stay populated, deletedAt stays unset (the row is
 *     suspended, NOT finalized). Sole admin is blocked at request time.
 *   - restoreDeletion: admin-mediated recovery within the 30-day window — clears
 *     the pending markers + isActive=true + drops the claims cache.
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
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AccountDeletionService } from '../account-deletion.service';

const DAY = 24 * 60 * 60 * 1000;

describe('AccountDeletionService (Phase 1)', () => {
  const userId = new Types.ObjectId();
  const userIdHex = userId.toString();
  const adminId = new Types.ObjectId().toString();

  let userModel: any;
  let accountErasure: { assertNotLastActiveAdmin: ReturnType<typeof vi.fn> };
  let sessionsService: { invalidateAllSessions: ReturnType<typeof vi.fn> };
  let claimsCache: { invalidate: ReturnType<typeof vi.fn> };
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let authService: { assertReauthenticated: ReturnType<typeof vi.fn> };
  let smsOtp: { consumeStepupProof: ReturnType<typeof vi.fn> };
  let mailService: {
    sendAccountDeletionScheduledEmail: ReturnType<typeof vi.fn>;
    sendAccountDeletionReminderEmail: ReturnType<typeof vi.fn>;
  };
  let mandateService: { cancelMandate: ReturnType<typeof vi.fn> };
  let svc: AccountDeletionService;
  let foundUser: any;

  beforeEach(() => {
    foundUser = {
      _id: userId,
      name: 'Asha Patel',
      email: 'asha@example.com',
      mobile: '919876543210',
      isActive: true,
    };
    userModel = {
      findById: vi.fn().mockReturnValue({
        exec: () => Promise.resolve(foundUser),
        select: vi.fn().mockReturnValue({ exec: () => Promise.resolve(foundUser) }),
      }),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
        }),
      }),
    };
    accountErasure = { assertNotLastActiveAdmin: vi.fn().mockResolvedValue(undefined) };
    sessionsService = { invalidateAllSessions: vi.fn().mockResolvedValue(2) };
    claimsCache = { invalidate: vi.fn().mockResolvedValue(undefined) };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    authService = { assertReauthenticated: vi.fn().mockResolvedValue(undefined) };
    smsOtp = { consumeStepupProof: vi.fn().mockResolvedValue(true) };
    mailService = {
      sendAccountDeletionScheduledEmail: vi.fn().mockResolvedValue(undefined),
      sendAccountDeletionReminderEmail: vi.fn().mockResolvedValue(undefined),
    };
    mandateService = { cancelMandate: vi.fn().mockResolvedValue(undefined) };
    svc = new AccountDeletionService(
      userModel,
      accountErasure as any,
      sessionsService as any,
      claimsCache as any,
      auditService as any,
      authService as any,
      smsOtp as any,
      mailService as any,
      mandateService as any,
    );
  });

  // ── scheduleAccountDeletion ───────────────────────────────────────────────

  it('schedule suspends the account (state=pending + isActive=false) and logs the user out', async () => {
    const res = await svc.scheduleAccountDeletion(userIdHex, userIdHex);

    expect(res.state).toBe('pending');
    // Sole-admin guard ran BEFORE any state change.
    expect(accountErasure.assertNotLastActiveAdmin).toHaveBeenCalledWith(userIdHex);

    const set = userModel.updateOne.mock.calls[0][1].$set;
    expect(set.isActive).toBe(false);
    expect(set.accountDeletion.state).toBe('pending');
    expect(set.accountDeletion.requestedBy.toString()).toBe(userIdHex);

    // purgeAfter is exactly 30 days after requestedAt (the recovery timer).
    const diff =
      new Date(set.accountDeletion.purgeAfter).getTime() -
      new Date(set.accountDeletion.requestedAt).getTime();
    expect(diff).toBe(30 * DAY);

    // Fully logged out: all sessions revoked + claims cache dropped.
    expect(sessionsService.invalidateAllSessions).toHaveBeenCalledWith(userIdHex);
    expect(claimsCache.invalidate).toHaveBeenCalledWith(userIdHex);

    // Audited.
    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'account_deletion_scheduled',
    );
    expect(call).toBeDefined();
    expect(call[0].actorId).toBe(userIdHex);
  });

  it('leaves email / mobile populated and deletedAt unset while pending (suspended, not finalized)', async () => {
    await svc.scheduleAccountDeletion(userIdHex, userIdHex);

    const set = userModel.updateOne.mock.calls[0][1].$set;
    // The scrub patch (which nulls email/mobile + sets deletedAt) is Day-30,
    // NOT schedule time. Re-signup stays blocked; retention crons don't see it
    // as finalized.
    expect('email' in set).toBe(false);
    expect('mobile' in set).toBe(false);
    expect('deletedAt' in set).toBe(false);
    expect(userModel.updateOne.mock.calls[0][1].$unset).toBeUndefined();
  });

  it('blocks a sole admin from scheduling self-deletion at request time (409, no state change)', async () => {
    accountErasure.assertNotLastActiveAdmin.mockRejectedValue(
      new ConflictException({ code: 'ERASURE_LAST_ADMIN_BLOCKED' }),
    );

    await expect(svc.scheduleAccountDeletion(userIdHex, userIdHex)).rejects.toMatchObject({
      response: { code: 'ERASURE_LAST_ADMIN_BLOCKED' },
    });
    // Nothing changed: no suspend, no logout.
    expect(userModel.updateOne).not.toHaveBeenCalled();
    expect(sessionsService.invalidateAllSessions).not.toHaveBeenCalled();
    expect(claimsCache.invalidate).not.toHaveBeenCalled();
  });

  it('is idempotent — re-scheduling an already-pending account is a no-op', async () => {
    foundUser.isActive = false;
    foundUser.accountDeletion = {
      state: 'pending',
      requestedAt: new Date(Date.now() - 2 * DAY),
      purgeAfter: new Date(Date.now() + 28 * DAY),
    };

    const res = await svc.scheduleAccountDeletion(userIdHex, userIdHex);

    expect(res.alreadyPending).toBe(true);
    expect(res.state).toBe('pending');
    expect(userModel.updateOne).not.toHaveBeenCalled();
    expect(sessionsService.invalidateAllSessions).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown user and changes nothing', async () => {
    userModel.findById.mockReturnValue({ exec: () => Promise.resolve(null) });

    await expect(svc.scheduleAccountDeletion(userIdHex, userIdHex)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  // ── restoreDeletion (admin-mediated recovery) ─────────────────────────────

  it('admin restore reactivates a pending account (isActive=true, marker cleared, claims dropped)', async () => {
    foundUser.isActive = false;
    foundUser.accountDeletion = {
      state: 'pending',
      requestedAt: new Date(Date.now() - 2 * DAY),
      purgeAfter: new Date(Date.now() + 28 * DAY),
    };

    const res = await svc.restoreDeletion(userIdHex, adminId, 'user emailed support to recover');

    const update = userModel.updateOne.mock.calls[0][1];
    expect(update.$set.isActive).toBe(true);
    expect(update.$unset).toHaveProperty('accountDeletion');
    expect(claimsCache.invalidate).toHaveBeenCalledWith(userIdHex);
    expect(res.restored).toContain('account');

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'account_deletion_cancelled',
    );
    expect(call).toBeDefined();
    expect(call[0].actorId).toBe(adminId);
  });

  it('refuses restore once the 30-day window has elapsed (data due for / past scrub)', async () => {
    foundUser.isActive = false;
    foundUser.accountDeletion = {
      state: 'pending',
      requestedAt: new Date(Date.now() - 40 * DAY),
      purgeAfter: new Date(Date.now() - 10 * DAY),
    };

    await expect(svc.restoreDeletion(userIdHex, adminId)).rejects.toMatchObject({
      response: { code: 'DELETION_WINDOW_EXPIRED' },
    });
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('refuses restore when there is no pending deletion to recover', async () => {
    await expect(svc.restoreDeletion(userIdHex, adminId)).rejects.toMatchObject({
      response: { code: 'NO_PENDING_DELETION' },
    });
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  // ── scheduleSelfServeAccountDeletion (Phase 2 verified self-serve schedule) ─

  const settle = () => new Promise((r) => setImmediate(r));

  it('verified schedule: confirm + re-auth + single-use proof, then suspends', async () => {
    const res = await svc.scheduleSelfServeAccountDeletion(userIdHex, {
      reauth: { kind: 'password', password: 'pw' },
      otpProof: 'proof-nonce',
      confirm: 'DELETE',
    });

    expect(res.state).toBe('pending');
    // Re-auth ran against the JWT subject; the step-up proof was consumed once.
    expect(authService.assertReauthenticated).toHaveBeenCalledWith(userIdHex, {
      kind: 'password',
      password: 'pw',
    });
    expect(smsOtp.consumeStepupProof).toHaveBeenCalledWith(userIdHex, 'proof-nonce');
    // The soft phase actually ran (account suspended).
    const set = userModel.updateOne.mock.calls[0][1].$set;
    expect(set.isActive).toBe(false);
    expect(set.accountDeletion.state).toBe('pending');
  });

  it('verified schedule: cancels subscription auto-renew + emails confirmation on first schedule', async () => {
    const res = await svc.scheduleSelfServeAccountDeletion(userIdHex, {
      reauth: { kind: 'password', password: 'pw' },
      otpProof: 'proof-nonce',
      confirm: 'DELETE',
    });
    await settle();

    // Auto-renew cancelled at cycle end (best-effort).
    expect(mandateService.cancelMandate).toHaveBeenCalledWith(userIdHex, {
      cancelAtCycleEnd: true,
    });
    // Confirmation email with the recover-by date == purgeAfter.
    expect(mailService.sendAccountDeletionScheduledEmail).toHaveBeenCalledTimes(1);
    const arg = mailService.sendAccountDeletionScheduledEmail.mock.calls[0][0];
    expect(arg.to).toBe('asha@example.com');
    expect(new Date(arg.recoverByDate).getTime()).toBe(new Date(res.purgeAfter).getTime());
  });

  it('verified schedule: rejects a wrong type-to-confirm phrase BEFORE any factor check or state change', async () => {
    await expect(
      svc.scheduleSelfServeAccountDeletion(userIdHex, {
        reauth: { kind: 'password', password: 'pw' },
        otpProof: 'proof-nonce',
        confirm: 'delete me',
      }),
    ).rejects.toMatchObject({ response: { code: 'DELETION_CONFIRM_REQUIRED' } });

    expect(authService.assertReauthenticated).not.toHaveBeenCalled();
    expect(smsOtp.consumeStepupProof).not.toHaveBeenCalled();
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('verified schedule: a failed re-auth propagates and never consumes the proof or suspends', async () => {
    authService.assertReauthenticated.mockRejectedValue(
      new (await import('@nestjs/common')).UnauthorizedException({ code: 'REAUTH_INVALID' }),
    );

    await expect(
      svc.scheduleSelfServeAccountDeletion(userIdHex, {
        reauth: { kind: 'password', password: 'wrong' },
        otpProof: 'proof-nonce',
        confirm: 'DELETE',
      }),
    ).rejects.toMatchObject({ response: { code: 'REAUTH_INVALID' } });

    expect(smsOtp.consumeStepupProof).not.toHaveBeenCalled();
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('verified schedule: an invalid / replayed step-up proof is rejected and nothing is suspended', async () => {
    // consumeStepupProof returns false for a missing/expired/already-burned nonce.
    smsOtp.consumeStepupProof.mockResolvedValue(false);

    await expect(
      svc.scheduleSelfServeAccountDeletion(userIdHex, {
        reauth: { kind: 'password', password: 'pw' },
        otpProof: 'stale-or-replayed',
        confirm: 'DELETE',
      }),
    ).rejects.toMatchObject({ response: { code: 'STEPUP_PROOF_INVALID' } });

    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('verified schedule: an already-pending account is idempotent — no re-cancel, no re-email', async () => {
    foundUser.isActive = false;
    foundUser.accountDeletion = {
      state: 'pending',
      requestedAt: new Date(Date.now() - 2 * DAY),
      purgeAfter: new Date(Date.now() + 28 * DAY),
    };

    const res = await svc.scheduleSelfServeAccountDeletion(userIdHex, {
      reauth: { kind: 'password', password: 'pw' },
      otpProof: 'proof-nonce',
      confirm: 'DELETE',
    });
    await settle();

    expect(res.alreadyPending).toBe(true);
    // Side-effects fire only on the first schedule.
    expect(mandateService.cancelMandate).not.toHaveBeenCalled();
    expect(mailService.sendAccountDeletionScheduledEmail).not.toHaveBeenCalled();
  });

  it('verified schedule: a missing subscription mandate does not abort the schedule (best-effort)', async () => {
    mandateService.cancelMandate.mockRejectedValue(
      new (await import('@nestjs/common')).NotFoundException(
        'No active mandate found for this account',
      ),
    );

    const res = await svc.scheduleSelfServeAccountDeletion(userIdHex, {
      reauth: { kind: 'password', password: 'pw' },
      otpProof: 'proof-nonce',
      confirm: 'DELETE',
    });
    await settle();

    expect(res.state).toBe('pending');
    // The suspend still committed even though there was no mandate to cancel.
    expect(userModel.updateOne).toHaveBeenCalled();
  });

  // ── remindDuePending (~Day-25 reminder sweep) ─────────────────────────────

  it('reminder sweep: emails pending accounts inside the window once + stamps reminderSentAt', async () => {
    const purgeAfter = new Date(Date.now() + 3 * DAY); // 3 days left
    userModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: () =>
            Promise.resolve([
              {
                _id: userId,
                name: 'Asha Patel',
                email: 'asha@example.com',
                accountDeletion: { state: 'pending', purgeAfter },
              },
            ]),
        }),
      }),
    });

    const res = await svc.remindDuePending();

    expect(res.reminded).toBe(1);
    expect(mailService.sendAccountDeletionReminderEmail).toHaveBeenCalledTimes(1);
    const arg = mailService.sendAccountDeletionReminderEmail.mock.calls[0][0];
    expect(arg.to).toBe('asha@example.com');
    expect(arg.daysLeft).toBe(3);
    // Deduped: reminderSentAt stamped so the next sweep skips it.
    const upd = userModel.updateOne.mock.calls[0];
    expect(Object.keys(upd[1].$set)).toContain('accountDeletion.reminderSentAt');

    // The query only selects pending accounts whose reminder has not been sent.
    const filter = userModel.find.mock.calls[0][0];
    expect(filter['accountDeletion.state']).toBe('pending');
    expect(filter['accountDeletion.reminderSentAt']).toBeDefined();
  });

  it('reminder sweep: skips a pending account with no email on file (cannot remind)', async () => {
    const purgeAfter = new Date(Date.now() + 2 * DAY);
    userModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: () =>
            Promise.resolve([
              {
                _id: userId,
                name: 'Mobile Only',
                accountDeletion: { state: 'pending', purgeAfter },
              },
            ]),
        }),
      }),
    });

    const res = await svc.remindDuePending();

    expect(res.reminded).toBe(0);
    expect(mailService.sendAccountDeletionReminderEmail).not.toHaveBeenCalled();
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });
});
