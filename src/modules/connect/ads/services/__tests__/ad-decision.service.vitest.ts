import { describe, it, expect, vi } from 'vitest';

// ---- These imports will fail until the service file exists (RED) ----
import {
  AdDecisionService,
  PLACEMENT_REPO,
  CANDIDATE_REPO,
  PROFILE_REPO,
  FREQ_CAP_REPO,
  PACING_REPO,
  IMPRESSION_OPENER,
} from '../ad-decision.service';
import type {
  Placement,
  Candidate,
  PlacementRepo,
  CandidateRepo,
  ProfileRepo,
  FreqCapRepo,
  PacingRepo,
  ImpressionOpener,
} from '../ad-decision.service';
import type { AdProfile } from '../../lib/targeting';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE: AdProfile = {
  role: 'manager',
  skills: ['textile'],
  district: 'surat',
  companySize: '50-200',
  connectionDegree: 1,
};

const PLACEMENT_ENABLED: Placement = {
  key: 'feed_promoted_post',
  surface: 'feed',
  floorCpm: 1.0,
  enabled: true,
};

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    campaignId: 'camp-1',
    adSetId: 'adset-1',
    creativeId: 'creative-1',
    authorUserId: 'author-user',
    creativeKind: 'promoted_post',
    postRef: 'post/123',
    billingEvent: 'cpm',
    bid: 5.0,
    predictedCtr: 0.01,
    relevance: 0.8,
    targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
    freqCapCount: 10,
    freqCapWindowSec: 86400,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake collaborators
// ---------------------------------------------------------------------------

function makeFakes(
  opts: {
    placement?: Placement | null;
    candidates?: Candidate[];
    isThrottled?: boolean;
    freqCapResult?: boolean;
    impressionToken?: string;
  } = {},
) {
  const {
    placement = PLACEMENT_ENABLED,
    candidates = [makeCandidate()],
    isThrottled = false,
    freqCapResult = true,
    impressionToken = 'tok-abc',
  } = opts;

  const topSpy = vi.fn((_key: string, _limit: number) => Promise.resolve(candidates));
  const openSpy = vi.fn(() => Promise.resolve({ impressionToken }));

  const placements: PlacementRepo = {
    get: vi.fn((_key: string) => Promise.resolve(placement)),
  };

  const candidatesRepo: CandidateRepo = { top: topSpy };

  const profiles: ProfileRepo = {
    get: vi.fn((_userId: string) => Promise.resolve(PROFILE)),
  };

  const freqCap: FreqCapRepo = {
    hitAndCheck: vi.fn((_userId: string, _adSetId: string, _windowSec: number, _cap: number) =>
      Promise.resolve(freqCapResult),
    ),
  };

  const pacing: PacingRepo = {
    isThrottled: vi.fn((_campaignId: string) => Promise.resolve(isThrottled)),
  };

  const impressions: ImpressionOpener = { open: openSpy };

  const captureSpy = vi.fn();
  const posthog = { capture: captureSpy } as any;

  return {
    placements,
    candidatesRepo,
    profiles,
    freqCap,
    pacing,
    impressions,
    topSpy,
    openSpy,
    posthog,
    captureSpy,
  };
}

function makeService(fakes: ReturnType<typeof makeFakes>): AdDecisionService {
  return new AdDecisionService(
    fakes.placements,
    fakes.candidatesRepo,
    fakes.profiles,
    fakes.freqCap,
    fakes.pacing,
    fakes.impressions,
    fakes.posthog,
  );
}

