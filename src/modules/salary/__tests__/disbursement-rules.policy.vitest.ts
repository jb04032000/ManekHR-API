/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators before importing SalaryService so that
// transitive schema imports don't trip reflect-metadata under vitest's transform.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { SalaryService } from '../salary.service';

// SalaryService constructor positional order (from salary.service.ts lines 441-503):
//   [0] salaryModel
//   [1] paymentModel
//   [2] teamModel
//   [3] attendanceModel
//   [4] incrementModel
//   [5] salaryAdjustmentModel
//   [6] payrollConfigModel  <-- the one updateDisbursementRules uses
//   [7..N] other models + services (not called by updateDisbursementRules)
//
// We pass null for positions 0-5 and the mock at position 6; the rest are
// undefined (the comment at line 500 explicitly says "existing positional test
// mocks that stop before this arg keep undefined -- the new write paths null-guard").
function buildService(capturedSet: Record<string, unknown>): SalaryService {
  const findOneAndUpdate = vi.fn().mockImplementation((_query: any, update: any) => {
    Object.assign(capturedSet, update.$set ?? {});
    return { exec: vi.fn().mockResolvedValue({ _id: 'mock-id' }) };
  });
  const payrollConfigModel = { findOneAndUpdate } as any;

  return new SalaryService(
    null as any, // [0] salaryModel
    null as any, // [1] paymentModel
    null as any, // [2] teamModel
    null as any, // [3] attendanceModel
    null as any, // [4] incrementModel
    null as any, // [5] salaryAdjustmentModel
    payrollConfigModel, // [6] payrollConfigModel -- updateDisbursementRules target
    // remaining args left as undefined; updateDisbursementRules does not touch them
  );
}

describe('updateDisbursementRules - advanceRequestPolicy persistence', () => {
  it('persists advanceRequestPolicy in the $set when window mode', async () => {
    const captured: Record<string, unknown> = {};
    const svc = buildService(captured);

    await svc.updateDisbursementRules('aaaaaaaaaaaaaaaaaaaaaaaa', {
      advanceRequestPolicy: { mode: 'window', windowStartDay: 21, windowEndDay: 23 },
    } as any);

    // Policy object must land verbatim in the Mongo $set.
    expect(captured['disbursementRules.advanceRequestPolicy']).toMatchObject({
      mode: 'window',
      windowStartDay: 21,
      windowEndDay: 23,
    });
  });

  it('also syncs legacy advanceRequestDay when mode is fixed_day', async () => {
    const captured: Record<string, unknown> = {};
    const svc = buildService(captured);

    await svc.updateDisbursementRules('aaaaaaaaaaaaaaaaaaaaaaaa', {
      advanceRequestPolicy: { mode: 'fixed_day', fixedDay: 21 },
    } as any);

    // Structured policy stored.
    expect(captured['disbursementRules.advanceRequestPolicy']).toMatchObject({
      mode: 'fixed_day',
      fixedDay: 21,
    });
    // Legacy scalar kept in sync so pre-migration code paths stay correct.
    // Links: advance-salary-request.service.ts createRequest (reads advanceRequestDay as fallback).
    expect(captured['disbursementRules.advanceRequestDay']).toBe(21);
  });
});
