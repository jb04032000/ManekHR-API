/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { PayrollAutoGenerateCron } from '../payroll-auto-generate.cron';
import { CommissionScheduleCron } from '../commission-schedule.cron';
import { CronJobKey } from '../../../../common/constants/cron.constants';

function lock(grant: boolean) {
  const calls: string[] = [];
  return {
    calls,
    svc: {
      runExclusive: vi.fn(async (jobKey: string, _p: string, fn: () => Promise<unknown>) => {
        calls.push(jobKey);
        if (!grant) return { ran: false };
        return { ran: true, result: await fn() };
      }),
    } as any,
  };
}

// payrollConfigModel.find() is the first thing both process() bodies call — the
// probe for "did the body run?". Empty result short-circuits the rest.
function configModel() {
  const find = vi.fn(() => ({
    select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
  }));
  return { model: { find } as any, find };
}

describe('salary crons — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PayrollAutoGenerateCron wraps in single-flight and runs body on claim', async () => {
    const l = lock(true);
    const c = configModel();
    await new PayrollAutoGenerateCron(
      c.model,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      l.svc,
    ).handleAutoGenerate();
    expect(l.calls[0]).toBe(CronJobKey.PAYROLL_AUTO_GENERATE);
    expect(c.find).toHaveBeenCalledOnce();
  });

  it('PayrollAutoGenerateCron does no work when the claim is held', async () => {
    const l = lock(false);
    const c = configModel();
    await new PayrollAutoGenerateCron(
      c.model,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      l.svc,
    ).handleAutoGenerate();
    expect(l.calls[0]).toBe(CronJobKey.PAYROLL_AUTO_GENERATE);
    expect(c.find).not.toHaveBeenCalled();
  });

  it('CommissionScheduleCron wraps in single-flight and runs body on claim', async () => {
    const l = lock(true);
    const c = configModel();
    await new CommissionScheduleCron(
      c.model,
      {} as any,
      {} as any,
      l.svc,
    ).handleCommissionDispatch();
    expect(l.calls[0]).toBe(CronJobKey.COMMISSION_DISPATCH);
    expect(c.find).toHaveBeenCalledOnce();
  });

  it('CommissionScheduleCron does no work when the claim is held', async () => {
    const l = lock(false);
    const c = configModel();
    await new CommissionScheduleCron(
      c.model,
      {} as any,
      {} as any,
      l.svc,
    ).handleCommissionDispatch();
    expect(l.calls[0]).toBe(CronJobKey.COMMISSION_DISPATCH);
    expect(c.find).not.toHaveBeenCalled();
  });
});
