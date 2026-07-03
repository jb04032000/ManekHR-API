/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight model mocks */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConnectViewService } from '../services/connect-view.service';

const OWNER = '507f1f77bcf86cd799439011';
const SHOP = '507f191e810c19729de860ea';
const VIEWER = '507f1f77bcf86cd799439013';
const TARGET = '507f191e810c19729de860eb';

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const leanExec = (val: unknown) => ({ lean: () => ({ exec: () => Promise.resolve(val) }) });

describe('ConnectViewService.recordView', () => {
  it('counts the first view of the day then dedupes the rest', async () => {
    const seen = {
      create: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce({ code: 11000 }),
    };
    const daily = { updateOne: vi.fn().mockResolvedValue({}), find: vi.fn() };
    const svc = new ConnectViewService(daily as any, seen as any, {} as any, {} as any);

    const first = await svc.recordView(VIEWER, 'storefront', TARGET);
    expect(first).toEqual({ ok: true, counted: true });
    expect(daily.updateOne).toHaveBeenCalledTimes(1);

    const second = await svc.recordView(VIEWER, 'storefront', TARGET);
    expect(second).toEqual({ ok: true, counted: false });
    // Dedupe: the same-day repeat must NOT bump the counter again.
    expect(daily.updateOne).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectViewService.storefrontSummary', () => {
  it('zero-fills 30 days, sums 7d/30d, and tallies per-listing views', async () => {
    const today = utcDay(new Date());
    const storefronts = { findOne: () => leanExec({ _id: SHOP, ownerUserId: OWNER }) };
    const daily = {
      find: vi
        .fn()
        .mockImplementation((q: { targetType: string }) =>
          leanExec(
            q.targetType === 'storefront'
              ? [{ date: today, count: 5 }]
              : [{ targetId: 'lid1', count: 3 }],
          ),
        ),
      updateOne: vi.fn(),
    };
    const listings = { find: () => ({ select: () => leanExec([{ _id: 'lid1' }]) }) };
    const svc = new ConnectViewService(
      daily as any,
      {} as any,
      storefronts as any,
      listings as any,
    );

    const sum = await svc.storefrontSummary(OWNER, SHOP);
    expect(sum.series).toHaveLength(30);
    expect(sum.series[29]).toEqual({ date: today, count: 5 });
    expect(sum.views7d).toBe(5);
    expect(sum.views30d).toBe(5);
    expect(sum.byListing).toEqual([{ listingId: 'lid1', views7d: 3 }]);
  });

  it('throws NotFound when the storefront is not the caller-owned', async () => {
    const storefronts = { findOne: () => leanExec(null) };
    const svc = new ConnectViewService({} as any, {} as any, storefronts as any, {} as any);
    await expect(svc.storefrontSummary(OWNER, SHOP)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ConnectViewService.profileViewSummary', () => {
  it('queries the profile target for the owner and sums the counts', async () => {
    const today = utcDay(new Date());
    // First call = windowed (30d) rows, second call = all-time rows.
    const find = vi
      .fn()
      .mockReturnValueOnce(leanExec([{ date: today, count: 2 }]))
      .mockReturnValueOnce({ select: () => leanExec([{ count: 5 }]) });
    const daily = { find };
    const svc = new ConnectViewService(daily as any, {} as any, {} as any, {} as any);

    const summary = await svc.profileViewSummary(OWNER);

    // The windowed query must be scoped to this owner's profile target.
    const windowQuery = find.mock.calls[0][0];
    expect(windowQuery.targetType).toBe('profile');
    expect(String(windowQuery.targetId)).toBe(OWNER);
    // Counts are summed from the rollup rows.
    expect(summary.views30d).toBe(2);
    expect(summary.views7d).toBe(2);
    expect(summary.total).toBe(5);
  });
});
