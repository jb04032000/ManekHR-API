/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * DecideController unit tests -- TDD.
 *
 * Critical assertion: userId for decide/recordClick comes from `req.user.sub`
 * (auth), NOT the body.
 */

import { describe, it, expect, vi } from 'vitest';
import { DecideController } from '../decide.controller';

const AUTH_USER_ID = 'authed-user-123';
const BOGUS_USER_ID = 'evil-body-user-999';

const TEST_UA = 'Mozilla/5.0 (Test Browser)';

function makeReq(sub = AUTH_USER_ID) {
  return { user: { sub }, headers: { 'user-agent': TEST_UA } };
}

function makeMockAdDecisionService() {
  return {
    decide: vi.fn().mockResolvedValue({
      impressionToken: 'tok-abc',
      postRef: 'post-xyz',
      campaignId: 'camp-1',
    }),
  };
}

function makeMockAdEventsService() {
  return {
    recordImpression: vi.fn().mockResolvedValue(undefined),
    recordClick: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DecideController', () => {
  describe('POST /decide', () => {
    it('calls adDecisionService.decide with userId from auth and placementKey from body', async () => {
      const decisionSvc = makeMockAdDecisionService();
      const eventsSvc = makeMockAdEventsService();
      const ctrl = new DecideController(decisionSvc as any, eventsSvc as any);
      // Supply a bogus userId in the body - must be ignored
      const dto = { placementKey: 'feed_card_3', userId: BOGUS_USER_ID };

      await ctrl.decide(makeReq(), dto);

      expect(decisionSvc.decide).toHaveBeenCalledWith({
        userId: AUTH_USER_ID,
        placementKey: 'feed_card_3',
      });
      const callArg = decisionSvc.decide.mock.calls[0][0] as { userId: string };
      expect(callArg.userId).toBe(AUTH_USER_ID);
      expect(callArg.userId).not.toBe(BOGUS_USER_ID);
    });

    it('returns the DecisionResult from the service', async () => {
      const decisionSvc = makeMockAdDecisionService();
      const eventsSvc = makeMockAdEventsService();
      const ctrl = new DecideController(decisionSvc as any, eventsSvc as any);

      const result = await ctrl.decide(makeReq(), { placementKey: 'feed_card_3' });

      expect(result).toEqual({
        impressionToken: 'tok-abc',
        postRef: 'post-xyz',
        campaignId: 'camp-1',
      });
    });
  });

  describe('POST /events/impression', () => {
    it('calls adEventsService.recordImpression with the impressionToken from body', async () => {
      const decisionSvc = makeMockAdDecisionService();
      const eventsSvc = makeMockAdEventsService();
      const ctrl = new DecideController(decisionSvc as any, eventsSvc as any);
      const dto = { impressionToken: 'tok-impr-1' };

      await ctrl.recordImpression(makeReq(), dto);

      // CN-ADS-11: the caller (req.user.sub) is threaded so the service can
      // reject a leaked/replayed token fired by anyone but the served viewer.
      expect(eventsSvc.recordImpression).toHaveBeenCalledWith('tok-impr-1', AUTH_USER_ID);
    });

    it('returns undefined (204 no-content)', async () => {
      const decisionSvc = makeMockAdDecisionService();
      const eventsSvc = makeMockAdEventsService();
      const ctrl = new DecideController(decisionSvc as any, eventsSvc as any);

      const result = await ctrl.recordImpression(makeReq(), { impressionToken: 'tok-1' });

      expect(result).toBeUndefined();
    });
  });

  describe('POST /events/click', () => {
    it('calls adEventsService.recordClick with impressionToken from body and userId from auth', async () => {
      const decisionSvc = makeMockAdDecisionService();
      const eventsSvc = makeMockAdEventsService();
      const ctrl = new DecideController(decisionSvc as any, eventsSvc as any);
      // Bogus userId in body - must be ignored
      const dto = { impressionToken: 'tok-click-1', userId: BOGUS_USER_ID };

      await ctrl.recordClick(makeReq(), dto);

      // userId from auth, user-agent threaded from the request headers (IVT).
      expect(eventsSvc.recordClick).toHaveBeenCalledWith('tok-click-1', AUTH_USER_ID, TEST_UA);
      const [, userIdArg] = eventsSvc.recordClick.mock.calls[0] as [string, string];
      expect(userIdArg).toBe(AUTH_USER_ID);
      expect(userIdArg).not.toBe(BOGUS_USER_ID);
    });

    it('returns undefined (204 no-content)', async () => {
      const decisionSvc = makeMockAdDecisionService();
      const eventsSvc = makeMockAdEventsService();
      const ctrl = new DecideController(decisionSvc as any, eventsSvc as any);

      const result = await ctrl.recordClick(makeReq(), { impressionToken: 'tok-2' });

      expect(result).toBeUndefined();
    });
  });
});
