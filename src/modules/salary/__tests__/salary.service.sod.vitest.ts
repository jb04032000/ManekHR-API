/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SalaryService — the
// transitive schema imports would otherwise trip vitest's esbuild reflection
// pipeline. Mirrors the salary.service.access.vitest.ts pattern.
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

import { ForbiddenException } from '@nestjs/common';
import { SalaryService } from '../salary.service';

/**
 * Salary A3 — Separation-of-Duties guard
 *
 * SalaryService.assertNotSelfSalaryEdit blocks any non-owner from editing
 * their OWN salary record. Owners bypass unconditionally.
 */

function makeService() {
  const noopModel = () => ({
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
  });

  const callerScope = {
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

describe('SalaryService.assertNotSelfSalaryEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks a non-owner editing their own salary', async () => {
    const { service, callerScope } = makeService();
    callerScope.resolve.mockResolvedValue({ teamMemberId: 'tm1', isOwner: false });
    // call via bracket access since the method is private
    await expect((service as any).assertNotSelfSalaryEdit('ws', 'user', 'tm1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows a non-owner editing another member', async () => {
    const { service, callerScope } = makeService();
    callerScope.resolve.mockResolvedValue({ teamMemberId: 'tm1', isOwner: false });
    await expect(
      (service as any).assertNotSelfSalaryEdit('ws', 'user', 'tm2'),
    ).resolves.toBeUndefined();
  });

  it('allows the owner editing their own salary (owner bypass)', async () => {
    const { service, callerScope } = makeService();
    callerScope.resolve.mockResolvedValue({ teamMemberId: 'tm1', isOwner: true });
    await expect(
      (service as any).assertNotSelfSalaryEdit('ws', 'user', 'tm1'),
    ).resolves.toBeUndefined();
  });
});
