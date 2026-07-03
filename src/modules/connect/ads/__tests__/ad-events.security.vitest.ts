/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method --
   unbound-method: expect(fakeRepo.method) references a plain vi.fn() on a fake
   object literal, not a real unbound method; nothing here relies on `this`. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AdEventsService,
  type ImpressionView,
  type ImpressionRepo,
  type CampaignSpendRepo,
  type WalletDebiter,
  type ClickRepo,
} from '../services/ad-events.service';

/**
 * CN-ADS-11 (beacon caller-match + replay expiry) + CN-ADS-12 (late-beacon
 * campaign-status gate) coverage for AdEventsService. Fake repos (plain objects)
 * so no Mongo/Nest is needed — the service takes them via constructor injection.
 */

const VIEWER = 'viewer-1';
const OWNER = 'owner-1';
const TOKEN = 'tok-abc';

function impression(over: Partial<ImpressionView> = {}): ImpressionView {
  return {
    impressionToken: TOKEN,
    campaignId: 'camp-1',
    adSetId: 'set-1',
    ownerUserId: OWNER,
    viewerUserId: VIEWER,
    billingEvent: 'cpm',
    bid: 1000,
    charged: false,
    servedAt: new Date(), // fresh
    campaignStatus: 'active',
    ...over,
  };
}

function build(impr: ImpressionView | null) {
  const impressions: ImpressionRepo = {
    findOne: vi.fn().mockResolvedValue(impr),
    setViewableAndCharge: vi.fn().mockResolvedValue(true),
    clearCharge: vi.fn().mockResolvedValue(undefined),
  };
  const campaigns: CampaignSpendRepo = { tryConsumeBudget: vi.fn().mockResolvedValue(true) };
  const wallet: WalletDebiter = { debit: vi.fn().mockResolvedValue(undefined) };
  const clicks: ClickRepo = {
    createIfAbsent: vi.fn().mockResolvedValue(true),
    countByUserCampaignSince: vi.fn().mockResolvedValue(0),
    setChargeAmount: vi.fn().mockResolvedValue(undefined),
  };
  const svc = new AdEventsService(
    impressions as any,
    campaigns as any,
    wallet as any,
    clicks as any,
  );
  return { svc, impressions, campaigns, wallet, clicks };
}

describe('AdEventsService.recordImpression — CN-ADS-11 / CN-ADS-12', () => {
  beforeEach(() => vi.clearAllMocks());

  it('CN-ADS-11: ignores a beacon fired by a different account than the served viewer', async () => {
    const { svc, wallet, impressions } = build(impression());
    await svc.recordImpression(TOKEN, 'someone-else');
    // No charge path ran at all.
    expect(impressions.setViewableAndCharge).not.toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('CN-ADS-11: rejects a beacon received past the replay window (no charge)', async () => {
    const stale = impression({ servedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }); // 2h old
    const { svc, wallet } = build(stale);
    await svc.recordImpression(TOKEN, VIEWER);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('CN-ADS-12: a late impression beacon for a non-active campaign is delivered-not-charged', async () => {
    const paused = impression({ campaignStatus: 'paused' });
    const { svc, wallet, campaigns, impressions } = build(paused);
    await svc.recordImpression(TOKEN, VIEWER);
    // Marked viewable with zero charge; no budget claim, no debit.
    expect(impressions.setViewableAndCharge).toHaveBeenCalledWith(TOKEN, 0);
    expect(campaigns.tryConsumeBudget).not.toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('charges a fresh, active, correctly-attributed CPM impression', async () => {
    const { svc, wallet } = build(impression());
    await svc.recordImpression(TOKEN, VIEWER);
    // bid 1000 / 1000 = 1 credit debited.
    expect(wallet.debit).toHaveBeenCalledWith(OWNER, 1, 'camp-1', TOKEN);
  });
});

describe('AdEventsService.recordClick — CN-ADS-11 / CN-ADS-12', () => {
  beforeEach(() => vi.clearAllMocks());

  it('CN-ADS-11: ignores a click beacon from a different account than the served viewer', async () => {
    const { svc, clicks, wallet } = build(impression({ billingEvent: 'cpc' }));
    await svc.recordClick(TOKEN, 'someone-else');
    expect(clicks.createIfAbsent).not.toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('CN-ADS-12: a late CPC click for a non-active campaign is delivered-not-charged', async () => {
    const completed = impression({ billingEvent: 'cpc', campaignStatus: 'completed' });
    const { svc, wallet, campaigns } = build(completed);
    await svc.recordClick(TOKEN, VIEWER);
    // The click row is recorded (analytics), but no budget claim / debit.
    expect(campaigns.tryConsumeBudget).not.toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('charges a valid CPC click on a fresh, active campaign by the served viewer', async () => {
    const { svc, wallet } = build(impression({ billingEvent: 'cpc' }));
    // A real browser user-agent -> not classified as a bot by the IVT filter
    // (an empty UA is treated as a bot, which would correctly skip billing).
    await svc.recordClick(TOKEN, VIEWER, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120');
    expect(wallet.debit).toHaveBeenCalledWith(OWNER, 1000, 'camp-1', 'click:' + TOKEN);
  });
});
