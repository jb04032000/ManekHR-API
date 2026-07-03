/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SalaryService - the
// transitive schema imports (Salary, Payment, TeamMember, ...) would
// otherwise trip vitest's esbuild reflection pipeline. Mirrors the
// salary.service.access.vitest.ts pattern.
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

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SalaryService } from '../salary.service';

/**
 * Access Control Initiative - Salary A2 (2026-05-29).
 * Unit tests for SalaryService.getOwnPayslipDownload, the self-scoped
 * single-payslip bundle endpoint. Mirrors salary.service.access.vitest.ts
 * harness construction pattern.
 */

const WS = '64b2f00000000000000000aa';
const USER = 'user-1';
// Must be a valid 24-hex ObjectId so Fix 2's format guard does not interfere.
const SALARY_ID = '64b2f00000000000000000cc';

type CallerScopeMock = {
  resolve: ReturnType<typeof vi.fn>;
  effectiveScope: ReturnType<typeof vi.fn>;
  selfFilterValue: ReturnType<typeof vi.fn>;
};

function makeService(): { service: SalaryService; callerScope: CallerScopeMock } {
  const noopModel = () => ({
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
  });

  const callerScope: CallerScopeMock = {
    resolve: vi.fn(),
    effectiveScope: vi.fn(),
    selfFilterValue: vi.fn(),
  };

  const service = new SalaryService(
    noopModel() as any, // salaryModel
    noopModel() as any, // paymentModel
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
    noopModel() as any, // advanceRecoveryPlanModel
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
  );

  return { service, callerScope };
}

describe('SalaryService.getOwnPayslipDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the own-record bundle with currencyConfig when self caller reads own data (populated shape)', async () => {
    const { service, callerScope } = makeService();
    callerScope.effectiveScope.mockReturnValue('self');
    // resolve returns the real populated-object shape for teamMemberId
    callerScope.resolve.mockResolvedValue({ teamMemberId: 'tm1', isOwner: false });
    vi.spyOn(service, 'getPayslipData').mockResolvedValue([
      {
        record: { teamMemberId: { _id: 'tm1', name: 'Worker One' } },
        adjustments: [],
        payments: [],
        componentTemplate: null,
        workspaceName: 'Acme',
        branding: {},
      },
    ] as any);
    vi.spyOn(service, 'getPayrollConfig').mockResolvedValue({
      display: { currencySymbol: 'Rs', currencyLocale: 'en-IN', currencyCode: 'INR' },
    } as any);

    const out = await service.getOwnPayslipDownload(WS, 'tm1', SALARY_ID, USER);

    expect(out.workspaceName).toBe('Acme');
    expect(out.currencyConfig).toEqual({ symbol: 'Rs', locale: 'en-IN', code: 'INR' });
  });

  it('throws Forbidden when the salaryId belongs to another member (populated shape)', async () => {
    const { service, callerScope } = makeService();
    callerScope.effectiveScope.mockReturnValue('self');
    callerScope.resolve.mockResolvedValue({ teamMemberId: 'tm1', isOwner: false });
    vi.spyOn(service, 'getPayslipData').mockResolvedValue([
      {
        record: { teamMemberId: { _id: 'tm2' } },
        adjustments: [],
        payments: [],
        componentTemplate: null,
        workspaceName: 'Acme',
        branding: {},
      },
    ] as any);
    vi.spyOn(service, 'getPayrollConfig').mockResolvedValue({ display: {} } as any);

    await expect(service.getOwnPayslipDownload(WS, 'tm1', SALARY_ID, USER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws Forbidden when a self caller passes another members teamMemberId', async () => {
    const { service, callerScope } = makeService();
    callerScope.effectiveScope.mockReturnValue('self');
    callerScope.resolve.mockResolvedValue({ teamMemberId: 'tm1', isOwner: false });

    await expect(service.getOwnPayslipDownload(WS, 'tm2', SALARY_ID, USER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws NotFound when no payslip data exists for the salaryId', async () => {
    const { service, callerScope } = makeService();
    callerScope.effectiveScope.mockReturnValue('self');
    callerScope.resolve.mockResolvedValue({ teamMemberId: 'tm1', isOwner: false });
    vi.spyOn(service, 'getPayslipData').mockResolvedValue([]);
    vi.spyOn(service, 'getPayrollConfig').mockResolvedValue({ display: {} } as any);

    await expect(service.getOwnPayslipDownload(WS, 'tm1', SALARY_ID, USER)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFound before getPayslipData when salaryId is not a valid ObjectId', async () => {
    const { service, callerScope } = makeService();
    callerScope.effectiveScope.mockReturnValue('self');
    callerScope.resolve.mockResolvedValue({ teamMemberId: 'tm1', isOwner: false });
    // getPayslipData must NOT be called; do NOT spy/mock it here so any call
    // would return undefined and surface a hard error if the guard is missing.

    await expect(
      service.getOwnPayslipDownload(WS, 'tm1', 'not-a-valid-objectid', USER),
    ).rejects.toThrow(NotFoundException);
  });
});
