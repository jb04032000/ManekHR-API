/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * Account-deletion Phase 4 — Scope-2 "Delete ERP" backend
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3B).
 *
 *   - scheduleErpDeletion: stamps ONLY the erpDeletion marker (scope isolation —
 *     the account stays active, Connect + identity untouched, no session revoke)
 *     and runs the reversible ERP soft phase (owned soft-delete + member offboard
 *     cascade) via WorkspacesService. NO eraseAccount / purge → statutory data is
 *     retained.
 *   - getErpDeletionImpact: the B2 warning surface — affected workspaces + the
 *     team-loses-access flag + open employer-loan / unpaid-advance counts.
 *   - scheduleSelfServeErpDeletion: same 3-factor gating as Scope 1/3.
 *   - restoreDeletion (erp): admin-mediated recovery best-effort restores owned
 *     workspaces; member workspaces need re-invite.
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

describe('AccountDeletionService — Scope-2 ERP deletion (Phase 4)', () => {
  const userId = new Types.ObjectId();
  const userIdHex = userId.toString();
  const adminId = new Types.ObjectId().toString();
  const ownedWsId = new Types.ObjectId().toString();
  const memberWsId = new Types.ObjectId().toString();

  let userModel: any;
  let accountErasure: any;
  let sessionsService: any;
  let claimsCache: any;
  let auditService: any;
  let authService: any;
  let smsOtp: any;
  let mailService: any;
  let mandateService: any;
  let connectProfile: any;
  let workspacesService: any;
  let employerLoanModel: any;
  let advanceRecoveryPlanModel: any;
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
    };
    accountErasure = { assertNotLastActiveAdmin: vi.fn(), eraseAccount: vi.fn() };
    sessionsService = { invalidateAllSessions: vi.fn().mockResolvedValue(0) };
    claimsCache = { invalidate: vi.fn().mockResolvedValue(undefined) };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    authService = { assertReauthenticated: vi.fn().mockResolvedValue(undefined) };
    smsOtp = { consumeStepupProof: vi.fn().mockResolvedValue(true) };
    mailService = {
      sendAccountDeletionScheduledEmail: vi.fn(),
      sendAccountDeletionReminderEmail: vi.fn(),
    };
    mandateService = { cancelMandate: vi.fn() };
    connectProfile = {
      hideForConnectDeletion: vi.fn(),
      unhideForConnectRecovery: vi.fn(),
    };
    workspacesService = {
      getErpDeletionImpact: vi.fn().mockResolvedValue({
        owned: [{ workspaceId: ownedWsId, name: 'Acme', memberCount: 0 }],
        member: [{ workspaceId: memberWsId, name: 'Partner Co' }],
      }),
      softDeleteErpForErasure: vi
        .fn()
        .mockResolvedValue({ ownedSoftDeleted: 1, membershipsOffboarded: 1 }),
      restoreAllOwnedForRecovery: vi.fn().mockResolvedValue({ restored: [ownedWsId], failed: [] }),
    };
    employerLoanModel = {
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    advanceRecoveryPlanModel = {
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };

    svc = new AccountDeletionService(
      userModel,
      accountErasure,
      sessionsService,
      claimsCache,
      auditService,
      authService,
      smsOtp,
      mailService,
      mandateService,
      connectProfile,
      workspacesService,
      employerLoanModel,
      advanceRecoveryPlanModel,
    );
  });

  // ── scheduleErpDeletion ────────────────────────────────────────────────────
  it('stamps ONLY the erpDeletion marker (scope isolation) and runs the reversible ERP soft phase', async () => {
    const res = await svc.scheduleErpDeletion(userIdHex, userIdHex);

    expect(res.state).toBe('pending');
    // purgeAfter is exactly 30 days after requestedAt.
    const set = userModel.updateOne.mock.calls[0][1].$set;
    const diff =
      new Date(set.erpDeletion.purgeAfter).getTime() -
      new Date(set.erpDeletion.requestedAt).getTime();
    expect(diff).toBe(30 * DAY);

    // SCOPE ISOLATION: the write touches ONLY erpDeletion — the account stays
    // active (no isActive flip), Connect stays enabled (no connectEnabled flip),
    // identity untouched, and no $unset.
    expect(Object.keys(set)).toEqual(['erpDeletion']);
    expect('isActive' in set).toBe(false);
    expect('connectEnabled' in set).toBe(false);
    expect(userModel.updateOne.mock.calls[0][1].$unset).toBeUndefined();
    // The account is NOT logged out (Scope 2 keeps the person signed in).
    expect(sessionsService.invalidateAllSessions).not.toHaveBeenCalled();

    // The reversible ERP soft phase ran (owned soft-delete + member offboard).
    expect(workspacesService.softDeleteErpForErasure).toHaveBeenCalledWith(userIdHex);

    // STATUTORY RETAINED: the soft phase never erases identity or purges Connect.
    expect(accountErasure.eraseAccount).not.toHaveBeenCalled();
    expect(connectProfile.hideForConnectDeletion).not.toHaveBeenCalled();

    // Audited as an ERP-scope schedule.
    const audit = auditService.logEvent.mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.action === 'erp_deletion_scheduled');
    expect(audit).toBeDefined();
    expect(audit.meta.scope).toBe('erp');

    // The schedule response carries the affected-workspace impact (B2 warning).
    expect(res.impact?.ownedWorkspaces).toHaveLength(1);
    expect(res.impact?.memberWorkspaces).toHaveLength(1);
  });

  it('soft phase failure does not abort the schedule (marker still set, best-effort)', async () => {
    workspacesService.softDeleteErpForErasure.mockRejectedValue(new Error('mongo down'));

    const res = await svc.scheduleErpDeletion(userIdHex, userIdHex);

    expect(res.state).toBe('pending');
    // The marker was still stamped (the durable intent + recovery anchor).
    expect(userModel.updateOne).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — re-scheduling an already-pending ERP deletion is a no-op', async () => {
    foundUser.erpDeletion = {
      state: 'pending',
      requestedAt: new Date(Date.now() - 2 * DAY),
      purgeAfter: new Date(Date.now() + 28 * DAY),
    };

    const res = await svc.scheduleErpDeletion(userIdHex, userIdHex);

    expect(res.alreadyPending).toBe(true);
    expect(userModel.updateOne).not.toHaveBeenCalled();
    expect(workspacesService.softDeleteErpForErasure).not.toHaveBeenCalled();
  });

  // ── getErpDeletionImpact (B2 warning surface) ──────────────────────────────
  it('impact combines workspace topology with open employer-loan + unpaid-advance counts + teamLosesAccess', async () => {
    workspacesService.getErpDeletionImpact.mockResolvedValue({
      owned: [{ workspaceId: ownedWsId, name: 'Acme', memberCount: 4 }],
      member: [{ workspaceId: memberWsId, name: 'Partner Co' }],
    });
    employerLoanModel.countDocuments.mockReturnValue({ exec: () => Promise.resolve(2) });
    advanceRecoveryPlanModel.countDocuments.mockReturnValue({ exec: () => Promise.resolve(3) });

    const impact = await svc.getErpDeletionImpact(userIdHex);

    expect(impact.openEmployerLoans).toBe(2);
    expect(impact.unpaidAdvances).toBe(3);
    // Sole owner with a team → the team loses access on delete.
    expect(impact.teamLosesAccess).toBe(true);
    // Member workspaces are not auto-rejoinable on recovery.
    expect(impact.memberWorkspacesNeedReinvite).toBe(true);

    // The loan/advance flags are scoped to the OWNED workspaces being deleted, and
    // count only OPEN (active/paused) rows.
    const loanFilter = employerLoanModel.countDocuments.mock.calls[0][0];
    expect(loanFilter.status.$in).toEqual(['active', 'paused']);
    expect(loanFilter.workspaceId.$in.map(String)).toEqual([ownedWsId]);
  });

  it('impact reports teamLosesAccess=false when the only owned workspace has no team', async () => {
    workspacesService.getErpDeletionImpact.mockResolvedValue({
      owned: [{ workspaceId: ownedWsId, name: 'Solo', memberCount: 0 }],
      member: [],
    });

    const impact = await svc.getErpDeletionImpact(userIdHex);

    expect(impact.teamLosesAccess).toBe(false);
    expect(impact.memberWorkspacesNeedReinvite).toBe(false);
  });

  // ── scheduleSelfServeErpDeletion (3-factor gating) ─────────────────────────
  it('verified ERP schedule: confirm + re-auth + single-use proof, then runs the soft phase', async () => {
    const res = await svc.scheduleSelfServeErpDeletion(userIdHex, {
      reauth: { kind: 'password', password: 'pw' },
      otpProof: 'proof-nonce',
      confirm: 'DELETE',
    });

    expect(res.state).toBe('pending');
    expect(authService.assertReauthenticated).toHaveBeenCalledWith(userIdHex, {
      kind: 'password',
      password: 'pw',
    });
    expect(smsOtp.consumeStepupProof).toHaveBeenCalledWith(userIdHex, 'proof-nonce');
    expect(workspacesService.softDeleteErpForErasure).toHaveBeenCalledWith(userIdHex);
  });

  it('verified ERP schedule: rejects a wrong confirm phrase BEFORE any factor check or state change', async () => {
    await expect(
      svc.scheduleSelfServeErpDeletion(userIdHex, {
        reauth: { kind: 'password', password: 'pw' },
        otpProof: 'proof-nonce',
        confirm: 'delete erp',
      }),
    ).rejects.toMatchObject({ response: { code: 'DELETION_CONFIRM_REQUIRED' } });

    expect(authService.assertReauthenticated).not.toHaveBeenCalled();
    expect(smsOtp.consumeStepupProof).not.toHaveBeenCalled();
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('verified ERP schedule: an invalid / replayed step-up proof is rejected and nothing is scheduled', async () => {
    smsOtp.consumeStepupProof.mockResolvedValue(false);

    await expect(
      svc.scheduleSelfServeErpDeletion(userIdHex, {
        reauth: { kind: 'password', password: 'pw' },
        otpProof: 'stale',
        confirm: 'DELETE',
      }),
    ).rejects.toMatchObject({ response: { code: 'STEPUP_PROOF_INVALID' } });

    expect(userModel.updateOne).not.toHaveBeenCalled();
    expect(workspacesService.softDeleteErpForErasure).not.toHaveBeenCalled();
  });

  // ── restoreDeletion (erp recovery) ─────────────────────────────────────────
  it('admin restore of an ERP deletion restores owned workspaces (best-effort) and flags member re-invite', async () => {
    foundUser.erpDeletion = {
      state: 'pending',
      requestedAt: new Date(Date.now() - 2 * DAY),
      purgeAfter: new Date(Date.now() + 28 * DAY),
    };
    workspacesService.restoreAllOwnedForRecovery.mockResolvedValue({
      restored: [ownedWsId],
      failed: [{ workspaceId: 'x', code: 'WORKSPACE_RESTORE_WINDOW_EXPIRED' }],
    });

    const res: any = await svc.restoreDeletion(userIdHex, adminId, 'user emailed support');

    expect(res.restored).toContain('erp');
    // Owned workspaces restored, anchored on the deletion's requestedAt.
    expect(workspacesService.restoreAllOwnedForRecovery).toHaveBeenCalledTimes(1);
    const [calledUser, since] = workspacesService.restoreAllOwnedForRecovery.mock.calls[0];
    expect(calledUser).toBe(userIdHex);
    expect(since).toBeInstanceOf(Date);
    expect(res.workspaces.restored).toEqual([ownedWsId]);
    expect(res.workspaces.failed).toHaveLength(1);
    // Member workspaces are NOT auto-rejoinable.
    expect(res.memberWorkspacesNeedReinvite).toBe(true);
    // STATUTORY RETAINED: recovery never erases or purges.
    expect(accountErasure.eraseAccount).not.toHaveBeenCalled();
  });

  it('admin restore does NOT touch workspaces for a Connect-only deletion (no erp scope pending)', async () => {
    foundUser.connectDeletion = {
      state: 'pending',
      requestedAt: new Date(Date.now() - 2 * DAY),
      purgeAfter: new Date(Date.now() + 28 * DAY),
    };

    const res: any = await svc.restoreDeletion(userIdHex, adminId);

    expect(res.restored).toContain('connect');
    expect(workspacesService.restoreAllOwnedForRecovery).not.toHaveBeenCalled();
  });
});
