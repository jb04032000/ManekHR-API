/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReferralController } from '../controllers/referral.controller';

/**
 * Unit coverage for the user-facing referral read controller (`connect/referrals/me`).
 * Verifies the summary is fetched for the AUTHED user (req.user.sub) only -- no
 * userId is ever read from a body/param. The service is stubbed (its own unit
 * specs cover the summary aggregation + lazy code creation).
 */

const ME = '60b0000000000000000000a1';
const OTHER = '60b0000000000000000000ff';

function build() {
  const referralService: any = {
    getMyReferralSummary: vi.fn().mockResolvedValue({
      code: 'RAJESH23',
      enabled: true,
      referrerCredits: 50,
      refereeCredits: 50,
      referredCount: 3,
      rewardedCount: 1,
      pendingCount: 1,
      creditsEarned: 50,
      creditsPending: 50,
      recent: [],
    }),
  };
  const controller = new ReferralController(referralService);
  const req: any = { user: { sub: ME } };
  return { controller, referralService, req };
}

beforeEach(() => vi.clearAllMocks());

describe('ReferralController', () => {
  it('GET /me -> getMyReferralSummary(req.user.sub) and returns the summary', async () => {
    const f = build();
    const out = await f.controller.getMine(f.req);
    expect(f.referralService.getMyReferralSummary).toHaveBeenCalledWith(ME);
    expect(out).toMatchObject({ code: 'RAJESH23', enabled: true, referredCount: 3 });
  });

  it('always uses req.user.sub as the owner (never another id)', async () => {
    const f = build();
    await f.controller.getMine({ user: { sub: OTHER } } as any);
    expect(f.referralService.getMyReferralSummary).toHaveBeenCalledWith(OTHER);
    expect(f.referralService.getMyReferralSummary).not.toHaveBeenCalledWith(ME);
  });
});
