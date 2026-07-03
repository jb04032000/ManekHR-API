/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SalaryService - mirrors
// the documented backend pattern (see salary.service.access.vitest.ts).
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

/**
 * Unit coverage for countUpcomingJoiners - the helper that powers the
 * "upcoming joiners" hint on the Run Payroll page. We mock teamModel.aggregate
 * and assert (a) the $match targets members joining AFTER the viewed month and
 * (b) the count + earliest joining month/year are mapped correctly, including
 * the empty (no upcoming joiners) path.
 */
describe('SalaryService.countUpcomingJoiners', () => {
  const workspaceId = new Types.ObjectId().toHexString();

  function buildService(aggregateImpl: (pipeline: any) => any): {
    svc: SalaryService;
    aggregate: ReturnType<typeof vi.fn>;
  } {
    const noopModel = () => ({ find: vi.fn(), findOne: vi.fn(), findById: vi.fn() });
    const aggregate = vi.fn((pipeline: any) => ({
      exec: () => Promise.resolve(aggregateImpl(pipeline)),
    }));
    const teamModel = { ...noopModel(), aggregate } as any;
    const svc = new SalaryService(
      noopModel() as any, // salaryModel
      noopModel() as any, // paymentModel
      teamModel, // teamModel - under test
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
      {} as any, // callerScope
      { capture: vi.fn(), identify: vi.fn() } as any, // postHog
    );
    return { svc, aggregate };
  }

  it('maps count and earliest joining month/year, and filters on dateOfJoining > month end', async () => {
    // Viewing May 2026; earliest upcoming joiner starts 15 Jun 2026.
    const { svc, aggregate } = buildService(() => [
      { _id: null, count: 2, nextJoining: new Date(2026, 5, 15) },
    ]);

    const result = await (svc as any).countUpcomingJoiners(workspaceId, 5, 2026);

    expect(result).toEqual({ count: 2, nextJoinerMonth: 6, nextJoinerYear: 2026 });

    const pipeline = aggregate.mock.calls[0][0];
    const match = pipeline[0].$match;
    expect(match.isActive).toBe(true);
    expect(match.dateOfJoining.$gt).toBeInstanceOf(Date);
    // Month end for May 2026 is the 31st.
    expect(match.dateOfJoining.$gt.getMonth()).toBe(4); // 0-indexed May
    expect(match.dateOfJoining.$gt.getDate()).toBe(31);
    // Guards the resignation clause so it cannot be dropped silently.
    expect(match.$or).toHaveLength(3);
    expect(match.$or[2].dateOfResignation.$gte).toBeInstanceOf(Date);
  });

  it('returns zero / null when there are no upcoming joiners', async () => {
    const { svc } = buildService(() => []);

    const result = await (svc as any).countUpcomingJoiners(workspaceId, 5, 2026);

    expect(result).toEqual({ count: 0, nextJoinerMonth: null, nextJoinerYear: null });
  });
});
