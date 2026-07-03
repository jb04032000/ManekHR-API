/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * BoostController unit tests -- TDD.
 *
 * Critical assertion: ownerUserId comes from `req.user.sub` (auth), NOT the body.
 * A bogus ownerUserId in the body must be ignored; the service receives the auth userId.
 */

import { describe, it, expect, vi } from 'vitest';
import { BoostController } from '../boost.controller';

// Auth pattern: req.user.sub (matches feed.controller.ts)
const AUTH_USER_ID = 'authed-user-123';
const BOGUS_USER_ID = 'evil-body-user-999';

function makeReq(sub = AUTH_USER_ID) {
  return { user: { sub } };
}

function makeMockBoostService() {
  // pause/resume/cancel are intentionally NOT mocked here: the controller no
  // longer exposes those routes (owner decision 2026-06-20 -- users cannot stop
  // their own live boost). The service methods still exist and keep their own
  // service-level coverage in boost.service.vitest.ts.
  return {
    createListingBoost: vi
      .fn()
      .mockResolvedValue({ _id: 'camp-listing-new', status: 'pending_review' }),
    createPostBoost: vi.fn().mockResolvedValue({ _id: 'camp-post-new', status: 'pending_review' }),
    status: vi.fn().mockResolvedValue({ status: 'active', spend: 100 }),
  };
}

const BASE_LISTING_DTO = {
  listingId: 'listing-abc',
  objective: 'reach' as const,
  totalBudget: 500,
  days: 7,
  targeting: { roles: [], sectors: ['weaving'], districts: [], companySizes: [] },
};

describe('BoostController', () => {
  describe('POST /listing (createListing)', () => {
    it('calls boostService.createListingBoost with ownerUserId from auth (req.user.sub), not body', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);
      const dtoWithBogusOwner = { ...BASE_LISTING_DTO, ownerUserId: BOGUS_USER_ID };

      await ctrl.createListing(makeReq(), dtoWithBogusOwner as any);

      const callArg = svc.createListingBoost.mock.calls[0][0];
      expect(callArg.ownerUserId).toBe(AUTH_USER_ID);
      expect(callArg.ownerUserId).not.toBe(BOGUS_USER_ID);
    });

    it('passes DTO fields (listingId, objective, totalBudget, days, targeting) through to service', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);

      await ctrl.createListing(makeReq(), BASE_LISTING_DTO as any);

      expect(svc.createListingBoost).toHaveBeenCalledWith(
        expect.objectContaining({
          listingId: 'listing-abc',
          objective: 'reach',
          totalBudget: 500,
          days: 7,
          targeting: BASE_LISTING_DTO.targeting,
        }),
      );
    });

    it('returns the value returned by boostService.createListingBoost', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);

      const result = await ctrl.createListing(makeReq(), BASE_LISTING_DTO as any);

      expect(result).toEqual({ _id: 'camp-listing-new', status: 'pending_review' });
    });

    it('defaults targeting to {} when dto.targeting is undefined', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);
      const dtoNoTargeting = {
        listingId: 'l1',
        objective: 'inquiries' as const,
        totalBudget: 200,
        days: 3,
      };

      await ctrl.createListing(makeReq(), dtoNoTargeting as any);

      const callArg = svc.createListingBoost.mock.calls[0][0];
      expect(callArg.targeting).toEqual({});
    });
  });

  describe('POST /post (createPost)', () => {
    const BASE_POST_DTO = {
      postId: 'post-abc',
      objective: 'reach' as const,
      totalBudget: 500,
      days: 7,
      targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
    };

    it('calls boostService.createPostBoost with ownerUserId from auth (req.user.sub), not body', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);
      const dtoWithBogusOwner = { ...BASE_POST_DTO, ownerUserId: BOGUS_USER_ID };

      await ctrl.createPost(makeReq(), dtoWithBogusOwner as any);

      const callArg = svc.createPostBoost.mock.calls[0][0];
      expect(callArg.ownerUserId).toBe(AUTH_USER_ID);
      expect(callArg.ownerUserId).not.toBe(BOGUS_USER_ID);
    });

    it('passes DTO fields (postId, objective, totalBudget, days, targeting) through to service', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);

      await ctrl.createPost(makeReq(), BASE_POST_DTO as any);

      expect(svc.createPostBoost).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-abc',
          objective: 'reach',
          totalBudget: 500,
          days: 7,
          targeting: BASE_POST_DTO.targeting,
        }),
      );
    });

    it('defaults targeting to {} when dto.targeting is undefined', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);

      await ctrl.createPost(makeReq(), {
        postId: 'p1',
        objective: 'profile_visits' as const,
        totalBudget: 200,
        days: 3,
      } as any);

      expect(svc.createPostBoost.mock.calls[0][0].targeting).toEqual({});
    });

    it('returns the value returned by boostService.createPostBoost', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);

      const result = await ctrl.createPost(makeReq(), BASE_POST_DTO as any);

      expect(result).toEqual({ _id: 'camp-post-new', status: 'pending_review' });
    });
  });

  describe('GET /:id (status)', () => {
    it('calls boostService.status with campaignId from param and userId from auth', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);

      await ctrl.getStatus(makeReq(), 'camp-xyz');

      expect(svc.status).toHaveBeenCalledWith('camp-xyz', AUTH_USER_ID);
    });

    it('returns the BoostStatusView from the service', async () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any);

      const result = await ctrl.getStatus(makeReq(), 'camp-xyz');

      expect(result).toEqual({ status: 'active', spend: 100 });
    });
  });

  // The user-facing pause / resume / cancel routes were removed (owner decision
  // 2026-06-20): a user cannot stop their own live boost. The controller no longer
  // has those methods, so there is nothing to exercise here. Admin take-down stays
  // on its own path (ads-admin) and the service methods keep service-level tests.
  describe('removed user lifecycle routes', () => {
    it('does not expose pause / resume / cancel methods on the controller', () => {
      const svc = makeMockBoostService();
      const ctrl = new BoostController(svc as any) as Record<string, unknown>;
      expect(ctrl.pause).toBeUndefined();
      expect(ctrl.resume).toBeUndefined();
      expect(ctrl.cancel).toBeUndefined();
    });
  });
});
