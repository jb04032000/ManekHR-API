/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing TeamService so transitive
// decorated schema imports don't trip vitest's reflect-metadata pipeline
// (mirrors team.service.access.vitest.ts).
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
import { QueryHelper } from '../../../common/helpers/query.helper';

/**
 * Phase 6 (member-cap read filter) — the ORG-scoped Team list applies the
 * allowed-member set to its query and surfaces the cap status; a SELF-scoped
 * caller is never capped (the cap service is not consulted), and the lazy
 * reconcile is best-effort (a thrown reconcile never breaks the read).
 *
 * These assert at the `QueryHelper.paginate` boundary (the regex/index path):
 * the `baseFilter` passed in carries `_id: { $in: allowedObjectIds }` only on
 * the org path and only when the cap is biting.
 */
describe('TeamService — member-cap read filter', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();
  const ownMemberId = new Types.ObjectId().toHexString();
  const allowedA = new Types.ObjectId().toHexString();
  const allowedB = new Types.ObjectId().toHexString();

  let memberCap: {
    getCapStatus: ReturnType<typeof vi.fn>;
    getAllowedMemberIds: ReturnType<typeof vi.fn>;
    reconcileWorkspace: ReturnType<typeof vi.fn>;
  };
  let callerScope: {
    resolve: ReturnType<typeof vi.fn>;
    selfPathFilterValue: ReturnType<typeof vi.fn>;
    hasPath: ReturnType<typeof vi.fn>;
  };
  let paginateSpy: ReturnType<typeof vi.spyOn>;

  function buildService() {
    return new TeamService(
      {} as any, // teamModel
      {} as any, // machineModel
      {} as any, // locationModel
      {} as any, // locationsService
      {} as any, // moduleRef
      {} as any, // uploadsService
      { get: vi.fn().mockReturnValue('') } as any, // configService
      {} as any, // mailService
      {} as any, // smsService
      { logEvent: vi.fn().mockResolvedValue(undefined) } as any, // auditService
      {} as any, // workspaceCounterService
      { capture: vi.fn(), identify: vi.fn() } as any, // postHog
      {} as any, // revocationService
      {} as any, // notificationsService
      callerScope as any,
      {} as any, // permissionDispatcher
      undefined, // mobileOtpService
      { emit: vi.fn() } as any, // permissionEvents
      memberCap as any, // Phase 6 — appended LAST
    );
  }

  beforeEach(() => {
    memberCap = {
      getCapStatus: vi.fn(),
      getAllowedMemberIds: vi.fn(),
      reconcileWorkspace: vi.fn().mockResolvedValue(undefined),
    };
    callerScope = {
      resolve: vi.fn(),
      selfPathFilterValue: vi.fn(),
      hasPath: vi.fn().mockReturnValue(true),
    };
    paginateSpy = vi
      .spyOn(QueryHelper, 'paginate')
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, pages: 0 } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── ORG-scoped + capped → query is restricted to the allowed set ─────────
  it('org-scoped + capped: injects _id { $in: allowedObjectIds } into the paginate filter', async () => {
    callerScope.resolve.mockResolvedValue({ isOwner: true, teamMemberId: null });
    callerScope.selfPathFilterValue.mockReturnValue(null); // org-scoped (no self anchor)
    memberCap.getCapStatus.mockResolvedValue({
      capped: true,
      visibleCount: 2,
      totalCount: 5,
      limit: 2,
    });
    memberCap.getAllowedMemberIds.mockResolvedValue([allowedA, allowedB]);

    const svc = buildService();
    const res = await svc.findAll(workspaceId, {} as any, false, userId);

    expect(paginateSpy).toHaveBeenCalledTimes(1);
    const baseFilter = paginateSpy.mock.calls[0][1] as Record<string, any>;
    expect(baseFilter._id).toBeDefined();
    expect(baseFilter._id.$in).toHaveLength(2);
    expect(baseFilter._id.$in.map((o: any) => String(o)).sort()).toEqual(
      [allowedA, allowedB].sort(),
    );

    // The optional cap notice is on the response payload.
    expect((res.data as any).memberCap).toEqual({
      capped: true,
      visibleCount: 2,
      totalCount: 5,
      limit: 2,
    });
  });

  // ── ORG-scoped + NOT capped → no _id filter (pass-through) ───────────────
  it('org-scoped + under cap: does NOT constrain _id (getAllowedMemberIds not called)', async () => {
    callerScope.resolve.mockResolvedValue({ isOwner: true, teamMemberId: null });
    callerScope.selfPathFilterValue.mockReturnValue(null);
    memberCap.getCapStatus.mockResolvedValue({
      capped: false,
      visibleCount: 3,
      totalCount: 3,
      limit: 5,
    });

    const svc = buildService();
    await svc.findAll(workspaceId, {} as any, false, userId);

    const baseFilter = paginateSpy.mock.calls[0][1] as Record<string, any>;
    expect(baseFilter._id).toBeUndefined();
    // When not capped we skip the allowed-set query entirely.
    expect(memberCap.getAllowedMemberIds).not.toHaveBeenCalled();
  });

  // ── SELF-scoped → cap is NOT consulted at all ────────────────────────────
  it('self-scoped: the cap service is never consulted and _id is the self anchor', async () => {
    const selfOid = new Types.ObjectId(ownMemberId);
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: ownMemberId });
    callerScope.selfPathFilterValue.mockReturnValue(selfOid); // self-scoped

    const svc = buildService();
    await svc.findAll(workspaceId, {} as any, false, userId);

    // Cap never touched for a self-scoped caller.
    expect(memberCap.getCapStatus).not.toHaveBeenCalled();
    expect(memberCap.getAllowedMemberIds).not.toHaveBeenCalled();
    expect(memberCap.reconcileWorkspace).not.toHaveBeenCalled();

    const baseFilter = paginateSpy.mock.calls[0][1] as Record<string, any>;
    expect(String(baseFilter._id)).toBe(ownMemberId);
  });

  // ── Lazy reconcile fires on the org path, and never breaks the read ──────
  it('org-scoped: fires lazy reconcileWorkspace (best-effort) and a thrown reconcile does not break the read', async () => {
    callerScope.resolve.mockResolvedValue({ isOwner: true, teamMemberId: null });
    callerScope.selfPathFilterValue.mockReturnValue(null);
    memberCap.getCapStatus.mockResolvedValue({
      capped: false,
      visibleCount: 1,
      totalCount: 1,
      limit: 5,
    });
    // Reconcile rejects — the read must still succeed (fire-and-forget + catch).
    memberCap.reconcileWorkspace.mockRejectedValue(new Error('reconcile boom'));

    const svc = buildService();
    const res = await svc.findAll(workspaceId, {} as any, false, userId);

    expect(memberCap.reconcileWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(res.success).toBe(true);
  });
});
