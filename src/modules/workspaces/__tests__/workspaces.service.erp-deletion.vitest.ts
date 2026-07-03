/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing WorkspacesService (transitive schema
// imports would otherwise trip vitest's reflection pipeline). Mirrors the
// hardening / audit / soft-delete-write-guards spec pattern.
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
  hash: vi.fn().mockResolvedValue('hashed-secret'),
  default: { hash: vi.fn().mockResolvedValue('hashed-secret') },
}));

import { Types } from 'mongoose';
import { WorkspacesService } from '../workspaces.service';

/**
 * Account-deletion Phase 4 — Scope-2 (Delete ERP) workspace-domain primitives
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3B):
 *   - removeMember(..., {allowSelf}) — let the self-deleting user offboard their
 *     OWN membership through the worker-offboard cascade (the path that scrubs a
 *     linked worker's kiosk PIN), instead of the bare leaveWorkspace exit.
 *   - offboardAllMembershipsForErasure — route every non-owner membership through
 *     that cascade.
 *   - softDeleteErpForErasure — owned soft-delete + member offboard + hasWorkspace
 *     recompute, in one call.
 *   - getErpDeletionImpact — the B2 warning topology (owned + member workspaces).
 *   - restoreAllOwnedForRecovery — best-effort owned-workspace restore for the
 *     admin-mediated recovery, surfacing restore() error codes.
 */
