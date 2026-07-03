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

import { AnomalyStreakCron } from '../anomalies/anomaly-streak.cron';
import { AutoPresentCron } from '../attendance/auto-present.cron';
import { CronJobKey } from '../../common/constants/cron.constants';

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

// find().lean().exec() -> [] (anomaly workspace scan, auto-close stale scan).
const findLeanExecEmpty = (probe: () => void) => ({
  find: () => ({ lean: () => ({ exec: () => Promise.resolve((probe(), [])) }) }),
});
// find().select() -> [] (auto-present subscription scan; awaited directly).
const findSelectEmpty = (probe: () => void) => ({
  find: () => ({ select: () => Promise.resolve((probe(), [])) }),
});

function build(idx: number, lockSvc: any, probe: () => void): Promise<unknown> {
  switch (idx) {
    case 0:
      // anomaly-streak: process() -> workspaceModel.find().lean().exec() (probe).
      return new AnomalyStreakCron(
        findLeanExecEmpty(probe) as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        lockSvc,
      ).run();
    case 1:
      // auto-present: processAutoPresent() -> subscriptionModel.find().select() (probe).
      // 9th arg = HolidaysService (B); unreached here because the subscription scan
      // returns [] before any holiday resolution, so a bare stub is sufficient.
      return new AutoPresentCron(
        {} as any,
        {} as any,
        {} as any,
        findSelectEmpty(probe) as any,
        {} as any,
        {} as any,
        {} as any,
        lockSvc,
        {} as any,
      ).handleCron();
    case 2:
      // auto-close stale: processAutoCloseStale() -> attendanceModel.find().lean().exec() (probe).
      // 9th arg = HolidaysService (B); auto-close path never touches it.
      return new AutoPresentCron(
        findLeanExecEmpty(probe) as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        lockSvc,
        {} as any,
      ).handleAutoCloseStale();
    default:
      throw new Error('bad idx');
  }
}

const expected = [
  CronJobKey.ANOMALY_MISSED_STREAK,
  CronJobKey.AUTO_PRESENT,
  CronJobKey.AUTO_CLOSE_STALE,
];

describe('attendance + anomaly Tier B crons — single-flight gating', () => {
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
