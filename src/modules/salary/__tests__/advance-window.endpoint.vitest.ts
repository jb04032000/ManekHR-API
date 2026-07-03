/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators before importing AdvanceSalaryRequestService so
// transitive schema imports don't trip reflect-metadata under vitest's transform.
// Pattern from src/modules/auth/__tests__/auth.service.audit.vitest.ts.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { AdvanceSalaryRequestService } from '../advance-salary-request.service';

// AdvanceSalaryRequestService constructor arg order (advance-salary-request.service.ts:28-40):
//   [0] advanceRequestModel
//   [1] payrollConfigModel  <-- getWindowForMember uses loadPayrollConfig which uses this
//   [2] notificationsService
//   [3] teamMemberModel

describe('getWindowForMember', () => {
  it('reports closed + message when today is outside a fixed_day policy', async () => {
    const cfg = {
      disbursementRules: {
        advanceRequestDay: 15,
        advanceRequestPolicy: { mode: 'fixed_day', fixedDay: 21 },
      },
    };
    const payrollConfigModel = {
      findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(cfg) }) }),
    };
    const svc = new AdvanceSalaryRequestService(
      {} as any, // [0] advanceRequestModel
      payrollConfigModel as any, // [1] payrollConfigModel
      {} as any, // [2] notificationsService
      {} as any, // [3] teamMemberModel
    );

    const res = await svc.getWindowForMember('aaaaaaaaaaaaaaaaaaaaaaaa', 23); // today = 23, policy day = 21
    expect(res.isOpenToday).toBe(false);
    expect(res.policy.mode).toBe('fixed_day');
    // advanceRequestWindowMessage returns "...day 21..." for fixed_day mode.
    expect(res.message).toMatch(/day 21/);
  });

  it('reports open for an any_day policy', async () => {
    const cfg = {
      disbursementRules: {
        advanceRequestPolicy: { mode: 'any_day' },
      },
    };
    const payrollConfigModel = {
      findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(cfg) }) }),
    };
    const svc = new AdvanceSalaryRequestService(
      {} as any,
      payrollConfigModel as any,
      {} as any,
      {} as any,
    );

    const res = await svc.getWindowForMember('aaaaaaaaaaaaaaaaaaaaaaaa', 23);
    expect(res.isOpenToday).toBe(true);
  });
});
