/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * OQ-S6 — Tax declaration upsert with Worker self-service (security-review HIGH-1).
 *
 * Before this hardening the route required salary.edit (all scope) so a Karigar
 * could not file their own IT declaration. The fix added the dedicated
 * `salary.declare_tax` action at self scope, gating the route so:
 *   - Worker (declare_tax@self): may upsert their OWN declaration, CANNOT set
 *     isLocked, CANNOT target another member (IDOR), blocked after HR locks it.
 *   - HR (declare_tax@all) / Owner: full control — any member, lock/unlock.
 *
 * Mirrors salary.service.access.vitest.ts — no DB fixtures, driven via mock
 * CallerScopeService + TdsService.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { Types } from 'mongoose';
import { SalaryService } from '../salary.service';

const WS = new Types.ObjectId().toHexString();
const WORKER_USER = new Types.ObjectId().toHexString();
const WORKER_TM = new Types.ObjectId().toHexString();
const OTHER_TM = new Types.ObjectId().toHexString();
const HR_USER = new Types.ObjectId().toHexString();

const BASE_DTO = {
  financialYear: 2025,
  taxRegime: 'new' as const,
};

type CallerScopeMock = {
  resolve: ReturnType<typeof vi.fn>;
  effectiveScope: ReturnType<typeof vi.fn>;
  selfFilterValue: ReturnType<typeof vi.fn>;
};

type TdsServiceMock = {
  getDeclaration: ReturnType<typeof vi.fn>;
  updateDeclaration: ReturnType<typeof vi.fn>;
};

function noopModel() {
  return { find: vi.fn(), findOne: vi.fn(), findById: vi.fn() };
}

function buildService(callerScope: CallerScopeMock, tdsService: TdsServiceMock): SalaryService {
  return new SalaryService(
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    noopModel() as any,
    {} as any, // auditService
    {} as any, // mailService
    {} as any, // payslipPdfService
    {} as any, // complianceExportService
    tdsService as any, // tdsService
    {} as any, // gratuityService
    {} as any, // fnfService
    {} as any, // attendancePoliciesService
    {} as any, // teamService
    callerScope as any,
    { capture: vi.fn(), identify: vi.fn() } as any,
  );
}

