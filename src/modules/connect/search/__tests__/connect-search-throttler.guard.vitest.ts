import { describe, it, expect } from 'vitest';
import { ConnectSearchThrottlerGuard } from '../connect-search-throttler.guard';

/**
 * Unit coverage for `ConnectSearchThrottlerGuard` (SRCH-PERF-1). The default
 * `@nestjs/throttler` guard rate-limits per CLIENT IP, which would let many
 * workers behind one factory NAT 429 each other on a shared connection. The
 * search endpoint is authenticated (the global `JwtAuthGuard` populates
 * `req.user` before this route guard runs), so we rate-limit per authenticated
 * USER, falling back to IP only if the user id is somehow absent.
 *
 * `getTracker` is exercised directly off the prototype so the test needs no
 * ThrottlerModule storage/reflector wiring.
 */
function tracker(req: Record<string, unknown>): Promise<string> {
  const guard = Object.create(ConnectSearchThrottlerGuard.prototype) as ConnectSearchThrottlerGuard;
  return (
    guard as unknown as { getTracker: (r: Record<string, unknown>) => Promise<string> }
  ).getTracker(req);
}

describe('ConnectSearchThrottlerGuard (SRCH-PERF-1)', () => {
  it('rate-limits per authenticated user id', async () => {
    const key = await tracker({ user: { sub: 'user-123' }, ip: '10.0.0.9' });
    expect(key).toBe('search:user:user-123');
  });

  it('two different users on the same IP get independent buckets', async () => {
    const a = await tracker({ user: { sub: 'user-a' }, ip: '10.0.0.9' });
    const b = await tracker({ user: { sub: 'user-b' }, ip: '10.0.0.9' });
    expect(a).not.toBe(b);
  });

  it('falls back to the client IP when there is no authenticated user', async () => {
    const key = await tracker({ ip: '203.0.113.7' });
    expect(key).toBe('search:ip:203.0.113.7');
  });

  it('falls back to a stable sentinel when neither user nor IP is resolvable', async () => {
    const key = await tracker({});
    expect(key).toBe('search:ip:0.0.0.0');
  });
});
