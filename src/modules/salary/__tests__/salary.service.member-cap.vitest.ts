/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SalaryService (mirrors
// salary.service.access.vitest.ts).
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
import { SalaryService } from '../salary.service';
import { SALARY_INTERNAL_UNFILTERED } from '../salary-read-filter';

/**
 * Phase 6 (member-cap read filter) — the ORG-scoped salary reports respect the
 * allowed-member set:
 *  - getSalaryRecords adds `teamMemberId: { $in: allowedIds }` to its `.find()`
 *    when the cap is biting,
 *  - getSalaryRecordsPaginated injects the allowed set into the aggregation's
 *    opening `$match` (teamMatch),
 *  - the internal/compliance caller (SALARY_INTERNAL_UNFILTERED) is NEVER capped
 *    (statutory exports must see the whole roster).
 */
describe('SalaryService — member-cap read filter', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();
  const a1 = new Types.ObjectId();
  const a2 = new Types.ObjectId();

  let salaryModel: any;
  let teamModel: any;
  let paymentModel: any;
  let salaryAdjustmentModel: any;
  let payrollConfigModel: any;
  let callerScope: { resolve: ReturnType<typeof vi.fn>; effectiveScope: ReturnType<typeof vi.fn> };
  let memberCap: {
    getCapStatus: ReturnType<typeof vi.fn>;
    getAllowedMemberIds: ReturnType<typeof vi.fn>;
  };

  /** A `.find(filter).populate().exec()` chain that records the filter. */
  function recordingFind(captured: { filter?: any }) {
    return (filter: any) => {
      captured.filter = filter;
      const chain: any = { populate: () => chain, exec: async () => [] };
      return chain;
    };
  }

  function buildService(): SalaryService {
    const noop = () => ({ find: vi.fn(), findOne: vi.fn(), findById: vi.fn(), aggregate: vi.fn() });
    return new SalaryService(
      salaryModel as any, // 1 salaryModel
      paymentModel as any, // 2 paymentModel
      teamModel as any, // 3 teamModel
      noop() as any, // 4 attendanceModel
      noop() as any, // 5 incrementModel
      salaryAdjustmentModel as any, // 6 salaryAdjustmentModel
      payrollConfigModel as any, // 7 payrollConfigModel
      noop() as any, // 8 ptSlabConfigModel
      noop() as any, // 9 componentTemplateModel
      noop() as any, // 10 workspaceModel
      noop() as any, // 11 subscriptionModel
      noop() as any, // 12 bulkEmailJobModel
      noop() as any, // 13 userModel
      noop() as any, // 14 shiftModel
      noop() as any, // 15 leaveRequestModel
      noop() as any, // 16 leaveTypeModel
      noop() as any, // 17 productionLogModel
      noop() as any, // 18 machineModel
      noop() as any, // 19 pieceRateConfigAuditModel
      noop() as any, // 20 advanceRecoveryPlanModel
      {} as any, // 21 auditService
      {} as any, // 22 mailService
      {} as any, // 23 payslipPdfService
      {} as any, // 24 complianceExportService
      {} as any, // 25 tdsService
      {} as any, // 26 gratuityService
      {} as any, // 27 fnfService
      {} as any, // 28 attendancePoliciesService
      {} as any, // 29 teamService
      callerScope as any, // 30 callerScope
      { capture: vi.fn(), identify: vi.fn() } as any, // 31 postHog
      {} as any, // 32 complianceGuard
      noop() as any, // 33 employerLoanModel
      {} as any, // 34 salaryDisbursementGuardService
      {} as any, // 35 salaryLedgerPostingService
      {} as any, // 36 advanceSalaryRequestService
      noop() as any, // 37 advanceSalaryRequestModel
      undefined as any, // 38 writeGuard
      memberCap as any, // 39 Phase 6 — appended LAST
    );
  }

  beforeEach(() => {
    paymentModel = { aggregate: vi.fn().mockResolvedValue([]) };
    salaryAdjustmentModel = { aggregate: vi.fn().mockResolvedValue([]) };
    payrollConfigModel = {};
    callerScope = {
      // resolveSalarySensitiveCtx → owner (no PII strip), keeps the test focused
      // on the cap filter rather than the sensitive-field stripping.
      resolve: vi.fn().mockResolvedValue({ isOwner: true, teamMemberId: null }),
      effectiveScope: vi.fn().mockReturnValue('all'),
    };
    memberCap = {
      getCapStatus: vi.fn(),
      getAllowedMemberIds: vi.fn(),
    };
  });

  // ── getSalaryRecords: capped → find filter carries teamMemberId $in ──────
  it('getSalaryRecords (real caller, capped): adds teamMemberId { $in: allowed } to the find', async () => {
    const captured: { filter?: any } = {};
    salaryModel = { find: vi.fn(recordingFind(captured)) };
    teamModel = { aggregate: vi.fn() };
    memberCap.getCapStatus.mockResolvedValue({
      capped: true,
      visibleCount: 2,
      totalCount: 5,
      limit: 2,
    });
    memberCap.getAllowedMemberIds.mockResolvedValue([String(a1), String(a2)]);

    const svc = buildService();
    await svc.getSalaryRecords(workspaceId, 6, 2026, userId);

    expect(captured.filter.teamMemberId.$in.map((o: any) => String(o)).sort()).toEqual(
      [String(a1), String(a2)].sort(),
    );
  });

  // ── getSalaryRecords: NOT capped → no teamMemberId filter ────────────────
  it('getSalaryRecords (real caller, under cap): no teamMemberId filter', async () => {
    const captured: { filter?: any } = {};
    salaryModel = { find: vi.fn(recordingFind(captured)) };
    teamModel = { aggregate: vi.fn() };
    memberCap.getCapStatus.mockResolvedValue({
      capped: false,
      visibleCount: 3,
      totalCount: 3,
      limit: 5,
    });

    const svc = buildService();
    await svc.getSalaryRecords(workspaceId, 6, 2026, userId);

    expect(captured.filter.teamMemberId).toBeUndefined();
    expect(memberCap.getAllowedMemberIds).not.toHaveBeenCalled();
  });

  // ── getSalaryRecords: INTERNAL/compliance caller → NEVER capped ──────────
  it('getSalaryRecords (SALARY_INTERNAL_UNFILTERED): never consults the cap', async () => {
    const captured: { filter?: any } = {};
    salaryModel = { find: vi.fn(recordingFind(captured)) };
    teamModel = { aggregate: vi.fn() };

    const svc = buildService();
    await svc.getSalaryRecords(workspaceId, 6, 2026, SALARY_INTERNAL_UNFILTERED);

    // Compliance/statutory reads must see the full roster — cap untouched.
    expect(memberCap.getCapStatus).not.toHaveBeenCalled();
    expect(memberCap.getAllowedMemberIds).not.toHaveBeenCalled();
    expect(captured.filter.teamMemberId).toBeUndefined();
  });

  // ── getSalaryRecordsPaginated: capped → opening $match carries the allowed set
  it('getSalaryRecordsPaginated (real caller, capped): injects allowed set into the base $match', async () => {
    // getSalaryRecordsPaginated runs several aggregations on teamModel (the main
    // paginated facet + an upcoming-joiners count). Capture EVERY pipeline so we
    // can pick the base pipeline (its opening `$match` is `teamMatch`, which when
    // capped carries `_id: { $in: allowed }`).
    const captured: { pipelines: any[][] } = { pipelines: [] };
    teamModel = {
      aggregate: vi.fn((pipeline: any[]) => {
        captured.pipelines.push(pipeline);
        return { exec: async () => [{ summary: [], filtered: [], filteredTotal: [] }] };
      }),
    };
    salaryModel = { find: vi.fn(), collection: { name: 'salaries' } };
    paymentModel = { aggregate: vi.fn().mockResolvedValue([]), collection: { name: 'payments' } };
    salaryAdjustmentModel = {
      aggregate: vi.fn().mockResolvedValue([]),
      collection: { name: 'salaryadjustments' },
    };
    // getPayrollConfig reads payrollConfigModel via findOneAndUpdate(...).exec() —
    // stub a minimal resolved config.
    payrollConfigModel = {
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: async () => ({ display: { defaultWorkingDays: 26 } }),
      }),
    };
    memberCap.getCapStatus.mockResolvedValue({
      capped: true,
      visibleCount: 2,
      totalCount: 5,
      limit: 2,
    });
    memberCap.getAllowedMemberIds.mockResolvedValue([String(a1), String(a2)]);

    const svc = buildService();
    await svc.getSalaryRecordsPaginated(workspaceId, 6, 2026, { userId });

    // The base pipeline's opening stage is `{ $match: teamMatch }`. With the cap
    // biting and no explicit teamMemberId filter, teamMatch._id === { $in }.
    // Find the pipeline whose opening $match carries the capped `_id` constraint.
    const baseMatch = captured.pipelines
      .map((p) => p[0]?.$match)
      .find((m) => m && m._id && m._id.$in);
    expect(baseMatch).toBeDefined();
    expect(baseMatch._id.$in.map((o: any) => String(o)).sort()).toEqual(
      [String(a1), String(a2)].sort(),
    );
  });

  // Helper: a paginated-aggregation harness whose teamModel returns an empty
  // facet (we only care about the response wrapper here, not the rows).
  function buildPaginatedHarness() {
    teamModel = {
      aggregate: vi.fn(() => ({
        exec: async () => [{ summary: [], filtered: [], filteredTotal: [] }],
      })),
    };
    salaryModel = { find: vi.fn(), collection: { name: 'salaries' } };
    paymentModel = { aggregate: vi.fn().mockResolvedValue([]), collection: { name: 'payments' } };
    salaryAdjustmentModel = {
      aggregate: vi.fn().mockResolvedValue([]),
      collection: { name: 'salaryadjustments' },
    };
    payrollConfigModel = {
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: async () => ({ display: { defaultWorkingDays: 26 } }),
      }),
    };
  }

  // ── getSalaryRecordsPaginated: capped → response carries the 4-field memberCap ─
  it('getSalaryRecordsPaginated (real caller, capped): attaches the memberCap status (4-field)', async () => {
    buildPaginatedHarness();
    memberCap.getCapStatus.mockResolvedValue({
      capped: true,
      visibleCount: 2,
      totalCount: 5,
      limit: 2,
      inGrace: false,
      graceEndsAt: null,
    });
    memberCap.getAllowedMemberIds.mockResolvedValue([String(a1), String(a2)]);

    const svc = buildService();
    const res: any = await svc.getSalaryRecordsPaginated(workspaceId, 6, 2026, { userId });

    // Same trimmed 4-field shape Team surfaces; existing fields left intact.
    expect(res.memberCap).toEqual({ capped: true, visibleCount: 2, totalCount: 5, limit: 2 });
    expect(res.records).toBeDefined();
    expect(res.pagination).toBeDefined();
    expect(res.summary).toBeDefined();
  });

  // ── getSalaryRecordsPaginated: not capped → status still rides (mirrors Team) ─
  it('getSalaryRecordsPaginated (real caller, under cap): surfaces the status (capped:false)', async () => {
    buildPaginatedHarness();
    memberCap.getCapStatus.mockResolvedValue({
      capped: false,
      visibleCount: 3,
      totalCount: 3,
      limit: 5,
      inGrace: false,
      graceEndsAt: null,
    });

    const svc = buildService();
    const res: any = await svc.getSalaryRecordsPaginated(workspaceId, 6, 2026, { userId });

    expect(res.memberCap).toEqual({ capped: false, visibleCount: 3, totalCount: 3, limit: 5 });
    // Under cap, the allowed-ids query is skipped (only the status read fires).
    expect(memberCap.getAllowedMemberIds).not.toHaveBeenCalled();
  });

  // ── getSalaryRecordsPaginated: INTERNAL/compliance caller → NO memberCap notice
  it('getSalaryRecordsPaginated (SALARY_INTERNAL_UNFILTERED): no memberCap notice + cap never consulted', async () => {
    buildPaginatedHarness();

    const svc = buildService();
    const res: any = await svc.getSalaryRecordsPaginated(workspaceId, 6, 2026, {
      userId: SALARY_INTERNAL_UNFILTERED,
    });

    // Statutory exports see everyone — no "N of TOTAL" notice, cap untouched.
    expect(res.memberCap).toBeUndefined();
    expect(memberCap.getCapStatus).not.toHaveBeenCalled();
    expect(memberCap.getAllowedMemberIds).not.toHaveBeenCalled();
  });
});
