/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Stub @nestjs/mongoose BEFORE importing SalaryService — transitive schema
 * imports would trip vitest's esbuild reflection pipeline. Mirrors the
 * pattern in salary.service.access.vitest.ts.
 */
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
import { SalaryService } from '../salary.service';

/**
 * Unit tests for `SalaryService.getAdvanceBalanceSummary` (Slice 4).
 *
 * Spec reference: phase-1-compliance-and-visibility.md section 4d / OQ-6.
 *
 * Covers:
 * 1. Self-scope enforcement (mirrors getOutstandingAdvances via the shared
 *    `assertSalarySelfReadAllowed` guard): a self-scoped caller requesting
 *    another member's balance must get ForbiddenException.
 * 2. Compact shape mapping: the method returns
 *    { outstanding, totalAdvanced, totalRecovered, planCount, activePlanCount }.
 * 3. All-scoped caller reads any member.
 */
describe('SalaryService.getAdvanceBalanceSummary — Slice 4', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const callerUserId = new Types.ObjectId().toHexString();
  const ownTeamMemberId = new Types.ObjectId().toHexString();
  const otherTeamMemberId = new Types.ObjectId().toHexString();

  let callerScope: {
    resolve: ReturnType<typeof vi.fn>;
    effectiveScope: ReturnType<typeof vi.fn>;
    selfFilterValue: ReturnType<typeof vi.fn>;
  };

  // Fake plan model — countDocuments returns configurable values.
  let advanceRecoveryPlanModel: {
    countDocuments: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };

  // Fake payment model — used by getOutstandingAdvances.
  let paymentModel: {
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };

  let svc: SalaryService;

  function buildService(): SalaryService {
    const noopModel = () => ({
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      }),
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      countDocuments: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(0) }),
    });

    return new SalaryService(
      noopModel() as any, // salaryModel
      paymentModel as any, // paymentModel
      noopModel() as any, // teamModel
      noopModel() as any, // attendanceModel
      noopModel() as any, // incrementModel
      noopModel() as any, // salaryAdjustmentModel
      noopModel() as any, // payrollConfigModel
      noopModel() as any, // ptSlabConfigModel
      noopModel() as any, // componentTemplateModel
      noopModel() as any, // workspaceModel
      noopModel() as any, // subscriptionModel
      noopModel() as any, // bulkEmailJobModel
      noopModel() as any, // userModel
      noopModel() as any, // shiftModel
      noopModel() as any, // leaveRequestModel
      noopModel() as any, // leaveTypeModel
      noopModel() as any, // productionLogModel
      noopModel() as any, // machineModel
      noopModel() as any, // pieceRateConfigAuditModel
      advanceRecoveryPlanModel as any, // advanceRecoveryPlanModel
      {} as any, // auditService
      {} as any, // mailService
      {} as any, // payslipPdfService
      {} as any, // complianceExportService
      {} as any, // tdsService
      {} as any, // gratuityService
      {} as any, // fnfService
      {} as any, // attendancePoliciesService
      {} as any, // teamService
      callerScope as any, // callerScope
      { capture: vi.fn(), identify: vi.fn() } as any, // postHog
      {} as any, // complianceGuard
    );
  }

  beforeEach(() => {
    callerScope = {
      resolve: vi.fn(),
      effectiveScope: vi.fn(),
      selfFilterValue: vi.fn(),
    };

    // Payment model returns an empty advances list (no advance payments for
    // this workspace member). This drives getOutstandingAdvances to return
    // totalAdvanced=0, totalRecovered=0, outstanding=0.
    paymentModel = {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      }),
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    };

    // Plan model: default 2 total, 1 active.
    advanceRecoveryPlanModel = {
      find: vi.fn(),
      findOne: vi.fn(),
      findById: vi.fn(),
      countDocuments: vi.fn().mockImplementation((query: any) => {
        const count = query?.status === 'active' ? 1 : 2;
        return { exec: vi.fn().mockResolvedValue(count) };
      }),
    };

    svc = buildService();
  });

  it('self-scoped caller requesting ANOTHER member balance → ForbiddenException', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownTeamMemberId,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('self');

    await expect(
      svc.getAdvanceBalanceSummary(workspaceId, otherTeamMemberId, callerUserId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('self-scoped caller requesting OWN balance → returns compact shape', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownTeamMemberId,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('self');

    const result = await svc.getAdvanceBalanceSummary(workspaceId, ownTeamMemberId, callerUserId);

    expect(result).toMatchObject({
      outstanding: 0,
      totalAdvanced: 0,
      totalRecovered: 0,
      planCount: 2,
      activePlanCount: 1,
    });
  });

  it('all-scoped caller reading another member balance → allowed, returns shape', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownTeamMemberId,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('all');

    const result = await svc.getAdvanceBalanceSummary(workspaceId, otherTeamMemberId, callerUserId);

    expect(result).toMatchObject({
      outstanding: 0,
      totalAdvanced: 0,
      totalRecovered: 0,
      planCount: 2,
      activePlanCount: 1,
    });
    // planCount and activePlanCount must always be numbers.
    expect(typeof result.planCount).toBe('number');
    expect(typeof result.activePlanCount).toBe('number');
  });

  it('owner reading any member balance → allowed', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: true,
      teamMemberId: null,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('all');

    const result = await svc.getAdvanceBalanceSummary(workspaceId, otherTeamMemberId, callerUserId);

    expect(result.outstanding).toBe(0);
    expect(result.planCount).toBe(2);
    expect(result.activePlanCount).toBe(1);
  });

  it('self-scoped caller with no team-directory row → ForbiddenException', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: null,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('self');

    await expect(
      svc.getAdvanceBalanceSummary(workspaceId, ownTeamMemberId, callerUserId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
