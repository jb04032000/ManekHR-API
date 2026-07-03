/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing TeamService — the
// transitive schema imports (TeamMember, TeamMemberDocument,
// MachineShiftAssignment, Machine) would otherwise trip vitest's esbuild
// reflection pipeline. Mirrors the workspace W5 pattern.
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
import { AppModule as AppModuleEnum } from '../../../common/enums/modules.enum';

/**
 * Audit fire-and-forget coverage for Phase 5 W5 team events.
 *
 * Verifies:
 *   - Each meaningful write fires `auditService.logEvent` with
 *     `module: AppModule.TEAM` + the expected action string.
 *   - The actor / workspace / member fields normalise via the helper
 *     (ObjectId or string both accepted).
 *   - Audit failures are swallowed and never break the caller.
 */
describe('TeamService — audit fire-and-forget (Phase 5 W5)', () => {
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
  let svc: TeamService;

  const workspaceId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const userId = new Types.ObjectId();

  beforeEach(() => {
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    teamModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      updateMany: vi.fn(),
      countDocuments: vi.fn(),
      create: vi.fn(),
      find: vi.fn(),
    };
    machineModel = {
      find: vi.fn(),
    };
    moduleRef = { get: vi.fn() };
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
      { revoke: vi.fn(), isRevoked: vi.fn(), clear: vi.fn() } as any,
      {} as any, // notificationsService — fire-and-forget, swallowed on failure
      {
        // §7 Part B — CallerScopeService (unused by the audited paths here).
        resolve: vi.fn().mockResolvedValue({
          isOwner: true,
          teamMemberId: null,
          permissions: [],
        }),
        effectiveScope: vi.fn(),
        selfFilterValue: vi.fn(),
      } as any,
    );
  });

  // ── Direct helper coverage ─────────────────────────────────────────────

  it('auditTeamEvent normalises ObjectId actorId/workspaceId/memberId via String()', async () => {
    svc.auditTeamEvent({
      action: 'team.member_created',
      workspaceId,
      actorId: userId,
      memberId,
    });
    // auditTeamEvent now resolves the actor name async before logEvent.
    await new Promise((r) => setImmediate(r));

    expect(auditService.logEvent).toHaveBeenCalledTimes(1);
    const arg = auditService.logEvent.mock.calls[0][0];
    expect(arg.module).toBe(AppModuleEnum.TEAM);
    expect(arg.action).toBe('team.member_created');
    expect(arg.workspaceId).toBe(workspaceId.toHexString());
    expect(arg.actorId).toBe(userId.toHexString());
    expect(arg.entityType).toBe('team_member');
    expect(arg.entityId).toBe(memberId.toHexString());
    expect(arg.teamMemberId).toBe(memberId.toHexString());
  });

  it('auditTeamEvent resolves actorNameSnapshot from the actor and passes meta through', async () => {
    // The helper resolves the ACTOR's name (TeamMember.name fallback). The
    // input.actorNameSnapshot is intentionally ignored (call sites used to pass
    // the TARGET name, which was the wrong "who").
    teamModel.findOne.mockReturnValue({
      select: () => ({ lean: () => ({ exec: () => Promise.resolve({ name: 'Resolved Actor' }) }) }),
    });
    svc.auditTeamEvent({
      action: 'team.karigar_profile_updated',
      workspaceId,
      actorId: userId,
      memberId,
      actorNameSnapshot: 'IGNORED INPUT',
      meta: { isKarigar: true, skillType: 'zari', dailyRatePaise: 50000 },
    });
    await new Promise((r) => setImmediate(r));

    const arg = auditService.logEvent.mock.calls[0][0];
    expect(arg.actorNameSnapshot).toBe('Resolved Actor');
    expect(arg.meta).toEqual({ isKarigar: true, skillType: 'zari', dailyRatePaise: 50000 });
  });

  // ── Write-path coverage ────────────────────────────────────────────────

  it('fires team.member_archived on remove success', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          name: 'Archive Me',
        }),
    });
    teamModel.updateOne.mockReturnValue({
      exec: () => Promise.resolve({ matchedCount: 1 }),
    });

    await svc.remove(workspaceId.toHexString(), memberId.toHexString(), userId.toHexString());
    await new Promise((r) => setImmediate(r));

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.member_archived',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      module: AppModuleEnum.TEAM,
      action: 'team.member_archived',
    });
    // actorId is now the acting user (was wrongly the target member before).
    expect(call[0].actorId).toBe(userId.toHexString());
  });

  it('remove is a no-op success when the member is already archived (2026-05-22 idempotency)', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          name: 'Already Archived',
          isDeleted: true,
          isPermanentlyDeleted: false,
        }),
    });

    const before = auditService.logEvent.mock.calls.length;
    const res = await svc.remove(
      workspaceId.toHexString(),
      memberId.toHexString(),
      userId.toHexString(),
    );

    expect(res).toEqual({
      success: true,
      message: 'Already archived',
      data: null,
    });
    expect(teamModel.updateOne).not.toHaveBeenCalled();
    // No audit / posthog emit on the no-op branch.
    expect(auditService.logEvent.mock.calls.length).toBe(before);
    expect(postHog.capture).not.toHaveBeenCalled();
  });

  it('remove is a no-op success when the member is already permanently deleted', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          name: 'Tombstone',
          isDeleted: true,
          isPermanentlyDeleted: true,
        }),
    });

    const res = await svc.remove(
      workspaceId.toHexString(),
      memberId.toHexString(),
      userId.toHexString(),
    );

    expect(res).toEqual({
      success: true,
      message: 'Already removed permanently',
      data: null,
    });
    expect(teamModel.updateOne).not.toHaveBeenCalled();
    expect(postHog.capture).not.toHaveBeenCalled();
  });

  it('fires team.member_restored on restore success', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          name: 'Restore Me',
        }),
    });
    teamModel.updateOne.mockReturnValue({
      exec: () => Promise.resolve({ matchedCount: 1 }),
    });

    await svc.restore(workspaceId.toHexString(), memberId.toHexString(), userId.toHexString());

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.member_restored',
    );
    expect(call).toBeDefined();
  });

  it('fires team.bulk_archived on bulkDelete success', async () => {
    teamModel.updateMany.mockReturnValue({
      exec: () => Promise.resolve({ modifiedCount: 3 }),
    });

    await svc.bulkDelete(
      workspaceId.toHexString(),
      [
        memberId.toHexString(),
        new Types.ObjectId().toHexString(),
        new Types.ObjectId().toHexString(),
      ],
      userId.toHexString(),
    );

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.bulk_archived',
    );
    expect(call).toBeDefined();
    expect(call[0].meta.count).toBe(3);
  });

  it('fires team.kiosk_pin_set on setKioskPin success', async () => {
    teamModel.updateOne.mockResolvedValue({ matchedCount: 1 });

    await svc.setKioskPin(
      workspaceId.toHexString(),
      memberId.toHexString(),
      '1234',
      userId.toHexString(),
    );

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.kiosk_pin_set',
    );
    expect(call).toBeDefined();
    expect(call[0].teamMemberId).toBe(memberId.toHexString());
  });

  it('fires team.karigar_profile_updated on updateKarigarProfile success', async () => {
    teamModel.findOneAndUpdate.mockResolvedValue({
      _id: memberId,
      name: 'Karigar Worker',
      isKarigar: true,
    });

    await svc.updateKarigarProfile(
      workspaceId.toHexString(),
      memberId.toHexString(),
      {
        isKarigar: true,
        karigarSkillType: 'embroidery',
        karigarDailyRatePaise: 60000,
      },
      userId.toHexString(),
    );

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.karigar_profile_updated',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toMatchObject({
      isKarigar: true,
      skillType: 'embroidery',
      dailyRatePaise: 60000,
    });
  });

  it('fires team.statutory_reveal_pan on recordStatutoryReveal pan success', async () => {
    teamModel.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: () => Promise.resolve({ name: 'Member X' }),
        }),
      }),
    });

    await svc.recordStatutoryReveal(
      workspaceId.toHexString(),
      memberId.toHexString(),
      userId.toHexString(),
      'pan',
    );

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'team.statutory_reveal_pan',
    );
    expect(call).toBeDefined();
    expect(call[0].meta).toEqual({ field: 'pan' });
  });

  // ── Resilience ─────────────────────────────────────────────────────────

  it('audit failure is swallowed and does NOT break caller', async () => {
    auditService.logEvent.mockRejectedValueOnce(new Error('audit DB down'));

    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          name: 'Resilience Test',
        }),
    });
    teamModel.updateOne.mockReturnValue({
      exec: () => Promise.resolve({ matchedCount: 1 }),
    });

    await expect(
      svc.remove(workspaceId.toHexString(), memberId.toHexString(), userId.toHexString()),
    ).resolves.toBeDefined();

    expect(auditService.logEvent).toHaveBeenCalled();
  });
});
