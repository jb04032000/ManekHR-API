/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing TeamService. Mirrors the
// existing audit / posthog suites in this folder.
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

vi.mock('bcryptjs', () => ({
  hash: vi.fn().mockResolvedValue('hashed-pin'),
  default: { hash: vi.fn().mockResolvedValue('hashed-pin') },
}));

import { Types } from 'mongoose';
import { TeamService } from '../team.service';

/**
 * A `findById(...)` result stub whose `.populate()` is chainable to any
 * depth — `.populate().populate().populate().exec()` all resolve to `doc`.
 * Mirrors Mongoose's real query builder, which returns itself from
 * `.populate()`. Use for service paths that do a multi-populate refresh.
 */
function chainablePopulate(doc: unknown) {
  const chain: { populate: () => typeof chain; exec: () => Promise<unknown> } = {
    populate: () => chain,
    exec: () => Promise.resolve(doc),
  };
  return chain;
}

/**
 * Behavioral coverage for the App Access Management endpoints (P1+P2+P3).
 *
 * We assert at the service-layer boundary — DB persistence is mocked, the
 * goal is to confirm:
 *   - revokeAccess clears access fields + flips WorkspaceMember + revokes
 *     the user's denylist key + deactivates Sessions (hard revoke).
 *   - resendInvite reuses the raw token when expiry is still in the future
 *     and regenerates when forceRegenerate or token is expired.
 *   - changeAccessRole updates both rbacRoleId and the bridge row.
 *   - setPermissionOverrides persists the new array verbatim.
 *   - All four fire the matching audit + PostHog event.
 */