describe('SalaryService.upsertTaxDeclaration — OQ-S6 (HIGH-1 fix)', () => {
  let callerScope: CallerScopeMock;
  let tdsService: TdsServiceMock;
  let svc: SalaryService;

  beforeEach(() => {
    callerScope = {
      resolve: vi.fn(),
      effectiveScope: vi.fn(),
      selfFilterValue: vi.fn(),
    };
    tdsService = {
      getDeclaration: vi.fn().mockResolvedValue(null), // unlocked by default
      updateDeclaration: vi.fn().mockResolvedValue({ financialYear: 2025 }),
    };
    svc = buildService(callerScope, tdsService);
    vi.clearAllMocks();
  });

  describe('Worker (declare_tax@self)', () => {
    beforeEach(() => {
      callerScope.resolve.mockResolvedValue({
        isOwner: false,
        teamMemberId: WORKER_TM,
        permissions: [],
      });
      callerScope.effectiveScope.mockReturnValue('self');
    });

    it('allows a worker to upsert their OWN tax declaration', async () => {
      const dto = { ...BASE_DTO, basic80C: 150000 };
      const result = await svc.upsertTaxDeclaration(WS, WORKER_TM, dto, WORKER_USER);
      expect(result).toBeDefined();
      expect(tdsService.updateDeclaration).toHaveBeenCalledOnce();
    });

    it('blocks a worker from updating ANOTHER member (IDOR guard)', async () => {
      await expect(
        svc.upsertTaxDeclaration(WS, OTHER_TM, { ...BASE_DTO }, WORKER_USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tdsService.updateDeclaration).not.toHaveBeenCalled();
    });

    it('strips isLocked from the DTO before writing (worker cannot lock)', async () => {
      const dto = { ...BASE_DTO, isLocked: true } as any;
      await svc.upsertTaxDeclaration(WS, WORKER_TM, dto, WORKER_USER);
      // isLocked must have been deleted from dto before updateDeclaration was called.
      // Signature: updateDeclaration(workspaceId, teamMemberId, financialYear, updates, userId)
      // so updates is at index 3.
      const callArgs = tdsService.updateDeclaration.mock.calls[0];
      const updates = callArgs[3];
      expect(updates).not.toHaveProperty('isLocked');
    });

    it('blocks a worker when HR has already locked the declaration', async () => {
      tdsService.getDeclaration.mockResolvedValue({ isLocked: true, financialYear: 2025 });
      await expect(
        svc.upsertTaxDeclaration(WS, WORKER_TM, { ...BASE_DTO }, WORKER_USER),
      ).rejects.toMatchObject({ response: { code: 'DECLARATION_LOCKED' } });
      expect(tdsService.updateDeclaration).not.toHaveBeenCalled();
    });

    it('allows edit when declaration exists but is NOT locked', async () => {
      tdsService.getDeclaration.mockResolvedValue({ isLocked: false, financialYear: 2025 });
      const result = await svc.upsertTaxDeclaration(WS, WORKER_TM, { ...BASE_DTO }, WORKER_USER);
      expect(result).toBeDefined();
      expect(tdsService.updateDeclaration).toHaveBeenCalledOnce();
    });

    it('blocks when no teamMemberId resolved (no member row in workspace)', async () => {
      callerScope.resolve.mockResolvedValue({
        isOwner: false,
        teamMemberId: null,
        permissions: [],
      });
      await expect(
        svc.upsertTaxDeclaration(WS, WORKER_TM, { ...BASE_DTO }, WORKER_USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('HR (declare_tax@all)', () => {
    beforeEach(() => {
      callerScope.resolve.mockResolvedValue({
        isOwner: false,
        teamMemberId: HR_USER,
        permissions: [],
      });
      callerScope.effectiveScope.mockReturnValue('all');
    });

    it('allows HR to upsert ANY member declaration', async () => {
      const result = await svc.upsertTaxDeclaration(WS, OTHER_TM, { ...BASE_DTO }, HR_USER);
      expect(result).toBeDefined();
      expect(tdsService.updateDeclaration).toHaveBeenCalledOnce();
    });

    it('allows HR to set isLocked (HR lock control)', async () => {
      const dto = { ...BASE_DTO, isLocked: true } as any;
      await svc.upsertTaxDeclaration(WS, OTHER_TM, dto, HR_USER);
      // isLocked must NOT be stripped in the all-scoped path.
      // Signature: updateDeclaration(workspaceId, teamMemberId, financialYear, updates, userId)
      const updates = tdsService.updateDeclaration.mock.calls[0][3];
      expect(updates).toHaveProperty('isLocked', true);
    });

    it('allows HR to upsert even after declaration is locked (HR can override)', async () => {
      tdsService.getDeclaration.mockResolvedValue({ isLocked: true, financialYear: 2025 });
      // all-scoped path does not check existing lock
      const result = await svc.upsertTaxDeclaration(WS, OTHER_TM, { ...BASE_DTO }, HR_USER);
      expect(result).toBeDefined();
    });
  });

  describe('Owner (full bypass)', () => {
    beforeEach(() => {
      callerScope.resolve.mockResolvedValue({
        isOwner: true,
        teamMemberId: null,
        permissions: [],
      });
      callerScope.effectiveScope.mockReturnValue('all');
    });

    it('allows owner to upsert any member declaration including locking', async () => {
      const dto = { ...BASE_DTO, isLocked: true } as any;
      const result = await svc.upsertTaxDeclaration(WS, OTHER_TM, dto, 'owner-user');
      expect(result).toBeDefined();
      // Signature: updateDeclaration(workspaceId, teamMemberId, financialYear, updates, userId)
      const updates = tdsService.updateDeclaration.mock.calls[0][3];
      expect(updates).toHaveProperty('isLocked', true);
    });
  });

  describe('No-grant path (fail-closed)', () => {
    it('denies when caller has no declare_tax grant (scope=null, not owner)', async () => {
      callerScope.resolve.mockResolvedValue({
        isOwner: false,
        teamMemberId: WORKER_TM,
        permissions: [],
      });
      callerScope.effectiveScope.mockReturnValue(null); // no grant
      await expect(
        svc.upsertTaxDeclaration(WS, WORKER_TM, { ...BASE_DTO }, WORKER_USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tdsService.updateDeclaration).not.toHaveBeenCalled();
    });
  });
});
