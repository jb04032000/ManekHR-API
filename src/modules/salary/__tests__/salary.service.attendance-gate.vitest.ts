/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the services — the
// transitive schema imports would otherwise trip vitest's esbuild reflection
// pipeline. Mirrors the documented pattern in the backend CLAUDE.md and the
// sibling salary.service.access.vitest.ts spec.
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
import { SalaryAbsenceLossService } from '../salary-absence-loss.service';
import { AppModule } from '../../../common/enums/modules.enum';

/**
 * Salary-standalone safeguard (2026-06-20) — ATTENDANCE-off gate coverage.
 *
 * Verifies the #1 standalone risk is closed: with ATTENDANCE switched OFF (no
 * subscription entitlement) salary must route through the fixed/calendar-day
 * branch and NEVER through the attendance query — so an empty/absent Attendance
 * collection can never zero out pay.
 *
 * We exercise the gate at three seams:
 *   1. resolveSalaryCalculationContext — attendanceModuleEnabled=false forces
 *      attendancePayModeApplied='disabled' even when features.attendanceBasedPay
 *      is true (the latent defect).
 *   2. resolveAttendanceModuleEnabled — single hasModule lookup per workspace
 *      (memoized), and fail-safe OFF when the service is missing or throws.
 *   3. SalaryAbsenceLossService.processExpiredAbsences — skips (processed:0) and
 *      never touches Attendance when ATTENDANCE is off.
 */

// A minimal monthly member: fixed 26-day basis, attendance-based-pay desired.
function buildMember() {
  return {
    _id: new Types.ObjectId(),
    salaryType: 'monthly',
    salaryAmount: 26000,
    salaryDayBasis: 'fixed_month_days',
    fixedMonthDays: 26,
    attendancePayMode: 'enabled', // member WANTS attendance pay
    dateOfJoining: undefined,
    dateOfResignation: undefined,
  } as any;
}

// PayrollConfig with attendanceBasedPay ON — the flag that, pre-fix, would have
// driven the attendance branch regardless of the module subscription.
const configAttendanceFlagOn = {
  features: { attendanceBasedPay: true },
  display: { defaultWorkingDays: 26 },
  rules: { attendancePayModeDefault: 'enabled' },
} as any;

function buildSalaryService(hasModule?: ReturnType<typeof vi.fn>): SalaryService {
  const noopModel = () => ({ find: vi.fn(), findOne: vi.fn(), findById: vi.fn() });
  const subscriptionsService = hasModule ? ({ hasModule } as any) : undefined;
  // Positional construction: fill every dep up to writeGuard with inert stubs,
  // then append the new optional subscriptionsService LAST.
  return new SalaryService(
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
    {} as any, // callerScope
    { capture: vi.fn(), identify: vi.fn() } as any, // postHog
    {} as any, // complianceGuard
    noopModel() as any, // employerLoanModel
    {} as any, // salaryDisbursementGuardService
    {} as any, // salaryLedgerPostingService
    {} as any, // advanceSalaryRequestService
    noopModel() as any, // advanceSalaryRequestModel
    {} as any, // writeGuard
    subscriptionsService, // subscriptionsService (new, LAST)
  );
}