describe('TeamService — App Access Management (P1+P2+P3)', () => {
  let teamModel: any;
  let machineModel: any;
  let moduleRef: any;
  let uploadsService: any;
  let configService: any;
  let mailService: any;
  let smsService: any;
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let workspaceCounterService: any;
  let postHog: { capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> };
  let revocationService: {
    revoke: ReturnType<typeof vi.fn>;
    isRevoked: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };

  let workspaceMemberModel: any;
  let sessionModel: any;
  let workspaceModel: any;
  let roleModel: any;

  let permissionDispatcher: {
    dispatch: ReturnType<typeof vi.fn>;
  };

  let svc: TeamService;

  const workspaceId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const linkedUserId = new Types.ObjectId();
  const actorId = new Types.ObjectId();
  const newRoleId = new Types.ObjectId();

  beforeEach(() => {
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    teamModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      updateMany: vi.fn(),
    };
    machineModel = { find: vi.fn() };

    workspaceMemberModel = {
      updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 1 }) }),
      findOneAndUpdate: vi.fn(),
    };
    sessionModel = {
      updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 1 }) }),
    };
    workspaceModel = {
      findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ name: 'TestWS' }) }),
    };
    roleModel = {
      findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ name: 'Manager' }) }),
    };

    moduleRef = {
      get: vi.fn().mockImplementation((token: string) => {
        if (token === 'WorkspaceMemberModel') return workspaceMemberModel;
        if (token === 'SessionModel') return sessionModel;
        if (token === 'WorkspaceModel') return workspaceModel;
        if (token === 'RoleModel') return roleModel;
        return { findOne: vi.fn(), findById: vi.fn() };
      }),
    };

    uploadsService = { deleteFile: vi.fn().mockResolvedValue(undefined) };
    configService = { get: vi.fn().mockReturnValue('https://test') };
    mailService = {
      checkEmailQuota: vi.fn().mockResolvedValue({ allowed: true }),
      sendTeamAccessInvitationEmail: vi.fn().mockResolvedValue(undefined),
      incrementEmailUsage: vi.fn().mockResolvedValue(undefined),
    };
    smsService = { send: vi.fn().mockResolvedValue(undefined) };
    workspaceCounterService = {
      getCurrent: vi.fn().mockResolvedValue(0),
      setCounter: vi.fn().mockResolvedValue(undefined),
    };
    postHog = { capture: vi.fn(), identify: vi.fn() };
    revocationService = {
      revoke: vi.fn().mockResolvedValue(undefined),
      isRevoked: vi.fn().mockResolvedValue(false),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    permissionDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ inApp: false, email: false, sms: false }),
    };

    svc = new TeamService(
      teamModel,
      machineModel,
      moduleRef,
      uploadsService,
      configService,
      mailService,
      smsService,
      auditService as any,
      workspaceCounterService,
      postHog as any,
      revocationService as any,
      {} as any, // notificationsService — fire-and-forget, swallowed on failure
      {
        // §7 Part B — CallerScopeService. `resolve` → owner short-circuits
        // the changeAccessRole / setPermissionOverrides self-escalation guard.
        resolve: vi.fn().mockResolvedValue({
          isOwner: true,
          teamMemberId: null,
          permissions: [],
        }),
        effectiveScope: vi.fn(),
        selfFilterValue: vi.fn(),
        // Task 7 — path-model methods (used by findAll + assertMemberReadScope).
        effectivePathScope: vi.fn(),
        selfPathFilterValue: vi.fn(),
        hasPath: vi.fn(),
      } as any,
      permissionDispatcher as any,
      undefined, // mobileOtpService, not exercised by these tests
      { emit: vi.fn() } as any, // permissionEvents (SSE fan-out)
    );
  });

  // ── revokeAccess ────────────────────────────────────────────────────────

  it('revokeAccess: hard revoke clears access + denylists user + kills workspace sessions', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          name: 'Test Member',
          linkedUserId,
        }),
    });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'Test Member',
        hasAppAccess: false,
        toObject: () => ({
          _id: memberId,
          name: 'Test Member',
          hasAppAccess: false,
        }),
      }),
    );

    await svc.revokeAccess(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      {
        reason: 'left the company',
      },
    );

    expect(teamModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: memberId }),
      expect.objectContaining({
        $set: { hasAppAccess: false },
        $unset: expect.objectContaining({
          linkedUserId: '',
          appAccessInviteTokenHash: '',
        }),
      }),
    );
    expect(workspaceMemberModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $in: ['active', 'invited'] } }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'removed' }),
      }),
    );
    expect(revocationService.revoke).toHaveBeenCalledWith(
      workspaceId.toHexString(),
      linkedUserId.toHexString(),
    );
    expect(sessionModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ userId: linkedUserId, isActive: true }),
      expect.objectContaining({ $set: { isActive: false } }),
    );

    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.access_revoked',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta).toMatchObject({ reason: 'left the company', hardRevoke: true });

    const phCall = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'team.access_revoked',
    );
    expect(phCall).toBeDefined();
  });

  it('revokeAccess: hardRevoke=false skips denylist + session-kill', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () => Promise.resolve({ _id: memberId, name: 'Test', linkedUserId }),
    });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'Test',
        toObject: () => ({ _id: memberId, name: 'Test' }),
      }),
    );

    await svc.revokeAccess(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { hardRevoke: false },
    );

    expect(revocationService.revoke).not.toHaveBeenCalled();
    expect(sessionModel.updateMany).not.toHaveBeenCalled();
  });

  it('revokeAccess: throws NotFoundException when member missing', async () => {
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(null) });
    await expect(
      svc.revokeAccess(
        workspaceId.toHexString(),
        memberId.toHexString(),
        actorId.toHexString(),
        {},
      ),
    ).rejects.toThrow(/not found/i);
  });

  // ── resendInvite ────────────────────────────────────────────────────────

  it('resendInvite: reuses raw token when expiry is in the future and forceRegenerate is false', async () => {
    const futureExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const memberDoc = {
      _id: memberId,
      name: 'Pending Member',
      email: 'p@example.com',
      mobile: '919876543210',
      rbacRoleId: newRoleId,
      hasAppAccess: false,
      appAccessInviteToken: 'EXISTING_RAW_TOKEN',
      appAccessInviteTokenHash: 'EXISTING_HASH',
      appAccessInviteExpiry: futureExpiry,
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });

    const res = await svc.resendInvite(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { sendMethod: 'link' },
    );

    expect(memberDoc.save).not.toHaveBeenCalled();
    expect(res.data.inviteToken).toBe('EXISTING_RAW_TOKEN');

    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.invite_resent',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta).toMatchObject({ regenerated: false, sendMethod: 'link' });
  });

  it('resendInvite: regenerates the token when forceRegenerate=true', async () => {
    const futureExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const memberDoc = {
      _id: memberId,
      name: 'Pending Member',
      mobile: '919876543210',
      rbacRoleId: newRoleId,
      hasAppAccess: false,
      appAccessInviteToken: 'EXISTING_RAW_TOKEN',
      appAccessInviteTokenHash: 'EXISTING_HASH',
      appAccessInviteExpiry: futureExpiry,
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });

    const res = await svc.resendInvite(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { sendMethod: 'link', forceRegenerate: true },
    );

    expect(memberDoc.save).toHaveBeenCalledTimes(1);
    expect(memberDoc.appAccessInviteToken).not.toBe('EXISTING_RAW_TOKEN');
    expect(res.data.inviteToken).toBe(memberDoc.appAccessInviteToken);

    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.invite_resent',
    );
    expect(auditCall[0].meta).toMatchObject({ regenerated: true });
  });

  it('resendInvite: regenerates the token when expiry is in the past', async () => {
    const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const memberDoc = {
      _id: memberId,
      name: 'Pending Member',
      rbacRoleId: newRoleId,
      hasAppAccess: false,
      appAccessInviteToken: 'STALE_TOKEN',
      appAccessInviteTokenHash: 'STALE_HASH',
      appAccessInviteExpiry: pastExpiry,
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });

    await svc.resendInvite(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { sendMethod: 'auto' },
    );

    expect(memberDoc.save).toHaveBeenCalledTimes(1);
    expect(memberDoc.appAccessInviteToken).not.toBe('STALE_TOKEN');
  });

  it('resendInvite: refuses when member already has access', async () => {
    const memberDoc = {
      _id: memberId,
      hasAppAccess: true,
      rbacRoleId: newRoleId,
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });

    await expect(
      svc.resendInvite(workspaceId.toHexString(), memberId.toHexString(), actorId.toHexString(), {
        sendMethod: 'link',
      }),
    ).rejects.toThrow(/already has access/i);
  });

  // ── changeAccessRole ────────────────────────────────────────────────────

  it('changeAccessRole: updates rbacRoleId on TeamMember and bridge row, fires audit + denylist', async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const oldRoleId = new Types.ObjectId();
    const memberDoc = {
      _id: memberId,
      name: 'Active Member',
      rbacRoleId: oldRoleId,
      hasAppAccess: true,
      linkedUserId,
      appAccessInviteTokenHash: 'X',
      appAccessInviteExpiry: futureExpiry,
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'Active Member',
        toObject: () => ({ _id: memberId, name: 'Active Member' }),
      }),
    );

    await svc.changeAccessRole(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { rbacRoleId: newRoleId.toHexString() },
    );

    expect(memberDoc.save).toHaveBeenCalledTimes(1);
    expect(workspaceMemberModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $in: ['active', 'invited'] } }),
      expect.objectContaining({ $set: expect.objectContaining({ roleId: expect.anything() }) }),
    );
    // 2026-05-22: a role change must NOT denylist an active member; the
    // revocation denylist makes RolesGuard 403 for the whole TTL, locking the
    // member out of every data route. Clear any stale deny instead; fresh
    // per-request role resolution propagates the new role immediately.
    expect(revocationService.revoke).not.toHaveBeenCalled();
    expect(revocationService.clear).toHaveBeenCalledWith(
      workspaceId.toHexString(),
      linkedUserId.toHexString(),
    );
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.access_role_changed',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta).toMatchObject({ oldRoleId: oldRoleId.toHexString() });
  });

  it('changeAccessRole: refuses when no active access and no pending invite', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          name: 'Plain Member',
          hasAppAccess: false,
        }),
    });

    await expect(
      svc.changeAccessRole(
        workspaceId.toHexString(),
        memberId.toHexString(),
        actorId.toHexString(),
        { rbacRoleId: newRoleId.toHexString() },
      ),
    ).rejects.toThrow(/no active access/i);
  });

  // ── setPermissionOverrides ──────────────────────────────────────────────

  it('setPermissionOverrides: persists the new array verbatim and fires audit', async () => {
    const memberDoc = {
      _id: memberId,
      name: 'Override Target',
      linkedUserId,
      permissionOverrides: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'Override Target',
        toObject: () => ({ _id: memberId, name: 'Override Target' }),
      }),
    );

    const newOverrides = [
      { module: 'team', action: 'edit', allowed: false } as any,
      { module: 'salary', action: 'view', allowed: true, scope: 'all' as const } as any,
    ];

    await svc.setPermissionOverrides(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      {
        overrides: newOverrides,
        pathOverrides: [
          // Phase 1d: view must accompany edit (coherence invariant).
          { path: 'team.profile.bank.view', allowed: true, scope: 'all' },
          { path: 'team.profile.bank.edit', allowed: true, scope: 'all' },
          { path: 'team.profile.pay.edit', allowed: false },
        ],
      },
    );

    expect(memberDoc.save).toHaveBeenCalledTimes(1);
    expect(memberDoc.permissionOverrides).toEqual([
      { module: 'team', action: 'edit', allowed: false, scope: undefined },
      { module: 'salary', action: 'view', allowed: true, scope: 'all' },
    ]);
    // Fix 2: assert path-override persistence (Phase 1c Task 4).
    // Phase 1d: view override added to satisfy coherence invariant → count=3.
    expect(memberDoc.permissionPathOverrides).toEqual([
      { path: 'team.profile.bank.view', allowed: true, scope: 'all' },
      { path: 'team.profile.bank.edit', allowed: true, scope: 'all' },
      { path: 'team.profile.pay.edit', allowed: false, scope: undefined },
    ]);
    // 2026-05-22: an override edit must NOT denylist an active member (that
    // 403s them out of every permission-gated data route for the whole TTL,
    // the "permission change not reflected" bug). Clear any stale deny instead;
    // RolesGuard re-resolves overrides fresh on the member's next request.
    expect(revocationService.revoke).not.toHaveBeenCalled();
    expect(revocationService.clear).toHaveBeenCalledWith(
      workspaceId.toHexString(),
      linkedUserId.toHexString(),
    );
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.permission_overrides_updated',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta).toMatchObject({ prevCount: 0, nextCount: 2, pathOverrideCount: 3 });
  });

  it('setPermissionOverrides: rejects unknown action', async () => {
    const memberDoc = {
      _id: memberId,
      name: 'X',
      permissionOverrides: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });

    await expect(
      svc.setPermissionOverrides(
        workspaceId.toHexString(),
        memberId.toHexString(),
        actorId.toHexString(),
        { overrides: [{ module: 'team', action: 'made_up_action', allowed: true } as any] },
      ),
    ).rejects.toThrow(/unknown action/i);
  });

  // Phase 1d Task 5 — view-edit coherence + dep-resolver wired into
  // setPermissionOverrides. Member has no rbacRoleId → effective set == allow-overrides only.
  it('rejects incoherent path overrides (view-self + edit-all on same leaf)', async () => {
    const memberDoc = {
      _id: memberId,
      name: 'Incoherent Target',
      permissionOverrides: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });

    await expect(
      svc.setPermissionOverrides(
        workspaceId.toHexString(),
        memberId.toHexString(),
        actorId.toHexString(),
        {
          overrides: [],
          pathOverrides: [
            { path: 'team.profile.bank.view', allowed: true, scope: 'self' },
            { path: 'team.profile.bank.edit', allowed: true, scope: 'all' },
          ],
        },
      ),
    ).rejects.toThrow(/incoherent|requires/i);
  });

  it('rejects unresolved deps in path overrides', async () => {
    const memberDoc = {
      _id: memberId,
      name: 'Dep Target',
      permissionOverrides: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });

    await expect(
      svc.setPermissionOverrides(
        workspaceId.toHexString(),
        memberId.toHexString(),
        actorId.toHexString(),
        {
          overrides: [],
          pathOverrides: [{ path: 'team.member.delete', allowed: true, scope: 'all' }],
        },
      ),
    ).rejects.toThrow(/team\.directory\.view/);
  });

  // ── PermissionNotificationDispatcher gating (Phase 2.2) ────────────────

  it('dispatcher: NOT called when member has no app access (setPermissionOverrides)', async () => {
    const memberDoc = {
      _id: memberId,
      name: 'No Access Member',
      hasAppAccess: false, // gate condition — dispatcher must be skipped
      permissionOverrides: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'No Access Member',
        toObject: () => ({ _id: memberId, name: 'No Access Member' }),
      }),
    );

    await svc.setPermissionOverrides(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { overrides: [] },
    );

    expect(permissionDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('dispatcher: called with overrides_updated when member has app access (setPermissionOverrides)', async () => {
    permissionDispatcher.dispatch.mockResolvedValue({ inApp: true, email: false, sms: false });
    const memberDoc = {
      _id: memberId,
      name: 'Access Member',
      hasAppAccess: true,
      linkedUserId,
      email: 'member@test.com',
      mobile: '919876543210',
      permissionOverrides: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'Access Member',
        toObject: () => ({ _id: memberId }),
      }),
    );

    await svc.setPermissionOverrides(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { overrides: [] },
    );

    expect(permissionDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspaceId.toHexString(),
        recipientUserId: linkedUserId.toHexString(),
        changeKind: 'overrides_updated',
      }),
    );
    // Dispatched result captured in audit meta.
    const auditCall = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.permission_overrides_updated',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0].meta).toMatchObject({
      notificationsDispatched: { inApp: true, email: false, sms: false },
    });
  });

  it('dispatcher: failure does NOT prevent permission save (setPermissionOverrides)', async () => {
    permissionDispatcher.dispatch.mockRejectedValue(new Error('network error'));
    const memberDoc = {
      _id: memberId,
      name: 'Fail Member',
      hasAppAccess: true,
      linkedUserId,
      permissionOverrides: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'Fail Member',
        toObject: () => ({ _id: memberId }),
      }),
    );

    // Must NOT throw even though the dispatcher rejects.
    await expect(
      svc.setPermissionOverrides(
        workspaceId.toHexString(),
        memberId.toHexString(),
        actorId.toHexString(),
        { overrides: [] },
      ),
    ).resolves.not.toThrow();

    expect(memberDoc.save).toHaveBeenCalledTimes(1);
  });

  it('dispatcher: called with role_changed for changeAccessRole (hasAppAccess=true)', async () => {
    const oldRoleId = new Types.ObjectId();
    const memberDoc = {
      _id: memberId,
      name: 'Role Member',
      hasAppAccess: true,
      linkedUserId,
      email: 'role@test.com',
      mobile: '919876543210',
      rbacRoleId: oldRoleId,
      appAccessInviteTokenHash: null,
      save: vi.fn().mockResolvedValue(undefined),
      toObject: () => ({ _id: memberId }),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'Role Member',
        toObject: () => ({ _id: memberId }),
      }),
    );

    await svc.changeAccessRole(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { rbacRoleId: newRoleId.toHexString() },
    );

    // Dispatcher is fired as void / fire-and-forget — check it was called.
    // Give the microtask queue a tick.
    await Promise.resolve();
    expect(permissionDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspaceId.toHexString(),
        recipientUserId: linkedUserId.toHexString(),
        changeKind: 'role_changed',
      }),
    );
  });

  it('dispatcher: NOT called for changeAccessRole when member has no app access', async () => {
    const memberDoc = {
      _id: memberId,
      name: 'No Access Role',
      hasAppAccess: false,
      linkedUserId: null,
      rbacRoleId: new Types.ObjectId(),
      appAccessInviteTokenHash: 'hash',
      appAccessInviteExpiry: new Date(Date.now() + 86400_000), // future → hasPendingInvite
      save: vi.fn().mockResolvedValue(undefined),
      toObject: () => ({ _id: memberId }),
    };
    teamModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberDoc) });
    teamModel.findById.mockReturnValue(
      chainablePopulate({
        _id: memberId,
        name: 'No Access Role',
        toObject: () => ({ _id: memberId }),
      }),
    );

    await svc.changeAccessRole(
      workspaceId.toHexString(),
      memberId.toHexString(),
      actorId.toHexString(),
      { rbacRoleId: newRoleId.toHexString() },
    );

    await Promise.resolve();
    expect(permissionDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ── Task 7 Phase 1d — per-leaf SoD tests ────────────────────────────────────
//
// These tests exercise the new declarative SoD layer in
// `assertProfileUpdateAllowed`. The registry declares
// `sodOwnerOnlyOnSelf: true` on `team.profile.{pay,bank,statutory,org}`.
// A non-owner editing their OWN record must be blocked for those groups
// regardless of their nominal `@all` grant.
//
// The `update` code path calls `assertProfileUpdateAllowed` which calls
// `callerScope.resolve`. We mock resolve to return a context with
// isOwnRecord = true/false and permissionPaths carrying the relevant grant.
// The member doc mock returns a bare doc — `update` only calls
// `assertProfileUpdateAllowed` then `assertTeamFieldGroupGrants`; we only
// need to reach the SoD guard.
describe('TeamService — per-leaf SoD in assertProfileUpdateAllowed (Phase 1d Task 7)', () => {
  // Shared ObjectIds for this suite.
  const wsId = new Types.ObjectId();
  const callerUserId = new Types.ObjectId();
  // callerMemberId === memberId to simulate own-record.
  const ownMemberId = new Types.ObjectId();
  // A different member id for the "editing someone else" case.
  const otherMemberId = new Types.ObjectId();

  function buildSodSvc(resolveValue: Record<string, unknown>): TeamService {
    const memberDocStub = {
      _id: ownMemberId,
      name: 'Test',
      toObject: () => ({ _id: ownMemberId, name: 'Test' }),
    };
    const tModel: any = {
      findOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve(memberDocStub),
      }),
      findById: vi.fn().mockReturnValue(chainablePopulate(memberDocStub)),
      // `update` calls findOneAndUpdate(...).populate(ROLE_POPULATE).populate(SHIFT_POPULATE).exec()
      findOneAndUpdate: vi.fn().mockReturnValue(chainablePopulate(memberDocStub)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      updateMany: vi.fn(),
    };
    const mModel: any = { find: vi.fn() };
    const mRef: any = {
      get: vi.fn().mockImplementation((token: string) => {
        if (token === 'WorkspaceMemberModel')
          return { updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }) };
        if (token === 'SessionModel')
          return { updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }) };
        if (token === 'WorkspaceModel')
          return {
            findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ name: 'WS' }) }),
          };
        if (token === 'RoleModel')
          return {
            findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ name: 'HR' }) }),
          };
        return { findOne: vi.fn(), findById: vi.fn() };
      }),
    };
    const callerScopeMock: any = {
      resolve: vi.fn().mockResolvedValue(resolveValue),
      effectiveScope: vi.fn(),
      selfFilterValue: vi.fn(),
      effectivePathScope: vi.fn(),
      selfPathFilterValue: vi.fn().mockReturnValue(null),
      hasPath: vi.fn().mockReturnValue(true), // Layer 2 always passes for these SoD tests
    };
    return new TeamService(
      tModel,
      mModel,
      mRef,
      { deleteFile: vi.fn() } as any,
      { get: vi.fn().mockReturnValue('https://test') } as any,
      {
        checkEmailQuota: vi.fn().mockResolvedValue({ allowed: true }),
        sendTeamAccessInvitationEmail: vi.fn(),
        incrementEmailUsage: vi.fn(),
      } as any,
      { send: vi.fn() } as any,
      { logEvent: vi.fn().mockResolvedValue(undefined) } as any,
      { getCurrent: vi.fn().mockResolvedValue(0), setCounter: vi.fn() } as any,
      { capture: vi.fn(), identify: vi.fn() } as any,
      { revoke: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false), clear: vi.fn() } as any,
      {} as any,
      callerScopeMock,
    );
  }

  it('SoD: non-owner with bank.edit@all CANNOT edit OWN bank (per-leaf flag)', async () => {
    const svc = buildSodSvc({
      isOwner: false,
      teamMemberId: ownMemberId.toHexString(),
      permissions: [],
      permissionPaths: [{ path: 'team.profile.bank.edit', scope: 'all' }],
    });

    await expect(
      svc.update(
        wsId.toHexString(),
        ownMemberId.toHexString(), // editing OWN record
        { bankDetails: { passbookImageUrl: 'https://example.com/bank.jpg' } } as any,
        callerUserId.toHexString(),
      ),
    ).rejects.toThrow(/segregation of duties/i);
  });

  it('SoD: non-owner with bank.edit@all CAN edit OTHER member bank', async () => {
    const svc = buildSodSvc({
      isOwner: false,
      teamMemberId: ownMemberId.toHexString(), // caller's own memberId
      permissions: [],
      permissionPaths: [{ path: 'team.profile.bank.edit', scope: 'all' }],
    });

    // Editing otherMemberId (NOT own record) — SoD layer should not block.
    // Layer 2 `hasPath` is mocked to return true so it also passes.
    await expect(
      svc.update(
        wsId.toHexString(),
        otherMemberId.toHexString(), // editing SOMEONE ELSE
        { bankDetails: { passbookImageUrl: 'https://example.com/bank.jpg' } } as any,
        callerUserId.toHexString(),
      ),
    ).resolves.toBeTruthy();
  });

  it('SoD: owner CAN edit own bank', async () => {
    const svc = buildSodSvc({
      isOwner: true, // owner bypass
      teamMemberId: ownMemberId.toHexString(),
      permissions: [],
      permissionPaths: [],
    });

    await expect(
      svc.update(
        wsId.toHexString(),
        ownMemberId.toHexString(),
        { bankDetails: { passbookImageUrl: 'https://example.com/bank.jpg' } } as any,
        callerUserId.toHexString(),
      ),
    ).resolves.toBeTruthy();
  });

  it('SoD: non-owner with personal.edit@self CAN edit OWN personal field', async () => {
    const svc = buildSodSvc({
      isOwner: false,
      teamMemberId: ownMemberId.toHexString(),
      permissions: [],
      permissionPaths: [{ path: 'team.profile.personal.edit', scope: 'self' }],
    });

    // `personal` leaf has NO sodOwnerOnlyOnSelf → no SoD block.
    // Layer 2 `hasPath` mocked to true so it passes.
    await expect(
      svc.update(
        wsId.toHexString(),
        ownMemberId.toHexString(),
        { name: 'Updated Name' } as any,
        callerUserId.toHexString(),
      ),
    ).resolves.toBeTruthy();
  });
});

