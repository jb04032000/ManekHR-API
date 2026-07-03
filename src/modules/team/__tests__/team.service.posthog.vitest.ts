/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
 * PostHog server-side capture coverage for Phase 5 W6.
 *
 * Asserts that the canonical `team.*` events fire on the success paths of
 * the team surface. Mirrors workspace W6 vitest pattern.
 *
 * PostHog is mocked — no real network calls. The real wrapper
 * (`PostHogService.capture`) swallows client errors internally, so a flaky
 * PostHog backend never breaks a team flow.
 */
describe('TeamService — PostHog capture (Phase 5 W6)', () => {
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
    postHog = { capture: vi.fn(), identify: vi.fn() };
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
    machineModel = { find: vi.fn() };
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
        // §7 Part B — CallerScopeService (unused by the PostHog paths here).
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

  // ── member_archived ─────────────────────────────────────────────────────

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

    await svc.remove(workspaceId.toHexString(), memberId.toHexString());

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'team.member_archived',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      event: 'team.member_archived',
      properties: {
        workspaceId: workspaceId.toHexString(),
        memberId: memberId.toHexString(),
      },
    });
  });

  // ── member_restored ─────────────────────────────────────────────────────

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

    await svc.restore(workspaceId.toHexString(), memberId.toHexString());

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'team.member_restored',
    );
    expect(call).toBeDefined();
  });

  // ── bulk_action ─────────────────────────────────────────────────────────

  it('fires team.bulk_action with action=archived on bulkDelete success', async () => {
    teamModel.updateMany.mockReturnValue({
      exec: () => Promise.resolve({ modifiedCount: 3 }),
    });

    await svc.bulkDelete(workspaceId.toHexString(), [
      memberId.toHexString(),
      new Types.ObjectId().toHexString(),
      new Types.ObjectId().toHexString(),
    ]);

    const call = postHog.capture.mock.calls.find((c: any[]) => c[0].event === 'team.bulk_action');
    expect(call).toBeDefined();
    expect(call[0].properties).toMatchObject({
      action: 'archived',
      count: 3,
    });
  });

  // ── kiosk_pin_set ───────────────────────────────────────────────────────

  it('fires team.kiosk_pin_set on setKioskPin success', async () => {
    teamModel.updateOne.mockResolvedValue({ matchedCount: 1 });

    await svc.setKioskPin(workspaceId.toHexString(), memberId.toHexString(), '1234');

    const call = postHog.capture.mock.calls.find((c: any[]) => c[0].event === 'team.kiosk_pin_set');
    expect(call).toBeDefined();
  });

  // ── karigar_profile_updated ─────────────────────────────────────────────

  it('fires team.karigar_profile_updated on updateKarigarProfile success', async () => {
    teamModel.findOneAndUpdate.mockResolvedValue({
      _id: memberId,
      name: 'Karigar Worker',
      isKarigar: true,
    });

    await svc.updateKarigarProfile(workspaceId.toHexString(), memberId.toHexString(), {
      isKarigar: true,
      karigarSkillType: 'embroidery',
      karigarDailyRatePaise: 60000,
    });

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'team.karigar_profile_updated',
    );
    expect(call).toBeDefined();
    expect(call[0].properties).toMatchObject({
      isKarigar: true,
      skillType: 'embroidery',
    });
  });

  // ── invite_accepted ─────────────────────────────────────────────────────

  it('fires team.invite_accepted on acceptInvite success', async () => {
    const memberWorkspaceId = new Types.ObjectId();
    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          name: 'Invitee',
          workspaceId: memberWorkspaceId,
          appAccessInviteToken: 'token-x',
          appAccessInviteExpiry: new Date(Date.now() + 10 * 60 * 1000),
          save: vi.fn().mockResolvedValue(undefined),
        }),
    });

    await svc.acceptInvite('token-x', userId.toHexString());

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'team.invite_accepted',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: userId.toHexString(),
      event: 'team.invite_accepted',
      properties: {
        workspaceId: memberWorkspaceId.toHexString(),
        memberId: memberId.toHexString(),
      },
    });
  });
});
