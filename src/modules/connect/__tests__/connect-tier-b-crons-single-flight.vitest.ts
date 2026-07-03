/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv/config', () => ({}));
vi.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: {
    EVERY_HOUR: 'h',
    EVERY_DAY_AT_2AM: 'd2',
    EVERY_DAY_AT_3AM: 'd3',
    EVERY_MINUTE: 'm',
  },
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

import { TrendingTagsService } from '../tags/trending-tags.service';
import { RollupCron } from '../ads/crons/rollup.cron';
import { ReconcileCron } from '../ads/crons/reconcile.cron';
import { PacingDaemon } from '../ads/crons/pacing.daemon';
import { CronJobKey } from '../../../common/constants/cron.constants';

// Lock double: records the jobKey passed and, when granted, runs the body so the
// per-job probe fires. When not granted (claim already held) the body must NOT run.
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

function build(idx: number, lockSvc: any, probe: () => void): Promise<unknown> {
  switch (idx) {
    case 0:
      // trending-tags: process() -> recomputeTrending() -> aggregate x2 ([]) -> updateMany (probe).
      return new TrendingTagsService(
        { aggregate: () => Promise.resolve([]) } as any,
        {
          updateMany: () => Promise.resolve((probe(), undefined)),
          bulkWrite: () => Promise.resolve(),
        } as any,
        lockSvc,
      ).handleTrendingCron();
    case 1:
      // ads rollup: tick() -> impressionModel.aggregate (probe).
      return new RollupCron(
        { aggregate: () => Promise.resolve((probe(), [])) } as any,
        { aggregate: () => Promise.resolve([]) } as any,
        { updateOne: () => Promise.resolve() } as any,
        lockSvc,
      ).run();
    case 2:
      // ads reconcile: tick() -> campaignModel.find (probe).
      return new ReconcileCron(
        { find: () => Promise.resolve((probe(), [])) } as any,
        {} as any,
        lockSvc,
      ).run();
    case 3:
      // ads pacing: tick() -> campaignModel.find().lean() (probe).
      return new PacingDaemon(
        { find: () => ({ lean: () => Promise.resolve((probe(), [])) }) } as any,
        {} as any,
        {} as any,
        lockSvc,
      ).run();
    default:
      throw new Error('bad idx');
  }
}

const expected = [
  CronJobKey.CONNECT_TRENDING_TAGS,
  CronJobKey.ADS_ROLLUP,
  CronJobKey.ADS_RECONCILE,
  CronJobKey.ADS_PACING,
];

describe('connect Tier B crons — single-flight gating', () => {
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
