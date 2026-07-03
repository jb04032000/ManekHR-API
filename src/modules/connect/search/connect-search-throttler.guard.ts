import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * `ConnectSearchThrottlerGuard` (SRCH-PERF-1) — extends `@nestjs/throttler`
 * `ThrottlerGuard` with a per-authenticated-USER tracker for `GET /connect/search`.
 *
 * The default tracker keys on client IP, which would let many workers behind one
 * factory NAT 429 each other on a shared connection. The search endpoint is
 * authenticated (the global `JwtAuthGuard` populates `req.user` BEFORE this
 * route-level guard runs), so we rate-limit per `req.user.sub` and fall back to
 * IP only if the user id is somehow absent. Mirrors `PortalThrottlerGuard`.
 *
 * The 'connect-search' limit/ttl tier is registered centrally in `AppModule`'s
 * `ThrottlerModule.forRoot([...])`; apply with
 * `@Throttle({ 'connect-search': { ... } })` + `@UseGuards(ConnectSearchThrottlerGuard)`.
 */
@Injectable()
export class ConnectSearchThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const userId = req.user?.sub;
    if (userId) return Promise.resolve(`search:user:${userId}`);
    const ip =
      req.ip ?? req.headers?.['x-forwarded-for'] ?? req.connection?.remoteAddress ?? '0.0.0.0';
    return Promise.resolve(`search:ip:${ip}`);
  }
}
