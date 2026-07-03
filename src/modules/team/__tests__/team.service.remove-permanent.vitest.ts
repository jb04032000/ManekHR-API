/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing TeamService. Mirrors the
// existing classify-mobile / access / audit / posthog suites in this folder.
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

describe('TeamService.removePermanent - retain files, release quota', () => {
  let teamModel: any;
  let machineModel: any;
  let moduleRef: any;
  let workspaceModel: any;
  let workspaceMemberModel: any;
  let userModel: any;
  let uploadsService: any;
  let salaryLifecycle: any;
  let attendanceLifecycle: any;
  let billsLifecycle: any;
  let svc: TeamService;

  /** Helper: build the service with the current mock state. */
  function buildService() {
    svc = new TeamService(
      teamModel,
      machineModel,
      // locationModel + locationsService — added to the TeamService constructor
      // (positions 3-4) for dto.locationId validation; previously omitted here,
      // which shifted every later arg by two and made configService.get throw.
      { findOne: vi.fn(), find: vi.fn() } as any,
      { validateForWorkspace: vi.fn() } as any,
      moduleRef,
      // uploadsService — both methods stubbed.
      uploadsService,
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
      // permissionDispatcher / mobileOtpService / permissionEvents — trailing
      // constructor args, unused on the remove / removePermanent paths under test.
      { dispatch: vi.fn() } as any,
      { startVerification: vi.fn(), confirm: vi.fn() } as any,
      { emit: vi.fn() } as any,
    );
  }

  beforeEach(() => {
    teamModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
      find: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 1 }) }),
      updateMany: vi.fn(),
      countDocuments: vi.fn(),
    };
    machineModel = { find: vi.fn() };

    workspaceModel = { findById: vi.fn(), countDocuments: vi.fn() };
    workspaceMemberModel = {
      find: vi.fn(),
      findOne: vi.fn(),
      countDocuments: vi.fn(),
      updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 0 }) }),
    };
    userModel = { findOne: vi.fn(), findById: vi.fn() };

    // Lifecycle service stubs — salary, attendance AND finance/bills Remove-vs-Delete
    // history gates run in removePermanent (resolved lazily via moduleRef by
    // class token). Default: no history on any side (delete allowed).
    salaryLifecycle = {
      memberHasHistory: vi.fn().mockResolvedValue(false),
      onMemberRemoved: vi.fn().mockResolvedValue(undefined),
    };
    attendanceLifecycle = {
      memberHasHistory: vi.fn().mockResolvedValue(false),
      onMemberRemoved: vi.fn().mockResolvedValue(undefined),
    };
    // Finance/Bills lifecycle gate (Finance/Bills hardening, 2026-06-15).
    // Default: no finance history (delete allowed). Tests override as needed.
    billsLifecycle = {
      memberHasHistory: vi.fn().mockResolvedValue(false),
    };

    moduleRef = {
      // The service resolves models by string token and lifecycle services by
      // CLASS token — key the mock on `token?.name ?? token` to cover both.
      get: vi.fn().mockImplementation((token: any) => {
        const name = typeof token === 'string' ? token : token?.name;
        if (name === 'WorkspaceModel') return workspaceModel;
        if (name === 'WorkspaceMemberModel') return workspaceMemberModel;
        if (name === 'UserModel') return userModel;
        if (name === 'SalaryLifecycleService') return salaryLifecycle;
        if (name === 'AttendanceLifecycleService') return attendanceLifecycle;
        if (name === 'BillsLifecycleService') return billsLifecycle;
        return {
          findOne: vi.fn().mockReturnValue(selectLeanExec(null)),
          findById: vi.fn().mockReturnValue(selectLeanExec(null)),
          find: vi.fn().mockReturnValue(selectLeanExec([])),
          countDocuments: vi.fn().mockResolvedValue(0),
          updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
        };
      }),
    };

    uploadsService = { deleteFile: vi.fn(), releaseFileFromQuota: vi.fn() } as any;

    buildService();
  });

  it('removePermanent keeps files (no physical delete) and releases their quota', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          avatar: 'https://cdn/a.jpg',
          bankDetails: { passbookImageUrl: 'https://cdn/p.jpg' },
          upiDetails: {},
        }),
    });
    teamModel.updateOne.mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 1 }) });

    await svc.removePermanent(
      workspaceId.toHexString(),
      memberId.toHexString(),
      ownerId.toHexString(),
    );

    // Files NOT physically deleted.
    expect(uploadsService.deleteFile).not.toHaveBeenCalled();
    // Quota released for each retained file.
    expect(uploadsService.releaseFileFromQuota).toHaveBeenCalledWith(
      'https://cdn/a.jpg',
      workspaceId.toHexString(),
    );
    expect(uploadsService.releaseFileFromQuota).toHaveBeenCalledWith(
      'https://cdn/p.jpg',
      workspaceId.toHexString(),
    );
    // Row flagged, not removed.
    const update = teamModel.updateOne.mock.calls[0][1];
    expect(update.$set.isPermanentlyDeleted).toBe(true);
  });

  // AC-1.7 (Attendance hardening / OQ-A1): a member with attendance history but
  // NO salary history must STILL be blocked from permanent delete — the muster
  // roll is statutory evidence. This proves the Team gate consults the attendance
  // history check alongside the salary one (the gap before this pass).
  it('blocks permanent delete when only attendance history exists (no salary history)', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () => Promise.resolve({ _id: memberId, avatar: null }),
    });
    salaryLifecycle.memberHasHistory.mockResolvedValue(false);
    attendanceLifecycle.memberHasHistory.mockResolvedValue(true);

    await expect(
      svc.removePermanent(workspaceId.toHexString(), memberId.toHexString(), ownerId.toHexString()),
    ).rejects.toMatchObject({ response: { code: 'MEMBER_HAS_HISTORY' } });

    // Never flagged permanently deleted — it stays archived.
    const flaggedPermanent = teamModel.updateOne.mock.calls.some(
      (c: any[]) => c[1]?.$set?.isPermanentlyDeleted === true,
    );
    expect(flaggedPermanent).toBe(false);
  });

  // Finance/Bills hardening (2026-06-15): a member with finance/bills history
  // (bills, purchase bills, expenses, or ledger entries) must be blocked from
  // permanent delete — the books must stay complete (AC-1.6 / C1-C).
  it('blocks permanent delete when only finance/bills history exists (no salary/attendance)', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () => Promise.resolve({ _id: memberId, avatar: null }),
    });
    salaryLifecycle.memberHasHistory.mockResolvedValue(false);
    attendanceLifecycle.memberHasHistory.mockResolvedValue(false);
    // Finance/Bills gate returns true — member has a bill attributed to them.
    billsLifecycle.memberHasHistory.mockResolvedValue(true);

    await expect(
      svc.removePermanent(workspaceId.toHexString(), memberId.toHexString(), ownerId.toHexString()),
    ).rejects.toMatchObject({ response: { code: 'MEMBER_HAS_HISTORY' } });

    // The member must NOT be flagged as permanently deleted.
    const flaggedPermanent = teamModel.updateOne.mock.calls.some(
      (c: any[]) => c[1]?.$set?.isPermanentlyDeleted === true,
    );
    expect(flaggedPermanent).toBe(false);
  });

  it('allows permanent delete when ALL three lifecycle gates return false', async () => {
    teamModel.findOne.mockReturnValue({
      exec: () => Promise.resolve({ _id: memberId, avatar: null }),
    });
    teamModel.updateOne.mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 1 }) });
    salaryLifecycle.memberHasHistory.mockResolvedValue(false);
    attendanceLifecycle.memberHasHistory.mockResolvedValue(false);
    billsLifecycle.memberHasHistory.mockResolvedValue(false);

    // Should complete without throwing.
    await expect(
      svc.removePermanent(workspaceId.toHexString(), memberId.toHexString(), ownerId.toHexString()),
    ).resolves.not.toThrow();

    // The row is flagged permanently deleted.
    const update = teamModel.updateOne.mock.calls[0][1];
    expect(update.$set.isPermanentlyDeleted).toBe(true);
  });
});
