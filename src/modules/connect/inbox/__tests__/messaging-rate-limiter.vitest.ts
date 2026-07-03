/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { MessagingRateLimiter } from '../messaging-rate-limiter';
import { resolveMessagingTier, MESSAGING_INITIATION_CAPS } from '../messaging-limits';

describe('resolveMessagingTier', () => {
  const now = new Date('2026-05-31T00:00:00.000Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  it('is verified when the verified badge is held (age irrelevant)', () => {
    expect(resolveMessagingTier({ createdAt: daysAgo(0), verified: true, now })).toBe('verified');
  });
  it('is new for an account younger than 7 days', () => {
    expect(resolveMessagingTier({ createdAt: daysAgo(2), verified: false, now })).toBe('new');
  });
  it('is established for an account 7+ days old', () => {
    expect(resolveMessagingTier({ createdAt: daysAgo(10), verified: false, now })).toBe(
      'established',
    );
  });
  it('is new (most restrictive) when createdAt is unknown', () => {
    expect(resolveMessagingTier({ createdAt: null, verified: false, now })).toBe('new');
  });
});

describe('MessagingRateLimiter.tryConsumeInitiation', () => {
  it('allows when the token bucket returns 1 and passes the tier caps + per-user key', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) };
    const limiter = new MessagingRateLimiter(redis as any);

    await expect(limiter.tryConsumeInitiation('u1', 'new', 1000)).resolves.toBe(true);

    const args = redis.eval.mock.calls[0];
    expect(args[1]).toBe(1); // numKeys
    expect(args[2]).toBe('inbox:rl:init:u1'); // KEYS[1]
    expect(args[3]).toBe(String(MESSAGING_INITIATION_CAPS.new.capacity));
    expect(args[7]).toBe('1'); // cost
  });

  it('blocks when the bucket is empty (0)', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) };
    const limiter = new MessagingRateLimiter(redis as any);
    await expect(limiter.tryConsumeInitiation('u1', 'established')).resolves.toBe(false);
  });

  it('fails OPEN when Redis errors (availability over strictness)', async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error('redis down')) };
    const limiter = new MessagingRateLimiter(redis as any);
    await expect(limiter.tryConsumeInitiation('u1', 'verified')).resolves.toBe(true);
  });
});
