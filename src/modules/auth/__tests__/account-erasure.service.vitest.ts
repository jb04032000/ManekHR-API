/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * OQ-3 account erasure (DPDP) — proves the erase-vs-retain split:
 *   - ERASE: all auth secrets + basis-less PII (Bucket C), identity anonymized.
 *   - RETAIN: razorpayCustomerId + billingProfile (Bucket B, 8y) and the
 *     consent/audit stamps (Bucket D) are NEVER in the scrub patch; statutory
 *     salary/attendance rows (other collections) are never touched.
 *   - Revokes all sessions, invalidates the JWT claims cache, audits as the
 *     ADMIN actor (not the erased user).
 * Links: account-erasure.service.ts, DATA-MAP-AND-RETENTION.md.
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
import { AccountErasureService } from '../services/account-erasure.service';
import { ConflictException, NotFoundException } from '@nestjs/common';

describe('AccountErasureService (OQ-3)', () => {
  const userId = new Types.ObjectId();
  const userIdHex = userId.toString();
  const adminId = new Types.ObjectId().toString();

  let userModel: any;
  let sessionsService: any;
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let claimsCache: any;
  // Fake of SingleFlightService.withLock. Default impl just runs the critical
  // section (no real Redis) — the concurrency test below overrides it with one
  // that genuinely serializes callers so the TOCTOU interleaving is exercised.
  let singleFlight: { withLock: ReturnType<typeof vi.fn> };
  let svc: AccountErasureService;

  // The doc returned by findById().select().exec(); overridable per test.
  let foundUser: any;
  // The count returned by countDocuments().exec() (other active admins).
  let otherActiveAdmins: number;

  beforeEach(() => {
    foundUser = {
      _id: userId,
      name: 'Asha Patel',
      email: 'asha@example.com',
      mobile: '919876543210',
      isAdmin: false,
    };
    otherActiveAdmins = 0;
    userModel = {
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi.fn().mockImplementation(() => Promise.resolve(foundUser)),
        }),
      }),
      countDocuments: vi.fn().mockReturnValue({
        exec: vi.fn().mockImplementation(() => Promise.resolve(otherActiveAdmins)),
      }),
      updateOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({}) }),
    };
    sessionsService = { invalidateAllSessions: vi.fn().mockResolvedValue(3) };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    claimsCache = { invalidate: vi.fn().mockResolvedValue(undefined) };
    // Pass-through lock by default: run the critical section immediately.
    singleFlight = { withLock: vi.fn().mockImplementation((_key: string, fn: () => any) => fn()) };
    svc = new AccountErasureService(
      userModel,
      sessionsService,
      auditService as any,
      claimsCache,
      singleFlight as any,
    );
  });

  it('buildBucketCScrubPatch scrubs every auth secret + basis-less PII, anonymizes identity', () => {
    const patch = AccountErasureService.buildBucketCScrubPatch(userIdHex);

    // Identity anonymized (not deleted).
    expect(patch.name).toBe('Deleted user');
    expect(patch.email).toBeNull();
    expect(patch.mobile).toBeNull();
    expect(patch.handle).toBe(`user-${userIdHex}`);
    expect(patch.profilePicture).toBeNull();

    // Every auth secret nulled.
    expect(patch.passwordHash).toBeNull();
    expect(patch.pinHash).toBeNull();
    expect(patch.googleId).toBeNull();
    expect(patch.resetPasswordTokenHash).toBeNull();
    expect(patch.emailVerificationToken).toBeNull();
    expect(patch.mobileVerificationToken).toBeNull();

    // Device binding + basis-less prefs + platform role flag scrubbed.
    expect(patch.fcmToken).toBeNull();
    expect(patch.appLockIdleMs).toBeNull();
    expect(patch.isAdmin).toBe(false);
    expect(patch.connectEnabled).toBe(false);

    // Lifecycle.
    expect(patch.isActive).toBe(false);
    expect(patch.deletedAt).toBeInstanceOf(Date);
  });

  it('buildBucketCScrubPatch NEVER includes retained Bucket B / Bucket D fields', () => {
    const patch = AccountErasureService.buildBucketCScrubPatch(userIdHex);

    // Bucket B — billing reconciliation basis (8y): must be RETAINED, so absent.
    expect('razorpayCustomerId' in patch).toBe(false);
    expect('billingProfile' in patch).toBe(false);

    // Bucket D — consent + HR-decision audit stamps: must be RETAINED, so absent.
    expect('connectPolicyAcceptedAt' in patch).toBe(false);
    expect('erpPolicyAcceptedAt' in patch).toBe(false);
    expect('deactivatedAt' in patch).toBe(false);
    expect('deactivationNote' in patch).toBe(false);
  });

  it('eraseAccount revokes sessions, scrubs, invalidates cache, audits as admin', async () => {
    const result = await svc.eraseAccount(userIdHex, adminId, 'DPDP-ticket-42');

    // Sessions revoked cross-workspace.
    expect(sessionsService.invalidateAllSessions).toHaveBeenCalledWith(userIdHex);
    expect(result.sessionsRevoked).toBe(3);

    // Scrub patch applied to the User row (does not hard-delete it).
    expect(userModel.updateOne).toHaveBeenCalledTimes(1);
    const setArg = userModel.updateOne.mock.calls[0][1].$set;
    expect(setArg.name).toBe('Deleted user');
    expect(setArg.passwordHash).toBeNull();
    expect('razorpayCustomerId' in setArg).toBe(false); // retained

    // JWT hot-path cache invalidated (OQ-2 coupling).
    expect(claimsCache.invalidate).toHaveBeenCalledWith(userIdHex);

    // Audited with the ADMIN as actor + PRE-erasure name snapshot.
    expect(auditService.logEvent).toHaveBeenCalledTimes(1);
    const audit = auditService.logEvent.mock.calls[0][0];
    expect(audit.action).toBe('account_erased');
    expect(audit.actorId).toBe(adminId);
    expect(audit.actorNameSnapshot).toBe('Asha Patel');
    expect(audit.workspaceId).toBeNull();
    expect(audit.reason).toBe('DPDP-ticket-42');

    expect(result.retained.billing).toBe(true);
    expect(result.retained.statutory).toBe('preserved-in-owning-modules');
  });

  it('eraseAccount still scrubs PII even if session revoke fails (DPDP obligation wins)', async () => {
    sessionsService.invalidateAllSessions.mockRejectedValueOnce(new Error('redis down'));

    const result = await svc.eraseAccount(userIdHex, adminId);

    // Scrub proceeded despite the revoke error.
    expect(userModel.updateOne).toHaveBeenCalledTimes(1);
    expect(claimsCache.invalidate).toHaveBeenCalledWith(userIdHex);
    expect(result.sessionsRevoked).toBe(0);
  });

  it('throws NotFound for an unknown / invalid user id and scrubs nothing', async () => {
    await expect(svc.eraseAccount('not-an-objectid', adminId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  // ── AUTH-H4: privilege-orphan guards ──────────────────────────────────────

  it('blocks self-erase (target == actor) and scrubs nothing', async () => {
    await expect(svc.eraseAccount(userIdHex, userIdHex)).rejects.toMatchObject({
      response: { code: 'ERASURE_SELF_BLOCKED' },
    });
    await expect(svc.eraseAccount(userIdHex, userIdHex)).rejects.toBeInstanceOf(ConflictException);
    // No lookup/scrub/session-revoke happened.
    expect(userModel.findById).not.toHaveBeenCalled();
    expect(userModel.updateOne).not.toHaveBeenCalled();
    expect(sessionsService.invalidateAllSessions).not.toHaveBeenCalled();
  });

  it('blocks erasing the last active admin (no other active admin remains)', async () => {
    foundUser.isAdmin = true;
    otherActiveAdmins = 0;

    await expect(svc.eraseAccount(userIdHex, adminId)).rejects.toMatchObject({
      response: { code: 'ERASURE_LAST_ADMIN_BLOCKED' },
    });
    // It counted OTHER active admins, then refused before scrubbing.
    expect(userModel.countDocuments).toHaveBeenCalledTimes(1);
    const countFilter = userModel.countDocuments.mock.calls[0][0];
    expect(countFilter.isAdmin).toBe(true);
    expect(countFilter.isActive).toBe(true);
    expect(countFilter._id).toEqual({ $ne: userId });
    expect(countFilter.deletedAt).toEqual({ $in: [null, undefined] });
    expect(userModel.updateOne).not.toHaveBeenCalled();
    expect(sessionsService.invalidateAllSessions).not.toHaveBeenCalled();
  });

  it('allows erasing an admin when at least one OTHER active admin remains', async () => {
    foundUser.isAdmin = true;
    otherActiveAdmins = 1;

    const result = await svc.eraseAccount(userIdHex, adminId);

    expect(result.ok).toBe(true);
    expect(userModel.updateOne).toHaveBeenCalledTimes(1);
    expect(sessionsService.invalidateAllSessions).toHaveBeenCalledWith(userIdHex);
  });

  it('does not run the admin-count query for a non-admin target', async () => {
    foundUser.isAdmin = false;

    await svc.eraseAccount(userIdHex, adminId);

    expect(userModel.countDocuments).not.toHaveBeenCalled();
    expect(userModel.updateOne).toHaveBeenCalledTimes(1);
    // Common path is lock-free — no added latency on non-admin erasures.
    expect(singleFlight.withLock).not.toHaveBeenCalled();
  });

  it('serializes the admin check+scrub under the admin-roster mutex', async () => {
    foundUser.isAdmin = true;
    otherActiveAdmins = 1;

    await svc.eraseAccount(userIdHex, adminId);

    // Admin path goes through withLock; the count + scrub ran inside it.
    expect(singleFlight.withLock).toHaveBeenCalledTimes(1);
    expect(singleFlight.withLock.mock.calls[0][0]).toBe('auth:admin-roster');
    expect(userModel.countDocuments).toHaveBeenCalledTimes(1);
    expect(userModel.updateOne).toHaveBeenCalledTimes(1);
  });

  // ── AUTH-H4a: TOCTOU race — two concurrent erasures of the two LAST admins ──
  // This is the regression test for the fix. We back countDocuments/updateOne
  // with a shared in-memory store of TWO admins and use a REAL serializing mutex
  // for withLock. Without serialization both erasures would count "1 other admin
  // remains" before either writes and both would scrub → zero admins. With the
  // mutex, the first demote is committed before the second's count runs, so the
  // second sees 0 and is blocked. Assert: AT MOST ONE succeeds and AT LEAST ONE
  // active admin always remains.
  it('never drops below one active admin under two concurrent last-admin erasures', async () => {
    const adminA = new Types.ObjectId();
    const adminB = new Types.ObjectId();
    const actor = new Types.ObjectId().toString();

    // Shared in-memory user store (the source of truth both erasures race on).
    const store: Record<
      string,
      {
        _id: Types.ObjectId;
        name: string;
        isAdmin: boolean;
        isActive: boolean;
        deletedAt: Date | null;
      }
    > = {
      [adminA.toString()]: {
        _id: adminA,
        name: 'Admin A',
        isAdmin: true,
        isActive: true,
        deletedAt: null,
      },
      [adminB.toString()]: {
        _id: adminB,
        name: 'Admin B',
        isAdmin: true,
        isActive: true,
        deletedAt: null,
      },
    };

    const countOtherActiveAdmins = (excludeId: Types.ObjectId): number =>
      Object.values(store).filter(
        (u) => !u._id.equals(excludeId) && u.isAdmin && u.isActive && u.deletedAt == null,
      ).length;

    const sharedUserModel: any = {
      findById: (id: string) => ({
        select: () => ({ exec: () => Promise.resolve(store[id] ?? null) }),
      }),
      countDocuments: (filter: any) => ({
        // Excluded id arrives as filter._id.$ne (an ObjectId).
        exec: () => Promise.resolve(countOtherActiveAdmins(filter._id.$ne)),
      }),
      updateOne: (filter: any, update: any) => ({
        exec: () => {
          const row = store[filter._id.toString()];
          if (row) Object.assign(row, update.$set); // applies isAdmin:false etc.
          return Promise.resolve({});
        },
      }),
    };

    // REAL serializing mutex: only one withLock body runs at a time, the other
    // awaits the in-flight promise chain. This forces the interleaving the fix
    // depends on (first demote commits before second count runs).
    let chain: Promise<unknown> = Promise.resolve();
    const serializingLock = {
      withLock: vi.fn().mockImplementation((_key: string, fn: () => Promise<unknown>) => {
        const run = chain.then(() => fn());
        // Keep the chain alive even if a body rejects, so the next waiter still runs.
        chain = run.catch(() => undefined);
        return run;
      }),
    };

    const concurrentSvc = new AccountErasureService(
      sharedUserModel,
      { invalidateAllSessions: vi.fn().mockResolvedValue(0) } as any,
      { logEvent: vi.fn().mockResolvedValue(undefined) } as any,
      { invalidate: vi.fn().mockResolvedValue(undefined) } as any,
      serializingLock as any,
    );

    // Fire BOTH erasures concurrently (the naive count would let both through).
    const results = await Promise.allSettled([
      concurrentSvc.eraseAccount(adminA.toString(), actor),
      concurrentSvc.eraseAccount(adminB.toString(), actor),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // AT MOST ONE erasure succeeded (the invariant: we cannot erase both).
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    // The blocked one(s) fail with the stable last-admin code.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConflictException);
      expect((r.reason as ConflictException).getResponse()).toMatchObject({
        code: 'ERASURE_LAST_ADMIN_BLOCKED',
      });
    }
    // AT LEAST ONE active, non-deleted admin always remains.
    const remainingAdmins = Object.values(store).filter(
      (u) => u.isAdmin && u.isActive && u.deletedAt == null,
    );
    expect(remainingAdmins.length).toBeGreaterThanOrEqual(1);
  });

  // ── Account-deletion Phase 1 — assertNotLastActiveAdmin extraction ─────────
  // Extracted so the self-serve SCHEDULE path can re-use the same guard
  // synchronously (block a sole admin from scheduling their own deletion before
  // any state change). Plan §A.4.
  describe('assertNotLastActiveAdmin (extracted guard)', () => {
    it('is a no-op for a non-admin target (cannot be the last admin)', async () => {
      foundUser.isAdmin = false;

      await expect(svc.assertNotLastActiveAdmin(userIdHex)).resolves.toBeUndefined();
      // Non-admin can never orphan admin access → no count query.
      expect(userModel.countDocuments).not.toHaveBeenCalled();
    });

    it('throws ERASURE_LAST_ADMIN_BLOCKED when the target is the only active admin', async () => {
      foundUser.isAdmin = true;
      otherActiveAdmins = 0;

      await expect(svc.assertNotLastActiveAdmin(userIdHex)).rejects.toMatchObject({
        response: { code: 'ERASURE_LAST_ADMIN_BLOCKED' },
      });
      const countFilter = userModel.countDocuments.mock.calls[0][0];
      expect(countFilter.isAdmin).toBe(true);
      expect(countFilter.isActive).toBe(true);
      expect(countFilter._id).toEqual({ $ne: userId });
      expect(countFilter.deletedAt).toEqual({ $in: [null, undefined] });
    });

    it('resolves when at least one OTHER active admin remains', async () => {
      foundUser.isAdmin = true;
      otherActiveAdmins = 1;

      await expect(svc.assertNotLastActiveAdmin(userIdHex)).resolves.toBeUndefined();
    });
  });

  // ── Account-deletion Phase 1 — self-serve erase (allowSelf) ────────────────
  // The Day-30 finalize calls eraseAccount with the REAL userId as actor +
  // allowSelf:true; the admin path keeps ERASURE_SELF_BLOCKED. Plan §A.5.
  describe('eraseAccount allowSelf / initiatedBy', () => {
    it('permits self-target (actor === target) when allowSelf is true and records initiatedBy', async () => {
      const result = await svc.eraseAccount(userIdHex, userIdHex, 'grace elapsed', {
        allowSelf: true,
        initiatedBy: 'self-serve',
      });

      expect(result.ok).toBe(true);
      // Scrub proceeded — self-block did NOT fire.
      expect(userModel.updateOne).toHaveBeenCalledTimes(1);
      const audit = auditService.logEvent.mock.calls[0][0];
      expect(audit.meta.initiatedBy).toBe('self-serve');
    });

    it('still blocks self-target when allowSelf is absent (admin path default)', async () => {
      await expect(svc.eraseAccount(userIdHex, userIdHex)).rejects.toMatchObject({
        response: { code: 'ERASURE_SELF_BLOCKED' },
      });
      expect(userModel.updateOne).not.toHaveBeenCalled();
    });
  });

  // ── OQ-W4 (Workspaces hardening) — auto-soft-delete owned workspaces ───────
  // Erasure must soft-delete the user's owned workspaces BEFORE scrubbing the
  // identity, so none is left orphaned with an ownerId → "Deleted user" stub.
  describe('OQ-W4 — owned-workspace auto-soft-delete', () => {
    it('calls softDeleteAllOwnedForErasure(userId) before scrubbing, records the count', async () => {
      const workspacesService = {
        softDeleteAllOwnedForErasure: vi.fn().mockResolvedValue({ softDeleted: 2 }),
      };
      const svcWithWs = new AccountErasureService(
        userModel,
        sessionsService,
        auditService as any,
        claimsCache,
        singleFlight as any,
        // 6th ctor param is the @Optional eventEmitter; workspacesService is 7th.
        // (Pre-Phase-1 these tests omitted the eventEmitter slot, so the
        // workspacesService mock landed on eventEmitter and the WS step no-op'd.)
        { emit: vi.fn() } as any,
        workspacesService as any,
      );

      await svcWithWs.eraseAccount(userIdHex, adminId, 'DPDP-ticket-7');

      // Owned workspaces soft-deleted for this user.
      expect(workspacesService.softDeleteAllOwnedForErasure).toHaveBeenCalledWith(userIdHex);
      // Still scrubbed the identity (the workspace step does not replace it).
      expect(userModel.updateOne).toHaveBeenCalledTimes(1);
      // The count is recorded in the erasure audit meta.
      const audit = auditService.logEvent.mock.calls[0][0];
      expect(audit.meta.ownedWorkspacesSoftDeleted).toBe(2);
    });

    it('still scrubs identity if the workspace soft-delete fails (DPDP obligation wins)', async () => {
      const workspacesService = {
        softDeleteAllOwnedForErasure: vi.fn().mockRejectedValue(new Error('mongo down')),
      };
      const svcWithWs = new AccountErasureService(
        userModel,
        sessionsService,
        auditService as any,
        claimsCache,
        singleFlight as any,
        // 6th ctor param is the @Optional eventEmitter; workspacesService is 7th.
        // (Pre-Phase-1 these tests omitted the eventEmitter slot, so the
        // workspacesService mock landed on eventEmitter and the WS step no-op'd.)
        { emit: vi.fn() } as any,
        workspacesService as any,
      );

      const result = await svcWithWs.eraseAccount(userIdHex, adminId);

      // Identity scrub proceeded despite the workspace-step error.
      expect(userModel.updateOne).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      const audit = auditService.logEvent.mock.calls[0][0];
      expect(audit.meta.ownedWorkspacesSoftDeleted).toBe(0);
    });
  });
});
