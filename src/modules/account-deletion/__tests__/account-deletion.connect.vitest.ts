/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * Account-deletion Phase 3 — Scope-1 "Delete Connect" soft phase + recovery
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A). Unlike Scope 3 this NEVER suspends the
 * account or revokes sessions — only the Connect box is hidden + flagged.
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
import { AccountDeletionService } from '../account-deletion.service';

const DAY = 24 * 60 * 60 * 1000;

describe('AccountDeletionService — Scope-1 Delete Connect (Phase 3)', () => {
  const userId = new Types.ObjectId();
  const userIdHex = userId.toString();
  const adminId = new Types.ObjectId().toString();

  let userModel: any;
  let accountErasure: any;
  let sessionsService: any;
  let claimsCache: any;
  let auditService: any;
  let authService: any;
  let smsOtp: any;
  let connectProfile: {
    hideForConnectDeletion: ReturnType<typeof vi.fn>;
    unhideForConnectRecovery: ReturnType<typeof vi.fn>;
  };
  let svc: AccountDeletionService;
  let foundUser: any;

  const build = () =>
    new AccountDeletionService(
      userModel,
      accountErasure,
      sessionsService,
      claimsCache,
      auditService,
      authService,
      smsOtp,
      undefined, // mailService
      undefined, // mandateService
      connectProfile as any,
    );

  beforeEach(() => {
    foundUser = {
      _id: userId,
      name: 'Asha Patel',
      email: 'asha@example.com',
      mobile: '919876543210',
      isActive: true,
      connectEnabled: true,
    };
    userModel = {
      findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve(foundUser) }),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
    };
    accountErasure = { assertNotLastActiveAdmin: vi.fn().mockResolvedValue(undefined) };
    sessionsService = { invalidateAllSessions: vi.fn().mockResolvedValue(0) };
    claimsCache = { invalidate: vi.fn().mockResolvedValue(undefined) };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    authService = { assertReauthenticated: vi.fn().mockResolvedValue(undefined) };
    smsOtp = { consumeStepupProof: vi.fn().mockResolvedValue(true) };
    connectProfile = {
      hideForConnectDeletion: vi.fn().mockResolvedValue(undefined),
      unhideForConnectRecovery: vi.fn().mockResolvedValue(undefined),
    };
    svc = build();
  });

  const settle = () => new Promise((r) => setImmediate(r));

  // ── scheduleConnectDeletion ────────────────────────────────────────────────

  it('SCOPE ISOLATION: writes ONLY connectEnabled=false + the marker (identity row otherwise untouched)', async () => {
    await svc.scheduleConnectDeletion(userIdHex, userIdHex);

    const set = userModel.updateOne.mock.calls[0][1].$set;
    // The ONLY two fields written — no isActive, no email/mobile/name/handle scrub,
    // no deletedAt. The shared User identity stays byte-identical apart from these.
    expect(Object.keys(set).sort()).toEqual(['connectDeletion', 'connectEnabled']);
    expect(set.connectEnabled).toBe(false);
    expect(set.connectDeletion.state).toBe('pending');
    expect(set).not.toHaveProperty('isActive');
    expect(set).not.toHaveProperty('deletedAt');
    expect(set).not.toHaveProperty('email');
  });

  it('hides the Connect profile and does NOT suspend or revoke sessions', async () => {
    await svc.scheduleConnectDeletion(userIdHex, userIdHex);

    expect(connectProfile.hideForConnectDeletion).toHaveBeenCalledWith(userIdHex);
    // Connect-only deletion keeps the ERP account fully active.
    expect(sessionsService.invalidateAllSessions).not.toHaveBeenCalled();
    expect(accountErasure.assertNotLastActiveAdmin).not.toHaveBeenCalled();
  });

  it('sets a 30-day purgeAfter and audits connect_deletion_scheduled', async () => {
    const before = Date.now();
    const res = await svc.scheduleConnectDeletion(userIdHex, userIdHex);

    expect(res.state).toBe('pending');
    const delta = res.purgeAfter.getTime() - before;
    expect(delta).toBeGreaterThan(29 * DAY);
    expect(delta).toBeLessThan(31 * DAY);

    await settle();
    const audit = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'connect_deletion_scheduled',
    );
    expect(audit).toBeDefined();
    expect(audit[0].meta.scope).toBe('connect');
  });

  it('is idempotent: an already-pending Connect deletion is a no-op', async () => {
    foundUser.connectDeletion = { state: 'pending', purgeAfter: new Date(Date.now() + 10 * DAY) };

    const res = await svc.scheduleConnectDeletion(userIdHex, userIdHex);

    expect(res.alreadyPending).toBe(true);
    expect(userModel.updateOne).not.toHaveBeenCalled();
    expect(connectProfile.hideForConnectDeletion).not.toHaveBeenCalled();
  });

  it('schedule survives a Connect hide failure (marker still set, best-effort hide)', async () => {
    connectProfile.hideForConnectDeletion.mockRejectedValue(new Error('meili down'));

    const res = await svc.scheduleConnectDeletion(userIdHex, userIdHex);

    expect(res.state).toBe('pending');
    expect(userModel.updateOne).toHaveBeenCalled(); // the durable marker write committed
  });

  // ── scheduleSelfServeConnectDeletion (gating) ──────────────────────────────

  it('self-serve requires the type-to-confirm phrase', async () => {
    await expect(
      svc.scheduleSelfServeConnectDeletion(userIdHex, {
        confirm: 'nope',
        otpProof: 'p',
      } as any),
    ).rejects.toMatchObject({ response: { code: 'DELETION_CONFIRM_REQUIRED' } });
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('self-serve rejects an invalid step-up proof (and never schedules)', async () => {
    smsOtp.consumeStepupProof.mockResolvedValue(false);
    await expect(
      svc.scheduleSelfServeConnectDeletion(userIdHex, {
        confirm: 'DELETE',
        otpProof: 'bad',
      } as any),
    ).rejects.toMatchObject({ response: { code: 'STEPUP_PROOF_INVALID' } });
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('self-serve schedules after all three factors pass', async () => {
    const res = await svc.scheduleSelfServeConnectDeletion(userIdHex, {
      confirm: 'DELETE',
      otpProof: 'good',
    } as any);

    expect(authService.assertReauthenticated).toHaveBeenCalled();
    expect(smsOtp.consumeStepupProof).toHaveBeenCalledWith(userIdHex, 'good');
    expect(res.state).toBe('pending');
    expect(connectProfile.hideForConnectDeletion).toHaveBeenCalled();
  });

  // ── restore (recovery un-hide) ─────────────────────────────────────────────

  it('admin restore of a pending Connect deletion re-enables Connect + un-hides the profile', async () => {
    foundUser.connectDeletion = { state: 'pending', purgeAfter: new Date(Date.now() + 10 * DAY) };

    const res = await svc.restoreDeletion(userIdHex, adminId, 'user contacted support');

    expect(res.restored).toContain('connect');
    const set = userModel.updateOne.mock.calls[0][1].$set;
    expect(set.connectEnabled).toBe(true);
    const unset = userModel.updateOne.mock.calls[0][1].$unset;
    expect(unset).toHaveProperty('connectDeletion');
    expect(connectProfile.unhideForConnectRecovery).toHaveBeenCalledWith(userIdHex);
  });
});
