/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AUTH-H1 — the JWT-claims Redis cache TTL must be capped at 15 min (900s)
 * independent of the (possibly 30d) access-token lifetime, so a single missed
 * `del` cannot keep a deactivated/demoted user's stale claims for up to 30 days.
 * Links: user-claims-cache.service.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Control the configured access-token lifetime per-test by mocking the env
// singleton (the service reads env.jwt.accessExpiry at construction). vi.hoisted
// makes `envMock` available inside the hoisted vi.mock factory below.
const { envMock } = vi.hoisted(() => ({ envMock: { jwt: { accessExpiry: '15m' } } }));
vi.mock('../../../config/env', () => ({ env: envMock }));

// REDIS_CLIENT is only an injection token here; a string stand-in is fine.
vi.mock('../../../common/redis/redis.module', () => ({ REDIS_CLIENT: 'REDIS_CLIENT' }));

import { UserClaimsCacheService } from '../user-claims-cache.service';

function buildRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
}

describe('UserClaimsCacheService TTL ceiling (AUTH-H1)', () => {
  let redis: ReturnType<typeof buildRedis>;

  beforeEach(() => {
    redis = buildRedis();
  });

  it('caps the TTL at 900s even when access expiry is configured to 30d', () => {
    envMock.jwt.accessExpiry = '30d';
    const svc = new UserClaimsCacheService(redis as any);
    // 30d would be 2,592,000s without the cap.
    expect(svc.getTtlSecForTest()).toBe(900);
  });

  it('hands Redis a TTL <= 900s on set() with a 30d access expiry', async () => {
    envMock.jwt.accessExpiry = '30d';
    const svc = new UserClaimsCacheService(redis as any);

    await svc.set('user-1', { isAdmin: false, isActive: true, email: 'a@b.com' });

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [, , exFlag, ttl] = redis.set.mock.calls[0];
    expect(exFlag).toBe('EX');
    expect(ttl).toBeLessThanOrEqual(900);
    expect(ttl).toBe(900);
  });

  it('uses the configured lifetime when it is BELOW the ceiling (e.g. 5m)', () => {
    envMock.jwt.accessExpiry = '5m';
    const svc = new UserClaimsCacheService(redis as any);
    expect(svc.getTtlSecForTest()).toBe(300);
  });

  it('falls back to <= 900s for an unparseable access expiry', () => {
    envMock.jwt.accessExpiry = 'garbage';
    const svc = new UserClaimsCacheService(redis as any);
    expect(svc.getTtlSecForTest()).toBeLessThanOrEqual(900);
    expect(svc.getTtlSecForTest()).toBe(900);
  });
});
