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

import { RfmCron } from '../party-intelligence/rfm/rfm.cron';
import { GstinMonitorCron } from '../party-intelligence/gstin-monitor/gstin-monitor.cron';
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

// Both crons load the active workspace list via find().select().lean() before
// any per-workspace work; the empty list lets process() return cleanly while the
// probe still proves the body ran.
const findSelectLeanEmpty = (probe: () => void) => ({
  find: () => ({ select: () => ({ lean: () => Promise.resolve((probe(), [])) }) }),
});

function build(idx: number, lockSvc: any, probe: () => void): Promise<unknown> {
  switch (idx) {
    case 0:
      return new RfmCron(findSelectLeanEmpty(probe) as any, {} as any, lockSvc).run();
    case 1:
      return new GstinMonitorCron(findSelectLeanEmpty(probe) as any, {} as any, lockSvc).run();
    default:
      throw new Error('bad idx');
  }
}

const expected = [CronJobKey.RFM_SEGMENTER, CronJobKey.GSTIN_MONITOR];

describe('finance party-intelligence Tier B crons — single-flight gating', () => {
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
