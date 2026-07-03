/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// ---- Will fail until pacing.daemon.ts exists (RED) ----
import { PacingDaemon } from '../pacing.daemon';

// ---------------------------------------------------------------------------
// Fake collaborators
// ---------------------------------------------------------------------------

function makeMockCampaignModel(campaigns: any[]) {
  return {
    find: vi.fn(() => ({
      lean: vi.fn(() => Promise.resolve(campaigns)),
    })),
  };
}

function makeMockImpressionModel(count: number) {
  return {
    countDocuments: vi.fn(() => Promise.resolve(count)),
  };
}

function makeFakePacingRepo() {
  const setThrottleSpy = vi.fn(
    (_campaignId: string, _ttlSec: number): Promise<void> => Promise.resolve(),
  );
  return { setThrottle: setThrottleSpy, isThrottled: vi.fn(() => Promise.resolve(false)) };
}

// ---------------------------------------------------------------------------
// Helpers to build campaign objects
// ---------------------------------------------------------------------------

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'camp-id-1',
    status: 'active',
    totalBudget: 1000,
    budgetSpent: 0,
    billingEvent: 'cpm',
    bid: 5.0,
    endAt: new Date(Date.now() + 60 * 60 * 1000), // 60 minutes from now
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const NOW_MS = Date.now();

describe('PacingDaemon.tick', () => {
  describe('throttle triggered', () => {
    it('calls setThrottle(campaignId, 60) when lastMinute exceeds target * 1.2', async () => {
      // budget=1000, spent=0 -> remaining=1000; endAt = 60min from now -> minutesLeft=60
      // avgCpm=5 (CPM campaign, bid=5)
      // target = floor(1000 / 60 / 5 * 1000) = floor(3333.3) = 3333
      // lastMinute=5000 > 3333*1.2=3999.6 -> throttle
      const campaign = makeCampaign({ endAt: new Date(NOW_MS + 60 * 60_000) });
      const mockCampaignModel = makeMockCampaignModel([campaign]);
      const mockImpressionModel = makeMockImpressionModel(5000);
      const fakePacingRepo = makeFakePacingRepo();

      const daemon = new PacingDaemon(
        mockCampaignModel as any,
        mockImpressionModel as any,
        fakePacingRepo as any,
      );

      await daemon.tick(NOW_MS);

      expect(fakePacingRepo.setThrottle).toHaveBeenCalledWith(String(campaign._id), 60);
    });

    it('does NOT call setThrottle when lastMinute is below target', async () => {
      // budget=1000, spent=900 -> remaining=100; endAt = 60min from now -> minutesLeft=60
      // avgCpm=5; target = floor(100 / 60 / 5 * 1000) = floor(333.3) = 333
      // lastMinute=10 < 333*1.2=399.6 -> no throttle
      const campaign = makeCampaign({
        budgetSpent: 900,
        endAt: new Date(NOW_MS + 60 * 60_000),
      });
      const mockCampaignModel = makeMockCampaignModel([campaign]);
      const mockImpressionModel = makeMockImpressionModel(10);
      const fakePacingRepo = makeFakePacingRepo();

      const daemon = new PacingDaemon(
        mockCampaignModel as any,
        mockImpressionModel as any,
        fakePacingRepo as any,
      );

      await daemon.tick(NOW_MS);

      expect(fakePacingRepo.setThrottle).not.toHaveBeenCalled();
    });
  });

  describe('CPC campaign avgCpm calculation', () => {
    it('uses avgCpm = max(1, bid * 10) for CPC campaigns', async () => {
      // CPC campaign: bid=2, avgCpm=max(1, 2*10)=20
      // budget=100, spent=0 -> remaining=100; endAt=10min from now -> minutesLeft=10
      // target = floor(100 / 10 / 20 * 1000) = floor(500) = 500
      // lastMinute=1000 > 500*1.2=600 -> throttle
      //
      // If CPM logic were mistakenly used: avgCpm=2
      // target = floor(100 / 10 / 2 * 1000) = floor(5000) = 5000
      // lastMinute=1000 < 5000*1.2=6000 -> NO throttle
      // So the throttle outcome distinguishes the two paths.
      const campaign = makeCampaign({
        billingEvent: 'cpc',
        bid: 2,
        totalBudget: 100,
        budgetSpent: 0,
        endAt: new Date(NOW_MS + 10 * 60_000),
      });
      const mockCampaignModel = makeMockCampaignModel([campaign]);
      const mockImpressionModel = makeMockImpressionModel(1000);
      const fakePacingRepo = makeFakePacingRepo();

      const daemon = new PacingDaemon(
        mockCampaignModel as any,
        mockImpressionModel as any,
        fakePacingRepo as any,
      );

      await daemon.tick(NOW_MS);

      // With correct avgCpm=20 -> throttle fires; with wrong avgCpm=2 -> no throttle
      expect(fakePacingRepo.setThrottle).toHaveBeenCalledWith(String(campaign._id), 60);
    });
  });

  describe('empty active list', () => {
    it('does not call setThrottle or countDocuments when no active campaigns', async () => {
      const mockCampaignModel = makeMockCampaignModel([]);
      const mockImpressionModel = makeMockImpressionModel(0);
      const fakePacingRepo = makeFakePacingRepo();

      const daemon = new PacingDaemon(
        mockCampaignModel as any,
        mockImpressionModel as any,
        fakePacingRepo as any,
      );

      await daemon.tick(NOW_MS);

      expect(fakePacingRepo.setThrottle).not.toHaveBeenCalled();
      expect(mockImpressionModel.countDocuments).not.toHaveBeenCalled();
    });
  });

  describe('campaign model query', () => {
    it('queries for active campaigns with endAt in the future', async () => {
      const mockCampaignModel = makeMockCampaignModel([]);
      const mockImpressionModel = makeMockImpressionModel(0);
      const fakePacingRepo = makeFakePacingRepo();

      const daemon = new PacingDaemon(
        mockCampaignModel as any,
        mockImpressionModel as any,
        fakePacingRepo as any,
      );

      await daemon.tick(NOW_MS);

      expect(mockCampaignModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
          endAt: expect.objectContaining({ $gt: expect.any(Date) }),
        }),
      );
    });
  });
});
