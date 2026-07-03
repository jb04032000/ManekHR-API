import { describe, it, expect, vi } from 'vitest';
import { AdDecisionService } from '../ad-decision.service';
import type {
  Placement,
  Candidate,
  PlacementRepo,
  CandidateRepo,
  ProfileRepo,
  FreqCapRepo,
  PacingRepo,
  ImpressionOpener,
  BlockRepo,
} from '../ad-decision.service';
import type { AdProfile } from '../../lib/targeting';

/**
 * Block-filter tests for the auction (audit B5). A boosted post must NEVER serve
 * to a viewer when EITHER side blocked the other (viewer blocked owner OR owner
 * blocked viewer). `BlockRepo.isBlocked` checks both directions; `decide()`
 * skips a blocked candidate before consuming its frequency-cap hit.
 */

const PROFILE: AdProfile = {
  role: 'manager',
  skills: ['textile'],
  district: 'surat',
  companySize: '50-200',
  connectionDegree: 1,
};

const PLACEMENT: Placement = {
  key: 'feed_promoted_post',
  surface: 'feed',
  floorCpm: 0,
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

function build(opts: { candidates: Candidate[]; isBlocked: boolean }) {
  const placements: PlacementRepo = { get: vi.fn(() => Promise.resolve(PLACEMENT)) };
  const candidatesRepo: CandidateRepo = { top: vi.fn(() => Promise.resolve(opts.candidates)) };
  const profiles: ProfileRepo = { get: vi.fn(() => Promise.resolve(PROFILE)) };
  const freqHit = vi.fn(() => Promise.resolve(true));
  const freqCap: FreqCapRepo = { hitAndCheck: freqHit };
  const pacing: PacingRepo = { isThrottled: vi.fn(() => Promise.resolve(false)) };
  const openSpy = vi.fn(() => Promise.resolve({ impressionToken: 'tok' }));
  const impressions: ImpressionOpener = { open: openSpy };
  const isBlockedSpy = vi.fn(() => Promise.resolve(opts.isBlocked));
  const blocks: BlockRepo = { isBlocked: isBlockedSpy };

  const svc = new AdDecisionService(
    placements,
    candidatesRepo,
    profiles,
    freqCap,
    pacing,
    impressions,
    undefined, // posthog
    blocks,
  );
  return { svc, openSpy, freqHit, isBlockedSpy };
}

describe('AdDecisionService.decide block filtering', () => {
  it('skips a candidate when the viewer/owner pair is blocked (returns null, no impression)', async () => {
    const { svc, openSpy, freqHit } = build({
      candidates: [makeCandidate({ authorUserId: 'blocked-author' })],
      isBlocked: true,
    });

    const result = await svc.decide({ userId: 'viewer-1', placementKey: 'feed_promoted_post' });

    expect(result).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
    // A blocked candidate must be skipped BEFORE its frequency-cap hit is consumed.
    expect(freqHit).not.toHaveBeenCalled();
  });

  it('serves normally when the pair is not blocked', async () => {
    const { svc, openSpy, isBlockedSpy } = build({
      candidates: [makeCandidate({ authorUserId: 'fine-author' })],
      isBlocked: false,
    });

    const result = await svc.decide({ userId: 'viewer-1', placementKey: 'feed_promoted_post' });

    expect(result).not.toBeNull();
    expect(result?.postRef).toBe('post/123');
    expect(openSpy).toHaveBeenCalledOnce();
    expect(isBlockedSpy).toHaveBeenCalledWith('viewer-1', 'fine-author');
  });
});
