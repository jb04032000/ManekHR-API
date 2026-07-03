/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AttendanceService (mirrors
// attendance.self-scope.vitest.ts).
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

import { Types } from 'mongoose';
import { AttendanceService } from '../attendance.service';
import { QueryHelper } from '../../../common/helpers/query.helper';

/**
 * Phase 6 (member-cap read filter) — the ORG-scoped attendance reports respect
 * the allowed-member set:
 *  - getSummary narrows its active-member set (status aggregation `$match`) to
 *    the allowed ids,
 *  - findAll (org-scoped) constrains the records query to the allowed set when
 *    the cap is biting,
 *  - a self-scoped findAll never consults the cap.
 */
describe('AttendanceService — member-cap read filter', () => {
  const wsId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();
  const ownMemberId = new Types.ObjectId().toHexString();

  const m1 = new Types.ObjectId();
  const m2 = new Types.ObjectId();
  const m3 = new Types.ObjectId();

  let attendanceModel: any;
  let teamMemberModel: any;
  let memberCap: {
    getCapStatus: ReturnType<typeof vi.fn>;
    getAllowedMemberIds: ReturnType<typeof vi.fn>;
  };
  let callerScope: {
    resolve: ReturnType<typeof vi.fn>;
    selfPathFilterValue: ReturnType<typeof vi.fn>;
  };
  let svc: AttendanceService;

  function leanFind(rows: unknown[]) {
    const builder: any = {
      select: () => builder,
      lean: () => builder,
      exec: async () => rows,
    };
    return builder;
  }

  beforeEach(() => {
    // attendanceModel.aggregate captures the status-aggregation pipeline.
    attendanceModel = { aggregate: vi.fn().mockResolvedValue([]) };
    teamMemberModel = { find: vi.fn() };
    memberCap = {
      getCapStatus: vi.fn(),
      getAllowedMemberIds: vi.fn(),
    };
    callerScope = {
      resolve: vi.fn().mockResolvedValue({ isOwner: true, teamMemberId: null }),
      selfPathFilterValue: vi.fn().mockReturnValue(null),
    };

    svc = new AttendanceService(
      attendanceModel, // attendanceModel
      teamMemberModel, // teamMemberModel
      {} as any, // salaryModel
      {} as any, // eventService
      {} as any, // projectionService
      {} as any, // writeGuard
      { logEvent: vi.fn() } as any, // auditService
      { capture: vi.fn() } as any, // postHog
      callerScope as any, // callerScope
      { get: vi.fn(), setex: vi.fn(), del: vi.fn() } as any, // redis
      memberCap as any, // Phase 6 — appended LAST
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getSummary: status aggregation is scoped to the allowed (capped) set ──
  it('getSummary: narrows the active-member set to the allowed cap', async () => {
    // 3 active members; cap allows only m1 + m2 (m3 is grandfathered out).
    teamMemberModel.find.mockReturnValue(
      leanFind([
        { _id: m1, weeklyOff: [] },
        { _id: m2, weeklyOff: [] },
        { _id: m3, weeklyOff: [] },
      ]),
    );
    memberCap.getAllowedMemberIds.mockResolvedValue([String(m1), String(m2)]);
    // Phase 7 — getSummary now also surfaces the cap STATUS for the report notice.
    memberCap.getCapStatus.mockResolvedValue({
      capped: true,
      visibleCount: 2,
      totalCount: 3,
      limit: 2,
    });

    const res = await svc.getSummary(wsId, '2026-06-01');

    // The status aggregation $match was scoped to the allowed ids only.
    expect(attendanceModel.aggregate).toHaveBeenCalledTimes(1);
    const pipeline = attendanceModel.aggregate.mock.calls[0][0] as any[];
    const matchStage = pipeline.find((s) => s.$match)?.$match;
    const inIds = matchStage.teamMemberId.$in.map((o: any) => String(o)).sort();
    expect(inIds).toEqual([String(m1), String(m2)].sort());
    expect(inIds).not.toContain(String(m3));

    // Headcount reflects the capped roster (2, not 3).
    expect((res as any).data.total).toBe(2);
  });

  // ── getSummary: the 4-field cap notice rides the org-scoped report response ──
  it('getSummary: attaches the memberCap status (4-field) to the report response when capped', async () => {
    teamMemberModel.find.mockReturnValue(
      leanFind([
        { _id: m1, weeklyOff: [] },
        { _id: m2, weeklyOff: [] },
        { _id: m3, weeklyOff: [] },
      ]),
    );
    memberCap.getAllowedMemberIds.mockResolvedValue([String(m1), String(m2)]);
    memberCap.getCapStatus.mockResolvedValue({
      capped: true,
      visibleCount: 2,
      totalCount: 5,
      limit: 2,
      inGrace: false,
      graceEndsAt: null,
    });

    const res = await svc.getSummary(wsId, '2026-06-01');

    // Same 4-field shape Team surfaces (capped/visibleCount/totalCount/limit only).
    expect((res as any).memberCap).toEqual({
      capped: true,
      visibleCount: 2,
      totalCount: 5,
      limit: 2,
    });
  });

  // ── getSummary: not-capped still carries the status (mirrors Team — always on org) ─
  it('getSummary: surfaces the status even when not capped (capped:false)', async () => {
    teamMemberModel.find.mockReturnValue(
      leanFind([
        { _id: m1, weeklyOff: [] },
        { _id: m2, weeklyOff: [] },
      ]),
    );
    memberCap.getAllowedMemberIds.mockResolvedValue([String(m1), String(m2)]);
    memberCap.getCapStatus.mockResolvedValue({
      capped: false,
      visibleCount: 2,
      totalCount: 2,
      limit: 5,
      inGrace: false,
      graceEndsAt: null,
    });

    const res = await svc.getSummary(wsId, '2026-06-01');

    expect((res as any).memberCap).toEqual({
      capped: false,
      visibleCount: 2,
      totalCount: 2,
      limit: 5,
    });
  });

  // ── findAll: org-scoped + capped → records query restricted to allowed set ─
  it('findAll org-scoped + capped: constrains teamMemberId to the allowed set', async () => {
    const paginateSpy = vi
      .spyOn(QueryHelper, 'paginate')
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, pages: 0 } as any);

    memberCap.getCapStatus.mockResolvedValue({
      capped: true,
      visibleCount: 2,
      totalCount: 5,
      limit: 2,
    });
    memberCap.getAllowedMemberIds.mockResolvedValue([String(m1), String(m2)]);

    await svc.findAll(wsId, userId, {});

    const baseFilter = paginateSpy.mock.calls[0][1] as Record<string, any>;
    expect(baseFilter.teamMemberId.$in.map((o: any) => String(o)).sort()).toEqual(
      [String(m1), String(m2)].sort(),
    );
  });

  // ── findAll: org-scoped + NOT capped → no constraint ─────────────────────
  it('findAll org-scoped + under cap: leaves teamMemberId unconstrained', async () => {
    const paginateSpy = vi
      .spyOn(QueryHelper, 'paginate')
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, pages: 0 } as any);

    memberCap.getCapStatus.mockResolvedValue({
      capped: false,
      visibleCount: 3,
      totalCount: 3,
      limit: 5,
    });

    await svc.findAll(wsId, userId, {});

    const baseFilter = paginateSpy.mock.calls[0][1] as Record<string, any>;
    expect(baseFilter.teamMemberId).toBeUndefined();
    expect(memberCap.getAllowedMemberIds).not.toHaveBeenCalled();
  });

  // ── findAll: self-scoped → cap NEVER consulted; _id is the self anchor ───
  it('findAll self-scoped: never consults the cap', async () => {
    const selfOid = new Types.ObjectId(ownMemberId);
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: ownMemberId });
    callerScope.selfPathFilterValue.mockReturnValue(selfOid);
    const paginateSpy = vi
      .spyOn(QueryHelper, 'paginate')
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, pages: 0 } as any);

    await svc.findAll(wsId, userId, {});

    expect(memberCap.getCapStatus).not.toHaveBeenCalled();
    expect(memberCap.getAllowedMemberIds).not.toHaveBeenCalled();
    const baseFilter = paginateSpy.mock.calls[0][1] as Record<string, any>;
    expect(String(baseFilter.teamMemberId)).toBe(ownMemberId);
  });
});
