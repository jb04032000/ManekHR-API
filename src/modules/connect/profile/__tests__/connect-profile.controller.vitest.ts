/* eslint-disable @typescript-eslint/unbound-method -- expect(spy) references the
   vitest mock by member access; these are vi.fn() spies, not real unbound methods. */
import { describe, it, expect, vi } from 'vitest';
import { ConnectProfilePublicController } from '../connect-profile.controller';
import type { ConnectProfileService } from '../connect-profile.service';
import type { ErpLinkService } from '../erp-link.service';
import { OptionalJwtAuthGuard } from '../../../../common/guards/optional-jwt-auth.guard';

/**
 * Controller + guard unit spec for the public profile read.
 *
 * Proves the HIGH-severity viewer-resolution fix: a `@Public()` route paired
 * with `OptionalJwtAuthGuard` threads the signed-in viewer id into the service
 * when a token is present, and passes `undefined` (without throwing) when the
 * caller is logged out. The bug was that `req.user` was never populated on the
 * `@Public()` route, so a logged-in connection was treated as logged-out and
 * `network`-audience intents were hidden from everyone.
 */

// A request object as it looks after the guard chain has (or has not) run.
type Req = { user?: { sub: string } };

function makeController() {
  const profileService = {
    getPublicBySlug: vi.fn().mockResolvedValue({ ok: true }),
    getPublicByUserId: vi.fn().mockResolvedValue({ ok: true }),
    resolveSlugToUserId: vi.fn().mockResolvedValue('user-1'),
  } as unknown as ConnectProfileService;
  const erpLinkService = {
    getUserStatus: vi.fn().mockResolvedValue({ linked: true, since: null }),
  } as unknown as ErpLinkService;
  const controller = new ConnectProfilePublicController(profileService, erpLinkService);
  return { controller, profileService, erpLinkService };
}

describe('ConnectProfilePublicController — viewer resolution', () => {
  it('passes the signed-in viewer id when the request carries a viewer', async () => {
    const { controller, profileService } = makeController();
    const req: Req = { user: { sub: 'viewer-42' } };

    await controller.getPublic('alice', req);

    expect(profileService.getPublicBySlug).toHaveBeenCalledWith('alice', 'viewer-42');
  });

  it('passes undefined and does not throw for a logged-out request', async () => {
    const { controller, profileService } = makeController();
    const req: Req = {}; // no token => guard left req.user undefined

    await expect(controller.getPublic('alice', req)).resolves.toBeDefined();
    expect(profileService.getPublicBySlug).toHaveBeenCalledWith('alice', undefined);
  });

  it('threads the viewer id through the erp-link read too', async () => {
    const { controller, profileService } = makeController();
    const req: Req = { user: { sub: 'viewer-7' } };

    await controller.getPublicErpLink('alice', req);

    expect(profileService.getPublicByUserId).toHaveBeenCalledWith('user-1', 'viewer-7');
  });
});

describe('OptionalJwtAuthGuard.handleRequest', () => {
  it('returns the user when present', () => {
    const guard = new OptionalJwtAuthGuard();
    const user = { sub: 'u-1' };
    expect(guard.handleRequest(null, user)).toBe(user);
  });

  it('returns undefined (never throws) when there is no user', () => {
    const guard = new OptionalJwtAuthGuard();
    expect(() => guard.handleRequest(null, undefined)).not.toThrow();
    expect(guard.handleRequest(null, undefined)).toBeUndefined();
  });

  it('returns undefined (never throws) when the strategy errored', () => {
    const guard = new OptionalJwtAuthGuard();
    const err = new Error('jwt expired');
    expect(() => guard.handleRequest(err, undefined)).not.toThrow();
    expect(guard.handleRequest(err, undefined)).toBeUndefined();
  });
});
