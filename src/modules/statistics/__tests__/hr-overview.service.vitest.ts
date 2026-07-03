/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports do not trip vitest's reflect-metadata
// pipeline (same pattern as has-module.vitest.ts).
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

import { HrOverviewService } from '../hr-overview.service';
import { AppModule } from '../../../common/enums/modules.enum';

const WS_ID = '507f1f77bcf86cd799439011';

/** A lean()-chainable query stub that resolves to `rows`. */
function leanQuery(rows: any[]) {
  return {
    select: () => ({ lean: () => Promise.resolve(rows) }),
  };
}

function buildService(opts: {
  headcountAgg?: any;
  salaryRecords?: any[];
  payments?: any[];
  salaryEnabled?: boolean;
}) {
  const teamModel = {
    aggregate: vi.fn().mockReturnValue({
      exec: () => Promise.resolve(opts.headcountAgg ? [opts.headcountAgg] : [undefined]),
    }),
  } as any;

  const salaryModel = {
    find: vi.fn().mockReturnValue(leanQuery(opts.salaryRecords ?? [])),
  } as any;

  const paymentModel = {
    find: vi.fn().mockReturnValue(leanQuery(opts.payments ?? [])),
  } as any;

  const subscriptionsService = {
    hasModule: vi.fn().mockResolvedValue(opts.salaryEnabled ?? true),
  } as any;

  return new HrOverviewService(teamModel, salaryModel, paymentModel, subscriptionsService);
}

describe('HrOverviewService.getOverview', () => {
  it('returns active headcount, joiners, app-access, and a designation breakdown', async () => {
    const svc = buildService({
      headcountAgg: {
        active: 12,
        addedThisMonth: 3,
        withAppAccess: 5,
        byDesignation: [
          { designation: 'Polisher', count: 7 },
          { designation: null, count: 2 },
        ],
      },
      salaryEnabled: true,
      salaryRecords: [],
    });

    const res = await svc.getOverview(WS_ID);

    expect(res.headcount).toEqual({ active: 12, addedThisMonth: 3, withAppAccess: 5 });
    expect(res.byDesignation).toEqual([
      { designation: 'Polisher', count: 7 },
      { designation: 'Unassigned', count: 2 },
    ]);
    expect(res.modules.salaryEnabled).toBe(true);
    expect(typeof res.generatedAt).toBe('string');
  });

  it('sums this-month net payable and payments, deriving pending + paid counts', async () => {
    const svc = buildService({
      headcountAgg: { active: 2, addedThisMonth: 0, withAppAccess: 0, byDesignation: [] },
      salaryEnabled: true,
      salaryRecords: [
        { _id: 'sal1', teamMemberId: 'm1', netSalary: 10000 },
        { _id: 'sal2', teamMemberId: 'm2', netSalary: 8000 },
      ],
      payments: [
        { teamMemberId: 'm1', amount: 10000 }, // fully paid
        { teamMemberId: 'm2', amount: 3000 }, // partial
      ],
    });

    const res = await svc.getOverview(WS_ID);

    expect(res.salary).not.toBeNull();
    expect(res.salary!.totalPayable).toBe(18000);
    expect(res.salary!.totalPaid).toBe(13000);
    expect(res.salary!.totalPending).toBe(5000);
    expect(res.salary!.employeesCount).toBe(2);
    expect(res.salary!.paidEmployeesCount).toBe(1);
    expect(res.salary!.pendingEmployeesCount).toBe(1);
    expect(res.salary!.payrollGenerated).toBe(true);
  });

  it('reports payrollGenerated:false with zeroed totals when no salary rows exist', async () => {
    const svc = buildService({
      headcountAgg: { active: 4, addedThisMonth: 1, withAppAccess: 0, byDesignation: [] },
      salaryEnabled: true,
      salaryRecords: [],
    });

    const res = await svc.getOverview(WS_ID);

    expect(res.salary).not.toBeNull();
    expect(res.salary!.payrollGenerated).toBe(false);
    expect(res.salary!.totalPayable).toBe(0);
    expect(res.salary!.employeesCount).toBe(0);
  });

  it('hides salary numbers (salary:null) when the SALARY module is disabled', async () => {
    const svc = buildService({
      headcountAgg: { active: 6, addedThisMonth: 0, withAppAccess: 0, byDesignation: [] },
      salaryEnabled: false,
      salaryRecords: [{ _id: 'sal1', teamMemberId: 'm1', netSalary: 9999 }],
    });

    const res = await svc.getOverview(WS_ID);

    expect(res.modules.salaryEnabled).toBe(false);
    expect(res.salary).toBeNull();
  });

  it('passes the SALARY module enum to the entitlement gate', async () => {
    const svc = buildService({
      headcountAgg: { active: 1, addedThisMonth: 0, withAppAccess: 0, byDesignation: [] },
      salaryEnabled: true,
    });
    // Reach into the injected stub to assert the gate argument.
    await svc.getOverview(WS_ID);
    const sub = (svc as any).subscriptionsService;
    expect(sub.hasModule).toHaveBeenCalledWith(WS_ID, AppModule.SALARY);
  });
});
