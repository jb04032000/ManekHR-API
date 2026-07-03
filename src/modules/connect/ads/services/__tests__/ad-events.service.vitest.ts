/**
 * AdEventsService unit tests -- strict TDD.
 *
 * All collaborators are replaced with in-process fakes / spies.
 * No real Mongo, Redis, or network calls.
 *
 * Coverage:
 *   T24 - recordImpression() -- CPM two-phase debit, idempotent, self-impression
 *         guard (F3.7), budget gate + delivered-not-charged (A.2 / F2.4)
 *   T25 - recordClick()      -- CPC debit, idempotent, IVT validation (F3),
 *         budget gate
 *   Budget race (A.2): budget for exactly 1, two concurrent charges -> one win.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AdEventsService,
  IMPRESSION_REPO,
  CAMPAIGN_SPEND_REPO,
  WALLET_DEBITER,
  CLICK_REPO,
} from '../ad-events.service';
import type {
  ImpressionRepo,
  ImpressionView,
  CampaignSpendRepo,
  WalletDebiter,
  ClickRepo,
} from '../ad-events.service';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// ---------------------------------------------------------------------------
// Fake / spy builders
// ---------------------------------------------------------------------------

function makeImpressionView(overrides: Partial<ImpressionView> = {}): ImpressionView {
  return {
    impressionToken: 'tok-default',
    campaignId: 'c1',
    adSetId: 'adset-1',
    ownerUserId: 'w1',
    // Default viewer matches the recordClick tests' USER_ID ('user-abc') so the
    // CN-ADS-11 caller-match gate passes on the happy paths. Tests that exercise
    // the self-impression guard override both viewerUserId + ownerUserId.
    viewerUserId: 'user-abc',
    billingEvent: 'cpm',
    bid: 40,
    charged: false,
    // CN-ADS-11 / CN-ADS-12 (feed harden): fresh servedAt + active status so the
    // new beacon replay-expiry + late-beacon-status gates pass by default.
    servedAt: new Date(),
    campaignStatus: 'active',
    ...overrides,
  };
}

function makeFakes(impressionView: ImpressionView | null = makeImpressionView()) {
  const setViewableAndCharge = vi.fn().mockResolvedValue(true);
  const clearCharge = vi.fn().mockResolvedValue(undefined);
  const tryConsumeBudget = vi.fn().mockResolvedValue(true);
  const debit = vi.fn().mockResolvedValue(undefined);
  const createIfAbsent = vi.fn().mockResolvedValue(true);
  const countByUserCampaignSince = vi.fn().mockResolvedValue(0);
  const setChargeAmount = vi.fn().mockResolvedValue(undefined);
  const capture = vi.fn();

  const impressionRepo: ImpressionRepo = {
    findOne: vi.fn().mockResolvedValue(impressionView),
    setViewableAndCharge,
    clearCharge,
  };

  const campaignSpendRepo: CampaignSpendRepo = { tryConsumeBudget };
  const walletDebiter: WalletDebiter = { debit };
  const clickRepo: ClickRepo = { createIfAbsent, countByUserCampaignSince, setChargeAmount };

  return {
    impressionRepo,
    campaignSpendRepo,
    walletDebiter,
    clickRepo,
    posthog: { capture } as any,
    setViewableAndCharge,
    clearCharge,
    tryConsumeBudget,
    debit,
    createIfAbsent,
    countByUserCampaignSince,
    setChargeAmount,
    capture,
  };
}

function makeService(fakes: ReturnType<typeof makeFakes>): AdEventsService {
  return new AdEventsService(
    fakes.impressionRepo,
    fakes.campaignSpendRepo,
    fakes.walletDebiter,
    fakes.clickRepo,
    fakes.posthog,
  );
}

// ---------------------------------------------------------------------------
// T24 -- recordImpression()
// ---------------------------------------------------------------------------

describe('AdEventsService.recordImpression (T24)', () => {
  const TOKEN = 'tok-impr-1';

  it('CPM happy path: setViewableAndCharge(bid/1000), claims budget, then debit', async () => {
    const fakes = makeFakes(
      makeImpressionView({
        impressionToken: TOKEN,
        billingEvent: 'cpm',
        bid: 40,
        campaignId: 'c1',
        ownerUserId: 'w1',
      }),
    );
    const svc = makeService(fakes);

    await svc.recordImpression(TOKEN);

    expect(fakes.setViewableAndCharge).toHaveBeenCalledWith(TOKEN, 0.04);
    expect(fakes.tryConsumeBudget).toHaveBeenCalledWith('c1', 0.04);
    expect(fakes.debit).toHaveBeenCalledWith('w1', 0.04, 'c1', TOKEN);
    expect(fakes.clearCharge).not.toHaveBeenCalled();
  });

  it('already charged -> early return, no charge or debit', async () => {
    const fakes = makeFakes(makeImpressionView({ impressionToken: TOKEN, charged: true }));
    const svc = makeService(fakes);

    await svc.recordImpression(TOKEN);

    expect(fakes.setViewableAndCharge).not.toHaveBeenCalled();
    expect(fakes.tryConsumeBudget).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('lost per-impression race (setViewableAndCharge false) -> no budget claim, no debit', async () => {
    const fakes = makeFakes(
      makeImpressionView({ impressionToken: TOKEN, billingEvent: 'cpm', bid: 40 }),
    );
    fakes.setViewableAndCharge.mockResolvedValue(false);
    const svc = makeService(fakes);

    await svc.recordImpression(TOKEN);

    expect(fakes.tryConsumeBudget).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('budget exhausted (tryConsumeBudget false) -> clearCharge, no debit, leakage metric', async () => {
    const fakes = makeFakes(
      makeImpressionView({
        impressionToken: TOKEN,
        billingEvent: 'cpm',
        bid: 40,
        campaignId: 'c1',
      }),
    );
    fakes.tryConsumeBudget.mockResolvedValue(false);
    const svc = makeService(fakes);

    await svc.recordImpression(TOKEN);

    expect(fakes.setViewableAndCharge).toHaveBeenCalledWith(TOKEN, 0.04);
    expect(fakes.clearCharge).toHaveBeenCalledWith(TOKEN);
    expect(fakes.debit).not.toHaveBeenCalled();
    expect(fakes.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ads.delivered_not_charged',
        properties: expect.objectContaining({
          reason: 'budget_exhausted',
          eventType: 'impression',
        }),
      }),
    );
  });

  it('self-impression (viewer === owner) -> marks viewable, never charged (F3.7)', async () => {
    const fakes = makeFakes(
      makeImpressionView({
        impressionToken: TOKEN,
        billingEvent: 'cpm',
        bid: 40,
        ownerUserId: 'same',
        viewerUserId: 'same',
      }),
    );
    const svc = makeService(fakes);

    await svc.recordImpression(TOKEN);

    expect(fakes.setViewableAndCharge).toHaveBeenCalledWith(TOKEN, 0);
    expect(fakes.tryConsumeBudget).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
    expect(fakes.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ reason: 'self_impression' }),
      }),
    );
  });

  it('CPC impression -> viewable with zero charge, no billing', async () => {
    const fakes = makeFakes(
      makeImpressionView({ impressionToken: TOKEN, billingEvent: 'cpc', bid: 4 }),
    );
    const svc = makeService(fakes);

    await svc.recordImpression(TOKEN);

    expect(fakes.setViewableAndCharge).toHaveBeenCalledWith(TOKEN, 0);
    expect(fakes.tryConsumeBudget).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('unknown token -> no-op', async () => {
    const fakes = makeFakes(null);
    const svc = makeService(fakes);

    await svc.recordImpression('unknown-tok');

    expect(fakes.setViewableAndCharge).not.toHaveBeenCalled();
    expect(fakes.tryConsumeBudget).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Budget race (A.2): budget for exactly 1 impression, two concurrent charges
// ---------------------------------------------------------------------------

describe('AdEventsService budget race (A.2)', () => {
  it('budget for exactly 1, two concurrent impressions -> only one debit', async () => {
    // Stateful budget fake: campaign affords exactly ONE more 0.04 charge.
    let remaining = 1;
    const tryConsumeBudget = vi.fn().mockImplementation(() => {
      if (remaining > 0) {
        remaining -= 1;
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });
    const debit = vi.fn().mockResolvedValue(undefined);
    const clearCharge = vi.fn().mockResolvedValue(undefined);

    // Two different impression tokens of the same near-exhausted campaign, both
    // winning their own per-impression once-guard.
    const viewA = makeImpressionView({
      impressionToken: 'A',
      billingEvent: 'cpm',
      bid: 40,
      campaignId: 'c1',
    });
    const viewB = makeImpressionView({
      impressionToken: 'B',
      billingEvent: 'cpm',
      bid: 40,
      campaignId: 'c1',
    });

    const impressionRepo: ImpressionRepo = {
      findOne: vi
        .fn()
        .mockImplementation((t: string) => Promise.resolve(t === 'A' ? viewA : viewB)),
      setViewableAndCharge: vi.fn().mockResolvedValue(true),
      clearCharge,
    };
    const svc = new AdEventsService(
      impressionRepo,
      { tryConsumeBudget },
      { debit },
      { createIfAbsent: vi.fn(), countByUserCampaignSince: vi.fn(), setChargeAmount: vi.fn() },
    );

    await Promise.all([svc.recordImpression('A'), svc.recordImpression('B')]);

    // Exactly one charge landed; the loser was rolled back (clearCharge).
    expect(debit).toHaveBeenCalledTimes(1);
    expect(clearCharge).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T25 -- recordClick() + IVT (F3)
// ---------------------------------------------------------------------------

describe('AdEventsService.recordClick (T25)', () => {
  const TOKEN = 'tok-click-1';
  const USER_ID = 'user-abc';

  it('CPC valid click: records valid, claims budget, debits once with click: key', async () => {
    const fakes = makeFakes(
      makeImpressionView({
        impressionToken: TOKEN,
        billingEvent: 'cpc',
        bid: 4,
        campaignId: 'c1',
        ownerUserId: 'w1',
      }),
    );
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, BROWSER_UA);

    expect(fakes.createIfAbsent).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ valid: true, invalidReason: null, chargeAmount: 4 }),
    );
    expect(fakes.tryConsumeBudget).toHaveBeenCalledWith('c1', 4);
    expect(fakes.debit).toHaveBeenCalledTimes(1);
    expect(fakes.debit).toHaveBeenCalledWith('w1', 4, 'c1', 'click:' + TOKEN);
  });

  it('duplicate click (createIfAbsent false) -> no budget claim, no debit', async () => {
    const fakes = makeFakes(
      makeImpressionView({ impressionToken: TOKEN, billingEvent: 'cpc', bid: 4 }),
    );
    fakes.createIfAbsent.mockResolvedValue(false);
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, BROWSER_UA);

    expect(fakes.tryConsumeBudget).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('CPM campaign click -> recorded with chargeAmount 0, not charged', async () => {
    const fakes = makeFakes(
      makeImpressionView({
        impressionToken: TOKEN,
        billingEvent: 'cpm',
        bid: 40,
        campaignId: 'c1',
      }),
    );
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, BROWSER_UA);

    expect(fakes.createIfAbsent).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ chargeAmount: 0, valid: true }),
    );
    expect(fakes.tryConsumeBudget).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('budget exhausted on CPC click -> records, no debit, resets chargeAmount, leakage metric', async () => {
    const fakes = makeFakes(
      makeImpressionView({ impressionToken: TOKEN, billingEvent: 'cpc', bid: 4, campaignId: 'c1' }),
    );
    fakes.tryConsumeBudget.mockResolvedValue(false);
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, BROWSER_UA);

    expect(fakes.debit).not.toHaveBeenCalled();
    expect(fakes.setChargeAmount).toHaveBeenCalledWith(TOKEN, 0);
    expect(fakes.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ reason: 'budget_exhausted', eventType: 'click' }),
      }),
    );
  });

  it('unknown token -> no-op', async () => {
    const fakes = makeFakes(null);
    const svc = makeService(fakes);

    await svc.recordClick('unknown-tok', USER_ID, BROWSER_UA);

    expect(fakes.createIfAbsent).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  // ---- IVT rules: invalid clicks are stored with reason but never billed ----

  it('IVT self-click: clicker is the campaign owner -> invalid, stored, not charged', async () => {
    const fakes = makeFakes(
      makeImpressionView({
        impressionToken: TOKEN,
        billingEvent: 'cpc',
        bid: 4,
        ownerUserId: USER_ID,
      }),
    );
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, BROWSER_UA);

    expect(fakes.createIfAbsent).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ valid: false, invalidReason: 'self_click', chargeAmount: 0 }),
    );
    expect(fakes.tryConsumeBudget).not.toHaveBeenCalled();
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('IVT bot UA -> invalid (bot_ua), stored, not charged', async () => {
    const fakes = makeFakes(
      makeImpressionView({ impressionToken: TOKEN, billingEvent: 'cpc', bid: 4 }),
    );
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, 'curl/8.4.0');

    expect(fakes.createIfAbsent).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ valid: false, invalidReason: 'bot_ua', chargeAmount: 0 }),
    );
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('IVT missing UA -> invalid (bot_ua), not charged', async () => {
    const fakes = makeFakes(
      makeImpressionView({ impressionToken: TOKEN, billingEvent: 'cpc', bid: 4 }),
    );
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, undefined);

    expect(fakes.createIfAbsent).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ valid: false, invalidReason: 'bot_ua' }),
    );
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('IVT rapid duplicate (prior click in dedupe window) -> invalid, not charged', async () => {
    const fakes = makeFakes(
      makeImpressionView({ impressionToken: TOKEN, billingEvent: 'cpc', bid: 4 }),
    );
    // recent-window count >= 1.
    fakes.countByUserCampaignSince.mockResolvedValue(1);
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, BROWSER_UA);

    expect(fakes.createIfAbsent).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ valid: false, invalidReason: 'rapid_duplicate' }),
    );
    expect(fakes.debit).not.toHaveBeenCalled();
  });

  it('IVT daily cap exceeded -> invalid (daily_cap), not charged', async () => {
    const fakes = makeFakes(
      makeImpressionView({ impressionToken: TOKEN, billingEvent: 'cpc', bid: 4 }),
    );
    // First call = recent window (0), second = daily window (>= cap).
    fakes.countByUserCampaignSince.mockResolvedValueOnce(0).mockResolvedValueOnce(10);
    const svc = makeService(fakes);

    await svc.recordClick(TOKEN, USER_ID, BROWSER_UA);

    expect(fakes.createIfAbsent).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ valid: false, invalidReason: 'daily_cap' }),
    );
    expect(fakes.debit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Injection tokens exported
// ---------------------------------------------------------------------------

describe('injection tokens exported', () => {
  it('exports all 4 injection tokens as distinct non-empty strings', () => {
    const tokens = [IMPRESSION_REPO, CAMPAIGN_SPEND_REPO, WALLET_DEBITER, CLICK_REPO];
    expect(new Set(tokens).size).toBe(4);
    tokens.forEach((t) => expect(t.length).toBeGreaterThan(0));
  });
});