describe('SalaryService — ATTENDANCE-off pay gate (standalone safeguard)', () => {
  const workspaceId = new Types.ObjectId().toHexString();

  it('forces disabled pay mode when ATTENDANCE module is OFF even if attendanceBasedPay flag is on', () => {
    const svc = buildSalaryService();
    const ctx = (svc as any).resolveSalaryCalculationContext(
      buildMember(),
      6,
      2026,
      configAttendanceFlagOn,
      false, // attendanceModuleEnabled = OFF
    );
    // The defect this closes: flag on + module off must NOT keep 'enabled'.
    expect(ctx.attendancePayModeApplied).toBe('disabled');
    // Fixed-day basis is intact so the fixed-day math (perDay × basisDays) runs.
    expect(ctx.basisDays).toBe(26);
  });

  it('keeps enabled pay mode when ATTENDANCE module is ON and attendanceBasedPay flag is on', () => {
    const svc = buildSalaryService();
    const ctx = (svc as any).resolveSalaryCalculationContext(
      buildMember(),
      6,
      2026,
      configAttendanceFlagOn,
      true, // attendanceModuleEnabled = ON
    );
    expect(ctx.attendancePayModeApplied).toBe('enabled');
  });

  it('resolveAttendanceModuleEnabled calls hasModule ONCE per workspace (memoized) and returns its value', async () => {
    const hasModule = vi.fn().mockResolvedValue(true);
    const svc = buildSalaryService(hasModule);

    const a = await (svc as any).resolveAttendanceModuleEnabled(workspaceId);
    const b = await (svc as any).resolveAttendanceModuleEnabled(workspaceId);
    const c = await (svc as any).resolveAttendanceModuleEnabled(workspaceId);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(c).toBe(true);
    // One DB-backed lookup for the whole run, not one per member.
    expect(hasModule).toHaveBeenCalledTimes(1);
    expect(hasModule).toHaveBeenCalledWith(workspaceId, AppModule.ATTENDANCE);
  });

  it('fail-safes to OFF when SubscriptionsService is absent', async () => {
    const svc = buildSalaryService(); // no subscriptionsService injected
    const result = await (svc as any).resolveAttendanceModuleEnabled(workspaceId);
    expect(result).toBe(false);
  });

  it('fail-safes to OFF when hasModule throws', async () => {
    const hasModule = vi.fn().mockRejectedValue(new Error('db down'));
    const svc = buildSalaryService(hasModule);
    const result = await (svc as any).resolveAttendanceModuleEnabled(workspaceId);
    expect(result).toBe(false);
  });
});

describe('SalaryAbsenceLossService — ATTENDANCE-off cron guard (standalone safeguard)', () => {
  const workspaceId = new Types.ObjectId().toHexString();

  let attendanceModel: { find: ReturnType<typeof vi.fn> };
  let payrollConfigModel: { findOne: ReturnType<typeof vi.fn> };

  function buildLossService(hasModule?: ReturnType<typeof vi.fn>): SalaryAbsenceLossService {
    const subscriptionsService = hasModule ? ({ hasModule } as any) : undefined;
    return new SalaryAbsenceLossService(
      payrollConfigModel as any, // payrollConfigModel
      attendanceModel as any, // attendanceModel
      { findOne: vi.fn() } as any, // regularizationRequestModel
      { findOne: vi.fn() } as any, // salaryModel
      { findOne: vi.fn() } as any, // salaryAdjustmentModel
      { findById: vi.fn() } as any, // teamMemberModel
      subscriptionsService, // subscriptionsService (new, LAST)
    );
  }

  beforeEach(() => {
    // salaryLossEnabled defaults to true (loss otherwise active), so the
    // ATTENDANCE gate is the only thing that can skip the run.
    payrollConfigModel = {
      findOne: vi.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve({ salaryLossConfig: { salaryLossEnabled: true } }) }),
      }),
    };
    attendanceModel = {
      find: vi.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
    };
  });

  it('skips (processed:0) and never reads Attendance when ATTENDANCE module is OFF', async () => {
    const hasModule = vi.fn().mockResolvedValue(false);
    const svc = buildLossService(hasModule);

    const result = await svc.processExpiredAbsences(workspaceId);

    expect(result).toEqual({ processed: 0 });
    expect(hasModule).toHaveBeenCalledWith(workspaceId, AppModule.ATTENDANCE);
    // Critical: no absence_recovery deductions posted off stale/empty attendance.
    expect(attendanceModel.find).not.toHaveBeenCalled();
  });

  it('skips when SubscriptionsService is absent (fail-safe OFF)', async () => {
    const svc = buildLossService(); // no service
    const result = await svc.processExpiredAbsences(workspaceId);
    expect(result).toEqual({ processed: 0 });
    expect(attendanceModel.find).not.toHaveBeenCalled();
  });

  it('proceeds to read Attendance when ATTENDANCE module is ON', async () => {
    const hasModule = vi.fn().mockResolvedValue(true);
    const svc = buildLossService(hasModule);

    const result = await svc.processExpiredAbsences(workspaceId);

    // No absent rows → processed:0, but it DID query attendance (gate passed).
    expect(result).toEqual({ processed: 0 });
    expect(attendanceModel.find).toHaveBeenCalledTimes(1);
  });
});
