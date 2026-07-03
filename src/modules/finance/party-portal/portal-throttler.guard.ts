import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * PortalThrottlerGuard — extends @nestjs/throttler ThrottlerGuard with a
 * per-(jti, ip) tracker so abuse on one signed link cannot tar-pit unrelated
 * tokens. Per D-27 the cap is 60 req/min.
 *
 * The throttler limit ('portal' definition) is registered in
 * PartyPortalModule via `ThrottlerModule.forRoot([{ name: 'portal',
 * limit: 60, ttl: 60_000 }])`. Apply with @Throttle({ portal: { ... } }) on
 * controller methods.
 */
@Injectable()
export class PortalThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const jti = req.portalContext?.jti ?? 'no-jti';
    const ip =
      req.ip ??
      req.headers?.['x-forwarded-for'] ??
      req.connection?.remoteAddress ??
      '0.0.0.0';
    return Promise.resolve(`portal:${jti}:${ip}`);
  }
}