// ── Task 7 — path-model self-narrowing (findAll) ────────────────────────────
//
// Focused behavioral check: when a self-scoped caller has no directory row,
// `selfPathFilterValue` returns `'no-self-anchor'`, which drives `findAll` to
// set an impossible `_id` filter → 0 results (fail-closed).
//
// We do NOT attempt to fully exercise the Mongo aggregation pipeline. Instead
// we verify the call contract: `selfPathFilterValue` is invoked with the
// correct path, and when it signals no anchor the service returns an empty
// member list (via a mocked countDocuments + find).
describe('TeamService — findAll path-model self-narrowing (Task 7)', () => {
  let svcPath: TeamService;
  let teamModelPath: any;
  let callerScopePath: {
    resolve: ReturnType<typeof vi.fn>;
    effectiveScope: ReturnType<typeof vi.fn>;
    selfFilterValue: ReturnType<typeof vi.fn>;
    effectivePathScope: ReturnType<typeof vi.fn>;
    selfPathFilterValue: ReturnType<typeof vi.fn>;
    hasPath: ReturnType<typeof vi.fn>;
  };

  const wsId = new Types.ObjectId();
  const userId = new Types.ObjectId();

  beforeEach(() => {
    callerScopePath = {
      resolve: vi.fn().mockResolvedValue({
        isOwner: false,
        teamMemberId: null, // self-scoped, but NO directory row
        permissions: [],
        selfProfileEdit: 'allow',
      }),
      effectiveScope: vi.fn(),
      selfFilterValue: vi.fn(),
      effectivePathScope: vi.fn(),
      // 'no-self-anchor' → caller has a self-scoped view grant but no linked
      // directory row → impossible _id filter → empty result
      selfPathFilterValue: vi.fn().mockReturnValue('no-self-anchor'),
      hasPath: vi.fn(),
    };

    // countDocuments + find needed by QueryHelper.paginate
    teamModelPath = {
      findOne: vi.fn(),
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      updateMany: vi.fn(),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
      find: vi.fn().mockReturnValue({
        sort: () => ({
          populate: () => ({ exec: () => Promise.resolve([]) }),
        }),
      }),
    };

    const moduleRefPath = {
      get: vi.fn().mockImplementation((token: string) => {
        if (token === 'WorkspaceMemberModel')
          return { updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }) };
        if (token === 'SessionModel')
          return { updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }) };
        if (token === 'WorkspaceModel')
          return {
            findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ name: 'WS' }) }),
          };
        if (token === 'RoleModel')
          return {
            findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ name: 'Karigar' }) }),
          };
        return { findOne: vi.fn(), findById: vi.fn() };
      }),
    };

    svcPath = new TeamService(
      teamModelPath,
      { find: vi.fn() } as any, // machineModel
      moduleRefPath as any,
      { deleteFile: vi.fn() } as any, // uploadsService
      { get: vi.fn().mockReturnValue('https://test') } as any, // configService
      {
        checkEmailQuota: vi.fn(),
        sendTeamAccessInvitationEmail: vi.fn(),
        incrementEmailUsage: vi.fn(),
      } as any, // mailService
      { send: vi.fn() } as any, // smsService
      { logEvent: vi.fn().mockResolvedValue(undefined) } as any, // auditService
      { getCurrent: vi.fn().mockResolvedValue(0), setCounter: vi.fn() } as any, // workspaceCounterService
      { capture: vi.fn(), identify: vi.fn() } as any, // postHog
      { revoke: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false), clear: vi.fn() } as any, // revocationService
      {} as any, // notificationsService
      callerScopePath as any, // callerScopeService
    );
  });

  it('findAll: self-scoped caller with no directory row → selfPathFilterValue called with "team.directory.view" → empty result', async () => {
    const result = await svcPath.findAll(
      wsId.toHexString(),
      { page: 1, limit: 10 },
      false,
      userId.toHexString(),
    );

    // selfPathFilterValue must be called with the registry path, not legacy args
    expect(callerScopePath.selfPathFilterValue).toHaveBeenCalledWith(
      expect.anything(), // scope ctx
      'team.directory.view',
    );

    // fail-closed: no members returned
    expect(result.success).toBe(true);
    expect((result.data as any).members).toHaveLength(0);
    expect((result.data as any).total).toBe(0);
  });

  it('findAll: all-scoped caller → selfPathFilterValue returns null → no _id narrowing → full member set returned', async () => {
    // An all-scoped caller has team.directory.view at scope='all'.
    // selfPathFilterValue signals this by returning null — no self-filter applied.
    callerScopePath.selfPathFilterValue.mockReturnValue(null);

    const memberA = { _id: new Types.ObjectId(), name: 'Alice', toObject: () => ({}) };
    const memberB = { _id: new Types.ObjectId(), name: 'Bob', toObject: () => ({}) };

    teamModelPath.countDocuments.mockReturnValue({ exec: () => Promise.resolve(2) });
    teamModelPath.find.mockReturnValue({
      sort: () => ({
        populate: () => ({ exec: () => Promise.resolve([memberA, memberB]) }),
      }),
    });

    const result = await svcPath.findAll(
      wsId.toHexString(),
      { page: 1, limit: 10 },
      false,
      userId.toHexString(),
    );

    // selfPathFilterValue must still be called — the service must always consult it
    expect(callerScopePath.selfPathFilterValue).toHaveBeenCalledWith(
      expect.anything(),
      'team.directory.view',
    );

    // No _id constraint: the full stubbed set (both members) is returned
    expect(result.success).toBe(true);
    expect((result.data as any).total).toBe(2);
    expect((result.data as any).members).toHaveLength(2);

    // Confirm no _id filter reached the query: the find call must NOT have
    // received a filter with an _id key.
    const findCallFilter: Record<string, unknown> = teamModelPath.find.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(findCallFilter).not.toHaveProperty('_id');
  });
});
