/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing TeamService. Mirrors the
// existing access / audit / posthog suites in this folder.
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
  hash: vi.fn().mockResolvedValue('hashed'),
  default: { hash: vi.fn().mockResolvedValue('hashed') },
}));

import { Types } from 'mongoose';
import { TeamService } from '../team.service';
import type { MobileClassification } from '../dto/check-identifier.dto';

// ── Mongoose query chain helpers ─────────────────────────────────────────────

/** Builds a chainable { select, lean, exec } stub that resolves to `result`. */
function selectLeanExec(result: unknown) {
  const chain: any = {
    select: () => chain,
    lean: () => chain,
    exec: () => Promise.resolve(result),
  };
  return chain;
}

// ── Constants ────────────────────────────────────────────────────────────────

const workspaceId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const memberId = new Types.ObjectId();
const otherUserId = new Types.ObjectId();

/** Valid canonical Indian mobile: 91 + 10-digit body starting with 9. */
const MOBILE_FULL = '919876543210';
/** Same number, bare 10-digit form. */
const MOBILE_BARE = '9876543210';

/**
 * Unit-style coverage for TeamService.classifyMobile - Phase 1f.0 union shrink.
 *
 * The 3 old cross-tenant kinds (platform_user_other_ws, team_member_other_ws,
 * pending_invite_other_ws) are merged into one `registered` kind. No counts,
 * no names, no workspace ids are ever returned for cross-tenant cases.
 *
 * DB models are injected via a vi.fn() moduleRef.get stub that keys on the
 * model token string (e.g. 'WorkspaceModel', 'UserModel'). No real Mongoose
 * or MongoDB instance is used.
 */