/** Pull the outcome from the single ads.auction_decided telemetry event. */
function lastOutcome(captureSpy: ReturnType<typeof vi.fn>): string | undefined {
  const call = captureSpy.mock.calls.find((c) => c[0]?.event === 'ads.auction_decided');
  return call?.[0]?.properties?.outcome;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdDecisionService.decide', () => {
  describe('placement guard', () => {
    it('returns null when placement does not exist', async () => {
      const fakes = makeFakes({ placement: null });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'u1', placementKey: 'feed_promoted_post' });

      expect(result).toBeNull();
      expect(fakes.topSpy).not.toHaveBeenCalled();
    });

    it('returns null when placement is disabled', async () => {
      const fakes = makeFakes({ placement: { ...PLACEMENT_ENABLED, enabled: false } });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'u1', placementKey: 'feed_promoted_post' });

      expect(result).toBeNull();
      expect(fakes.topSpy).not.toHaveBeenCalled();
    });
  });

  describe('happy path - winner + token', () => {
    it('returns impressionToken, postRef, campaignId from winner + opener', async () => {
      const candidate = makeCandidate({
        campaignId: 'camp-win',
        postRef: 'post/456',
        authorUserId: 'other-author',
      });
      const fakes = makeFakes({ candidates: [candidate], impressionToken: 'tok-win' });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).not.toBeNull();
      expect(result.impressionToken).toBe('tok-win');
      expect(result.postRef).toBe('post/456');
      expect(result.campaignId).toBe('camp-win');
    });

    it('calls impressions.open with winner ids + userId + placementKey', async () => {
      const candidate = makeCandidate({
        campaignId: 'camp-A',
        adSetId: 'adset-A',
        creativeId: 'creative-A',
        authorUserId: 'not-viewer',
      });
      const fakes = makeFakes({ candidates: [candidate] });
      const svc = makeService(fakes);

      await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(fakes.openSpy).toHaveBeenCalledWith({
        campaignId: 'camp-A',
        adSetId: 'adset-A',
        creativeId: 'creative-A',
        userId: 'viewer',
        placementKey: 'feed_promoted_post',
      });
    });

    it('returns creativeKind=promoted_listing + listingRef (no postRef) for a listing winner', async () => {
      const candidate = makeCandidate({
        campaignId: 'camp-listing',
        creativeKind: 'promoted_listing',
        postRef: undefined,
        listingRef: 'listing/789',
        authorUserId: 'other-author',
      });
      const fakes = makeFakes({ candidates: [candidate], impressionToken: 'tok-listing' });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'marketplace_rail' });

      expect(result).not.toBeNull();
      expect(result.creativeKind).toBe('promoted_listing');
      expect(result.listingRef).toBe('listing/789');
      expect(result.postRef).toBeUndefined();
      expect(result.campaignId).toBe('camp-listing');
    });
  });

  describe('own-author exclusion', () => {
    it('returns null when the sole candidate is authored by the requesting user', async () => {
      const candidate = makeCandidate({ authorUserId: 'viewer-self' });
      const fakes = makeFakes({ candidates: [candidate] });
      const svc = makeService(fakes);

      const result = await svc.decide({
        userId: 'viewer-self',
        placementKey: 'feed_promoted_post',
      });

      expect(result).toBeNull();
    });
  });

  // Cross-sell rails (company_page etc.) run the SAME decide() path, so the
  // self-view + block gates must hold there too. The leak gate itself is enforced
  // at web hydration (public listing getter); these prove the BE auction never
  // emits a self / blocked candidate regardless of placement.
  describe('cross-sell rail gates hold (company_page)', () => {
    const COMPANY_PAGE: Placement = { ...PLACEMENT_ENABLED, key: 'company_page', surface: 'rail' };

    it('self-view: a viewer never sees their own listing boost on a cross-sell rail', async () => {
      const candidate = makeCandidate({
        creativeKind: 'promoted_listing',
        listingRef: 'listing/1',
        authorUserId: 'viewer-self',
      });
      const fakes = makeFakes({ candidates: [candidate], placement: COMPANY_PAGE });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer-self', placementKey: 'company_page' });
      expect(result).toBeNull();
    });

    it('block gate: a blocked author never serves on a cross-sell rail', async () => {
      const candidate = makeCandidate({
        creativeKind: 'promoted_listing',
        listingRef: 'listing/1',
        authorUserId: 'blocked-author',
      });
      const fakes = makeFakes({ candidates: [candidate], placement: COMPANY_PAGE });
      const blocks = { isBlocked: vi.fn(() => Promise.resolve(true)) };
      const svc = new AdDecisionService(
        fakes.placements,
        fakes.candidatesRepo,
        fakes.profiles,
        fakes.freqCap,
        fakes.pacing,
        fakes.impressions,
        fakes.posthog,
        blocks as any,
      );

      const result = await svc.decide({ userId: 'viewer', placementKey: 'company_page' });
      expect(result).toBeNull();
      expect(blocks.isBlocked).toHaveBeenCalledWith('viewer', 'blocked-author');
    });

    it('serves a non-self, non-blocked listing boost on a cross-sell rail', async () => {
      const candidate = makeCandidate({
        campaignId: 'camp-listing',
        creativeKind: 'promoted_listing',
        listingRef: 'listing/9',
        authorUserId: 'other-author',
        bid: 5,
      });
      const fakes = makeFakes({ candidates: [candidate], placement: COMPANY_PAGE });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'company_page' });
      expect(result).not.toBeNull();
      expect(result?.listingRef).toBe('listing/9');
      expect(result?.campaignId).toBe('camp-listing');
    });
  });

  describe('targeting filter', () => {
    it('returns null when the sole candidate targeting does not match the viewer profile', async () => {
      const candidate = makeCandidate({
        targeting: {
          roles: ['ceo'],
          sectors: [],
          districts: [],
          companySizes: [],
        },
        authorUserId: 'other-author',
      });
      const fakes = makeFakes({ candidates: [candidate] });
      // PROFILE has role 'manager', so this candidate requires 'ceo' - no match
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).toBeNull();
    });
  });

  describe('pacing throttle', () => {
    it('returns null when pacing is throttled for the sole candidate', async () => {
      const fakes = makeFakes({ isThrottled: true });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).toBeNull();
    });
  });

  describe('frequency cap', () => {
    it('returns null when freqCap.hitAndCheck returns false for the sole candidate', async () => {
      const fakes = makeFakes({ freqCapResult: false });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).toBeNull();
    });
  });

  describe('floor CPM fallback', () => {
    it('returns null when winner eCPM is below placement floorCpm', async () => {
      // candidate bid=0.5 CPM, floor=1.0 -> winner fails floor check
      const candidate = makeCandidate({
        billingEvent: 'cpm',
        bid: 0.5,
        authorUserId: 'other-author',
      });
      const placement: Placement = { ...PLACEMENT_ENABLED, floorCpm: 1.0 };
      const fakes = makeFakes({ placement, candidates: [candidate] });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).toBeNull();
      expect(fakes.openSpy).not.toHaveBeenCalled();
    });
  });

  describe('multi-candidate scoring', () => {
    it('picks the candidate with the highest score (higher bid wins, opener called with winning campaignId)', async () => {
      const lowBid = makeCandidate({
        campaignId: 'camp-low',
        adSetId: 'adset-low',
        creativeId: 'creative-low',
        bid: 2.0,
        billingEvent: 'cpm',
        relevance: 0.5,
        authorUserId: 'other-author',
        postRef: 'post/low',
      });
      const highBid = makeCandidate({
        campaignId: 'camp-high',
        adSetId: 'adset-high',
        creativeId: 'creative-high',
        bid: 8.0,
        billingEvent: 'cpm',
        relevance: 0.5,
        authorUserId: 'other-author',
        postRef: 'post/high',
      });
      const fakes = makeFakes({ candidates: [lowBid, highBid], impressionToken: 'tok-high' });
      const svc = makeService(fakes);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).not.toBeNull();
      expect(result.campaignId).toBe('camp-high');
      expect(fakes.openSpy).toHaveBeenCalledWith(
        expect.objectContaining({ campaignId: 'camp-high' }),
      );
    });
  });

  describe('region (district) unknown-location down-rank', () => {
    /** Build a service whose viewer profile has the given district. */
    function makeServiceForDistrict(
      district: string,
      candidates: Candidate[],
    ): { svc: AdDecisionService; openSpy: ReturnType<typeof vi.fn> } {
      const fakes = makeFakes({ candidates });
      (fakes.profiles.get as any).mockResolvedValue({ ...PROFILE, district });
      return { svc: makeService(fakes), openSpy: fakes.openSpy };
    }

    it('down-ranks an unknown-location district match below an equal-bid non-region candidate', async () => {
      // Viewer district is unrecognized -> a district-targeted candidate matches
      // ONLY via the unknown-location fallback and is down-ranked (x0.7), so the
      // equal-bid candidate WITHOUT district targeting wins the slot.
      const regionTargeted = makeCandidate({
        campaignId: 'camp-region',
        adSetId: 'as-region',
        bid: 5,
        relevance: 1,
        authorUserId: 'other',
        targeting: { roles: [], sectors: [], districts: ['Surat'], companySizes: [] },
      });
      const noRegion = makeCandidate({
        campaignId: 'camp-broad',
        adSetId: 'as-broad',
        bid: 5,
        relevance: 1,
        authorUserId: 'other',
        targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
      });
      const { svc } = makeServiceForDistrict('Some Unknown Place', [regionTargeted, noRegion]);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result?.campaignId).toBe('camp-broad');
    });

    it('a confidently-local viewer (recognized district in target) is NOT down-ranked and wins', async () => {
      // Same two candidates, but the viewer IS in the targeted district -> full
      // score, so the region candidate wins on rotation/tie (and is served).
      const regionTargeted = makeCandidate({
        campaignId: 'camp-region',
        adSetId: 'as-region',
        bid: 5,
        relevance: 1,
        authorUserId: 'other',
        targeting: { roles: [], sectors: [], districts: ['Surat'], companySizes: [] },
      });
      const { svc, openSpy } = makeServiceForDistrict('Surat', [regionTargeted]);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      // Recognized + targeted -> confident match, served at full score.
      expect(result?.campaignId).toBe('camp-region');
      expect(openSpy).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'camp-region' }));
    });

    it('still serves an unknown-location match when it is the only candidate (eligible, just lower-ranked)', async () => {
      const regionTargeted = makeCandidate({
        campaignId: 'camp-region',
        adSetId: 'as-region',
        bid: 5,
        relevance: 1,
        authorUserId: 'other',
        targeting: { roles: [], sectors: [], districts: ['Surat'], companySizes: [] },
      });
      const { svc } = makeServiceForDistrict('', [regionTargeted]);

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      // Blank district is unknown-location -> eligible; floor gate uses raw eCPM
      // (not the down-ranked score), so it still clears the floor and serves.
      expect(result?.campaignId).toBe('camp-region');
    });
  });

  describe('selection telemetry (F2)', () => {
    it('emits served + winnerCampaignId when an ad wins', async () => {
      const candidate = makeCandidate({ campaignId: 'camp-win', authorUserId: 'other' });
      const fakes = makeFakes({ candidates: [candidate] });
      const svc = makeService(fakes);

      await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(lastOutcome(fakes.captureSpy)).toBe('served');
      const evt = fakes.captureSpy.mock.calls.find((c) => c[0]?.event === 'ads.auction_decided')[0];
      expect(evt.properties.winnerCampaignId).toBe('camp-win');
      expect(evt.properties.candidateCount).toBe(1);
    });

    it('emits no_candidates when the candidate list is empty', async () => {
      const fakes = makeFakes({ candidates: [] });
      const svc = makeService(fakes);

      await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(lastOutcome(fakes.captureSpy)).toBe('no_candidates');
    });

    it('emits all_filtered when candidates exist but all are filtered out', async () => {
      // Sole candidate is authored by the viewer -> filtered.
      const candidate = makeCandidate({ authorUserId: 'viewer-self' });
      const fakes = makeFakes({ candidates: [candidate] });
      const svc = makeService(fakes);

      await svc.decide({ userId: 'viewer-self', placementKey: 'feed_promoted_post' });

      expect(lastOutcome(fakes.captureSpy)).toBe('all_filtered');
    });

    it('emits all_below_floor when the winner does not clear the floor', async () => {
      const candidate = makeCandidate({ billingEvent: 'cpm', bid: 0.5, authorUserId: 'other' });
      const fakes = makeFakes({
        placement: { ...PLACEMENT_ENABLED, floorCpm: 1.0 },
        candidates: [candidate],
      });
      const svc = makeService(fakes);

      await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(lastOutcome(fakes.captureSpy)).toBe('all_below_floor');
    });

    it('emits error and rethrows when a collaborator throws', async () => {
      const fakes = makeFakes();
      (fakes.profiles.get as any).mockRejectedValue(new Error('profile boom'));
      const svc = makeService(fakes);

      await expect(
        svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' }),
      ).rejects.toThrow('profile boom');
      expect(lastOutcome(fakes.captureSpy)).toBe('error');
    });

    it('passes the placement floor price (floorCpm/1000) into the candidate query', async () => {
      const fakes = makeFakes({ placement: { ...PLACEMENT_ENABLED, floorCpm: 8 }, candidates: [] });
      const svc = makeService(fakes);

      await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      // CN-ADS-8: the optional `kinds` filter is the 4th arg (undefined here — no
      // kind restriction on the feed slot).
      expect(fakes.topSpy).toHaveBeenCalledWith('feed_promoted_post', 50, 0.008, undefined);
    });

    it('CN-ADS-8: threads the kinds filter into the candidate query when supplied', async () => {
      const fakes = makeFakes({ placement: { ...PLACEMENT_ENABLED, floorCpm: 8 }, candidates: [] });
      const svc = makeService(fakes);

      await svc.decide({
        userId: 'viewer',
        placementKey: 'feed_sponsored',
        kinds: ['promoted_open_to_work', 'promoted_hiring'],
      });

      expect(fakes.topSpy).toHaveBeenCalledWith('feed_sponsored', 50, 0.008, [
        'promoted_open_to_work',
        'promoted_hiring',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Fairness controls (C4 daily cap, C5 per-page dedupe, C6 rotation, C7 telem)
  // -------------------------------------------------------------------------

  /** A stateful daily-cap fake: blocks after `cap` serves per (viewer,campaign). */
  function makeCampaignCap(cap = 2) {
    const counts = new Map<string, number>();
    const k = (v: string, c: string) => `${v}:${c}`;
    return {
      withinDailyCampaignCap: vi.fn((v: string, c: string) =>
        Promise.resolve((counts.get(k(v, c)) ?? 0) < cap),
      ),
      recordDailyCampaignServe: vi.fn((v: string, c: string) => {
        counts.set(k(v, c), (counts.get(k(v, c)) ?? 0) + 1);
        return Promise.resolve();
      }),
    };
  }

  /** A page-dedupe fake backed by an in-memory set per pageRequestId. */
  function makePageDedupe(preServed: Record<string, string[]> = {}) {
    const pages = new Map<string, Set<string>>(
      Object.entries(preServed).map(([p, ids]) => [p, new Set(ids)]),
    );
    return {
      servedCampaigns: vi.fn((p: string) => Promise.resolve([...(pages.get(p) ?? [])])),
      markServedOnPage: vi.fn((p: string, c: string) => {
        const s = pages.get(p) ?? new Set<string>();
        s.add(c);
        pages.set(p, s);
        return Promise.resolve();
      }),
    };
  }

  function makeServiceWithFairness(
    fakes: ReturnType<typeof makeFakes>,
    campaignCap: ReturnType<typeof makeCampaignCap>,
    pageDedupe: ReturnType<typeof makePageDedupe>,
  ): AdDecisionService {
    return new AdDecisionService(
      fakes.placements,
      fakes.candidatesRepo,
      fakes.profiles,
      fakes.freqCap,
      fakes.pacing,
      fakes.impressions,
      fakes.posthog,
      undefined, // blocks
      campaignCap as any,
      pageDedupe as any,
    );
  }

  function lastEvent(captureSpy: ReturnType<typeof vi.fn>) {
    return captureSpy.mock.calls.find((c) => c[0]?.event === 'ads.auction_decided')?.[0];
  }

  describe('daily campaign cap (C4)', () => {
    it('filters the sole candidate when over the daily cap and reports frequency_capped', async () => {
      const candidate = makeCandidate({ campaignId: 'camp-x', authorUserId: 'other' });
      const fakes = makeFakes({ candidates: [candidate] });
      const cap = makeCampaignCap(2);
      // Pre-exhaust the cap: two prior serves.
      await cap.recordDailyCampaignServe('viewer', 'camp-x');
      await cap.recordDailyCampaignServe('viewer', 'camp-x');
      const svc = makeServiceWithFairness(fakes, cap, makePageDedupe());

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).toBeNull();
      expect(lastOutcome(fakes.captureSpy)).toBe('all_filtered');
      expect(lastEvent(fakes.captureSpy).properties.frequency_capped).toBe(1);
    });

    it('records a serve toward the cap on the winner', async () => {
      const candidate = makeCandidate({ campaignId: 'camp-x', authorUserId: 'other' });
      const fakes = makeFakes({ candidates: [candidate] });
      const cap = makeCampaignCap(2);
      const svc = makeServiceWithFairness(fakes, cap, makePageDedupe());

      await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(cap.recordDailyCampaignServe).toHaveBeenCalledWith('viewer', 'camp-x');
    });

    it('suppresses the 3rd same-day impression of one campaign (cap=2)', async () => {
      const candidate = makeCandidate({ campaignId: 'camp-x', authorUserId: 'other' });
      const cap = makeCampaignCap(2);
      const dedupe = makePageDedupe();

      // Each decide uses a fresh candidate list (the repo is re-stubbed) but the
      // SAME stateful cap, so the third serve is suppressed.
      const r1 = await makeServiceWithFairness(
        makeFakes({ candidates: [candidate] }),
        cap,
        dedupe,
      ).decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });
      const r2 = await makeServiceWithFairness(
        makeFakes({ candidates: [candidate] }),
        cap,
        dedupe,
      ).decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });
      const r3 = await makeServiceWithFairness(
        makeFakes({ candidates: [candidate] }),
        cap,
        dedupe,
      ).decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r3).toBeNull(); // 3rd impression suppressed
    });
  });

  describe('viewer ad suppression (Phase 7d — sponsored "Hide")', () => {
    /** Construct a service with a suppression fake (positional arg 12). */
    function makeServiceWithSuppression(
      fakes: ReturnType<typeof makeFakes>,
      suppressed: Set<string>,
    ): AdDecisionService {
      const suppression = {
        isCampaignSuppressed: vi.fn((_v: string, c: string) => Promise.resolve(suppressed.has(c))),
      };
      const svc = new AdDecisionService(
        fakes.placements,
        fakes.candidatesRepo,
        fakes.profiles,
        fakes.freqCap,
        fakes.pacing,
        fakes.impressions,
        fakes.posthog,
        undefined, // blocks
        makeCampaignCap(),
        makePageDedupe(),
        suppression as any,
      );
      return svc;
    }

    it('skips a campaign the viewer hid (returns null, falls back to house promo)', async () => {
      const candidate = makeCandidate({ campaignId: 'camp-hidden', authorUserId: 'other' });
      const fakes = makeFakes({ candidates: [candidate] });
      const svc = makeServiceWithSuppression(fakes, new Set(['camp-hidden']));

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).toBeNull();
    });

    it('serves a campaign the viewer has NOT hidden', async () => {
      const candidate = makeCandidate({ campaignId: 'camp-ok', authorUserId: 'other' });
      const fakes = makeFakes({ candidates: [candidate] });
      const svc = makeServiceWithSuppression(fakes, new Set(['some-other-camp']));

      const result = await svc.decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });

      expect(result).not.toBeNull();
    });
  });

  describe('per-page dedupe (C5)', () => {
    it('excludes a campaign already served on the same page and reports page_deduped', async () => {
      const candidate = makeCandidate({ campaignId: 'camp-dup', authorUserId: 'other' });
      const fakes = makeFakes({ candidates: [candidate] });
      const dedupe = makePageDedupe({ 'page-1': ['camp-dup'] });
      const svc = makeServiceWithFairness(fakes, makeCampaignCap(), dedupe);

      const result = await svc.decide({
        userId: 'viewer',
        placementKey: 'marketplace_grid',
        pageRequestId: 'page-1',
      });

      expect(result).toBeNull();
      expect(lastOutcome(fakes.captureSpy)).toBe('all_filtered');
      expect(lastEvent(fakes.captureSpy).properties.page_deduped).toBe(1);
    });

    it('a campaign cannot win two slots of the same page response', async () => {
      const railCandidate = makeCandidate({
        campaignId: 'camp-1',
        creativeKind: 'promoted_listing',
        listingRef: 'l/1',
        authorUserId: 'other',
      });
      const dedupe = makePageDedupe();
      const cap = makeCampaignCap();

      // Slot 1 (rail): camp-1 wins and is recorded against page-1.
      const slot1 = await makeServiceWithFairness(
        makeFakes({ candidates: [railCandidate] }),
        cap,
        dedupe,
      ).decide({ userId: 'viewer', placementKey: 'marketplace_rail', pageRequestId: 'page-1' });
      expect(slot1?.campaignId).toBe('camp-1');

      // Slot 2 (grid) on the SAME page: camp-1 is the only candidate -> deduped.
      const slot2 = await makeServiceWithFairness(
        makeFakes({ candidates: [railCandidate] }),
        cap,
        dedupe,
      ).decide({ userId: 'viewer', placementKey: 'marketplace_grid', pageRequestId: 'page-1' });
      expect(slot2).toBeNull();
    });

    it('does not dedupe across different pages', async () => {
      const candidate = makeCandidate({ campaignId: 'camp-1', authorUserId: 'other' });
      const dedupe = makePageDedupe({ 'page-1': ['camp-1'] });
      const svc = makeServiceWithFairness(
        makeFakes({ candidates: [candidate] }),
        makeCampaignCap(),
        dedupe,
      );

      // page-2 has not served camp-1, so it serves.
      const result = await svc.decide({
        userId: 'viewer',
        placementKey: 'marketplace_grid',
        pageRequestId: 'page-2',
      });
      expect(result?.campaignId).toBe('camp-1');
    });
  });

  describe('equal-bid rotation (C6)', () => {
    it('shares wins between two equal bidders over repeated auctions', async () => {
      const a = makeCandidate({
        campaignId: 'camp-a',
        adSetId: 'as-a',
        bid: 5,
        relevance: 1,
        authorUserId: 'other',
      });
      const b = makeCandidate({
        campaignId: 'camp-b',
        adSetId: 'as-b',
        bid: 5,
        relevance: 1,
        authorUserId: 'other',
      });
      const wins: Record<string, number> = { 'camp-a': 0, 'camp-b': 0 };
      for (let i = 0; i < 400; i++) {
        // Fresh services each run; no cap/dedupe so only rotation drives the pick.
        const r = await makeServiceWithFairness(
          makeFakes({ candidates: [a, b] }),
          makeCampaignCap(9999),
          makePageDedupe(),
        ).decide({ userId: 'viewer', placementKey: 'feed_promoted_post' });
        if (r) wins[r.campaignId]++;
      }
      // Neither equal bidder is starved.
      expect(wins['camp-a']).toBeGreaterThan(100);
      expect(wins['camp-b']).toBeGreaterThan(100);
    });
  });

  describe('injection tokens exported', () => {
    it('exports all 6 injection tokens as non-empty strings', () => {
      expect(typeof PLACEMENT_REPO).toBe('string');
      expect(typeof CANDIDATE_REPO).toBe('string');
      expect(typeof PROFILE_REPO).toBe('string');
      expect(typeof FREQ_CAP_REPO).toBe('string');
      expect(typeof PACING_REPO).toBe('string');
      expect(typeof IMPRESSION_OPENER).toBe('string');
      // all distinct
      const tokens = [
        PLACEMENT_REPO,
        CANDIDATE_REPO,
        PROFILE_REPO,
        FREQ_CAP_REPO,
        PACING_REPO,
        IMPRESSION_OPENER,
      ];
      expect(new Set(tokens).size).toBe(6);
    });
  });
});
