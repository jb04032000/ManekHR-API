import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';
import { ReferralService } from '../services/referral.service';

/** JWT payload shape populated by `JwtAuthGuard` -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/referrals` -- the authenticated user's own referral surface.
 *
 * What: serves `GET /me`, the referral summary (the caller's code + their
 * referred/earned/pending stats + recent referred list) that powers the web
 * `/connect/referrals` page, the boost-page nudge, and the profile entry.
 *
 * Guards: JwtAuthGuard only. The owner is always the authenticated Connect User
 * (`req.user.sub`); Connect has no workspace and no userId is ever read from the
 * body/params, so cross-user reads are impossible.
 *
 * Cross-module links: ReferralService (this module) -> getMyReferralSummary,
 *   which lazily creates the caller's referral code on first read (a write) and
 *   reads the live ConnectReferralConfig for the `enabled` flag + per-side
 *   amounts. Registered in ConnectReferralsModule.
 *
 * Watch: this GET is intentionally NOT cacheable -- getMyReferralSummary calls
 *   getOrCreateMyCode, which persists a code on first access. A read-through
 *   cache would skip the code creation and serve a stale/empty code. The OTel
 *   span mirrors the service-layer span convention; no PostHog event (read path).
 */
// CN-ADS-5 (Bucket 4): ThrottlerGuard in the class chain so the @Throttle on
// GET /me actually enforces (the global guard list has no ThrottlerGuard).
@LegacyUnclassified()
@Controller('connect/referrals')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class ReferralController {
  private readonly tracer = trace.getTracer('connect.referrals');

  constructor(private readonly referralService: ReferralService) {}

  /**
   * Return the caller's referral summary (code + stats + recent list). Lazily
   * creates the caller's code on first call (a write) -- intended, not cacheable.
   */
  @Get('me')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  getMine(@Req() req: AuthedRequest) {
    return this.tracer.startActiveSpan('connect.referrals.getMine', async (span) => {
      try {
        span.setAttributes({ userId: req.user.sub });
        const summary = await this.referralService.getMyReferralSummary(req.user.sub);
        span.setStatus({ code: SpanStatusCode.OK });
        return summary;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
