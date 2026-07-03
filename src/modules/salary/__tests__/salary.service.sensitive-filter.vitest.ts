/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SalaryService - the
// transitive schema imports (Salary, Payment, TeamMember, ...) would
// otherwise trip vitest's esbuild reflection pipeline. Mirrors the
// salary.service.access.vitest.ts pattern documented in the backend CLAUDE.md.
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

import { SalaryService } from '../salary.service';
import { stripSalarySensitiveFields, SALARY_INTERNAL_UNFILTERED } from '../salary-read-filter';

/**
 * Salary A3 - Sensitive-field read filter integration tests (2026-05-30).
 *
 * Strategy: test `resolveSalarySensitiveCtx` composed with
 * `stripSalarySensitiveFields` on representative member sub-objects by
 * mocking `callerScope.resolve` + `callerScope.effectiveScope`. This
 * validates the full filter decision logic without needing DB fixtures.
 *
 * Cases:
 *   (a) Manager (no sensitive_view) on another member's row -> bank/PAN stripped.
 *   (b) Manager WITH effective salary.sensitive_view -> fields retained.
 *   (c) isOwner=true -> fields retained.
 *   (d) Manager on their OWN record (ownTeamMemberId === row member id) -> retained.
 *   (e) SALARY_INTERNAL_UNFILTERED sentinel -> all fields retained, callerScope.resolve NOT called.
 */

const WS = '64b2f00000000000000000aa';
const USER = 'user-manager-1';

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

/** Build a representative member sub-object with all sensitive fields populated. */
function makeMemberSubObject(id: string): Record<string, unknown> {
  return {
    _id: id,
    name: 'Test Worker',
    designation: 'Karigar',
    bankDetails: { accountNumber: '000111222333', ifscCode: 'HDFC0001234', bankName: 'HDFC' },
    upiDetails: { upiId: 'worker@upi' },
    preferredMethod: 'BANK',
    pan: 'ABCDE1234F',
    uan: '100123456789',
    esiIpNumber: 'IP123456',
    aadhaar: '123456789012',
  };
}

