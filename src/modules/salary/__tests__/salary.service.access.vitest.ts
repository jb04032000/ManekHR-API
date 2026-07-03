/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SalaryService — the
// transitive schema imports (Salary, Payment, TeamMember, …) would
// otherwise trip vitest's esbuild reflection pipeline. Mirrors the
// `team.service.access.vitest.ts` / `team.service.audit.vitest.ts` pattern
// documented in the backend CLAUDE.md.
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
 * RBAC scope-split coverage — audit `salary-shifts-holidays.md` #1-#4
 * (ADR-001 Tier 1.5, 🔴 critical salary-PII leak).
 *
 * The per-employee salary READ endpoints are decorated
 * `@RequirePermissions(SALARY, VIEW, 'self')`, which RolesGuard admits for
 * BOTH `self`- and `all`-scoped callers. `SalaryService.assertSalarySelfReadAllowed`
 * closes the gap the decorator alone cannot: a `self`-scoped caller may
 * only read their OWN linked team member's salary data.
 *
 * We assert at the service-layer boundary via `getGratuityLedger` (a thin
 * delegation, so no DB-shape mocking is needed beyond the stubbed
 * `gratuityService`). The guard is shared by every Group A read
 * (`history` / `advances` / `form16` / `tax-declaration` / `fnf` /
 * `increments`), so one method exercises the same code path for all.
 *
 *   - `self`-scoped caller requesting ANOTHER member's data → ForbiddenException.
 *   - `self`-scoped caller requesting their OWN data        → allowed (delegates).
 *   - `self`-scoped caller with no team-directory row       → ForbiddenException.
 *   - `all`-scoped caller (manager) requesting any member   → allowed (unchanged).
 *   - owner requesting any member                           → allowed (unchanged).
 */
describe('SalaryService — RBAC self-scope read enforcement (audit #1-#4)', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const callerUserId = new Types.ObjectId().toHexString();
  const ownTeamMemberId = new Types.ObjectId().toHexString();
  const otherTeamMemberId = new Types.ObjectId().toHexString();

  let gratuityService: { getGratuityLedger: ReturnType<typeof vi.fn> };
  let callerScope: {
    resolve: ReturnType<typeof vi.fn>;
    effectiveScope: ReturnType<typeof vi.fn>;
    selfFilterValue: ReturnType<typeof vi.fn>;
  };
  let svc: SalaryService;

  // Build a SalaryService with every dependency mocked. Only `gratuityService`
  // and `callerScope` carry behaviour for these tests; the rest are inert
  // stubs — `getGratuityLedger` never touches them.
  function buildService(): SalaryService {
    const noopModel = () => ({
      find: vi.fn(),
      findOne: vi.fn(),
      findById: vi.fn(),
    });
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
      gratuityService as any, // gratuityService
      {} as any, // fnfService
      {} as any, // attendancePoliciesService
      {} as any, // teamService
      callerScope as any, // callerScope — the unit under test
      { capture: vi.fn(), identify: vi.fn() } as any, // postHog
    );
  }

  beforeEach(() => {
    gratuityService = {
      getGratuityLedger: vi.fn().mockResolvedValue({ stub: 'ledger' }),
    };
    callerScope = {
      resolve: vi.fn(),
      effectiveScope: vi.fn(),
      selfFilterValue: vi.fn(),
    };
    svc = buildService();
  });

  it('self-scoped caller requesting ANOTHER member’s gratuity → ForbiddenException', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownTeamMemberId,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('self');

    await expect(
      svc.getGratuityLedger(workspaceId, otherTeamMemberId, callerUserId),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The delegation must NOT run — the caller never reaches the data layer.
    expect(gratuityService.getGratuityLedger).not.toHaveBeenCalled();
    expect(callerScope.effectiveScope).toHaveBeenCalledWith(expect.anything(), 'salary', 'view');
  });

  it('self-scoped caller requesting their OWN gratuity → allowed (delegates)', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownTeamMemberId,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('self');

    const result = await svc.getGratuityLedger(workspaceId, ownTeamMemberId, callerUserId);

    expect(result).toEqual({ stub: 'ledger' });
    expect(gratuityService.getGratuityLedger).toHaveBeenCalledWith(workspaceId, ownTeamMemberId);
  });

  it('self-scoped caller with no team-directory row → ForbiddenException', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: null,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('self');

    await expect(
      svc.getGratuityLedger(workspaceId, ownTeamMemberId, callerUserId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gratuityService.getGratuityLedger).not.toHaveBeenCalled();
  });

  it('all-scoped caller (manager) requesting ANY member → allowed (unchanged)', async () => {
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownTeamMemberId,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('all');

    const result = await svc.getGratuityLedger(workspaceId, otherTeamMemberId, callerUserId);

    expect(result).toEqual({ stub: 'ledger' });
    expect(gratuityService.getGratuityLedger).toHaveBeenCalledWith(workspaceId, otherTeamMemberId);
  });

  it('owner requesting ANY member → allowed (unchanged)', async () => {
    // Owners short-circuit inside CallerScopeService.effectiveScope → 'all'.
    callerScope.resolve.mockResolvedValue({
      isOwner: true,
      teamMemberId: null,
      permissions: [],
    });
    callerScope.effectiveScope.mockReturnValue('all');

    const result = await svc.getGratuityLedger(workspaceId, otherTeamMemberId, callerUserId);

    expect(result).toEqual({ stub: 'ledger' });
    expect(gratuityService.getGratuityLedger).toHaveBeenCalledWith(workspaceId, otherTeamMemberId);
  });
});
