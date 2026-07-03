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

import { TrialReminderCron } from '../trial-reminder.cron';
import { RenewalNoticeCron } from '../renewal-notice.cron';
import { WinBackCron } from '../win-back.cron';
import { AbandonedCheckoutCron } from '../abandoned-checkout.cron';
import { CronJobKey } from '../../../../../common/constants/cron.constants';

/** A single-flight that records its jobKey and runs (or denies) fn. */
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

// policyService is the first thing every process() touches — a perfect probe for
// "did the body run?". When disabled, the body returns immediately after it.
const policyDisabled = { getPolicy: vi.fn().mockResolvedValue({ marketing: {}, trial: {} }) };
const model = () =>
  ({ find: vi.fn(), findById: vi.fn(), findOne: vi.fn(), exists: vi.fn() }) as any;

describe('billing crons — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  const cases: Array<{
    name: string;
    key: CronJobKey;
    make: (l: any, p: any) => { run: () => Promise<void> };
  }> = [
    {
      name: 'TrialReminderCron',
      key: CronJobKey.BILLING_TRIAL_REMINDER,
      make: (l, p) => new TrialReminderCron(model(), model(), {} as any, p, l),
    },
    {
      name: 'RenewalNoticeCron',
      key: CronJobKey.BILLING_RENEWAL_NOTICE,
      make: (l, p) => new RenewalNoticeCron(model(), model(), model(), {} as any, {} as any, p, l),
    },
    {
      name: 'WinBackCron',
      key: CronJobKey.BILLING_WIN_BACK,
      make: (l, p) => new WinBackCron(model(), model(), model(), {} as any, p, l),
    },
    {
      name: 'AbandonedCheckoutCron',
      key: CronJobKey.BILLING_ABANDONED_CHECKOUT,
      make: (l, p) => new AbandonedCheckoutCron(model(), model(), {} as any, p, l),
    },
  ];

  for (const c of cases) {
    it(`${c.name} wraps its body in single-flight with the right job key`, async () => {
      const l = lock(true);
      await c.make(l.svc, policyDisabled).run();
      expect(l.svc.runExclusive).toHaveBeenCalledOnce();
      expect(l.calls[0]).toBe(c.key);
      // Body ran (claim won) → it consulted the policy.
      expect(policyDisabled.getPolicy).toHaveBeenCalledOnce();
    });

    it(`${c.name} does no work when the claim is held by another worker`, async () => {
      const l = lock(false);
      await c.make(l.svc, policyDisabled).run();
      expect(l.calls[0]).toBe(c.key);
      // Body skipped → policy never consulted.
      expect(policyDisabled.getPolicy).not.toHaveBeenCalled();
    });
  }
});
