import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdFairnessService, CAMPAIGN_DAILY_CAP } from '../ad-fairness.service';

/**
 * In-memory ioredis double: just the four commands AdFairnessService uses
 * (get/incr/expire for the daily cap, smembers/sadd for the page set).
 */
function makeRedis() {
  const strings = new Map<string, number>();
  const sets = new Map<string, Set<string>>();
  return {
    get: vi.fn((k: string) => Promise.resolve(strings.has(k) ? String(strings.get(k)) : null)),
    incr: vi.fn((k: string) => {
      const n = (strings.get(k) ?? 0) + 1;
      strings.set(k, n);
      return Promise.resolve(n);
    }),
    expire: vi.fn(() => Promise.resolve(1)),
    smembers: vi.fn((k: string) => Promise.resolve([...(sets.get(k) ?? [])])),
    sadd: vi.fn((k: string, v: string) => {
      const s = sets.get(k) ?? new Set<string>();
      s.add(v);
      sets.set(k, s);
      return Promise.resolve(1);
    }),
  } as any;
}

describe('AdFairnessService - daily campaign cap', () => {
  let redis: ReturnType<typeof makeRedis>;
  let svc: AdFairnessService;

  beforeEach(() => {
    redis = makeRedis();
    svc = new AdFairnessService(redis);
  });

  it('is within cap before any serve', async () => {
    expect(await svc.withinDailyCampaignCap('viewer', 'camp')).toBe(true);
  });

  it('stays within cap after CAMPAIGN_DAILY_CAP-1 serves, blocks on the cap-th', async () => {
    // Serve up to the cap, then the next check is false (the 3rd impression when cap=2).
    for (let i = 0; i < CAMPAIGN_DAILY_CAP; i++) {
      expect(await svc.withinDailyCampaignCap('viewer', 'camp')).toBe(true);
      await svc.recordDailyCampaignServe('viewer', 'camp');
    }
    expect(await svc.withinDailyCampaignCap('viewer', 'camp')).toBe(false);
  });

  it('sets a TTL on the first serve only', async () => {
    await svc.recordDailyCampaignServe('viewer', 'camp');
    await svc.recordDailyCampaignServe('viewer', 'camp');
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it('keys cap per (viewer, campaign) - other pairs are independent', async () => {
    for (let i = 0; i < CAMPAIGN_DAILY_CAP; i++) {
      await svc.recordDailyCampaignServe('viewer', 'camp');
    }
    expect(await svc.withinDailyCampaignCap('viewer', 'camp')).toBe(false);
    expect(await svc.withinDailyCampaignCap('viewer', 'other-camp')).toBe(true);
    expect(await svc.withinDailyCampaignCap('other-viewer', 'camp')).toBe(true);
  });
});

describe('AdFairnessService - per-page dedupe', () => {
  let svc: AdFairnessService;

  beforeEach(() => {
    svc = new AdFairnessService(makeRedis());
  });

  it('returns no served campaigns for a fresh page', async () => {
    expect(await svc.servedCampaigns('page-1')).toEqual([]);
  });

  it('records and reads back served campaigns for a page', async () => {
    await svc.markServedOnPage('page-1', 'camp-A');
    await svc.markServedOnPage('page-1', 'camp-B');
    const served = await svc.servedCampaigns('page-1');
    expect(served.sort()).toEqual(['camp-A', 'camp-B']);
  });

  it('isolates pages from each other', async () => {
    await svc.markServedOnPage('page-1', 'camp-A');
    expect(await svc.servedCampaigns('page-2')).toEqual([]);
  });

  it('treats an empty pageRequestId as a no-op (dedupe off)', async () => {
    await svc.markServedOnPage('', 'camp-A');
    expect(await svc.servedCampaigns('')).toEqual([]);
  });
});
