/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv/config', () => ({}));
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

import { ReminderDispatcherCron } from '../reminders/dispatcher/reminder-dispatcher.cron';
import { GreetingsCron } from '../party-intelligence/greetings/greetings.cron';
import { SamplesCron } from '../inventory/samples/samples.cron';
import { JwPendingAlarmCron } from '../job-work/pending-alarm/jw-pending-alarm.cron';
import { VerifyDataCronService } from '../gst/verify-data/verify-data-cron.service';
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
const selectLeanEmpty = (probe: () => void) => ({
  select: () => ({ lean: () => Promise.resolve((probe(), [])) }),
});
const populateLeanEmpty = (probe: () => void) => ({
  populate: () => ({ lean: () => Promise.resolve((probe(), [])) }),
});

function build(idx: number, lockSvc: any, probe: () => void) {
  switch (idx) {
    case 0:
      return new ReminderDispatcherCron(
        { runForAllWorkspaces: () => Promise.resolve((probe(), {})) } as any,
        lockSvc,
      ).run();
    case 1:
      return new GreetingsCron(
        { find: () => selectLeanEmpty(probe) } as any,
        {} as any,
        lockSvc,
      ).run();
    case 2:
      return new SamplesCron(
        { find: () => ({ lean: () => Promise.resolve((probe(), [])) }) } as any,
        lockSvc,
      ).runSampleAlarm();
    case 3:
      return new JwPendingAlarmCron(
        { find: () => populateLeanEmpty(probe) } as any,
        {} as any,
        {} as any,
        {} as any,
        lockSvc,
      ).handleDeemedSupplyAlarm();
    case 4:
      return new VerifyDataCronService(
        { find: () => selectLeanEmpty(probe) } as any,
        {} as any,
        lockSvc,
      ).handleNightlyVerify();
    default:
      throw new Error('bad idx');
  }
}

const expected = [
  CronJobKey.REMINDER_DISPATCHER,
  CronJobKey.GREETINGS_DISPATCH,
  CronJobKey.SAMPLE_ALARM,
  CronJobKey.FINANCE_JW_PENDING_ALARM,
  CronJobKey.FINANCE_GST_VERIFY_DATA,
];

describe('finance alarm/notification crons — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  expected.forEach((key, idx) => {
    it(`${key} runs its body under the right key on claim`, async () => {
      const probe = vi.fn();
      const l = lock(true);
      await build(idx, l.svc, probe);
      expect(l.calls[0]).toBe(key);
      expect(probe).toHaveBeenCalled();
    });

    it(`${key} does no work when the claim is held`, async () => {
      const probe = vi.fn();
      const l = lock(false);
      await build(idx, l.svc, probe);
      expect(l.calls[0]).toBe(key);
      expect(probe).not.toHaveBeenCalled();
    });
  });
});
