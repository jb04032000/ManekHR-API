/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// ---- Will fail until reconcile.cron.ts exists (RED phase for pure helper) ----
import {
  ReconcileCron,
  reconcileAmount,
  reservedDelta,
  expectedReservedFromLedger,
  reservedDrift,
} from '../reconcile.cron';

// ---------------------------------------------------------------------------
// Pure helper tests (full TDD coverage)
// ---------------------------------------------------------------------------

describe('reconcileAmount', () => {
  it('returns the unspent reserve for a completed campaign', () => {
    expect(
      reconcileAmount({ status: 'completed', reservedForCampaign: 500, confirmedSpend: 120 }),
    ).toBe(380);
  });

  it('returns 0 for an active campaign (nothing to reconcile yet)', () => {
    expect(
      reconcileAmount({ status: 'active', reservedForCampaign: 500, confirmedSpend: 120 }),
    ).toBe(0);
  });

  it('returns 0 for a pending_review campaign', () => {
    expect(
      reconcileAmount({ status: 'pending_review', reservedForCampaign: 500, confirmedSpend: 120 }),
    ).toBe(0);
  });

  it('returns the unspent reserve for a paused campaign', () => {
    expect(
      reconcileAmount({ status: 'paused', reservedForCampaign: 500, confirmedSpend: 120 }),
    ).toBe(380);
  });

  it('clamps to 0 when confirmed spend exceeds reserved (over-spent edge case)', () => {
    expect(
      reconcileAmount({ status: 'completed', reservedForCampaign: 500, confirmedSpend: 600 }),
    ).toBe(0);
  });

  it('returns 0 when spend exactly equals reserved (fully spent)', () => {
    expect(
      reconcileAmount({ status: 'completed', reservedForCampaign: 500, confirmedSpend: 500 }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reserved-drift reconstruction (claimed-but-never-debited crash window)
// ---------------------------------------------------------------------------

describe('reservedDelta', () => {
  it('reserve raises reserved by |amount| (amount is negative)', () => {
    expect(reservedDelta('reserve', -100)).toBe(100);
  });
  it('debit lowers reserved by |amount| (amount is negative)', () => {
    expect(reservedDelta('debit', -30)).toBe(-30);
  });
  it('release lowers reserved by amount (amount is positive)', () => {
    expect(reservedDelta('release', 20)).toBe(-20);
  });
  it('topup / grant / grant_expire do not touch reserved', () => {
    expect(reservedDelta('topup', 100)).toBe(0);
    expect(reservedDelta('grant', 50)).toBe(0);
    expect(reservedDelta('grant_expire', -50)).toBe(0);
  });
});

describe('expectedReservedFromLedger', () => {
  it('sums the per-row reserved deltas (reserve - debit - release)', () => {
    // reserve 100, debit 30, release 20 -> 100 - 30 - 20 = 50 still reserved.
    expect(
      expectedReservedFromLedger([
        { type: 'reserve', amount: -100 },
        { type: 'debit', amount: -30 },
        { type: 'release', amount: 20 },
        { type: 'topup', amount: 500 }, // ignored
      ]),
    ).toBe(50);
  });
});

describe('reservedDrift', () => {
  it('positive drift = actual exceeds ledger-implied (claimed-but-never-debited)', () => {
    expect(reservedDrift(130, 100)).toBe(30);
  });
  it('zero when actual matches expected', () => {
    expect(reservedDrift(100, 100)).toBe(0);
  });
});

describe('ReconcileCron.detectReservedDrift (report-only)', () => {
  function chain(result: unknown) {
    const c: any = {
      select: vi.fn(() => c),
      lean: vi.fn(() => c),
      exec: vi.fn().mockResolvedValue(result),
    };
    return c;
  }

  it('flags a positive-drift owner as claimedNotDebited and skips owners with adjustments', async () => {
    // A: expected 100, actual 130 -> +30 drift (crash-window fingerprint).
    // B: expected 50, actual 50  -> clean.
    // C: has an adjustment row   -> skipped (unreconstructable).
    const ledgerModel = {
      aggregate: vi.fn(() =>
        Promise.resolve([
          { _id: 'A', expectedReserved: 100, hasAdjustment: 0 },
          { _id: 'B', expectedReserved: 50, hasAdjustment: 0 },
          { _id: 'C', expectedReserved: 30, hasAdjustment: 1 },
        ]),
      ),
    };
    const walletModel = {
      find: vi.fn(() =>
        chain([
          { ownerUserId: 'A', reserved: 130 },
          { ownerUserId: 'B', reserved: 50 },
          { ownerUserId: 'C', reserved: 999 },
        ]),
      ),
    };
    const mockPosthog = { capture: vi.fn() };

    const cron = new ReconcileCron(
      makeMockCampaignModel([]) as any,
      makeMockWallet() as any,
      makeMockSingleFlight() as any,
      mockPosthog as any,
      ledgerModel as any,
      walletModel as any,
    );

    const summary = await cron.detectReservedDrift();

    expect(summary.ownersChecked).toBe(2); // A + B (C skipped)
    expect(summary.ownersSkipped).toBe(1); // C
    expect(summary.claimedNotDebited).toBe(1); // A
    expect(summary.underReserved).toBe(0);
    // Report-only: emits a metric, never mutates the wallet.
    const evt = mockPosthog.capture.mock.calls.find(
      (c: any) => c[0].event === 'ads.reserved_drift_scan',
    );
    expect(evt).toBeTruthy();
  });

  it('no-ops cleanly when the ledger/wallet models are not injected (positional unit construction)', async () => {
    const cron = new ReconcileCron(makeMockCampaignModel([]) as any, makeMockWallet() as any);
    const summary = await cron.detectReservedDrift();
    expect(summary).toEqual({
      ownersChecked: 0,
      ownersSkipped: 0,
      claimedNotDebited: 0,
      underReserved: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// ReconcileCron.tick tests (mock models)
// ---------------------------------------------------------------------------

function makeCampaignDoc(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: 'camp-id-1',
    ownerUserId: 'ws-1',
    status: 'active',
    totalBudget: 500,
    budgetSpent: 120,
    endAt: new Date(Date.now() - 60_000), // ended 1 minute ago
    save: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return doc;
}

function makeMockCampaignModel(docs: any[]) {
  return {
    find: vi.fn(() => Promise.resolve(docs)),
  };
}

function makeMockWallet() {
  return {
    release: vi.fn((): Promise<void> => Promise.resolve()),
  };
}

// The cron constructor takes `singleFlight` as its 3rd arg (added during the
// scheduler-hardening work); tick() does not use it (only run() does), so a
// no-op stub is enough. Without it, PostHog (the 4th arg) lands in the wrong
// slot and never fires.
function makeMockSingleFlight() {
  return { runExclusive: vi.fn() };
}

const NOW_MS = Date.now();

describe('ReconcileCron.tick', () => {
  describe('ended campaign with unspent reserve', () => {
    it('calls wallet.release with the gap amount, sets status to completed, and saves', async () => {
      const doc = makeCampaignDoc(); // totalBudget 500, budgetSpent 120 -> gap 380
      const mockCampaignModel = makeMockCampaignModel([doc]);
      const mockWallet = makeMockWallet();

      const cron = new ReconcileCron(mockCampaignModel as any, mockWallet as any);
      await cron.tick(NOW_MS);

      expect(mockWallet.release).toHaveBeenCalledWith('ws-1', 380, 'camp-id-1'); // ownerUserId = 'ws-1'
      expect(doc.status).toBe('completed');
      expect(doc.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('fully-spent ended campaign', () => {
    it('does NOT call wallet.release when gap is 0, but still sets completed and saves', async () => {
      const doc = makeCampaignDoc({ totalBudget: 500, budgetSpent: 500 }); // gap = 0
      const mockCampaignModel = makeMockCampaignModel([doc]);
      const mockWallet = makeMockWallet();

      const cron = new ReconcileCron(mockCampaignModel as any, mockWallet as any);
      await cron.tick(NOW_MS);

      expect(mockWallet.release).not.toHaveBeenCalled();
      expect(doc.status).toBe('completed');
      expect(doc.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('no ended campaigns', () => {
    it('neither calls release nor save when find returns empty array', async () => {
      const mockCampaignModel = makeMockCampaignModel([]);
      const mockWallet = makeMockWallet();

      const cron = new ReconcileCron(mockCampaignModel as any, mockWallet as any);
      await cron.tick(NOW_MS);

      expect(mockWallet.release).not.toHaveBeenCalled();
    });
  });

  describe('campaign model query', () => {
    it('queries for active campaigns with endAt <= nowMs', async () => {
      const mockCampaignModel = makeMockCampaignModel([]);
      const mockWallet = makeMockWallet();

      const cron = new ReconcileCron(mockCampaignModel as any, mockWallet as any);
      await cron.tick(NOW_MS);

      expect(mockCampaignModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
          endAt: expect.objectContaining({ $lte: expect.any(Date) }),
        }),
      );
    });
  });

  describe('multiple ended campaigns', () => {
    it('reconciles all of them independently', async () => {
      const doc1 = makeCampaignDoc({
        _id: 'c1',
        ownerUserId: 'ws-1',
        totalBudget: 500,
        budgetSpent: 100,
      });
      const doc2 = makeCampaignDoc({
        _id: 'c2',
        ownerUserId: 'ws-2',
        totalBudget: 200,
        budgetSpent: 200,
      });
      const mockCampaignModel = makeMockCampaignModel([doc1, doc2]);
      const mockWallet = makeMockWallet();

      const cron = new ReconcileCron(mockCampaignModel as any, mockWallet as any);
      await cron.tick(NOW_MS);

      // doc1: gap = 400, release called
      expect(mockWallet.release).toHaveBeenCalledWith('ws-1', 400, 'c1');
      // doc2: gap = 0, release NOT called
      expect(mockWallet.release).not.toHaveBeenCalledWith('ws-2', expect.any(Number), 'c2');
      expect(doc1.status).toBe('completed');
      expect(doc2.status).toBe('completed');
      expect(doc1.save).toHaveBeenCalledTimes(1);
      expect(doc2.save).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// ReconcileCron -- PostHog emit (T34)
// ---------------------------------------------------------------------------

describe('ReconcileCron.tick -- PostHog emit (T34)', () => {
  it('emits ads.campaign_completed per completed campaign with campaignId and released amount', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-ph-1',
      ownerUserId: 'user-ph-1',
      totalBudget: 500,
      budgetSpent: 120,
    });
    const mockCampaignModel = makeMockCampaignModel([doc]);
    const mockWallet = makeMockWallet();
    const mockPosthog = { capture: vi.fn() };

    const cron = new ReconcileCron(
      mockCampaignModel as any,
      mockWallet as any,
      makeMockSingleFlight() as any,
      mockPosthog as any,
    );
    await cron.tick(NOW_MS);

    expect(mockPosthog.capture).toHaveBeenCalledOnce();
    const call = mockPosthog.capture.mock.calls[0][0];
    expect(call.distinctId).toBe('user-ph-1');
    expect(call.event).toBe('ads.campaign_completed');
    expect(call.properties.campaignId).toBe('camp-ph-1');
    expect(call.properties.released).toBe(380); // 500 - 120
  });

  it('emits ads.campaign_completed with released=0 for a fully-spent campaign', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-ph-2',
      ownerUserId: 'user-ph-2',
      totalBudget: 500,
      budgetSpent: 500,
    });
    const mockCampaignModel = makeMockCampaignModel([doc]);
    const mockWallet = makeMockWallet();
    const mockPosthog = { capture: vi.fn() };

    const cron = new ReconcileCron(
      mockCampaignModel as any,
      mockWallet as any,
      makeMockSingleFlight() as any,
      mockPosthog as any,
    );
    await cron.tick(NOW_MS);

    expect(mockPosthog.capture).toHaveBeenCalledOnce();
    const call = mockPosthog.capture.mock.calls[0][0];
    expect(call.properties.released).toBe(0);
  });

  it('does NOT emit when posthog is undefined (existing tests use 2-arg construction)', async () => {
    const doc = makeCampaignDoc();
    const mockCampaignModel = makeMockCampaignModel([doc]);
    const mockWallet = makeMockWallet();

    // Original 2-arg construction - posthog is undefined.
    const cron = new ReconcileCron(mockCampaignModel as any, mockWallet as any);
    await expect(cron.tick(NOW_MS)).resolves.toBeUndefined();
  });

  it('emits once per campaign when multiple campaigns complete', async () => {
    const doc1 = makeCampaignDoc({
      _id: 'camp-m1',
      ownerUserId: 'u1',
      totalBudget: 300,
      budgetSpent: 100,
    });
    const doc2 = makeCampaignDoc({
      _id: 'camp-m2',
      ownerUserId: 'u2',
      totalBudget: 200,
      budgetSpent: 200,
    });
    const mockCampaignModel = makeMockCampaignModel([doc1, doc2]);
    const mockWallet = makeMockWallet();
    const mockPosthog = { capture: vi.fn() };

    const cron = new ReconcileCron(
      mockCampaignModel as any,
      mockWallet as any,
      makeMockSingleFlight() as any,
      mockPosthog as any,
    );
    await cron.tick(NOW_MS);

    expect(mockPosthog.capture).toHaveBeenCalledTimes(2);
    const ids = mockPosthog.capture.mock.calls.map((c: any) => c[0].properties.campaignId);
    expect(ids).toContain('camp-m1');
    expect(ids).toContain('camp-m2');
  });
});
