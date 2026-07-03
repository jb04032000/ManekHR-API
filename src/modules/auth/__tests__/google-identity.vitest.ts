/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
/**
 * AuthService.resolveGoogleIdentity — the single choke point that normalises a
 * Google credential from EITHER token kind the clients send:
 *   - web (`@react-oauth/google` useGoogleLogin implicit flow) sends an OAuth
 *     **access_token**;
 *   - mobile (`@react-native-google-signin`) and GIS One-Tap send an OIDC
 *     **id_token** (JWT).
 *
 * Both POST to /auth/google. Before this helper the backend only ever called
 * verifyIdToken, so the web access_token was rejected and Google login failed
 * with a token-validation error. These tests lock in:
 *   1. id_token path → verifyIdToken payload is returned (mobile unaffected).
 *   2. access_token path → tokeninfo audience is checked, then userinfo fills
 *      the profile.
 *   3. an access_token minted for a DIFFERENT client is rejected
 *      (anti token-substitution).
 *
 * The helper is private; we invoke it on a bare prototype instance with only the
 * two collaborators it touches stubbed (configService + googleClient) so we do
 * not stand up the full DI graph. global `fetch` (Node 20+/24) is stubbed.
 *
 * Links: auth.service.ts (resolveGoogleIdentity, googleAuth, forgot-PIN google
 * branch); web AuthClient.tsx + ForgotPinModal.tsx (token senders).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

vi.mock('bcryptjs', () => ({
  compare: vi.fn(),
  genSalt: vi.fn().mockResolvedValue('salt'),
  hash: vi.fn().mockResolvedValue('hashed'),
  default: { compare: vi.fn(), genSalt: vi.fn(), hash: vi.fn() },
}));

import { AuthService } from '../auth.service';

const CLIENT_ID = '120468487121-6poil744lr944q6sm6tdgl9qisdqcarg.apps.googleusercontent.com';

/** Build a bare AuthService with only the two collaborators the helper uses. */
function buildSvc(verifyIdToken: any): any {
  const svc: any = Object.create(AuthService.prototype);
  svc.configService = { get: (k: string) => (k === 'google.clientId' ? CLIENT_ID : undefined) };
  svc.googleClient = { verifyIdToken };
  return svc;
}

describe('AuthService.resolveGoogleIdentity', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns the verified payload for an id_token (mobile / GIS credential)', async () => {
    const verifyIdToken = vi.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-123',
        email: 'priya@example.com',
        email_verified: true,
        name: 'Priya Sharma',
        picture: 'https://pic',
      }),
    });
    // fetch must NOT be called on the id_token fast-path.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const svc = buildSvc(verifyIdToken);
    const out = await svc.resolveGoogleIdentity('an.id.token');

    expect(out).toEqual({
      sub: 'google-sub-123',
      email: 'priya@example.com',
      name: 'Priya Sharma',
      picture: 'https://pic',
      emailVerified: true,
    });
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'an.id.token', audience: CLIENT_ID });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates an access_token via tokeninfo + userinfo (web implicit flow)', async () => {
    // Not an id_token → verifyIdToken throws, helper falls through.
    const verifyIdToken = vi.fn().mockRejectedValue(new Error('not a jwt'));

    const fetchSpy = vi.fn((url: string) => {
      if (url.includes('tokeninfo')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              aud: CLIENT_ID,
              azp: CLIENT_ID,
              sub: 'sub-web',
              email: 'web@x.com',
              email_verified: 'true',
            }),
        });
      }
      // userinfo
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sub: 'sub-web', name: 'Web User', picture: 'https://wp' }),
      });
    });
    globalThis.fetch = fetchSpy as any;

    const svc = buildSvc(verifyIdToken);
    const out = await svc.resolveGoogleIdentity('ya29.accesstoken');

    expect(out).toEqual({
      sub: 'sub-web',
      email: 'web@x.com',
      name: 'Web User',
      picture: 'https://wp',
      emailVerified: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects an access_token minted for a different client (token substitution)', async () => {
    const verifyIdToken = vi.fn().mockRejectedValue(new Error('not a jwt'));
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            aud: 'some-other-client.apps.googleusercontent.com',
            sub: 's',
            email: 'e@x.com',
          }),
      }),
    );
    globalThis.fetch = fetchSpy as any;

    const svc = buildSvc(verifyIdToken);
    await expect(svc.resolveGoogleIdentity('ya29.foreign')).rejects.toThrow(/different app/i);
  });

  it('rejects an unusable token (tokeninfo non-200)', async () => {
    const verifyIdToken = vi.fn().mockRejectedValue(new Error('not a jwt'));
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    ) as any;

    const svc = buildSvc(verifyIdToken);
    await expect(svc.resolveGoogleIdentity('garbage')).rejects.toThrow(/Invalid Google token/i);
  });
});
