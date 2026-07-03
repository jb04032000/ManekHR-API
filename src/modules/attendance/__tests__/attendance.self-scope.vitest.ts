/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AttendanceService so
// transitive schema imports don't trip vitest's esbuild metadata reflection
// (same technique as attendance.service.critical.vitest.ts).
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
import { ForbiddenException } from '@nestjs/common';
import { AttendanceService } from '../attendance.service';
import {
  CallerScopeService,
  type CallerScopeContext,
} from '../../../common/services/caller-scope.service';
import { QueryHelper } from '../../../common/helpers/query.helper';

/**
 * G2 (2026-05-24) — self/all scope resolution migrated from the FLAT grant
 * store to the PATH store the RolesGuard actually enforces on.
 *
 * Regression pinned here: a path-only (override) `self` grant — present in
 * `permissionPaths` but ABSENT from the flat `permissions` array — must narrow
 * reads to the caller's own rows and block writes against other members.
 *
 * Under the pre-G2 flat resolution (`effectiveScope` / `selfFilterValue`) such
 * a grant resolved to `null` (the flat array is empty), so the GET /attendance
 * query silently WIDENED to every row and the self-write guard did NOT fire.
 * The path twins (`effectivePathScope` / `selfPathFilterValue`) read the same
 * store the guard admitted on, closing the gap. A real CallerScopeService is
 * used (only `resolve` is stubbed) so the genuine path-resolution logic runs.
 */
describe('AttendanceService — G2 path-scope self-narrowing', () => {
  const wsId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();
  const ownMemberId = new Types.ObjectId().toHexString();
  const otherMemberId = new Types.ObjectId().toHexString();

  let callerScope: CallerScopeService;
  let svc: AttendanceService;

  // Path-only self grant: in permissionPaths, NOT in the flat permissions
  // array — exactly the shape the flat resolver mis-read as `null` (→ widen).
  const pathOnlySelfCtx = (path: string): CallerScopeContext => ({
    isOwner: false,
    teamMemberId: ownMemberId,
    permissions: [],
    permissionPaths: [{ path, scope: 'self' as const }],
  });

  beforeEach(() => {
    callerScope = new CallerScopeService({} as never);

    const noopModel: any = {};
    const eventService: any = {
      createEvent: vi.fn(),
      voidAllByPunchTypeForMemberDay: vi.fn(),
      bulkInsertEvents: vi.fn(),
    };
    const projectionService: any = { recompute: vi.fn() };
    // Attendance hardening: write-guard stub. These tests exercise the self-scope
    // narrowing (assertSelfWriteAllowed), which runs BEFORE the write guard, so a
    // permissive stub keeps the existing assertions intact.
    const writeGuard: any = {
      assertMemberWritable: vi.fn().mockResolvedValue(undefined),
      assertNotSelfAttendanceEdit: vi.fn().mockResolvedValue(undefined),
    };
    const auditService: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const postHog: any = { capture: vi.fn(), identify: vi.fn() };
    const redisStub: any = {
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn(),
      del: vi.fn(),
    };

    svc = new AttendanceService(
      noopModel, // attendanceModel
      noopModel, // teamMemberModel
      noopModel, // salaryModel
      eventService,
      projectionService,
      writeGuard,
      auditService,
      postHog,
      callerScope,
      redisStub,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Read narrowing (GET /attendance → findAll) ──────────────────────────

  it('findAll: a path-only self grant narrows the query to the caller own member row', async () => {
    vi.spyOn(callerScope, 'resolve').mockResolvedValue(pathOnlySelfCtx('attendance.record.view'));
    const paginateSpy = vi
      .spyOn(QueryHelper, 'paginate')
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, totalPages: 0 } as any);

    await svc.findAll(wsId, userId, {});

    expect(paginateSpy).toHaveBeenCalledTimes(1);
    const baseFilter = paginateSpy.mock.calls[0][1] as Record<string, any>;
    expect(baseFilter.teamMemberId).toBeInstanceOf(Types.ObjectId);
    expect(String(baseFilter.teamMemberId)).toBe(ownMemberId);
  });

  it('findAll: an all-scoped path grant applies no self narrowing', async () => {
    vi.spyOn(callerScope, 'resolve').mockResolvedValue({
      isOwner: false,
      teamMemberId: ownMemberId,
      permissions: [],
      permissionPaths: [{ path: 'attendance.record.view', scope: 'all' as const }],
    });
    const paginateSpy = vi
      .spyOn(QueryHelper, 'paginate')
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, totalPages: 0 } as any);

    await svc.findAll(wsId, userId, {});

    const baseFilter = paginateSpy.mock.calls[0][1] as Record<string, any>;
    expect(baseFilter.teamMemberId).toBeUndefined();
  });

  // ── Write guard (mark → assertSelfWriteAllowed) ─────────────────────────

  it('mark: a path-only self grant blocks marking another member', async () => {
    vi.spyOn(callerScope, 'resolve').mockResolvedValue(pathOnlySelfCtx('attendance.record.mark'));
    const pathScopeSpy = vi.spyOn(callerScope, 'effectivePathScope');

    await expect(
      svc.mark(wsId, userId, {
        teamMemberId: otherMemberId,
        date: '2026-05-11',
        status: 'Present',
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Wiring proof: scope was resolved from the PATH store, not the flat one.
    expect(pathScopeSpy).toHaveBeenCalledWith(expect.anything(), 'attendance.record.mark');
  });
});
