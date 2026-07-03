/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_DAY_AT_6AM: '0 6 * * *' },
}));
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

import { LateFeeAccrualCron } from '../payments/late-fee/late-fee.cron';
import { LoanEmiCron } from '../loan-accounts/loan-emi.cron';
import { DepreciationCron } from '../fixed-assets/depreciation/depreciation.cron';
import { RecurringExpenseCron } from '../expenses/recurring/recurring-expense.cron';
import { RecurringInvoiceCron } from '../sales/recurring/recurring.cron';
import { CapitalGoodsItcCron } from '../purchases/capital-goods-itc/capital-goods-itc.cron';
import { CronJobKey } from '../../../common/constants/cron.constants';

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

// Each cron pairs with: how to build it (given lock + a probe), its job key, and
// the probe that records whether the body actually ran.
function makeCases() {
  const probe = vi.fn();
  const findChain = () => ({ lean: () => Promise.resolve((probe(), [])) });
  return {
    probe,
    cases: [
      {
        name: 'LateFeeAccrualCron',
        key: CronJobKey.FINANCE_LATE_FEE,
        run: (l: any) =>
          new LateFeeAccrualCron(
            { find: () => findChain() } as any,
            {} as any,
            {} as any,
            l,
          ).handleAccrual(),
      },
      {
        name: 'LoanEmiCron',
        key: CronJobKey.FINANCE_LOAN_EMI,
        run: (l: any) =>
          new LoanEmiCron(
            { processEmiForMonth: () => Promise.resolve(probe()) } as any,
            l,
          ).runMonthlyEmi(),
      },
      {
        name: 'DepreciationCron',
        key: CronJobKey.FINANCE_DEPRECIATION,
        run: (l: any) =>
          new DepreciationCron(
            { aggregate: () => Promise.resolve((probe(), [])) } as any,
            {} as any,
            l,
          ).runMonthlyDepreciation(),
      },
      {
        name: 'RecurringExpenseCron',
        key: CronJobKey.FINANCE_RECURRING_EXPENSE,
        run: (l: any) =>
          new RecurringExpenseCron(
            { find: () => Promise.resolve((probe(), [])) } as any,
            {} as any,
            l,
          ).run(),
      },
      {
        name: 'RecurringInvoiceCron',
        key: CronJobKey.FINANCE_RECURRING_INVOICE,
        run: (l: any) =>
          new RecurringInvoiceCron(
            { find: () => Promise.resolve((probe(), [])) } as any,
            {} as any,
            l,
          ).run(),
      },
      {
        name: 'CapitalGoodsItcCron',
        key: CronJobKey.FINANCE_CAPITAL_GOODS_ITC,
        run: (l: any) =>
          new CapitalGoodsItcCron(
            { find: () => Promise.resolve((probe(), [])) } as any,
            {} as any,
            l,
          ).amortiseCapitalGoodsItc(),
      },
    ],
  };
}

describe('finance posting crons — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  // Table-driven: build fresh each iteration so the probe is isolated.
  const keys = [
    CronJobKey.FINANCE_LATE_FEE,
    CronJobKey.FINANCE_LOAN_EMI,
    CronJobKey.FINANCE_DEPRECIATION,
    CronJobKey.FINANCE_RECURRING_EXPENSE,
    CronJobKey.FINANCE_RECURRING_INVOICE,
    CronJobKey.FINANCE_CAPITAL_GOODS_ITC,
  ];
  keys.forEach((key, idx) => {
    it(`${key} wraps in single-flight and runs body on claim`, async () => {
      const { probe, cases } = makeCases();
      const l = lock(true);
      await cases[idx].run(l.svc);
      expect(l.calls[0]).toBe(key);
      expect(probe).toHaveBeenCalledOnce();
    });

    it(`${key} does no work when the claim is held`, async () => {
      const { probe, cases } = makeCases();
      const l = lock(false);
      await cases[idx].run(l.svc);
      expect(l.calls[0]).toBe(key);
      expect(probe).not.toHaveBeenCalled();
    });
  });
});
