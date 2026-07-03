/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing WorkspacesService — transitive schema
// imports would otherwise trip vitest's esbuild reflection pipeline. Mirrors the
// audit / soft-delete-write-guards spec pattern.
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

// OQ-W1 — removeMember resolves TeamService through a lazy `require()` +
// moduleRef.get (the same proven cross-module-service pattern create() uses for
// role-seeder / firms / addons). The vitest/esbuild sandbox does not resolve a
// bare CJS `require` of a relative `.ts` path, so the require throws and the
// best-effort cascade no-ops HERE (it works in the running app, where SWC
// resolves it). The tests therefore assert the DETERMINISTIC branch contract —
// the `offboardCascade` audit/posthog flag, set from `!!linkedTeamMemberId`
// independent of the require — to prove the cascade is wired for linked members
// and skipped for bare collaborators.

import { Types } from 'mongoose';
import { WorkspacesService } from '../workspaces.service';

/**
 * Workspaces hardening — Pillar 1 (lifecycle/compliance) + Pillar 2 (tenant
 * security) + re-add/rehire (§10). Each test maps to an acceptance criterion.
 */
describe('WorkspacesService — hardening (Workstream G)', () => {
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

  const ownerId = new Types.ObjectId();
  const workspaceId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const memberUserId = new Types.ObjectId();

  // Build a findById return that satisfies `.exec()`, `.select().lean().exec()`,
  // and `.select().exec()` shapes against a supplied doc.
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
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(2) }),
      // recomputeHasWorkspace() probes for any OTHER live workspace the owner
      // still owns. Default null = none left (owner dropped to zero); per-case
      // overrides return a truthy doc to simulate a still-owned workspace.
      exists: vi.fn().mockResolvedValue(null),
    };

    memberModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
      db: {
        // db.model('Session' | 'TeamMember' | 'User' | 'Role')
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

    usersService = {
      findById: vi.fn().mockResolvedValue({ name: 'Inviter', _id: ownerId }),
      findByIdentifier: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
    };
    subscriptionModel = {
      // Supports BOTH chains the service uses:
      //  - getWorkspaceLimit: findOne(...).sort().exec()  → default unlimited
      //    (-1) so restore()'s new limit guard is a no-op for the existing
      //    restore tests; the dedicated limit tests override this per-case.
      //  - create() tier lookup: findOne(...).select().lean().exec() → null.
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
    // moduleRef.get returns the team service when asked for TeamService.
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
      // ADR-0004 — EventEmitter2 stub: remove() / softDeleteAllOwnedForErasure()
      // emit `workspace.deleted` for the Connect ERP-link cascade.
      { emit: vi.fn() } as any,
    );
  });

  // ── AC-1.1 / AC-1.3 — credential scrub on workspace soft-delete ──────────
  describe('remove() credential scrub', () => {
    beforeEach(() => {
      // owner-owned, not-deleted, owns 2 workspaces (passes last-workspace guard)
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, name: 'Acme', isDeleted: false }),
      );
    });

    it('nulls kiosk token, ingest token and SMTP password in the SAME $set as isDeleted', async () => {
      await svc.remove(workspaceId.toHexString(), ownerId.toHexString());

      expect(workspaceModel.updateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = workspaceModel.updateOne.mock.calls[0];
      expect(String(filter._id)).toBe(workspaceId.toHexString());
      const $set = update.$set;
      expect($set.isDeleted).toBe(true);
      expect($set.deletedAt).toBeInstanceOf(Date);
      expect($set.kioskTokenHash).toBeNull();
      expect($set.kioskAllowedIpRanges).toEqual([]);
      expect($set.kioskTokenRotatedAt).toBeNull();
      expect($set.attendanceIngestToken).toBeNull();
      expect($set.attendanceIngestTokenRotatedAt).toBeNull();
      expect($set['emailConfig.smtpConfig.pass']).toBeNull();
    });

    it('AC-1.2 — does NOT delete any member/salary/attendance rows (soft-delete only)', async () => {
      await svc.remove(workspaceId.toHexString(), ownerId.toHexString());
      // No deleteMany / hard-delete anywhere on the workspace remove path.
      expect(workspaceModel.deleteMany).toBeUndefined();
      expect(workspaceModel.updateOne).toHaveBeenCalledTimes(1);
    });
  });

  // ── Last-workspace delete now allowed (owner-approved behaviour change) ───
  describe('remove() last-workspace guard removed', () => {
    it('soft-deletes the owner-only workspace even when it is their ONLY one', async () => {
      // Owner owns exactly ONE non-deleted workspace. Pre-change this threw
      // BadRequestException ("cannot delete your last workspace"); now it must
      // soft-delete + scrub credentials like any other delete.
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, name: 'Solo', isDeleted: false }),
      );
      workspaceModel.countDocuments.mockReturnValue({ exec: () => Promise.resolve(1) });

      await expect(
        svc.remove(workspaceId.toHexString(), ownerId.toHexString()),
      ).resolves.toBeUndefined();

      // The soft-delete write still fires (with the full credential scrub).
      expect(workspaceModel.updateOne).toHaveBeenCalledTimes(1);
      const [, update] = workspaceModel.updateOne.mock.calls[0];
      expect(update.$set.isDeleted).toBe(true);
      expect(update.$set.kioskTokenHash).toBeNull();
      expect(update.$set['emailConfig.smtpConfig.pass']).toBeNull();
    });

    it('no longer queries countDocuments to gate the delete', async () => {
      // The last-workspace count check is gone, so remove() must not consult
      // countDocuments at all (it would have, pre-change, to enforce the guard).
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, name: 'Solo', isDeleted: false }),
      );
      workspaceModel.countDocuments.mockClear();

      await svc.remove(workspaceId.toHexString(), ownerId.toHexString());

      expect(workspaceModel.countDocuments).not.toHaveBeenCalled();
    });

    it('still blocks a non-owner from deleting the workspace', async () => {
      // The owner gate is untouched by removing the last-workspace guard.
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, name: 'Solo', isDeleted: false }),
      );
      await expect(
        svc.remove(workspaceId.toHexString(), new Types.ObjectId().toHexString()),
      ).rejects.toThrow('Only the workspace owner can delete');
      expect(workspaceModel.updateOne).not.toHaveBeenCalled();
    });

    it('create() recounts active workspaces EXCLUDING soft-deleted ones, so delete-then-create works on a 1-ws plan', async () => {
      // Why this is safe after the change: getCurrentWorkspaceCount (used by both
      // create() and the restore guard) filters `isDeleted: { $ne: true }`. So
      // once the only workspace is soft-deleted, the active count drops to 0 and a
      // fresh create() at a 1-workspace limit is NOT blocked. Assert the
      // count-query contract that delete+create-new relies on. countDocuments is
      // awaited directly (no .exec()), so resolve to the number.
      workspaceModel.countDocuments.mockResolvedValue(0);

      const count = await (svc as any).getCurrentWorkspaceCount(ownerId.toHexString());

      expect(count).toBe(0);
      const filter = workspaceModel.countDocuments.mock.calls[0][0];
      expect(String(filter.ownerId)).toBe(ownerId.toHexString());
      // The soft-deleted exclusion is what makes the recreate succeed at the limit.
      expect(filter.isDeleted).toEqual({ $ne: true });
    });
  });

  // ── AC-2.2 / OQ-W5 + OQ-W2 + OQ-W1 — removeMember ────────────────────────
  // ── User.hasWorkspace recompute on owner-side live-workspace count change ──
  // The flag drives post-login ERP-vs-Connect routing + the Quick-PIN gate; it
  // must track real ownership so a now workspace-less owner is never force-PIN'd.
  describe('hasWorkspace recompute (remove / restore)', () => {
    it('remove() sets hasWorkspace=false when the owner has no other live workspace', async () => {
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, name: 'Solo', isDeleted: false }),
      );
      workspaceModel.exists.mockResolvedValue(null); // none left after the delete

      await svc.remove(workspaceId.toHexString(), ownerId.toHexString());

      expect(usersService.update).toHaveBeenCalledWith(ownerId.toHexString(), {
        hasWorkspace: false,
      });
    });

    it('remove() keeps hasWorkspace=true when the owner still owns another live workspace', async () => {
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, name: 'One of many', isDeleted: false }),
      );
      workspaceModel.exists.mockResolvedValue({ _id: new Types.ObjectId() }); // another remains

      await svc.remove(workspaceId.toHexString(), ownerId.toHexString());

      expect(usersService.update).toHaveBeenCalledWith(ownerId.toHexString(), {
        hasWorkspace: true,
      });
    });

    it('restore() sets hasWorkspace=true (covers delete-last -> restore)', async () => {
      const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({
          _id: workspaceId,
          ownerId,
          name: 'Back',
          isDeleted: true,
          deletedAt: recent,
        }),
      );
      workspaceModel.exists.mockResolvedValue({ _id: workspaceId }); // restored one is live

      await svc.restore(workspaceId.toHexString(), ownerId.toHexString());

      expect(usersService.update).toHaveBeenCalledWith(ownerId.toHexString(), {
        hasWorkspace: true,
      });
    });
  });

  describe('removeMember()', () => {
    function memberDoc(extra: any = {}) {
      const save = vi.fn().mockResolvedValue(undefined);
      return {
        doc: {
          _id: memberId,
          userId: memberUserId,
          workspaceId: { _id: workspaceId, ownerId },
          status: 'active',
          inviteeIdentifier: 'left-over@example.com',
          inviteeType: 'email',
          linkedTeamMemberId: null,
          save,
          ...extra,
        },
        save,
      };
    }

    beforeEach(() => {
      // assertWorkspaceNotDeleted reads findById(id).select('isDeleted').lean().exec()
      workspaceModel.findById.mockReturnValue(findByIdReturning({ isDeleted: false }));
    });

    it('AC-2.2 — uses a scoped findOne({_id, workspaceId}) (cross-workspace ⇒ 404)', async () => {
      memberModel.findOne.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(null) }),
      });

      await expect(
        svc.removeMember(workspaceId.toHexString(), memberId.toHexString(), ownerId.toHexString()),
      ).rejects.toThrow('Member not found');

      expect(memberModel.findOne).toHaveBeenCalledTimes(1);
      const filter = memberModel.findOne.mock.calls[0][0];
      expect(String(filter._id)).toBe(memberId.toHexString());
      expect(String(filter.workspaceId)).toBe(workspaceId.toHexString());
      // Must NOT fall back to the unscoped findById.
      expect(memberModel.findById).not.toHaveBeenCalled();
    });

    it('AC-1.5 / OQ-W2 — scrubs inviteeIdentifier/inviteeType on removal', async () => {
      const { doc, save } = memberDoc();
      memberModel.findOne.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(doc) }),
      });

      await svc.removeMember(
        workspaceId.toHexString(),
        memberId.toHexString(),
        ownerId.toHexString(),
      );

      expect(save).toHaveBeenCalled();
      expect(doc.status).toBe('removed');
      expect(doc.inviteeIdentifier).toBeUndefined();
      expect(doc.inviteeType).toBeUndefined();
      // Redis revoke + session kill scoped to this workspace+user.
      expect(revocationService.revoke).toHaveBeenCalledWith(
        workspaceId.toHexString(),
        String(memberUserId),
      );
      expect(sessionModel.updateMany).toHaveBeenCalledTimes(1);
    });

    function memberRemovedAudit() {
      return auditService.logEvent.mock.calls
        .map((c: any[]) => c[0])
        .find((e: any) => e.action === 'workspace.member_removed');
    }

    it('OQ-W1 — flags the full offboarding cascade when linked to a directory employee', async () => {
      const teamMemberId = new Types.ObjectId();
      const { doc } = memberDoc({ linkedTeamMemberId: teamMemberId });
      memberModel.findOne.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(doc) }),
      });

      await svc.removeMember(
        workspaceId.toHexString(),
        memberId.toHexString(),
        ownerId.toHexString(),
      );

      // The cascade is taken for a linked member (offboardCascade=true). In the
      // running app this routes through TeamService.remove() → salary + attendance
      // cascades; here the deterministic branch flag proves it is wired.
      const audit = memberRemovedAudit();
      expect(audit).toBeDefined();
      expect(audit.meta.offboardCascade).toBe(true);
    });

    it('OQ-W1 — does NOT take the offboarding cascade for a bare collaborator (no linked employee)', async () => {
      const { doc } = memberDoc({ linkedTeamMemberId: null });
      memberModel.findOne.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(doc) }),
      });

      await svc.removeMember(
        workspaceId.toHexString(),
        memberId.toHexString(),
        ownerId.toHexString(),
      );

      const audit = memberRemovedAudit();
      expect(audit).toBeDefined();
      expect(audit.meta.offboardCascade).toBe(false);
      expect(teamService.remove).not.toHaveBeenCalled();
    });

    it('still blocks removing yourself and the owner', async () => {
      const { doc: selfDoc } = memberDoc({ userId: ownerId });
      memberModel.findOne.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(selfDoc) }),
      });
      await expect(
        svc.removeMember(workspaceId.toHexString(), memberId.toHexString(), ownerId.toHexString()),
      ).rejects.toThrow('Cannot remove yourself');
    });
  });

  // ── OQ-W7 — branding $set merge fix ──────────────────────────────────────
  describe('updateBranding()', () => {
    it('writes dot-notation $set so unset nested fields are preserved', async () => {
      workspaceModel.findById.mockReturnValue(findByIdReturning({ isDeleted: false }));
      workspaceModel.findByIdAndUpdate.mockReturnValue({
        exec: () => Promise.resolve({ ownerId, branding: { logo: 'new' } }),
      });

      await svc.updateBranding(workspaceId.toHexString(), { logo: 'new-url' } as any);

      const [, update] = workspaceModel.findByIdAndUpdate.mock.calls[0];
      // Only the provided field is set, via dot-notation (NOT a whole-object replace).
      expect(update.$set).toEqual({ 'branding.logo': 'new-url' });
      expect(update.$set).not.toHaveProperty('branding');
    });
  });

  // ── OQ-W3 — restore / list-restorable ────────────────────────────────────
  describe('restore() + listRestorableWorkspaces()', () => {
    it('restore clears soft-delete flags within the 30-day window', async () => {
      const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({
          _id: workspaceId,
          ownerId,
          name: 'Acme',
          isDeleted: true,
          deletedAt: recent,
        }),
      );

      const res = await svc.restore(workspaceId.toHexString(), ownerId.toHexString());

      expect(res).toEqual({ ok: true, workspaceId: workspaceId.toHexString() });
      const [, update] = workspaceModel.updateOne.mock.calls[0];
      expect(update.$set).toEqual({ isDeleted: false, deletedAt: null, deletedBy: null });
    });

    it('restore rejects when the 30-day window has expired', async () => {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({
          _id: workspaceId,
          ownerId,
          name: 'Acme',
          isDeleted: true,
          deletedAt: old,
        }),
      );

      await expect(
        svc.restore(workspaceId.toHexString(), ownerId.toHexString()),
      ).rejects.toMatchObject({ response: { code: 'WORKSPACE_RESTORE_WINDOW_EXPIRED' } });
      expect(workspaceModel.updateOne).not.toHaveBeenCalled();
    });

    it('restore rejects a non-owner caller (owner-only, same gate as delete)', async () => {
      const recent = new Date();
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, isDeleted: true, deletedAt: recent }),
      );
      await expect(
        svc.restore(workspaceId.toHexString(), new Types.ObjectId().toHexString()),
      ).rejects.toThrow('Only the workspace owner can restore');
    });

    it('restore rejects a workspace that is not deleted', async () => {
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, isDeleted: false }),
      );
      await expect(svc.restore(workspaceId.toHexString(), ownerId.toHexString())).rejects.toThrow(
        'not deleted',
      );
    });

    // ── Workspace-limit guard on restore (edge opened by last-workspace delete) ──
    // getWorkspaceLimit reads subscriptionModel.findOne(...).sort().exec();
    // getCurrentWorkspaceCount reads workspaceModel.countDocuments(...).exec().
    // Helper: a within-window deleted workspace owned by the caller.
    function restorableWorkspaceDoc() {
      const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      return { _id: workspaceId, ownerId, name: 'Acme', isDeleted: true, deletedAt: recent };
    }
    function mockSubscriptionLimit(maxWorkspaces: number | null) {
      subscriptionModel.findOne.mockReturnValue({
        sort: () => ({
          exec: () =>
            Promise.resolve(
              maxWorkspaces === null
                ? null
                : { status: 'active', appliedEntitlements: { maxWorkspaces } },
            ),
        }),
      });
    }

    it('restore throws WORKSPACE_LIMIT_REACHED_ON_RESTORE when active count is already at the limit', async () => {
      // Limit = 1, the owner already has 1 active workspace (the replacement they
      // created after deleting this one) → restoring this one would make 2.
      // getCurrentWorkspaceCount awaits countDocuments(...) directly (no .exec()),
      // so the mock must resolve to the number itself.
      workspaceModel.findById.mockReturnValue(findByIdReturning(restorableWorkspaceDoc()));
      mockSubscriptionLimit(1);
      workspaceModel.countDocuments.mockResolvedValue(1);

      await expect(
        svc.restore(workspaceId.toHexString(), ownerId.toHexString()),
      ).rejects.toMatchObject({ response: { code: 'WORKSPACE_LIMIT_REACHED_ON_RESTORE' } });
      // Guard fails BEFORE the un-delete write.
      expect(workspaceModel.updateOne).not.toHaveBeenCalled();
    });

    it('restore succeeds when the active count is below the limit', async () => {
      // Limit = 2, only 1 active workspace → room to restore.
      workspaceModel.findById.mockReturnValue(findByIdReturning(restorableWorkspaceDoc()));
      mockSubscriptionLimit(2);
      workspaceModel.countDocuments.mockResolvedValue(1);

      const res = await svc.restore(workspaceId.toHexString(), ownerId.toHexString());

      expect(res).toEqual({ ok: true, workspaceId: workspaceId.toHexString() });
      const [, update] = workspaceModel.updateOne.mock.calls[0];
      expect(update.$set).toEqual({ isDeleted: false, deletedAt: null, deletedBy: null });
    });

    it('restore skips the limit check on an unlimited plan (limit === -1)', async () => {
      // Unlimited plan: even with many active workspaces, restore is allowed.
      workspaceModel.findById.mockReturnValue(findByIdReturning(restorableWorkspaceDoc()));
      mockSubscriptionLimit(-1);
      workspaceModel.countDocuments.mockResolvedValue(99);

      const res = await svc.restore(workspaceId.toHexString(), ownerId.toHexString());

      expect(res).toEqual({ ok: true, workspaceId: workspaceId.toHexString() });
      expect(workspaceModel.updateOne).toHaveBeenCalledTimes(1);
    });

    it('listRestorableWorkspaces filters by owner + soft-deleted + window', async () => {
      const deletedAt = new Date();
      workspaceModel.find.mockReturnValue({
        select: () => ({
          sort: () => ({
            lean: () => ({
              exec: () =>
                Promise.resolve([
                  { _id: workspaceId, name: 'Acme', branding: { logo: 'l' }, deletedAt },
                ]),
            }),
          }),
        }),
      });

      const list = await svc.listRestorableWorkspaces(ownerId.toHexString());

      const filter = workspaceModel.find.mock.calls[0][0];
      expect(String(filter.ownerId)).toBe(ownerId.toHexString());
      expect(filter.isDeleted).toBe(true);
      expect(filter.deletedAt.$gte).toBeInstanceOf(Date);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: workspaceId.toHexString(), name: 'Acme', logo: 'l' });
      expect(list[0].restorableUntil).toBeInstanceOf(Date);
    });
  });

  // ── OQ-W4 — soft-delete all owned for erasure ────────────────────────────
  describe('softDeleteAllOwnedForErasure()', () => {
    it('soft-deletes + scrubs credentials for every owned non-deleted workspace', async () => {
      workspaceModel.find.mockReturnValue({
        select: () => ({
          lean: () => ({
            exec: () =>
              Promise.resolve([
                { _id: workspaceId, name: 'A' },
                { _id: new Types.ObjectId(), name: 'B' },
              ]),
          }),
        }),
      });

      const res = await svc.softDeleteAllOwnedForErasure(ownerId.toHexString());

      expect(res).toEqual({ softDeleted: 2 });
      expect(workspaceModel.updateMany).toHaveBeenCalledTimes(1);
      const [filter, update] = workspaceModel.updateMany.mock.calls[0];
      expect(String(filter.ownerId)).toBe(ownerId.toHexString());
      expect(filter.isDeleted).toEqual({ $ne: true });
      expect(update.$set.isDeleted).toBe(true);
      expect(update.$set.kioskTokenHash).toBeNull();
      expect(update.$set['emailConfig.smtpConfig.pass']).toBeNull();
    });

    it('is a no-op when the user owns no non-deleted workspaces', async () => {
      workspaceModel.find.mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
      });
      const res = await svc.softDeleteAllOwnedForErasure(ownerId.toHexString());
      expect(res).toEqual({ softDeleted: 0 });
      expect(workspaceModel.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── OQ-W6 — leave workspace ──────────────────────────────────────────────
  describe('leaveWorkspace()', () => {
    beforeEach(() => {
      // assertWorkspaceNotDeleted + the owner/name read both go through findById.
      workspaceModel.findById.mockImplementation(() =>
        findByIdReturning({ _id: workspaceId, ownerId, name: 'Acme', isDeleted: false }),
      );
    });

    it('blocks the workspace owner from leaving', async () => {
      await expect(
        svc.leaveWorkspace(workspaceId.toHexString(), ownerId.toHexString()),
      ).rejects.toThrow('owner cannot leave');
    });

    it('removes a non-owner member, scrubs PII, revokes access + sessions', async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      const leaverId = new Types.ObjectId();
      const memberRow = {
        _id: memberId,
        userId: leaverId,
        status: 'active',
        inviteeIdentifier: 'x@example.com',
        inviteeType: 'email',
        save,
      };
      memberModel.findOne.mockReturnValue({ exec: () => Promise.resolve(memberRow) });

      const res = await svc.leaveWorkspace(workspaceId.toHexString(), leaverId.toHexString());

      expect(res).toEqual({ ok: true });
      expect(memberRow.status).toBe('removed');
      expect(memberRow.inviteeIdentifier).toBeUndefined();
      expect(revocationService.revoke).toHaveBeenCalledWith(
        workspaceId.toHexString(),
        leaverId.toHexString(),
      );
      expect(sessionModel.updateMany).toHaveBeenCalledTimes(1);
    });

    it('rejects when the caller is not an active member', async () => {
      const leaverId = new Types.ObjectId();
      memberModel.findOne.mockReturnValue({ exec: () => Promise.resolve(null) });
      await expect(
        svc.leaveWorkspace(workspaceId.toHexString(), leaverId.toHexString()),
      ).rejects.toThrow('not an active member');
    });
  });

  // ── §10 / AC-10.2 — re-add (rehire) worker-path heal ────────────────────
  // Removing then re-adding a worker (teamMemberId-linked row) must heal the
  // SAME WorkspaceMember row in place. The linked TeamMember, its employeeCode,
  // and all salary/attendance history (owned by Team/Salary/Attendance) survive
  // untouched because the service only touches the WorkspaceMember bridge row —
  // never the TeamMember or its sibling records.
  describe('inviteMember() worker-path heal (AC-10.2)', () => {
    const teamMemberId = new Types.ObjectId();

    beforeEach(() => {
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, name: 'Acme', isDeleted: false }),
      );
    });

    it('heals the SINGLE removed bridge row for a worker; does not insert a second row', async () => {
      const removedRowSave = vi.fn().mockResolvedValue(undefined);
      const workerBridge: any = {
        _id: memberId,
        workspaceId,
        userId: memberUserId,
        linkedTeamMemberId: teamMemberId,
        status: 'removed',
        removedAt: new Date('2026-02-15'),
        removedBy: ownerId,
        save: removedRowSave,
      };

      // The worker invite DTO always supplies an email or mobile (sent as the
      // invite delivery address). usersService.findByIdentifier resolves the
      // existing User object for that contact.
      usersService.findByIdentifier.mockResolvedValue({
        _id: memberUserId,
        email: 'worker@example.com',
      });

      // Worker-path: memberModel.findOne with {linkedTeamMemberId} finds the row.
      memberModel.findOne.mockImplementation((q: any) => {
        if (q.linkedTeamMemberId) {
          // Return the removed worker bridge.
          return { sort: () => ({ exec: () => Promise.resolve(workerBridge) }) };
        }
        // active/invited guard + collaborator-prior-row lookup return null so
        // the worker-path heal runs without any conflict.
        return { exec: () => Promise.resolve(null) };
      });

      // subscriptionModel: null subscription = 1-workspace limit (default).
      subscriptionModel.findOne.mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
      });

      const insertSpy = vi.fn(() => {
        throw new Error('must not insert a second row for worker re-add');
      });
      (svc as any).memberModel = new Proxy(memberModel, {
        construct: () => {
          insertSpy();
          return {};
        },
      });

      const res: any = await svc.inviteMember(workspaceId.toHexString(), ownerId.toHexString(), {
        email: 'worker@example.com',
        teamMemberId: teamMemberId.toHexString(),
      } as any);

      // Row healed in place — no second insert.
      expect(insertSpy).not.toHaveBeenCalled();
      expect(removedRowSave).toHaveBeenCalledTimes(1);
      expect(workerBridge.status).toBe('invited');
      // Terminal state fields are cleared on heal.
      expect(workerBridge.removedAt).toBeUndefined();
      expect(workerBridge.removedBy).toBeUndefined();
      // AC-10.3 — rehire signal surfaced for the worker path too.
      expect(res.priorMembership).not.toBeNull();
      expect(res.priorMembership.removedAt).toEqual(new Date('2026-02-15'));
      // The linkedTeamMemberId is UNCHANGED — same TeamMember record is reattached.
      expect(String(workerBridge.linkedTeamMemberId)).toBe(teamMemberId.toHexString());
    });

    it('blocks re-invite when the worker bridge is already active', async () => {
      usersService.findByIdentifier.mockResolvedValue({
        _id: memberUserId,
        email: 'worker@example.com',
      });
      const activeBridge: any = {
        _id: memberId,
        workspaceId,
        userId: memberUserId,
        linkedTeamMemberId: teamMemberId,
        status: 'active',
        save: vi.fn(),
      };
      memberModel.findOne.mockImplementation((q: any) => {
        if (q.linkedTeamMemberId) {
          return { sort: () => ({ exec: () => Promise.resolve(activeBridge) }) };
        }
        return { exec: () => Promise.resolve(null) };
      });

      await expect(
        svc.inviteMember(workspaceId.toHexString(), ownerId.toHexString(), {
          email: 'worker@example.com',
          teamMemberId: teamMemberId.toHexString(),
        } as any),
      ).rejects.toThrow('already has active access');
    });
  });

  // ── §10 / AC-10.1 — re-add (rehire) collaborator-path heal ────────────────
  describe('inviteMember() collaborator-path heal (AC-10.1)', () => {
    beforeEach(() => {
      // Non-deleted workspace for checkSeatLimit + the workspace info read.
      workspaceModel.findById.mockReturnValue(
        findByIdReturning({ _id: workspaceId, ownerId, name: 'Acme', isDeleted: false }),
      );
    });

    it('reactivates the SINGLE prior removed row instead of inserting a second (no E11000)', async () => {
      const existingUser = { _id: memberUserId, email: 'rehire@example.com' };
      usersService.findByIdentifier.mockResolvedValue(existingUser);

      const removedRowSave = vi.fn().mockResolvedValue(undefined);
      const removedRow: any = {
        _id: memberId,
        workspaceId,
        userId: memberUserId,
        status: 'removed',
        removedAt: new Date('2026-01-01'),
        linkedTeamMemberId: null,
        save: removedRowSave,
      };

      // findOne is called several times in inviteMember with DIFFERENT call
      // shapes. Route by the query:
      //  - active/invited existence check → AWAITED directly (no .exec()) ⇒ return
      //    a Promise resolving to null (no active row).
      //  - prior removed/declined row     → `.sort().exec()` ⇒ chain → removedRow.
      memberModel.findOne.mockImplementation((q: any) => {
        if (q.status && q.status.$in && q.status.$in.includes('removed')) {
          return { sort: () => ({ exec: () => Promise.resolve(removedRow) }) };
        }
        // active/invited existence check is awaited directly.
        return Promise.resolve(null) as any;
      });

      // Guard: the model CONSTRUCTOR must NOT be used (we heal in place, not
      // insert). Spy on the constructor path used by `new this.memberModel(...)`.
      const insertSpy = vi.fn(() => {
        throw new Error('must not insert a second row');
      });
      (svc as any).memberModel = new Proxy(memberModel, {
        construct: () => {
          insertSpy();
          return {};
        },
      });

      const res: any = await svc.inviteMember(workspaceId.toHexString(), ownerId.toHexString(), {
        email: 'rehire@example.com',
      } as any);

      expect(insertSpy).not.toHaveBeenCalled();

      // The prior row was healed (saved), not a new insert.
      expect(removedRowSave).toHaveBeenCalledTimes(1);
      expect(removedRow.status).toBe('invited');
      expect(removedRow.removedAt).toBeUndefined();
      // AC-10.3 — rehire signal returned.
      expect(res.priorMembership).not.toBeNull();
      expect(res.priorMembership.removedAt).toEqual(new Date('2026-01-01'));
    });
  });
});