describe('TeamService.classifyMobile - Phase 1f.0 (7 kinds)', () => {
  let teamModel: any;
  let machineModel: any;
  let moduleRef: any;
  let workspaceModel: any;
  let workspaceMemberModel: any;
  let userModel: any;
  let svc: TeamService;

  /** Helper: build the service with the current mock state. */
  function buildService() {
    svc = new TeamService(
      teamModel,
      machineModel,
      moduleRef,
      // uploadsService
      { deleteFile: vi.fn() } as any,
      // configService
      { get: vi.fn().mockReturnValue('https://test') } as any,
      // mailService
      {
        checkEmailQuota: vi.fn().mockResolvedValue({ allowed: true }),
        sendTeamAccessInvitationEmail: vi.fn().mockResolvedValue(undefined),
        incrementEmailUsage: vi.fn().mockResolvedValue(undefined),
      } as any,
      // smsService
      { send: vi.fn() } as any,
      // auditService
      { logEvent: vi.fn().mockResolvedValue(undefined) } as any,
      // workspaceCounterService
      { getCurrent: vi.fn().mockResolvedValue(0), setCounter: vi.fn() } as any,
      // postHog
      { capture: vi.fn(), identify: vi.fn() } as any,
      // revocationService
      {
        revoke: vi.fn().mockResolvedValue(undefined),
        isRevoked: vi.fn().mockResolvedValue(false),
        clear: vi.fn(),
      } as any,
      // notificationsService
      { createNotification: vi.fn().mockResolvedValue(undefined) } as any,
      // callerScopeService
      {
        resolve: vi.fn().mockResolvedValue({ isOwner: true, teamMemberId: null, permissions: [] }),
        effectiveScope: vi.fn(),
        selfFilterValue: vi.fn(),
        effectivePathScope: vi.fn(),
        selfPathFilterValue: vi.fn(),
        hasPath: vi.fn(),
      } as any,
    );
  }

  beforeEach(() => {
    teamModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
      find: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      updateMany: vi.fn(),
      countDocuments: vi.fn(),
    };
    machineModel = { find: vi.fn() };

    workspaceModel = {
      findById: vi.fn(),
      countDocuments: vi.fn(),
    };
    workspaceMemberModel = {
      find: vi.fn(),
      findOne: vi.fn(),
      countDocuments: vi.fn(),
      updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 0 }) }),
    };
    userModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
    };

    moduleRef = {
      get: vi.fn().mockImplementation((token: string) => {
        if (token === 'WorkspaceModel') return workspaceModel;
        if (token === 'WorkspaceMemberModel') return workspaceMemberModel;
        if (token === 'UserModel') return userModel;
        // fallback for any other model the service loads
        return {
          findOne: vi.fn().mockReturnValue(selectLeanExec(null)),
          findById: vi.fn().mockReturnValue(selectLeanExec(null)),
          find: vi.fn().mockReturnValue(selectLeanExec([])),
          countDocuments: vi.fn().mockResolvedValue(0),
          updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
        };
      }),
    };

    buildService();
  });

  /**
   * Shared workspace doc - ownerId does NOT match MOBILE_FULL so the owner
   * check passes through for most cases.
   */
  function workspaceDocWithDifferentOwnerMobile() {
    workspaceModel.findById.mockReturnValue(selectLeanExec({ ownerId }));
    // Owner user has a different mobile.
    userModel.findById.mockReturnValue(
      selectLeanExec({ _id: ownerId, name: 'Owner', mobile: '918888888888' }),
    );
  }

  /**
   * Make all downstream checks return empty / null so the classifier
   * falls through to the desired case.
   */
  function noTeamMembers() {
    teamModel.findOne.mockReturnValue(selectLeanExec(null));
  }
  function noPendingInvitesThisWs() {
    workspaceMemberModel.find.mockReturnValue(selectLeanExec([]));
  }
  function noPlatformUser() {
    userModel.findOne.mockReturnValue(selectLeanExec(null));
  }
  function noPendingInviteOtherWs() {
    workspaceMemberModel.findOne.mockReturnValue(selectLeanExec(null));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Case 1 - unregistered
  // ─────────────────────────────────────────────────────────────────────────

  it('case 1 - unregistered mobile returns { kind: "unregistered" }', async () => {
    workspaceDocWithDifferentOwnerMobile();
    noTeamMembers();
    noPendingInvitesThisWs();
    noPlatformUser();
    noPendingInviteOtherWs();

    const result = await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL);

    expect(result).toEqual({ kind: 'unregistered' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2 - workspace owner self
  // ─────────────────────────────────────────────────────────────────────────

  it('case 2 - mobile belongs to THIS workspace owner -> { kind: "workspace_owner_self", ownerName }', async () => {
    // Workspace doc has ownerId.
    workspaceModel.findById.mockReturnValue(selectLeanExec({ ownerId }));
    // Owner user mobile matches the queried mobile.
    userModel.findById.mockReturnValue(
      selectLeanExec({ _id: ownerId, name: 'Jayesh Bambhaniya', mobile: MOBILE_FULL }),
    );

    const result = await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL);

    expect(result).toEqual({ kind: 'workspace_owner_self', ownerName: 'Jayesh Bambhaniya' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 5 - active member THIS workspace
  // ─────────────────────────────────────────────────────────────────────────

  it('case 5 - active member in THIS workspace -> { kind: "active_member_this_ws", memberId, memberName }', async () => {
    workspaceDocWithDifferentOwnerMobile();

    // First teamModel.findOne call (active, isDeleted:false) -> hit.
    teamModel.findOne
      .mockReturnValueOnce(selectLeanExec({ _id: memberId, name: 'Raju Karigar' }))
      // Second call (archived) never reached.
      .mockReturnValue(selectLeanExec(null));

    const result = (await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL)) as Extract<
      MobileClassification,
      { kind: 'active_member_this_ws' }
    >;

    expect(result.kind).toBe('active_member_this_ws');
    expect(result.memberId).toBe(memberId.toHexString());
    expect(result.memberName).toBe('Raju Karigar');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 6 - archived member THIS workspace
  // ─────────────────────────────────────────────────────────────────────────

  it('case 6 - archived member in THIS workspace -> { kind: "archived_member_this_ws", memberId, memberName }', async () => {
    workspaceDocWithDifferentOwnerMobile();

    // First call (active) -> null; second call (archived isDeleted:true) -> hit.
    teamModel.findOne
      .mockReturnValueOnce(selectLeanExec(null))
      .mockReturnValueOnce(selectLeanExec({ _id: memberId, name: 'Archived Karigar' }));

    noPendingInvitesThisWs();
    noPlatformUser();
    noPendingInviteOtherWs();

    const result = (await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL)) as Extract<
      MobileClassification,
      { kind: 'archived_member_this_ws' }
    >;

    expect(result.kind).toBe('archived_member_this_ws');
    expect(result.memberId).toBe(memberId.toHexString());
    expect(result.memberName).toBe('Archived Karigar');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 8 - invalid format
  // ─────────────────────────────────────────────────────────────────────────

  it('case 8 - invalid mobile format -> { kind: "invalid_format" }', async () => {
    const result = await svc.classifyMobile(workspaceId.toHexString(), '123');

    expect(result).toEqual({ kind: 'invalid_format' });
    // No DB calls should have been made.
    expect(teamModel.findOne).not.toHaveBeenCalled();
    expect(workspaceModel.findById).not.toHaveBeenCalled();
  });

  it('case 8 - empty string -> { kind: "invalid_format" }', async () => {
    const result = await svc.classifyMobile(workspaceId.toHexString(), '');
    expect(result).toEqual({ kind: 'invalid_format' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 10a - pending invite THIS workspace
  // ─────────────────────────────────────────────────────────────────────────

  it('case 10a - pending invite THIS workspace with linked TeamMember -> memberName + inviteExpiresAt', async () => {
    workspaceDocWithDifferentOwnerMobile();
    // No active/archived member.
    teamModel.findOne
      .mockReturnValueOnce(selectLeanExec(null)) // active this ws
      .mockReturnValueOnce(selectLeanExec(null)); // archived this ws

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
    const linkedMemberId = new Types.ObjectId();

    // Pending invite in THIS workspace.
    workspaceMemberModel.find.mockReturnValue(
      selectLeanExec([
        {
          _id: new Types.ObjectId(),
          linkedTeamMemberId: linkedMemberId,
          inviteExpiry: expiresAt,
        },
      ]),
    );

    // The linked TeamMember lookup.
    teamModel.findById = vi
      .fn()
      .mockReturnValue(selectLeanExec({ _id: linkedMemberId, name: 'Pending Worker' }));

    const result = (await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL)) as Extract<
      MobileClassification,
      { kind: 'pending_invite_this_ws' }
    >;

    expect(result.kind).toBe('pending_invite_this_ws');
    expect(result.memberName).toBe('Pending Worker');
    expect(result.memberId).toBe(linkedMemberId.toHexString());
    expect(result.inviteExpiresAt).toBe(expiresAt.toISOString());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // `registered` - cross-tenant platform User
  // ─────────────────────────────────────────────────────────────────────────

  it('registered - platform User in another workspace -> { kind: "registered" }, Object.keys == ["kind"]', async () => {
    workspaceDocWithDifferentOwnerMobile();
    // No active or archived team member in THIS workspace.
    teamModel.findOne.mockReturnValue(selectLeanExec(null));
    // No pending invite in THIS workspace.
    workspaceMemberModel.find.mockReturnValue(selectLeanExec([]));

    // Platform User EXISTS.
    userModel.findOne.mockReturnValue(selectLeanExec({ _id: otherUserId, name: 'Other User' }));

    const result = await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL);

    expect(result.kind).toBe('registered');
    // PRIVACY: kind is the ONLY property - no counts, no names, no ids.
    expect(Object.keys(result)).toEqual(['kind']);
  });

  it('registered - TeamMember in another workspace (no User row) -> { kind: "registered" }, Object.keys == ["kind"]', async () => {
    workspaceDocWithDifferentOwnerMobile();
    // No member in THIS workspace (active or archived).
    teamModel.findOne
      .mockReturnValueOnce(selectLeanExec(null)) // active this ws
      .mockReturnValueOnce(selectLeanExec(null)) // archived this ws
      // Third call: member in OTHER workspace -> hit.
      .mockReturnValueOnce(selectLeanExec({ _id: new Types.ObjectId(), name: 'Foreign Member' }));

    noPendingInvitesThisWs();
    // No platform User row.
    noPlatformUser();

    const result = await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL);

    expect(result.kind).toBe('registered');
    // PRIVACY: kind is the ONLY property - no cross-tenant PII.
    expect(Object.keys(result)).toEqual(['kind']);
  });

  it('registered - pending invite in another workspace -> { kind: "registered" }, Object.keys == ["kind"]', async () => {
    workspaceDocWithDifferentOwnerMobile();
    teamModel.findOne
      .mockReturnValueOnce(selectLeanExec(null)) // active this ws
      .mockReturnValueOnce(selectLeanExec(null)) // archived this ws
      .mockReturnValueOnce(selectLeanExec(null)); // other ws member

    // No pending invite in THIS workspace.
    workspaceMemberModel.find.mockReturnValue(selectLeanExec([]));

    // No platform User.
    noPlatformUser();

    // Pending invite in OTHER workspace.
    workspaceMemberModel.findOne.mockReturnValue(
      selectLeanExec({
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(), // different workspace
        inviteeIdentifier: MOBILE_FULL,
      }),
    );

    const result = await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL);

    expect(result.kind).toBe('registered');
    // PRIVACY: kind is the ONLY property.
    expect(Object.keys(result)).toEqual(['kind']);
  });

  it('registered - orphaned User row (User exists but in NO workspace) still returns registered', async () => {
    workspaceDocWithDifferentOwnerMobile();
    // No active or archived member in THIS workspace.
    teamModel.findOne.mockReturnValue(selectLeanExec(null));
    // No pending invite in THIS workspace.
    workspaceMemberModel.find.mockReturnValue(selectLeanExec([]));

    // Platform User EXISTS - even with no workspace memberships, presence of a
    // User row is itself a cross-tenant signal.
    userModel.findOne.mockReturnValue(selectLeanExec({ _id: otherUserId, mobile: MOBILE_FULL }));

    const result = await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL);

    // Must return registered, NOT unregistered. The new algorithm does not
    // check workspace counts - any User row matching the mobile is sufficient.
    expect(result.kind).toBe('registered');
    expect(Object.keys(result)).toEqual(['kind']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // excludeMemberId - self-edit does not flag as self-collision
  // ─────────────────────────────────────────────────────────────────────────

  it('excludeMemberId - a member updating their own number is not flagged as active collision', async () => {
    workspaceDocWithDifferentOwnerMobile();

    // Without excludeMemberId, the active-member query would hit.
    // With excludeMemberId matching memberId, it should be excluded -> fall through.
    teamModel.findOne
      // Both active + archived queries return null (excludeId filters out the self-row).
      .mockReturnValue(selectLeanExec(null));

    noPendingInvitesThisWs();
    noPlatformUser();
    noPendingInviteOtherWs();

    const result = await svc.classifyMobile(
      workspaceId.toHexString(),
      MOBILE_FULL,
      memberId.toHexString(), // excludeMemberId
    );

    // With all queries returning null, falls through to unregistered.
    expect(result).toEqual({ kind: 'unregistered' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bare 10-digit input also resolves correctly
  // ─────────────────────────────────────────────────────────────────────────

  it('bare 10-digit input normalises to canonical form before any DB query', async () => {
    workspaceDocWithDifferentOwnerMobile();
    noTeamMembers();
    noPendingInvitesThisWs();
    noPlatformUser();
    noPendingInviteOtherWs();

    const result = await svc.classifyMobile(workspaceId.toHexString(), MOBILE_BARE);

    // normaliseIndianMobile('9876543210') -> full = '919876543210' - valid, falls to unregistered.
    expect(result).toEqual({ kind: 'unregistered' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Permanently-deleted members must NOT trigger a this-workspace collision.
  //
  // A member that was archived and then permanently deleted keeps isDeleted:true
  // but also carries isPermanentlyDeleted:true and is hidden from every team
  // list / archived view. The classifier's active + archived this-ws queries
  // must mirror that exclusion, otherwise the mobile is permanently blocked from
  // re-add and the "restore from the archived list" advice points to a list the
  // member no longer appears in.
  // ─────────────────────────────────────────────────────────────────────────

  it('this-ws active + archived queries exclude permanently-deleted members', async () => {
    workspaceDocWithDifferentOwnerMobile();
    noTeamMembers();
    noPendingInvitesThisWs();
    noPlatformUser();
    noPendingInviteOtherWs();

    await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL);

    // Step 3 — active member THIS workspace.
    expect(teamModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        mobile: MOBILE_FULL,
        isDeleted: false,
        isPermanentlyDeleted: { $ne: true },
      }),
    );

    // Step 4 — archived member THIS workspace.
    expect(teamModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        mobile: MOBILE_FULL,
        isDeleted: true,
        isPermanentlyDeleted: { $ne: true },
      }),
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Fix 3: inviteeIdentifier $in query covers bare 10-digit form
  // ─────────────────────────────────────────────────────────────────────────

  it('case 10a - invite stored with bare 10-digit inviteeIdentifier is still found (dual-form $in query)', async () => {
    workspaceDocWithDifferentOwnerMobile();
    teamModel.findOne
      .mockReturnValueOnce(selectLeanExec(null)) // active this ws
      .mockReturnValueOnce(selectLeanExec(null)) // archived this ws
      .mockReturnValue(selectLeanExec(null)); // other-ws team member (step 6b) + any further calls

    // The find() call for pending invites THIS workspace should be invoked with { $in: [normFull, bare] }.
    workspaceMemberModel.find.mockReturnValue(selectLeanExec([]));

    noPlatformUser();
    noPendingInviteOtherWs();

    await svc.classifyMobile(workspaceId.toHexString(), MOBILE_FULL);

    // Assert the find() was called with inviteeIdentifier: { $in: [...] } containing both forms.
    expect(workspaceMemberModel.find).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteeIdentifier: { $in: [MOBILE_FULL, MOBILE_BARE] },
      }),
    );
  });
});