describe('WorkspacesService — Scope-2 ERP deletion (Phase 4)', () => {
  let workspaceModel: any;
  let memberModel: any;
  let usersService: any;
  let subscriptionModel: any;
  let inviteDispatcher: any;
  let configService: any;
  let workspaceCounterService: any;
  let moduleRef: any;
  let auditService: any;
  let postHog: any;
  let revocationService: any;
  let notificationsService: any;
  let teamService: { remove: ReturnType<typeof vi.fn> };
  let sessionModel: { updateMany: ReturnType<typeof vi.fn> };
  let teamMemberModel: { updateOne: ReturnType<typeof vi.fn> };
  let svc: WorkspacesService;

  const ownerId = new Types.ObjectId(); // the user being ERP-deleted
  const otherOwnerId = new Types.ObjectId(); // someone else's workspace

  function findByIdReturning(doc: any) {
    return {
      exec: () => Promise.resolve(doc),
      select: () => ({
        exec: () => Promise.resolve(doc),
        lean: () => ({ exec: () => Promise.resolve(doc) }),
      }),
      lean: () => ({ exec: () => Promise.resolve(doc) }),
      populate: () => ({ exec: () => Promise.resolve(doc) }),
    };
  }

  beforeEach(() => {
    teamService = { remove: vi.fn().mockResolvedValue({ success: true }) };
    sessionModel = { updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }) };
    teamMemberModel = { updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }) };

    workspaceModel = {
      findById: vi.fn(),
      findByIdAndUpdate: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
      updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 0 }) }),
      find: vi.fn(),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
      exists: vi.fn().mockResolvedValue(null),
    };

    memberModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
      find: vi.fn(),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
      db: {
        model: vi.fn().mockImplementation((name: string) => {
          if (name === 'Session') return sessionModel;
          if (name === 'TeamMember') return teamMemberModel;
          return {
            findById: vi
              .fn()
              .mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
            findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
            updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
          };
        }),
      },
    };

    usersService = { update: vi.fn().mockResolvedValue(undefined) };
    subscriptionModel = {
      findOne: vi.fn().mockReturnValue({
        sort: () => ({
          exec: () =>
            Promise.resolve({ status: 'active', appliedEntitlements: { maxWorkspaces: -1 } }),
        }),
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
      }),
    };
    inviteDispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    configService = { get: vi.fn().mockReturnValue('https://test') };
    workspaceCounterService = {};
    moduleRef = { get: vi.fn().mockReturnValue(teamService) };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn(), identify: vi.fn() };
    revocationService = {
      clear: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue(undefined),
    };
    notificationsService = { createNotification: vi.fn().mockResolvedValue(undefined) };

    svc = new WorkspacesService(
      workspaceModel,
      memberModel,
      usersService,
      subscriptionModel,
      inviteDispatcher,
      configService,
      workspaceCounterService,
      moduleRef,
      auditService,
      postHog,
      revocationService,
      notificationsService,
      { emit: vi.fn() } as any,
    );
  });

  // ── removeMember({ allowSelf }) — self-offboard via the worker cascade ──────
  describe('removeMember({ allowSelf })', () => {
    const workspaceId = new Types.ObjectId(); // owned by otherOwnerId (a member ws)
    const memberRowId = new Types.ObjectId();
    const selfUserId = ownerId; // the self-deleting user is THIS member

    function selfMemberDoc(extra: any = {}) {
      const save = vi.fn().mockResolvedValue(undefined);
      return {
        _id: memberRowId,
        userId: selfUserId,
        workspaceId: { _id: workspaceId, ownerId: otherOwnerId },
        status: 'active',
        inviteeIdentifier: 'x@example.com',
        inviteeType: 'email',
        linkedTeamMemberId: null,
        save,
        ...extra,
      };
    }

    beforeEach(() => {
      // assertWorkspaceNotDeleted reads findById(id).select('isDeleted').lean().exec()
      workspaceModel.findById.mockReturnValue(findByIdReturning({ isDeleted: false }));
    });

    it('bypasses the "cannot remove yourself" block and fires the offboard cascade for a linked worker', async () => {
      const teamMemberId = new Types.ObjectId();
      const doc = selfMemberDoc({ linkedTeamMemberId: teamMemberId });
      memberModel.findOne.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(doc) }),
      });

      await svc.removeMember(
        workspaceId.toHexString(),
        memberRowId.toHexString(),
        selfUserId.toHexString(),
        { allowSelf: true },
      );

      // Self-removal did NOT throw; the member was torn down.
      expect(doc.status).toBe('removed');
      expect(revocationService.revoke).toHaveBeenCalledWith(
        workspaceId.toHexString(),
        String(selfUserId),
      );
      // The linked-worker offboard cascade is taken (this is the path that, in the
      // running app, scrubs the kiosk PIN via TeamService.remove → attendance).
      const audit = auditService.logEvent.mock.calls
        .map((c: any[]) => c[0])
        .find((e: any) => e.action === 'workspace.member_removed');
      expect(audit.meta.offboardCascade).toBe(true);
    });

    it('still blocks self-removal when allowSelf is not set (the admin UI guard is intact)', async () => {
      const doc = selfMemberDoc();
      memberModel.findOne.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(doc) }),
      });

      await expect(
        svc.removeMember(
          workspaceId.toHexString(),
          memberRowId.toHexString(),
          selfUserId.toHexString(),
        ),
      ).rejects.toThrow('Cannot remove yourself');
    });
  });

  // ── offboardAllMembershipsForErasure ───────────────────────────────────────
  describe('offboardAllMembershipsForErasure()', () => {
    it('routes every non-owner active membership through removeMember(allowSelf) and skips owned workspaces', async () => {
      const memberWsId = new Types.ObjectId();
      const memberRowId = new Types.ObjectId();
      const ownedWsId = new Types.ObjectId();
      const ownedRowId = new Types.ObjectId();
      const deletedWsId = new Types.ObjectId();
      const deletedRowId = new Types.ObjectId();

      memberModel.find.mockReturnValue({
        populate: () => ({
          exec: () =>
            Promise.resolve([
              // member of someone else's live workspace → offboard
              {
                _id: memberRowId,
                workspaceId: { _id: memberWsId, ownerId: otherOwnerId, isDeleted: false },
              },
              // own workspace (handled by softDeleteAllOwnedForErasure) → skip
              {
                _id: ownedRowId,
                workspaceId: { _id: ownedWsId, ownerId, isDeleted: false },
              },
              // member of an already-deleted workspace → skip
              {
                _id: deletedRowId,
                workspaceId: { _id: deletedWsId, ownerId: otherOwnerId, isDeleted: true },
              },
            ]),
        }),
      });

      const removeSpy = vi.spyOn(svc, 'removeMember').mockResolvedValue(undefined as any);

      const res = await svc.offboardAllMembershipsForErasure(ownerId.toHexString());

      expect(res).toEqual({ offboarded: 1 });
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledWith(
        memberWsId.toHexString(),
        memberRowId.toHexString(),
        ownerId.toHexString(),
        { allowSelf: true },
      );
      // Query is scoped to the user's own active memberships.
      const filter = memberModel.find.mock.calls[0][0];
      expect(String(filter.userId)).toBe(ownerId.toHexString());
      expect(filter.status).toBe('active');
    });

    it('is per-membership fault-isolated: one offboard failure does not abort the rest', async () => {
      const wsA = new Types.ObjectId();
      const rowA = new Types.ObjectId();
      const wsB = new Types.ObjectId();
      const rowB = new Types.ObjectId();
      memberModel.find.mockReturnValue({
        populate: () => ({
          exec: () =>
            Promise.resolve([
              { _id: rowA, workspaceId: { _id: wsA, ownerId: otherOwnerId, isDeleted: false } },
              { _id: rowB, workspaceId: { _id: wsB, ownerId: otherOwnerId, isDeleted: false } },
            ]),
        }),
      });
      const removeSpy = vi
        .spyOn(svc, 'removeMember')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined as any);

      const res = await svc.offboardAllMembershipsForErasure(ownerId.toHexString());

      expect(removeSpy).toHaveBeenCalledTimes(2);
      // Only the successful one is counted.
      expect(res).toEqual({ offboarded: 1 });
    });
  });

  // ── softDeleteErpForErasure ────────────────────────────────────────────────
  describe('softDeleteErpForErasure()', () => {
    it('soft-deletes owned + offboards memberships + recomputes hasWorkspace=false', async () => {
      const ownedSpy = vi
        .spyOn(svc, 'softDeleteAllOwnedForErasure')
        .mockResolvedValue({ softDeleted: 2 });
      const offboardSpy = vi
        .spyOn(svc, 'offboardAllMembershipsForErasure')
        .mockResolvedValue({ offboarded: 1 });
      // recomputeHasWorkspace probes for any other live owned workspace; none left.
      workspaceModel.exists.mockResolvedValue(null);

      const res = await svc.softDeleteErpForErasure(ownerId.toHexString());

      expect(res).toEqual({ ownedSoftDeleted: 2, membershipsOffboarded: 1 });
      expect(ownedSpy).toHaveBeenCalledWith(ownerId.toHexString());
      expect(offboardSpy).toHaveBeenCalledWith(ownerId.toHexString());
      // hasWorkspace recomputed to false (no live owned workspace remains).
      expect(usersService.update).toHaveBeenCalledWith(ownerId.toHexString(), {
        hasWorkspace: false,
      });
    });
  });

  // ── getErpDeletionImpact ───────────────────────────────────────────────────
  describe('getErpDeletionImpact()', () => {
    it('returns owned workspaces (with team-member count, excluding the owner) + member workspaces', async () => {
      const ownedWsId = new Types.ObjectId();
      const memberWsId = new Types.ObjectId();

      workspaceModel.find.mockReturnValue({
        select: () => ({
          lean: () => ({ exec: () => Promise.resolve([{ _id: ownedWsId, name: 'Acme' }]) }),
        }),
      });
      // memberCount for the owned workspace = 3 active members (excluding owner).
      memberModel.countDocuments.mockReturnValue({ exec: () => Promise.resolve(3) });
      memberModel.find.mockReturnValue({
        populate: () => ({
          exec: () =>
            Promise.resolve([
              {
                _id: new Types.ObjectId(),
                workspaceId: {
                  _id: memberWsId,
                  ownerId: otherOwnerId,
                  isDeleted: false,
                  name: 'Partner Co',
                },
              },
              // own workspace membership is excluded from the "member" list
              {
                _id: new Types.ObjectId(),
                workspaceId: { _id: ownedWsId, ownerId, isDeleted: false, name: 'Acme' },
              },
            ]),
        }),
      });

      const res = await svc.getErpDeletionImpact(ownerId.toHexString());

      expect(res.owned).toEqual([
        { workspaceId: ownedWsId.toHexString(), name: 'Acme', memberCount: 3 },
      ]);
      expect(res.member).toEqual([{ workspaceId: memberWsId.toHexString(), name: 'Partner Co' }]);
      // The owned-member count query excludes the owner's own row.
      const countFilter = memberModel.countDocuments.mock.calls[0][0];
      expect(countFilter.status).toBe('active');
      expect(String(countFilter.userId.$ne)).toBe(ownerId.toHexString());
    });
  });

  // ── restoreAllOwnedForRecovery ─────────────────────────────────────────────
  describe('restoreAllOwnedForRecovery()', () => {
    it('restores each owned soft-deleted workspace and surfaces restore() failure codes (best-effort)', async () => {
      const wsOk = new Types.ObjectId();
      const wsBlocked = new Types.ObjectId();
      const since = new Date(Date.now() - 60_000);

      workspaceModel.find.mockReturnValue({
        select: () => ({
          lean: () => ({ exec: () => Promise.resolve([{ _id: wsOk }, { _id: wsBlocked }]) }),
        }),
      });

      const restoreSpy = vi
        .spyOn(svc, 'restore')
        .mockResolvedValueOnce({ ok: true, workspaceId: wsOk.toHexString() } as any)
        .mockRejectedValueOnce({
          response: { code: 'WORKSPACE_LIMIT_REACHED_ON_RESTORE', message: 'limit' },
        });

      const res = await svc.restoreAllOwnedForRecovery(ownerId.toHexString(), since);

      expect(restoreSpy).toHaveBeenCalledTimes(2);
      expect(restoreSpy).toHaveBeenNthCalledWith(1, wsOk.toHexString(), ownerId.toHexString());
      expect(res.restored).toEqual([wsOk.toHexString()]);
      expect(res.failed).toEqual([
        { workspaceId: wsBlocked.toHexString(), code: 'WORKSPACE_LIMIT_REACHED_ON_RESTORE' },
      ]);

      // The lookup is scoped to owned + soft-deleted + the deletion anchor.
      const filter = workspaceModel.find.mock.calls[0][0];
      expect(String(filter.ownerId)).toBe(ownerId.toHexString());
      expect(filter.isDeleted).toBe(true);
      expect(filter.deletedAt.$gte).toBe(since);
    });
  });
});