describe('SalaryService.resolveSalarySensitiveCtx + stripSalarySensitiveFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a) Manager without sensitive_view viewing ANOTHER member -> bankDetails/pan/uan/aadhaar stripped', async () => {
    const { service, callerScope } = makeService();
    const ownMemberId = 'tmX';
    const otherMemberId = 'tmY';

    // Manager: isOwner=false, has teamMemberId 'tmX', no sensitive_view grant
    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownMemberId,
      permissions: [],
    });
    // effectiveScope returns null when action is not granted
    callerScope.effectiveScope.mockReturnValue(null);

    const sens = await service.resolveSalarySensitiveCtx(WS, USER);

    expect(sens.isOwner).toBe(false);
    expect(sens.ownTeamMemberId).toBe(ownMemberId);
    expect(sens.canViewSensitive).toBe(false);

    expect(callerScope.effectiveScope).toHaveBeenCalledWith(
      expect.anything(),
      'salary',
      'sensitive_view',
    );

    const memberObj = makeMemberSubObject(otherMemberId);
    stripSalarySensitiveFields(memberObj, {
      isOwner: sens.isOwner,
      isOwnRecord: sens.ownTeamMemberId === otherMemberId,
      canViewSensitive: sens.canViewSensitive,
    });

    expect(memberObj.bankDetails).toBeUndefined();
    expect(memberObj.upiDetails).toBeUndefined();
    expect(memberObj.preferredMethod).toBeUndefined();
    expect(memberObj.pan).toBeUndefined();
    expect(memberObj.uan).toBeUndefined();
    expect(memberObj.esiIpNumber).toBeUndefined();
    expect(memberObj.aadhaar).toBeUndefined();
    // Non-sensitive fields must still be present
    expect(memberObj.name).toBe('Test Worker');
    expect(memberObj.designation).toBe('Karigar');
  });

  it('(b) Manager WITH salary.sensitive_view -> fields retained on any member', async () => {
    const { service, callerScope } = makeService();
    const ownMemberId = 'tmX';
    const otherMemberId = 'tmY';

    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownMemberId,
      permissions: [],
    });
    // effectiveScope returns a non-null scope when the action is granted
    callerScope.effectiveScope.mockReturnValue('all');

    const sens = await service.resolveSalarySensitiveCtx(WS, USER);

    expect(sens.canViewSensitive).toBe(true);

    const memberObj = makeMemberSubObject(otherMemberId);
    stripSalarySensitiveFields(memberObj, {
      isOwner: sens.isOwner,
      isOwnRecord: sens.ownTeamMemberId === otherMemberId,
      canViewSensitive: sens.canViewSensitive,
    });

    expect(memberObj.bankDetails).toBeDefined();
    expect(memberObj.pan).toBe('ABCDE1234F');
    expect(memberObj.uan).toBe('100123456789');
    expect(memberObj.aadhaar).toBe('123456789012');
  });

  it('(c) isOwner=true -> fields always retained regardless of grant', async () => {
    const { service, callerScope } = makeService();

    callerScope.resolve.mockResolvedValue({
      isOwner: true,
      teamMemberId: null,
      permissions: [],
    });
    // effectiveScope short-circuits to 'all' for owner in real impl; mock
    // returns 'all' to reflect that
    callerScope.effectiveScope.mockReturnValue('all');

    const sens = await service.resolveSalarySensitiveCtx(WS, USER);

    expect(sens.isOwner).toBe(true);
    expect(sens.canViewSensitive).toBe(true);

    const memberObj = makeMemberSubObject('anyMember');
    stripSalarySensitiveFields(memberObj, {
      isOwner: sens.isOwner,
      isOwnRecord: false,
      canViewSensitive: sens.canViewSensitive,
    });

    expect(memberObj.bankDetails).toBeDefined();
    expect(memberObj.pan).toBe('ABCDE1234F');
  });

  it('(d) Manager viewing their OWN record (ownTeamMemberId === row member id) -> retained', async () => {
    const { service, callerScope } = makeService();
    const ownMemberId = 'tmX';

    callerScope.resolve.mockResolvedValue({
      isOwner: false,
      teamMemberId: ownMemberId,
      permissions: [],
    });
    // No sensitive_view grant
    callerScope.effectiveScope.mockReturnValue(null);

    const sens = await service.resolveSalarySensitiveCtx(WS, USER);

    expect(sens.canViewSensitive).toBe(false);
    expect(sens.ownTeamMemberId).toBe(ownMemberId);

    // Row belongs to the caller themselves
    const memberObj = makeMemberSubObject(ownMemberId);
    stripSalarySensitiveFields(memberObj, {
      isOwner: sens.isOwner,
      isOwnRecord: sens.ownTeamMemberId != null && sens.ownTeamMemberId === ownMemberId,
      canViewSensitive: sens.canViewSensitive,
    });

    // Own record -> no stripping
    expect(memberObj.bankDetails).toBeDefined();
    expect(memberObj.pan).toBe('ABCDE1234F');
    expect(memberObj.uan).toBe('100123456789');
  });

  it('(e) SALARY_INTERNAL_UNFILTERED sentinel -> canViewSensitive=true, callerScope.resolve NOT called, all fields retained', async () => {
    const { service, callerScope } = makeService();

    // callerScope.resolve should NEVER be called for the sentinel path
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: null, permissions: [] });

    const sens = await service.resolveSalarySensitiveCtx(WS, SALARY_INTERNAL_UNFILTERED);

    // Sentinel short-circuits before callerScope.resolve
    expect(callerScope.resolve).not.toHaveBeenCalled();
    expect(callerScope.effectiveScope).not.toHaveBeenCalled();

    expect(sens.isOwner).toBe(true);
    expect(sens.ownTeamMemberId).toBeNull();
    expect(sens.canViewSensitive).toBe(true);

    // Applying strip with these opts is a no-op - all fields retained
    const memberObj = makeMemberSubObject('anyMember');
    stripSalarySensitiveFields(memberObj, {
      isOwner: sens.isOwner,
      isOwnRecord: false,
      canViewSensitive: sens.canViewSensitive,
    });

    expect(memberObj.bankDetails).toBeDefined();
    expect(memberObj.upiDetails).toBeDefined();
    expect(memberObj.preferredMethod).toBe('BANK');
    expect(memberObj.pan).toBe('ABCDE1234F');
    expect(memberObj.uan).toBe('100123456789');
    expect(memberObj.esiIpNumber).toBe('IP123456');
    expect(memberObj.aadhaar).toBe('123456789012');
    // Non-sensitive fields also retained
    expect(memberObj.name).toBe('Test Worker');
    expect(memberObj.designation).toBe('Karigar');
  });
});
